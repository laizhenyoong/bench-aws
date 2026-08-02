import { describe, it, expect } from "vitest";
import { parseClaudeJsonl, parseCodexJsonl, getClaudePricing } from "../src/usage.js";

function claudeResult(usage: Record<string, number>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    num_turns: 3,
    duration_ms: 12500,
    usage,
    ...extra,
  });
}

describe("parseClaudeJsonl", () => {
  it("sums base, cache-creation, and cache-read tokens into total input", () => {
    const jsonl = claudeResult({
      input_tokens: 1000,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 4000,
      output_tokens: 300,
    });

    const u = parseClaudeJsonl(jsonl, { model: "claude-sonnet-5" });
    expect(u.input_tokens).toBe(5500);
    expect(u.input_tokens_cached).toBe(4000);
    expect(u.input_tokens_uncached).toBe(1500);
    expect(u.output_tokens).toBe(300);
  });

  it("prefers the CLI-reported cost over computing from tokens", () => {
    const jsonl = claudeResult(
      { input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 100 },
      { total_cost_usd: 0.0421 },
    );

    expect(parseClaudeJsonl(jsonl, { model: "claude-sonnet-5" }).total_cost_usd).toBe(0.0421);
  });

  it("computes cost from tokens when the result event carries no cost", () => {
    const jsonl = claudeResult({
      input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1_000_000,
    });

    // Sonnet 5: $3/1M input + $15/1M output.
    const u = parseClaudeJsonl(jsonl, { model: "claude-sonnet-5" });
    expect(u.total_cost_usd).toBeCloseTo(18.0, 5);
  });

  it("prices cache reads at 0.1x and cache writes at 1.25x base input", () => {
    const jsonl = claudeResult({
      input_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      output_tokens: 0,
    });

    // Opus 5 base input $5/1M → write 6.25 + read 0.5 = 6.75
    const u = parseClaudeJsonl(jsonl, { model: "claude-opus-5" });
    expect(u.total_cost_usd).toBeCloseTo(6.75, 5);
  });

  it("counts tool calls and logs shell commands", () => {
    const jsonl = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "aws s3api list-buckets" } },
            { type: "tool_use", name: "Bash", input: { command: "aws ec2 describe-instances" } },
          ],
        },
      }),
      claudeResult({ input_tokens: 10, output_tokens: 5 }),
    ].join("\n");

    const u = parseClaudeJsonl(jsonl, { model: "claude-sonnet-5" });
    expect(u.command_count).toBe(2);
    expect(u.command_log).toEqual([
      "aws s3api list-buckets",
      "aws ec2 describe-instances",
    ]);
  });

  it("records MCP tool calls that carry no shell command", () => {
    const jsonl = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "mcp__aws__aws___call_aws",
            input: { cli_command: "aws lambda list-functions" },
          },
        ],
      },
    });

    const u = parseClaudeJsonl(jsonl);
    expect(u.command_count).toBe(1);
    expect(u.command_log[0]).toContain("mcp__aws__aws___call_aws");
  });

  it("counts errored tool results", () => {
    const jsonl = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", is_error: true, content: "AccessDenied" },
          { type: "tool_result", content: "fine" },
        ],
      },
    });

    expect(parseClaudeJsonl(jsonl).error_count).toBe(1);
  });

  it("prefers externally measured wall clock over duration_ms", () => {
    const jsonl = claudeResult({ input_tokens: 1, output_tokens: 1 });
    expect(parseClaudeJsonl(jsonl, { wallClockSeconds: 42 }).wall_clock_seconds).toBe(42);
    expect(parseClaudeJsonl(jsonl).wall_clock_seconds).toBe(12.5);
  });

  it("returns zeroed metrics for empty or malformed output", () => {
    const u = parseClaudeJsonl("not json\n\n");
    expect(u.input_tokens).toBe(0);
    expect(u.total_cost_usd).toBe(0);
    expect(u.command_count).toBe(0);
  });
});

describe("parseCodexJsonl", () => {
  it("accumulates usage across turns", () => {
    const jsonl = [
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 100, output_tokens: 50, reasoning_tokens: 20 },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 200, output_tokens: 60, reasoning_tokens: 10 },
      }),
    ].join("\n");

    const u = parseCodexJsonl(jsonl);
    expect(u.turn_count).toBe(2);
    expect(u.input_tokens).toBe(300);
    expect(u.output_tokens).toBe(110);
    expect(u.reasoning_tokens).toBe(30);
  });

  it("reads cached tokens from either the flat or nested field", () => {
    const flat = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 100, cached_input_tokens: 40 },
    });
    const nested = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 } },
    });

    expect(parseCodexJsonl(flat).input_tokens_cached).toBe(40);
    expect(parseCodexJsonl(nested).input_tokens_cached).toBe(40);
  });

  it("counts non-zero exit codes as errors", () => {
    const jsonl = [
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "aws s3 ls", exit_code: 0 },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "aws ec2 describe-x", exit_code: 254 },
      }),
    ].join("\n");

    const u = parseCodexJsonl(jsonl);
    expect(u.command_count).toBe(2);
    expect(u.error_count).toBe(1);
  });
});

describe("getClaudePricing", () => {
  it("knows the current Claude 5 family", () => {
    expect(getClaudePricing("claude-opus-5")).toEqual({ input: 5e-6, output: 25e-6 });
    expect(getClaudePricing("claude-sonnet-5")).toEqual({ input: 3e-6, output: 15e-6 });
    expect(getClaudePricing("claude-haiku-4-5")).toEqual({ input: 1e-6, output: 5e-6 });
  });

  it("returns undefined for an unknown model rather than guessing", () => {
    expect(getClaudePricing("claude-imaginary-9")).toBeUndefined();
  });
});
