/** Parse agent CLI JSONL output (Claude stream-json, Codex --json) into usage metrics. */

import type { UsageMetrics } from "./types.js";

/** Per-model pricing in USD per 1M tokens. Cache read/write rates are derived below. */
interface ModelPricing {
  input: number; // $/1M uncached input tokens
  output: number; // $/1M output tokens
}

const CLAUDE_PRICING_PER_1M: Record<string, ModelPricing> = {
  "claude-fable-5": { input: 10.0, output: 50.0 },
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  "claude-opus-4-7": { input: 5.0, output: 25.0 },
  "claude-sonnet-5": { input: 3.0, output: 15.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
  opus: { input: 5.0, output: 25.0 },
  sonnet: { input: 3.0, output: 15.0 },
  haiku: { input: 1.0, output: 5.0 },
};

const CODEX_PRICING_PER_1M: Record<string, ModelPricing> = {
  "gpt-5.4": { input: 2.5, output: 15.0 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
};

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export interface ParseOptions {
  /** Model id for cost computation. Falls back to the CLI-reported cost. */
  model?: string;
  /** Wall-clock seconds measured externally. */
  wallClockSeconds?: number;
}

function lookupPricing(
  table: Record<string, ModelPricing>,
  model: string | undefined,
): ModelPricing | undefined {
  if (!model) return undefined;
  const entry = table[model];
  if (!entry) return undefined;
  return { input: entry.input / 1e6, output: entry.output / 1e6 };
}

export function getClaudePricing(model: string): ModelPricing | undefined {
  return lookupPricing(CLAUDE_PRICING_PER_1M, model);
}

export function parseClaudeJsonl(
  raw: string,
  opts: ParseOptions = {},
): UsageMetrics {
  const lines = raw.split("\n").filter((l) => l.trim());

  let inputTokens = 0;
  let inputTokensCached = 0;
  let inputTokensCacheCreation = 0;
  let outputTokens = 0;
  let reportedCost = 0;
  let turnCount = 0;
  let commandCount = 0;
  let errorCount = 0;
  let wallClockSeconds = opts.wallClockSeconds ?? 0;
  const commandLog: string[] = [];

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Tool invocations live inside assistant content blocks.
    if (entry.type === "assistant") {
      const msg = (entry.message ?? {}) as Record<string, unknown>;
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type !== "tool_use") continue;
          commandCount++;
          const input = (block.input ?? {}) as Record<string, unknown>;
          if (typeof input.command === "string") {
            commandLog.push(input.command);
          } else {
            commandLog.push(`${String(block.name)}(${JSON.stringify(input).slice(0, 200)})`);
          }
        }
      }
    }

    // Tool failures surface as is_error on the tool_result block.
    if (entry.type === "user") {
      const msg = (entry.message ?? {}) as Record<string, unknown>;
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result" && block.is_error === true) errorCount++;
        }
      }
    }

    if (entry.type === "result") {
      reportedCost = Number(entry.total_cost_usd ?? 0);
      turnCount = Number(entry.num_turns ?? 0);
      if (!wallClockSeconds && entry.duration_ms) {
        wallClockSeconds = Number(entry.duration_ms) / 1000;
      }
      const usage = (entry.usage ?? {}) as Record<string, unknown>;
      const baseInput = Number(usage.input_tokens ?? 0);
      const cacheCreation = Number(usage.cache_creation_input_tokens ?? 0);
      const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
      inputTokens = baseInput + cacheCreation + cacheRead;
      inputTokensCached = cacheRead;
      inputTokensCacheCreation = cacheCreation;
      outputTokens = Number(usage.output_tokens ?? 0);
    }
  }

  const inputTokensUncached = inputTokens - inputTokensCached;

  // Prefer the CLI's own cost figure; compute from tokens only when the result
  // event is missing (agent crashed or timed out mid-run).
  let totalCost = reportedCost;
  if (!totalCost && inputTokens > 0) {
    const pricing = getClaudePricing(opts.model ?? "");
    if (pricing) {
      const baseInputTokens = inputTokensUncached - inputTokensCacheCreation;
      totalCost =
        baseInputTokens * pricing.input +
        inputTokensCacheCreation * pricing.input * CACHE_WRITE_MULTIPLIER +
        inputTokensCached * pricing.input * CACHE_READ_MULTIPLIER +
        outputTokens * pricing.output;
    }
  }

  return {
    input_tokens: inputTokens,
    input_tokens_cached: inputTokensCached,
    input_tokens_uncached: inputTokensUncached,
    output_tokens: outputTokens,
    reasoning_tokens: 0,
    total_cost_usd: totalCost,
    wall_clock_seconds: wallClockSeconds,
    turn_count: turnCount,
    command_count: commandCount,
    error_count: errorCount,
    command_log: commandLog,
  };
}

export function parseCodexJsonl(
  raw: string,
  opts: ParseOptions = {},
): UsageMetrics {
  const lines = raw.split("\n").filter((l) => l.trim());

  let turnCount = 0;
  let inputTokens = 0;
  let inputTokensCached = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let reportedCost = 0;
  let commandCount = 0;
  let errorCount = 0;
  const commandLog: string[] = [];

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (entry.type === "turn.completed") {
      turnCount++;
      const usage = (entry.usage ?? {}) as Record<string, unknown>;
      inputTokens += Number(usage.input_tokens ?? 0);
      outputTokens += Number(usage.output_tokens ?? 0);
      reasoningTokens += Number(usage.reasoning_tokens ?? 0);
      reportedCost += Number(usage.cost_usd ?? 0);

      const cachedDirect = Number(usage.cached_input_tokens ?? 0);
      const details = (usage.input_tokens_details ?? {}) as Record<string, unknown>;
      const cachedNested = Number(details.cached_tokens ?? 0);
      inputTokensCached += cachedDirect || cachedNested;
    }

    if (entry.type === "item.completed") {
      const item = (entry.item ?? {}) as Record<string, unknown>;
      if (item.type === "command_execution") {
        commandCount++;
        if (item.command) commandLog.push(String(item.command));
        if (Number(item.exit_code ?? 0) !== 0) errorCount++;
      }
    }
  }

  const inputTokensUncached = inputTokens - inputTokensCached;

  let totalCost: number;
  const pricing = lookupPricing(CODEX_PRICING_PER_1M, opts.model);
  if (pricing) {
    totalCost =
      inputTokensUncached * pricing.input +
      inputTokensCached * pricing.input * CACHE_READ_MULTIPLIER +
      outputTokens * pricing.output;
  } else {
    totalCost = reportedCost;
  }

  return {
    input_tokens: inputTokens,
    input_tokens_cached: inputTokensCached,
    input_tokens_uncached: inputTokensUncached,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
    total_cost_usd: totalCost,
    wall_clock_seconds: opts.wallClockSeconds ?? 0,
    turn_count: turnCount,
    command_count: commandCount,
    error_count: errorCount,
    command_log: commandLog,
  };
}
