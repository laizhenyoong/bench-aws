#!/usr/bin/env tsx
/** CLI entry point: preflight, run, matrix, report. See `main()` for usage. */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentBackend, ConditionDef, ConditionId, TaskDef } from "./types.js";
import { runOne, checkToolAvailable } from "./runner.js";
import { writeReports } from "./reporter.js";
import { getReadOnlyCredentials, assertReadOnly } from "./credentials.js";

const BENCH_ROOT = resolve(import.meta.dirname, "..");
const CONFIG_DIR = join(BENCH_ROOT, "config");
const DEFAULT_REGION = process.env.AWS_REGION ?? "ap-southeast-1";

function loadConditions(): Map<string, ConditionDef> {
  const raw = readFileSync(join(CONFIG_DIR, "conditions.yaml"), "utf-8");
  const doc = parseYaml(raw) as { conditions: Record<string, Omit<ConditionDef, "id">> };
  const map = new Map<string, ConditionDef>();
  for (const [id, def] of Object.entries(doc.conditions)) {
    map.set(id, { ...def, id: id as ConditionId });
  }
  return map;
}

/**
 * Load task prompts, then merge in account-specific grading hints.
 *
 * Prompts are committed; hints live in a gitignored local file because they
 * encode real resource names and counts from the target AWS account.
 */
function loadTasks(): Map<string, TaskDef> {
  const raw = readFileSync(join(CONFIG_DIR, "tasks.yaml"), "utf-8");
  const doc = parseYaml(raw) as {
    tasks: Record<string, { category: TaskDef["category"]; prompt: string }>;
  };

  let hints: Record<string, string> = {};
  const hintsPath = join(CONFIG_DIR, "hints.yaml");
  if (existsSync(hintsPath)) {
    const hintsDoc = parseYaml(readFileSync(hintsPath, "utf-8")) as {
      hints?: Record<string, string>;
    };
    hints = hintsDoc?.hints ?? {};
  } else {
    console.warn(
      "Warning: config/hints.yaml not found. The judge will grade without " +
        "account ground truth, which makes counts effectively ungradeable.\n" +
        "         Copy config/hints.example.yaml and fill it in for your account.",
    );
  }

  const map = new Map<string, TaskDef>();
  for (const [id, def] of Object.entries(doc.tasks)) {
    map.set(id, {
      id,
      category: def.category,
      prompt: def.prompt,
      grading: { grading_hint: hints[id] },
    });
  }
  return map;
}

/** Drop previous results for the given conditions, keeping the others. */
function clearResults(conditionIds: string[]): void {
  const resultsDir = join(BENCH_ROOT, "results");
  const resultsPath = join(resultsDir, "results.jsonl");
  mkdirSync(resultsDir, { recursive: true });
  if (!existsSync(resultsPath)) {
    writeFileSync(resultsPath, "");
    return;
  }
  try {
    const kept = readFileSync(resultsPath, "utf-8")
      .split("\n")
      .filter((l) => {
        if (!l.trim()) return false;
        return !conditionIds.includes(JSON.parse(l).condition);
      })
      .join("\n");
    writeFileSync(resultsPath, kept ? kept + "\n" : "");
  } catch {
    writeFileSync(resultsPath, "");
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
    args[key] = val;
    if (val !== "true") i++;
  }
  return args;
}

/** Tools each condition needs on PATH before it can run. */
const REQUIRED_TOOLS: Record<string, string[]> = {
  cli: ["aws"],
  axi: ["aws-axi", "bun"],
  "mcp-with-toolsearch": ["uvx"],
  "mcp-no-toolsearch": ["uvx"],
};

