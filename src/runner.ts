/**
 * Benchmark runner — executes one agent task and grades the result.
 *
 * Per RunSpec: set up a scratch workspace with the condition's instruction file,
 * mint read-only AWS credentials, run the agent, parse usage, grade, and append
 * to results.jsonl. There's nothing to clone — the "environment" is the live
 * AWS account itself.
 */

import { execSync, execFileSync, type ExecSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import type { RunSpec, RunResult, ConditionDef, TaskDef } from "./types.js";
import { parseClaudeJsonl, parseCodexJsonl } from "./usage.js";
import { grade } from "./grader.js";
import { getReadOnlyCredentials, credentialEnv, withCredentials } from "./credentials.js";

const BENCH_ROOT = resolve(import.meta.dirname, "..");
const RESULTS_DIR = join(BENCH_ROOT, "results");
const AGENT_TIMEOUT_MS = 10 * 60 * 1000;

export function runOne(
  spec: RunSpec,
  condition: ConditionDef,
  task: TaskDef,
): RunResult {
  const artifactDir = join(RESULTS_DIR, spec.condition, spec.task, `run${spec.run}`);
  mkdirSync(artifactDir, { recursive: true });

  const workspaceDir = join(artifactDir, "workspace");
  mkdirSync(workspaceDir, { recursive: true });

  try {
    // Both agent CLIs read their instruction file from the working directory.
    writeFileSync(join(workspaceDir, "AGENTS.md"), condition.agents_md);
    writeFileSync(join(workspaceDir, "CLAUDE.md"), condition.agents_md);

    if (condition.setup_commands) {
      for (const setupCmd of condition.setup_commands) {
        try {
          execSync(setupCmd, { cwd: workspaceDir, stdio: "pipe", encoding: "utf-8" });
        } catch (err) {
          // Setup is advisory (tool presence checks); record and continue.
          const e = err as { stderr?: string; message?: string };
          writeFileSync(
            join(artifactDir, "setup_warnings.txt"),
            `${setupCmd}\n${e.stderr ?? e.message ?? ""}\n`,
          );
        }
      }
    }

    const { agentOutput, wallClockSeconds } = runAgent(spec, condition, task, artifactDir, workspaceDir);
    writeFileSync(join(artifactDir, "agent_output.txt"), agentOutput);

    const usage =
      spec.agent === "claude"
        ? parseClaudeJsonl(agentOutput, { model: spec.model, wallClockSeconds })
        : parseCodexJsonl(agentOutput, { model: spec.model, wallClockSeconds });

    const finalOutput =
      spec.agent === "claude"
        ? extractClaudeFinalOutput(agentOutput)
        : extractCodexFinalOutput(agentOutput);

    // A spend cap or auth failure produces a plausible-looking transcript that
    // grades as a task failure and silently poisons the comparison. Detect it
    // before spending a judge call on it.
    const infraError = detectInfraFailure(agentOutput, finalOutput);

    const gradeResult = infraError
      ? { task_success: false, details: `Infrastructure failure, not graded: ${infraError}` }
      : grade(task.grading, task.prompt, agentOutput, spec.agent, artifactDir);
    writeFileSync(join(artifactDir, "grade.json"), JSON.stringify(gradeResult, null, 2));

    const result: RunResult = {
      condition: spec.condition,
      task: spec.task,
      run: spec.run,
      model: spec.model,
      timestamp: new Date().toISOString(),
      usage,
      grade: gradeResult,
      agent_output: finalOutput.slice(0, 2000),
      ...(infraError ? { infra_error: infraError } : {}),
    };

    mkdirSync(RESULTS_DIR, { recursive: true });
    appendFileSync(join(RESULTS_DIR, "results.jsonl"), JSON.stringify(result) + "\n");

    return result;
  } finally {
    // The workspace holds only the instruction file plus whatever scratch the
    // agent wrote; artifacts worth keeping live one level up.
    if (existsSync(workspaceDir)) {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }
}

function runAgent(
  spec: RunSpec,
  condition: ConditionDef,
  task: TaskDef,
  artifactDir: string,
  workspaceDir: string,
): { agentOutput: string; wallClockSeconds: number } {
  // Every condition gets the same read-only session, so a mutation is blocked
  // at IAM no matter which interface the agent reaches for.
  const creds = getReadOnlyCredentials({ region: spec.region });
  const awsEnv = credentialEnv(creds, spec.region);

  // aws-axi is a bun program installed globally by npm; Homebrew's bin is not
  // always on a non-interactive PATH.
  const pathWithBrew = `/opt/homebrew/bin:${process.env.PATH ?? ""}`;
  const env = withCredentials(process.env, creds, spec.region, { PATH: pathWithBrew });

  let cmd: string[];

  if (spec.agent === "claude") {
    const mcpArgs: string[] = [];
    if (condition.mcp) {
      // The proxy signs requests with whatever credentials it inherits, so the
      // read-only session has to be threaded into the server's own env too.
      const mcpConfig = {
        mcpServers: {
          aws: {
            command: condition.mcp.command,
            args: condition.mcp.args,
            env: { ...awsEnv, PATH: pathWithBrew },
          },
        },
      };
      const mcpConfigPath = join(artifactDir, ".mcp-config.json");
      writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));
      mcpArgs.push("--mcp-config", mcpConfigPath);
      if (condition.disable_tool_search) {
        mcpArgs.push("--disallowedTools", "ToolSearch");
      }
    }

    cmd = [
      "claude",
      "--setting-sources", "''",
      "-p", JSON.stringify(task.prompt),
      "--model", spec.model,
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--allowedTools", "Bash", "Read", "Edit", "Glob", "Grep",
      ...mcpArgs,
    ];
  } else {
    cmd = [
      "codex", "exec", "--json",
      "--model", spec.model,
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "-C", workspaceDir,
      "--ephemeral",
      JSON.stringify(task.prompt),
    ];
  }

  const startTime = Date.now();
  let agentOutput = "";
  try {
    agentOutput = execSync(cmd.join(" "), {
      encoding: "utf-8",
      timeout: AGENT_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      env,
      cwd: workspaceDir,
    } as ExecSyncOptionsWithStringEncoding);
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string };
    agentOutput = execErr.stdout ?? "";
    if (execErr.stderr) writeFileSync(join(artifactDir, "stderr.txt"), execErr.stderr);
  }

  return { agentOutput, wallClockSeconds: (Date.now() - startTime) / 1000 };
}

