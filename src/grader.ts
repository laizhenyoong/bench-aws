/**
 * LLM-as-judge grading. A separate LLM call reads the agent's full trajectory —
 * commands, tool calls, outputs, prose — and decides pass/fail.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { AgentBackend, GradingSpec, GradeResult } from "./types.js";

const CLAUDE_JUDGE_MODEL = "claude-sonnet-5";
const CODEX_JUDGE_MODEL = "gpt-5.4-mini";

/** Cap on how much of any single tool output the judge sees. */
const MAX_OUTPUT_CHARS = 6000;

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
}

/** Format raw JSONL from the agent run into a readable trajectory transcript. */
export function formatTrajectory(jsonl: string): string {
  const parts: string[] = [];

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    // ── Codex ────────────────────────────────────────────────────────────
    if (entry.type === "item.completed") {
      const item = (entry.item ?? {}) as Record<string, unknown>;
      if (item.type === "command_execution") {
        parts.push(`COMMAND: ${item.command ?? "(unknown)"}`);
        const output = item.aggregated_output ?? item.output;
        if (output != null) parts.push(`OUTPUT: ${truncate(String(output))}`);
        parts.push(`EXIT_CODE: ${item.exit_code ?? 0}`);
        parts.push("");
      }
      if (
        (item.type === "message" || item.type === "agent_message") &&
        typeof item.text === "string"
      ) {
        parts.push(`AGENT: ${item.text}`, "");
      }
    }

    if (entry.type === "message" || entry.type === "response") {
      const content = entry.content ?? entry.text ?? "";
      if (typeof content === "string" && content) {
        parts.push(`AGENT: ${content}`, "");
      }
    }

    // ── Claude ───────────────────────────────────────────────────────────
    if (entry.type === "assistant") {
      const msg = (entry.message ?? {}) as Record<string, unknown>;
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            parts.push(`AGENT: ${block.text}`, "");
          }
          if (block.type === "tool_use") {
            const input = (block.input ?? {}) as Record<string, unknown>;
            if (typeof input.command === "string") {
              parts.push(`COMMAND: ${input.command}`);
            } else {
              parts.push(`TOOL_CALL: ${String(block.name)}(${JSON.stringify(input)})`);
            }
          }
        }
      }
    }

    if (entry.type === "user") {
      const msg = (entry.message ?? {}) as Record<string, unknown>;
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const label = block.is_error === true ? "OUTPUT (error)" : "OUTPUT";
          if (typeof block.content === "string") {
            parts.push(`${label}: ${truncate(block.content)}`);
          } else if (Array.isArray(block.content)) {
            // MCP tool results arrive as an array of {type, text} objects.
            const text = (block.content as Array<Record<string, unknown>>)
              .map((c) => (typeof c.text === "string" ? c.text : JSON.stringify(c)))
              .join("\n");
            parts.push(`${label}: ${truncate(text)}`);
          }
          parts.push("");
        }
      }
    }

    if (entry.type === "result" && typeof entry.result === "string") {
      parts.push(`AGENT: ${entry.result}`, "");
    }
  }

  return parts.join("\n").trim() || "(empty trajectory)";
}

/** Build the grading prompt for the LLM judge. */
export function buildGradingPrompt(
  taskPrompt: string,
  trajectory: string,
  gradingHint?: string,
): string {
  const hintSection = gradingHint ? `\nKNOWN FACTS: ${gradingHint}\n` : "";

  return `You are a benchmark grader evaluating whether an AI agent completed a task against a live AWS account.

TASK: ${taskPrompt}
${hintSection}
AGENT TRAJECTORY:
${trajectory}

Rules:
- PASS if the agent ran appropriate commands or tool calls AND produced a correct, complete answer
- FAIL if the agent produced numbers or resource names without running anything to obtain them
- FAIL if the agent ran commands but misread the results
- FAIL if the agent gave a partial answer when a complete one was requested
- FAIL if the agent reported the size of a single page as though it were a total. AWS list APIs paginate; a count that happens to equal a round page size (50, 100, 1000) is a strong signal the agent stopped at page one
- Counts drift as the account changes. Treat a count within about 5% of the known figure as correct unless the task demands exactness
- For error-recovery tasks, PASS if the agent correctly identified and reported the error

Respond with exactly: {"pass": true, "reason": "..."} or {"pass": false, "reason": "..."}`;
}