function cmdPreflight(argv: string[]): void {
  const args = parseArgs(argv);
  const region = args.region ?? DEFAULT_REGION;
  let failures = 0;

  console.log("=== Tooling ===");
  const conditions = loadConditions();
  for (const [condId] of conditions) {
    const tools = REQUIRED_TOOLS[condId] ?? [];
    const missing = tools.filter((t) => !checkToolAvailable(t));
    if (missing.length > 0) {
      console.log(`  ✗ ${condId}: missing ${missing.join(", ")}`);
      failures++;
    } else {
      console.log(`  ✓ ${condId}: ${tools.join(", ")}`);
    }
  }
  for (const agentBin of ["claude"]) {
    if (checkToolAvailable(agentBin)) console.log(`  ✓ agent: ${agentBin}`);
    else {
      console.log(`  ✗ agent: ${agentBin} not found`);
      failures++;
    }
  }

  console.log("\n=== Credentials ===");
  try {
    const creds = getReadOnlyCredentials({ force: true, region });
    console.log(`  ✓ minted read-only session: ${creds.arn}`);
    console.log(`    expires ${new Date(creds.expiresAt).toISOString()}`);
    assertReadOnly(creds, region);
    console.log("  ✓ reads succeed, mutations denied (ec2:CreateKeyPair → UnauthorizedOperation)");
  } catch (err) {
    console.log(`  ✗ ${(err as Error).message}`);
    failures++;
  }

  console.log("\n=== Grading hints ===");
  const hintsPath = join(CONFIG_DIR, "hints.yaml");
  if (existsSync(hintsPath)) {
    const tasks = loadTasks();
    const missing = [...tasks.values()].filter((t) => !t.grading.grading_hint);
    if (missing.length > 0) {
      console.log(`  ! ${missing.length} task(s) have no hint: ${missing.map((t) => t.id).join(", ")}`);
    } else {
      console.log(`  ✓ all ${tasks.size} tasks have grading hints`);
    }
  } else {
    console.log("  ✗ config/hints.yaml missing — run `npm run bench -- capture-facts`");
    failures++;
  }

  console.log(
    failures === 0
      ? "\nPreflight passed.\n"
      : `\nPreflight found ${failures} problem(s).\n`,
  );
  if (failures > 0) process.exit(1);
}

function cmdRun(argv: string[]): void {
  const args = parseArgs(argv);
  const conditionId = args.condition;
  const taskId = args.task;
  const repeat = parseInt(args.repeat ?? "1", 10);
  const agent = (args.agent ?? "claude") as AgentBackend;
  const model = args.model ?? (agent === "claude" ? "claude-sonnet-5" : "gpt-5.4");
  const region = args.region ?? DEFAULT_REGION;

  if (!conditionId || !taskId) {
    console.error(
      "Usage: bench run --condition <id> --task <id> [--repeat N] [--model M] [--region R]",
    );
    process.exit(1);
  }

  const conditions = loadConditions();
  const tasks = loadTasks();

  const condition = conditions.get(conditionId);
  if (!condition) {
    console.error(`Unknown condition: ${conditionId}. Available: ${[...conditions.keys()].join(", ")}`);
    process.exit(1);
  }
  const task = tasks.get(taskId);
  if (!task) {
    console.error(`Unknown task: ${taskId}. Available: ${[...tasks.keys()].join(", ")}`);
    process.exit(1);
  }

  clearResults([conditionId]);

  for (let r = 1; r <= repeat; r++) {
    console.log(`\n=== Run ${r}/${repeat}: ${conditionId} × ${taskId} ===\n`);
    const result = runOne(
      { condition: conditionId as ConditionId, task: taskId, run: r, model, agent, region },
      condition,
      task,
    );
    console.log(`  Success: ${result.grade.task_success}`);
    console.log(`  Turns: ${result.usage.turn_count}, Tool calls: ${result.usage.command_count}`);
    console.log(`  Input tokens: ${result.usage.input_tokens} (cached: ${result.usage.input_tokens_cached})`);
    console.log(`  Cost: $${result.usage.total_cost_usd.toFixed(4)}`);
    console.log(`  Time: ${result.usage.wall_clock_seconds.toFixed(1)}s`);
    if (result.infra_error) {
      console.log(`  ⚠️  ${result.infra_error} — not a task failure; re-run this one.`);
    } else if (!result.grade.task_success) {
      console.log(`  Reason: ${result.grade.details}`);
    }
  }
}

