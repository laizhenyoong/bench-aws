import { describe, it, expect } from "vitest";
import { detectInfraFailure } from "../src/runner.js";
import { summarize, markdownReport } from "../src/reporter.js";
import type { RunResult } from "../src/types.js";

function streamWith(finalText: string): string {
  return [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "result", subtype: "success", result: finalText }),
  ].join("\n");
}

describe("detectInfraFailure", () => {
  it("flags a spend-limit message that would otherwise grade as a wrong answer", () => {
    const text =
      "You've hit your monthly spend limit · raise it at claude.ai/settings/usage";
    expect(detectInfraFailure(streamWith(text), text)).toMatch(/spend\/usage limit/);
  });

  it("flags auth failures", () => {
    const text = "Invalid API key · please run /login";
    expect(detectInfraFailure(streamWith(text), text)).toMatch(/authentication/);
  });

  it("flags low credit balance", () => {
    const text = "Your credit balance is too low to access the API.";
    expect(detectInfraFailure(streamWith(text), text)).toMatch(/credit/);
  });

  it("flags an empty run", () => {
    expect(detectInfraFailure("", "")).toMatch(/no output/);
    expect(detectInfraFailure("   \n ", "")).toMatch(/no output/);
  });

  it("flags a stream with no parseable events as a crash", () => {
    expect(detectInfraFailure("Traceback: command not found", "")).toMatch(/no structured events/);
  });

  it("does not flag a normal successful answer", () => {
    const text = "**157 Lambda functions** are deployed in the default region.";
    expect(detectInfraFailure(streamWith(text), text)).toBeUndefined();
  });

  it("does not flag an AWS-side throttle the agent legitimately encountered", () => {
    const raw = [
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", content: "An error occurred (Throttling): Rate exceeded" }],
        },
      }),
      JSON.stringify({
        type: "result",
        result: "CloudWatch throttled the request, so I retried with backoff and got 745 log groups.",
      }),
    ].join("\n");
    const final = "CloudWatch throttled the request, so I retried with backoff and got 745 log groups.";

    expect(detectInfraFailure(raw, final)).toBeUndefined();
  });
});

function run(overrides: Partial<RunResult>): RunResult {
  return {
    condition: "cli",
    task: "count_buckets",
    run: 1,
    model: "claude-sonnet-5",
    timestamp: "2026-07-30T00:00:00.000Z",
    usage: {
      input_tokens: 1000,
      input_tokens_cached: 0,
      input_tokens_uncached: 1000,
      output_tokens: 100,
      reasoning_tokens: 0,
      total_cost_usd: 0.01,
      wall_clock_seconds: 10,
      turn_count: 2,
      command_count: 1,
      error_count: 0,
      command_log: [],
    },
    grade: { task_success: true, details: "ok" },
    agent_output: "266",
    ...overrides,
  };
}

describe("reporter treatment of infrastructure failures", () => {
  it("excludes them from the success rate instead of counting them as failures", () => {
    const results: RunResult[] = [
      run({ run: 1, grade: { task_success: true, details: "ok" } }),
      run({ run: 2, grade: { task_success: true, details: "ok" } }),
      run({
        run: 3,
        grade: { task_success: false, details: "Infrastructure failure, not graded: spend limit" },
        infra_error: "agent API spend/usage limit reached",
      }),
    ];

    const [summary] = summarize(results);
    expect(summary.total_tasks).toBe(3);
    expect(summary.infra_errors).toBe(1);
    // 2 of 2 graded, not 2 of 3.
    expect(summary.success_rate).toBe(1);
  });

  it("still counts genuine task failures against the rate", () => {
    const results: RunResult[] = [
      run({ run: 1, grade: { task_success: true, details: "ok" } }),
      run({ run: 2, grade: { task_success: false, details: "reported page size" } }),
    ];

    const [summary] = summarize(results);
    expect(summary.infra_errors).toBe(0);
    expect(summary.success_rate).toBe(0.5);
  });

  it("warns loudly in the report so excluded runs are not overlooked", () => {
    const md = markdownReport([
      run({ run: 1 }),
      run({ run: 2, infra_error: "agent API spend/usage limit reached" }),
    ]);

    expect(md).toContain("excluded from Success%");
    expect(md).toContain("agent API spend/usage limit reached");
  });

  it("reports a 0% rate rather than dividing by zero when every run errored", () => {
    const [summary] = summarize([run({ run: 1, infra_error: "auth failed" })]);
    expect(summary.success_rate).toBe(0);
    expect(summary.infra_errors).toBe(1);
  });
});