/**
 * Signatures of a run that failed for reasons unrelated to the condition.
 *
 * These arrive as ordinary text on stdout rather than a non-zero exit, so
 * without this check a spend cap reads as "the agent answered incorrectly" and
 * quietly drags down whichever condition happened to be running at the time.
 */
const INFRA_FAILURE_PATTERNS: Array<[RegExp, string]> = [
  [/hit your (monthly |weekly |usage )?(spend )?limit/i, "agent API spend/usage limit reached"],
  [/credit balance is too low/i, "insufficient API credit"],
  [/invalid[ _]api[ _]key|authentication_error|OAuth token has expired/i, "agent API authentication failed"],
  [/rate[ _]limit(ed|_error)?/i, "agent API rate limited"],
  [/overloaded_error/i, "agent API overloaded"],
];

/** Classify a run as an infrastructure failure, or undefined if it looks like a genuine attempt. */
export function detectInfraFailure(
  rawOutput: string,
  finalOutput: string,
): string | undefined {
  if (!rawOutput.trim()) return "agent produced no output";

  // Only inspect the final answer. The raw stream can legitimately contain
  // these words — an agent reading CloudWatch data may well hit an AWS-side
  // "Rate exceeded", which is a real task condition, not a harness failure.
  for (const [pattern, label] of INFRA_FAILURE_PATTERNS) {
    if (pattern.test(finalOutput)) return label;
  }

  // A stream that never produced a parseable event is a crash, not an answer.
  const hasStructuredEvent = rawOutput
    .split("\n")
    .some((line) => {
      if (!line.trim()) return false;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        return typeof entry.type === "string";
      } catch {
        return false;
      }
    });
  if (!hasStructuredEvent) return "agent emitted no structured events (likely crashed on startup)";

  return undefined;
}

/** Extract the agent's final text output from Claude stream-json output. */
function extractClaudeFinalOutput(jsonl: string): string {
  const parts: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.type === "result" && typeof entry.result === "string") {
        return entry.result;
      }
      if (entry.type === "assistant") {
        const msg = entry.message as Record<string, unknown> | undefined;
        if (msg && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
          }
        }
      }
    } catch {
      continue;
    }
  }
  return parts.length > 0 ? parts.join("\n") : jsonl;
}

/** Extract the agent's final text output from Codex JSONL output. */
function extractCodexFinalOutput(jsonl: string): string {
  const parts: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.type === "message" || entry.type === "response") {
        const content = entry.content ?? entry.text ?? "";
        if (typeof content === "string" && content) parts.push(content);
      }
      if (entry.type === "item.completed") {
        const item = (entry.item ?? {}) as Record<string, unknown>;
        if (item.type === "message" && typeof item.text === "string") parts.push(item.text);
      }
    } catch {
      continue;
    }
  }
  return parts.length > 0 ? parts.join("\n") : jsonl;
}

/** Exposed so the CLI can surface a clear error when a required tool is absent. */
export function checkToolAvailable(bin: string): boolean {
  try {
    execFileSync("which", [bin], {
      stdio: "pipe",
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}` },
    });
    return true;
  } catch {
    return false;
  }
}
