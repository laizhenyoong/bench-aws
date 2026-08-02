/** Aggregate results.jsonl into summary tables (markdown + CSV). */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunResult, ConditionId, ConditionSummary } from "./types.js";

const BENCH_ROOT = resolve(import.meta.dirname, "..");
const RESULTS_DIR = join(BENCH_ROOT, "results");

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

function loadResults(): RunResult[] {
  try {
    return readFileSync(join(RESULTS_DIR, "results.jsonl"), "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as RunResult);
  } catch {
    return [];
  }
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(item);
  }
  return map;
}

export function summarize(results?: RunResult[]): ConditionSummary[] {
  const all = results ?? loadResults();
  if (all.length === 0) return [];

  const summaries: ConditionSummary[] = [];
  for (const [condId, runs] of groupBy(all, (r) => r.condition)) {
    // Runs that died on a spend cap or auth error say nothing about the
    // condition, so they are reported but kept out of the success rate.
    const graded = runs.filter((r) => !r.infra_error);
    const successes = graded.filter((r) => r.grade.task_success).length;
    summaries.push({
      condition: condId as ConditionId,
      name: condId,
      total_tasks: runs.length,
      infra_errors: runs.length - graded.length,
      success_rate: graded.length > 0 ? successes / graded.length : 0,
      avg_input_tokens: Math.round(mean(runs.map((r) => r.usage.input_tokens))),
      avg_cached_pct: mean(
        runs.map((r) =>
          r.usage.input_tokens > 0 ? r.usage.input_tokens_cached / r.usage.input_tokens : 0,
        ),
      ),
      avg_output_tokens: Math.round(mean(runs.map((r) => r.usage.output_tokens))),
      avg_cost_usd: mean(runs.map((r) => r.usage.total_cost_usd)),
      total_cost_usd: sum(runs.map((r) => r.usage.total_cost_usd)),
      avg_duration_seconds: mean(runs.map((r) => r.usage.wall_clock_seconds)),
      avg_turns: Math.round(mean(runs.map((r) => r.usage.turn_count))),
    });
  }

  // Best-performing condition first: success rate desc, then cost asc.
  summaries.sort(
    (a, b) => b.success_rate - a.success_rate || a.avg_cost_usd - b.avg_cost_usd,
  );
  return summaries;
}

export function markdownReport(results?: RunResult[]): string {
  const all = results ?? loadResults();
  if (all.length === 0) return "No results found.\n";

  const lines: string[] = [];
  lines.push("# bench-aws Results\n");
  lines.push("## Summary\n");
  lines.push(
    "| Condition | Runs | Graded | Success% | Avg Input Tokens | Cache% | Avg Output Tokens | Avg Cost | Total Cost | Avg Duration | Avg Turns |",
  );
  lines.push(
    "|-----------|------|--------|----------|------------------|--------|-------------------|----------|------------|--------------|-----------|",
  );

  const summaries = summarize(all);
  for (const s of summaries) {
    const graded = s.total_tasks - s.infra_errors;
    lines.push(
      `| ${s.condition} | ${s.total_tasks} | ${graded} | ${(s.success_rate * 100).toFixed(0)}% | ${s.avg_input_tokens} | ${(s.avg_cached_pct * 100).toFixed(0)}% | ${s.avg_output_tokens} | $${s.avg_cost_usd.toFixed(4)} | $${s.total_cost_usd.toFixed(2)} | ${s.avg_duration_seconds.toFixed(1)}s | ${s.avg_turns} |`,
    );
  }

  const totalInfra = summaries.reduce((n, s) => n + s.infra_errors, 0);
  if (totalInfra > 0) {
    lines.push(
      `\n> ⚠️  ${totalInfra} run(s) excluded from Success% — they failed for infrastructure reasons ` +
        "(spend limit, auth, rate limit), not because the condition got the task wrong. " +
        "Re-run those before drawing conclusions.\n",
    );
    for (const r of all.filter((x) => x.infra_error)) {
      lines.push(`> - \`${r.condition}\` × \`${r.task}\` run ${r.run}: ${r.infra_error}`);
    }
    lines.push("");
  }

  lines.push("\n## Per-Task Breakdown\n");
  for (const [taskId, taskRuns] of groupBy(all, (r) => r.task)) {
    lines.push(`### ${taskId}\n`);
    lines.push(
      "| Condition | Avg Input Tokens | Cache% | Avg Output Tokens | Avg Cost | Avg Duration | Avg Turns | Success |",
    );
    lines.push(
      "|-----------|------------------|--------|-------------------|----------|--------------|-----------|---------|",
    );
    for (const [cond, condRuns] of groupBy(taskRuns, (r) => r.condition)) {
      const suc = condRuns.filter((r) => r.grade.task_success).length;
      const avgCachePct = mean(
        condRuns.map((r) =>
          r.usage.input_tokens > 0 ? r.usage.input_tokens_cached / r.usage.input_tokens : 0,
        ),
      );
      lines.push(
        `| ${cond} | ${Math.round(mean(condRuns.map((r) => r.usage.input_tokens)))} | ${(avgCachePct * 100).toFixed(0)}% | ${Math.round(mean(condRuns.map((r) => r.usage.output_tokens)))} | $${mean(condRuns.map((r) => r.usage.total_cost_usd)).toFixed(4)} | ${mean(condRuns.map((r) => r.usage.wall_clock_seconds)).toFixed(1)}s | ${Math.round(mean(condRuns.map((r) => r.usage.turn_count)))} | ${suc}/${condRuns.length} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

export function csvReport(results?: RunResult[]): string {
  const all = results ?? loadResults();
  if (all.length === 0) return "";

  const headers = [
    "condition", "task", "run", "model", "timestamp",
    "success", "infra_error", "input_tokens", "input_tokens_cached", "output_tokens",
    "reasoning_tokens", "total_cost_usd", "wall_clock_seconds",
    "turn_count", "command_count", "error_count",
  ];
  const lines = [headers.join(",")];

  for (const r of all) {
    lines.push(
      [
        r.condition, r.task, r.run, r.model, r.timestamp,
        r.grade.task_success, JSON.stringify(r.infra_error ?? ""),
        r.usage.input_tokens, r.usage.input_tokens_cached,
        r.usage.output_tokens, r.usage.reasoning_tokens, r.usage.total_cost_usd,
        r.usage.wall_clock_seconds, r.usage.turn_count, r.usage.command_count,
        r.usage.error_count,
      ].join(","),
    );
  }

  return lines.join("\n") + "\n";
}

export function writeReports(): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const md = markdownReport();
  writeFileSync(join(RESULTS_DIR, "report.md"), md);
  writeFileSync(join(RESULTS_DIR, "report.csv"), csvReport());
  console.log(md);
  console.log("Reports written to results/report.md and results/report.csv");
}