async function cmdMatrix(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const repeat = parseInt(args.repeat ?? "1", 10);
  const agent = (args.agent ?? "claude") as AgentBackend;
  const model = args.model ?? (agent === "claude" ? "claude-sonnet-5" : "gpt-5.4");
  const region = args.region ?? DEFAULT_REGION;

  const conditions = loadConditions();
  const tasks = loadTasks();

  const conditionIds = args.condition ? args.condition.split(",") : [...conditions.keys()];
  let taskIds = args.task ? args.task.split(",") : [...tasks.keys()];
  if (args.category) {
    taskIds = taskIds.filter((id) => tasks.get(id)?.category === args.category);
  }

  clearResults(conditionIds);

  const total = conditionIds.length * taskIds.length * repeat;
  const parallel = args.parallel === "true";

  if (parallel && conditionIds.length > 1) {
    console.log(`Running ${conditionIds.length} conditions in parallel (${total} total runs)...`);
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const childArgs = [
      "--agent", agent,
      "--repeat", String(repeat),
      "--model", model,
      "--region", region,
      ...(args.task ? ["--task", args.task] : []),
      ...(args.category ? ["--category", args.category] : []),
    ];
    await Promise.all(
      conditionIds.map(async (condId) => {
        console.log(`  Starting condition: ${condId}`);
        try {
          const res = await execFileAsync(
            "npx",
            ["tsx", "src/cli.ts", "matrix", "--condition", condId, ...childArgs],
            { cwd: BENCH_ROOT, maxBuffer: 64 * 1024 * 1024, timeout: 0, env: process.env },
          );
          console.log(res.stdout);
          if (res.stderr) console.error(res.stderr);
        } catch (err: any) {
          console.log(err.stdout ?? "");
          console.error(err.stderr ?? err.message);
        }
      }),
    );
  } else {
    for (const condId of conditionIds) {
      const condition = conditions.get(condId);
      if (!condition) {
        console.error(`Skipping unknown condition: ${condId}`);
        continue;
      }
      let done = 0;
      const condTotal = taskIds.length * repeat;
      for (const taskId of taskIds) {
        const task = tasks.get(taskId);
        if (!task) {
          console.error(`Skipping unknown task: ${taskId}`);
          continue;
        }
        for (let r = 1; r <= repeat; r++) {
          done++;
          console.log(`\n[${condId} ${done}/${condTotal}] ${taskId} (run ${r})`);
          const result = runOne(
            { condition: condId as ConditionId, task: taskId, run: r, model, agent, region },
            condition,
            task,
          );
          const status = result.infra_error
            ? "ERROR"
            : result.grade.task_success
              ? "PASS"
              : "FAIL";
          console.log(
            `  ${status} | ${result.usage.turn_count} turns | $${result.usage.total_cost_usd.toFixed(4)} | ${result.usage.wall_clock_seconds.toFixed(1)}s`,
          );
          if (result.infra_error) {
            console.log(`  ⚠️  ${result.infra_error} — not a task failure; re-run this one.`);
          }
        }
      }
    }
  }

  console.log(`\nMatrix complete: ${total} runs.`);
  writeReports();
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "preflight":
      return cmdPreflight(rest);
    case "run":
      return cmdRun(rest);
    case "matrix":
      return cmdMatrix(rest);
    case "report":
      return writeReports();
    default:
      console.log(`bench-aws — aws CLI vs aws-axi vs AWS MCP server

Commands:
  preflight   Verify tooling, credentials, and read-only enforcement
                --region <r>   (default: ${DEFAULT_REGION})

  run         Run a single benchmark
                --condition <cli|axi|mcp-with-toolsearch|mcp-no-toolsearch>
                --task <task_id>
                --repeat <N>   (default: 1)
                --model <M>    (default: claude-sonnet-5)
                --region <r>   (default: ${DEFAULT_REGION})

  matrix      Run all condition × task combinations
                --repeat <N>            (default: 1)
                --model <M>             (default: claude-sonnet-5)
                --condition <id,id,...> (filter conditions)
                --task <id,id,...>      (filter tasks)
                --category <single_step|multi_step|investigation|error_recovery>
                --parallel              Run conditions in parallel

  report      Regenerate the summary from results.jsonl
`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