/**
 * Grade the agent's run by invoking a separate LLM as judge.
 *
 * @param spec - Grading spec, optionally carrying account-specific ground truth
 * @param taskPrompt - The original task prompt given to the agent
 * @param rawJsonl - Raw JSONL output from the agent run
 */
export function grade(
  spec: GradingSpec,
  taskPrompt: string,
  rawJsonl: string,
  judgeBackend: AgentBackend = "claude",
  artifactDir?: string,
): GradeResult {
  const trajectory = formatTrajectory(rawJsonl);
  const prompt = buildGradingPrompt(taskPrompt, trajectory, spec.grading_hint);

  let judgeOutput: string;
  try {
    const { cmd, args } =
      judgeBackend === "claude"
        ? {
            cmd: "claude",
            args: [
              "--setting-sources", "",
              "-p", prompt,
              "--model", CLAUDE_JUDGE_MODEL,
              "--output-format", "text",
              "--max-turns", "1",
              "--dangerously-skip-permissions",
              "--no-session-persistence",
            ],
          }
        : {
            cmd: "codex",
            args: ["exec", "--json", "--model", CODEX_JUDGE_MODEL, "--ephemeral", prompt],
          };

    judgeOutput = execFileSync(cmd, args, {
      encoding: "utf-8",
      timeout: 120 * 1000,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string };
    judgeOutput = execErr.stdout ?? "";
    if (!judgeOutput) {
      return {
        task_success: false,
        details: `Judge process failed: ${execErr.stderr ?? "unknown error"}`,
      };
    }
  }

  if (artifactDir) {
    const judgeModel = judgeBackend === "claude" ? CLAUDE_JUDGE_MODEL : CODEX_JUDGE_MODEL;
    writeFileSync(`${artifactDir}/judge_output.txt`, judgeOutput);
    writeFileSync(`${artifactDir}/judge_model.txt`, judgeModel);
  }

  const verdict = extractVerdict(judgeOutput);
  if (!verdict) {
    return {
      task_success: false,
      details: `Could not parse judge verdict from output: ${judgeOutput.slice(0, 500)}`,
    };
  }

  return { task_success: verdict.pass, details: verdict.reason };
}

interface JudgeVerdict {
  pass: boolean;
  reason: string;
}

/**
 * Extract {"pass": bool, "reason": "..."} from the judge's output.
 * Handles raw text, fenced JSON, and JSONL-wrapped responses.
 */
function extractVerdict(output: string): JudgeVerdict | null {
  const stripped = output.replace(/```json\s*/g, "").replace(/```\s*/g, "");

  try {
    const direct = JSON.parse(stripped.trim()) as JudgeVerdict;
    if (typeof direct.pass === "boolean") {
      return { pass: direct.pass, reason: direct.reason ?? "" };
    }
  } catch {
    // fall through
  }

  const match =
    stripped.match(/\{\s*"pass"\s*:\s*(true|false)\s*,\s*"reason"\s*:\s*".*?"\s*\}/s) ??
    stripped.match(/\{\s*"reason"\s*:\s*".*?"\s*,\s*"pass"\s*:\s*(true|false)\s*\}/s);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as JudgeVerdict;
      if (typeof parsed.pass === "boolean") {
        return { pass: parsed.pass, reason: parsed.reason ?? "" };
      }
    } catch {
      // fall through
    }
  }

  for (const line of stripped.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (entry.type === "item.completed") {
        const item = (entry.item ?? {}) as Record<string, unknown>;
        if (typeof item.text === "string") {
          const nested = extractVerdict(item.text);
          if (nested) return nested;
        }
      }
      for (const field of ["content", "text", "result"]) {
        if (typeof entry[field] === "string") {
          const nested = extractVerdict(entry[field] as string);
          if (nested) return nested;
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}
