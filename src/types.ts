/** Shared interfaces for the benchmark harness. */

export type ConditionId =
  | "cli"
  | "axi"
  | "mcp-with-toolsearch"
  | "mcp-no-toolsearch";

export type TaskCategory =
  | "single_step"
  | "multi_step"
  | "investigation"
  | "error_recovery";

export type AgentBackend = "claude" | "codex";

export interface GradingSpec {
  /** Account-specific ground truth for the judge. Loaded from hints.yaml. */
  grading_hint?: string;
}

export interface TaskDef {
  id: string;
  category: TaskCategory;
  prompt: string;
  grading: GradingSpec;
}

export interface ConditionDef {
  id: ConditionId;
  name: string;
  tool: string;
  agents_md: string;
  /** Shell commands run once before the agent starts (e.g. tool install checks). */
  setup_commands?: string[];
  /** Registers the hosted AWS MCP server for this condition. */
  mcp?: {
    command: string;
    args: string[];
  };
  /** Disables ToolSearch so every MCP schema is loaded into context upfront. */
  disable_tool_search?: boolean;
}

export interface RunSpec {
  condition: ConditionId;
  task: string;
  run: number;
  model: string;
  agent: AgentBackend;
  region: string;
}

export interface UsageMetrics {
  input_tokens: number;
  input_tokens_cached: number;
  input_tokens_uncached: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_cost_usd: number;
  wall_clock_seconds: number;
  turn_count: number;
  command_count: number;
  error_count: number;
  command_log: string[];
}

export interface GradeResult {
  task_success: boolean;
  details: string;
}

export interface RunResult {
  condition: ConditionId;
  task: string;
  run: number;
  model: string;
  timestamp: string;
  usage: UsageMetrics;
  grade: GradeResult;
  agent_output: string;
  /**
   * Set when the run failed for reasons unrelated to the condition under test —
   * a spend cap, an auth problem, a rate limit. Such runs measure nothing and
   * are excluded from success rates rather than counted as task failures.
   */
  infra_error?: string;
}

export interface ConditionSummary {
  condition: ConditionId;
  name: string;
  total_tasks: number;
  /** Runs excluded from success_rate because they failed for infrastructure reasons. */
  infra_errors: number;
  /** Successes over *graded* runs only. */
  success_rate: number;
  avg_input_tokens: number;
  avg_cached_pct: number;
  avg_output_tokens: number;
  avg_cost_usd: number;
  total_cost_usd: number;
  avg_duration_seconds: number;
  avg_turns: number;
}
