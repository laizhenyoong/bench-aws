import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatTrajectory, buildGradingPrompt, grade } from "../src/grader.js";
import * as child_process from "node:child_process";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(child_process.execFileSync);

beforeEach(() => {
  mockedExecFileSync.mockReset();
});

describe("formatTrajectory", () => {
  it("extracts shell commands and their output from Claude tool_use blocks", () => {
    const jsonl = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Bash", input: { command: "aws s3api list-buckets" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", content: "266" }] },
      }),
    ].join("\n");

    const result = formatTrajectory(jsonl);
    expect(result).toContain("COMMAND: aws s3api list-buckets");
    expect(result).toContain("OUTPUT: 266");
  });

  it("renders MCP tool calls with their structured input", () => {
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

    const result = formatTrajectory(jsonl);
    expect(result).toContain("TOOL_CALL: mcp__aws__aws___call_aws");
    expect(result).toContain("aws lambda list-functions");
  });

  it("flattens MCP array-shaped tool results into text", () => {
    const jsonl = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            content: [
              { type: "text", text: "157 functions" },
              { type: "text", text: "next_token: null" },
            ],
          },
        ],
      },
    });

    const result = formatTrajectory(jsonl);
    expect(result).toContain("157 functions");
    expect(result).toContain("next_token: null");
  });

  it("marks failed tool results so the judge can see the error", () => {
    const jsonl = JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", is_error: true, content: "InvalidInstanceID.NotFound" },
        ],
      },
    });

    expect(formatTrajectory(jsonl)).toContain("OUTPUT (error): InvalidInstanceID.NotFound");
  });

  it("truncates very large tool outputs", () => {
    const huge = "x".repeat(20000);
    const jsonl = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: huge }] },
    });

    const result = formatTrajectory(jsonl);
    expect(result).toContain("[truncated");
    expect(result.length).toBeLessThan(10000);
  });

  it("extracts Codex command executions with exit codes", () => {
    const jsonl = JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "aws ec2 describe-instances",
        output: "31 instances",
        exit_code: 0,
      },
    });

    const result = formatTrajectory(jsonl);
    expect(result).toContain("COMMAND: aws ec2 describe-instances");
    expect(result).toContain("EXIT_CODE: 0");
  });

  it("returns a placeholder for empty input", () => {
    expect(formatTrajectory("")).toBe("(empty trajectory)");
    expect(formatTrajectory("\n\n")).toBe("(empty trajectory)");
  });

  it("skips malformed JSON lines", () => {
    const jsonl = [
      "not json",
      JSON.stringify({ type: "result", result: "Valid line." }),
    ].join("\n");

    const result = formatTrajectory(jsonl);
    expect(result).toContain("AGENT: Valid line.");
    expect(result).not.toContain("not json");
  });
});

describe("buildGradingPrompt", () => {
  it("includes the task prompt and trajectory", () => {
    const prompt = buildGradingPrompt("Count buckets", "COMMAND: aws s3api list-buckets");
    expect(prompt).toContain("TASK: Count buckets");
    expect(prompt).toContain("COMMAND: aws s3api list-buckets");
    expect(prompt).toContain("Rules:");
  });

  it("includes the pagination rule so page sizes are treated as suspect", () => {
    const prompt = buildGradingPrompt("Count log groups", "AGENT: 50");
    expect(prompt).toMatch(/paginate/i);
  });

  it("includes the grading hint when provided", () => {
    const prompt = buildGradingPrompt("Count Lambdas", "AGENT: 157", "There are 157 functions.");
    expect(prompt).toContain("KNOWN FACTS: There are 157 functions.");
  });

  it("omits the KNOWN FACTS section when no hint is given", () => {
    expect(buildGradingPrompt("Count buckets", "AGENT: done")).not.toContain("KNOWN FACTS");
  });
});

describe("grade", () => {
  it("returns pass when the judge says pass", () => {
    mockedExecFileSync.mockReturnValue(
      JSON.stringify({ pass: true, reason: "Ran the command and reported 266." }) as never,
    );

    const result = grade({}, "Count buckets", '{"type":"result","result":"266"}');
    expect(result.task_success).toBe(true);
    expect(result.details).toContain("266");
  });

  it("returns fail when the judge says fail", () => {
    mockedExecFileSync.mockReturnValue(
      JSON.stringify({ pass: false, reason: "Reported page size 50 as the total." }) as never,
    );

    const result = grade({}, "Count Lambdas", "");
    expect(result.task_success).toBe(false);
    expect(result.details).toContain("page size");
  });

  it("extracts a verdict wrapped in a markdown fence", () => {
    mockedExecFileSync.mockReturnValue(
      '```json\n{"pass": true, "reason": "Correct."}\n```' as never,
    );

    const result = grade({}, "Count buckets", "");
    expect(result.task_success).toBe(true);
    expect(result.details).toBe("Correct.");
  });

  it("extracts a verdict from a JSONL-wrapped response", () => {
    mockedExecFileSync.mockReturnValue(
      JSON.stringify({
        type: "item.completed",
        item: { type: "message", text: '{"pass": true, "reason": "Correct answer."}' },
      }) as never,
    );

    const result = grade({}, "Count buckets", "");
    expect(result.task_success).toBe(true);
    expect(result.details).toBe("Correct answer.");
  });

  it("handles judge process failure", () => {
    mockedExecFileSync.mockImplementation(() => {
      const err = new Error("process failed") as Error & { stdout: string; stderr: string };
      err.stdout = "";
      err.stderr = "timeout";
      throw err;
    });

    const result = grade({}, "Count buckets", "");
    expect(result.task_success).toBe(false);
    expect(result.details).toContain("Judge process failed");
  });

  it("handles unparseable judge output", () => {
    mockedExecFileSync.mockReturnValue("I don't know what to say" as never);

    const result = grade({}, "Count buckets", "");
    expect(result.task_success).toBe(false);
    expect(result.details).toContain("Could not parse judge verdict");
  });

  it("extracts a verdict whose reason contains braces", () => {
    mockedExecFileSync.mockReturnValue(
      JSON.stringify({ pass: true, reason: "Bucket {weird~name} handled correctly." }) as never,
    );

    const result = grade({}, "Spot check", "");
    expect(result.task_success).toBe(true);
    expect(result.details).toContain("{weird~name}");
  });

  it("passes the grading hint through to the judge prompt", () => {
    mockedExecFileSync.mockReturnValue(JSON.stringify({ pass: true, reason: "ok" }) as never);

    grade({ grading_hint: "There are 745 log groups." }, "Count log groups", "");

    const lastArgs = mockedExecFileSync.mock.calls.at(-1)![1] as string[];
    const promptArg = lastArgs[lastArgs.indexOf("-p") + 1];
    expect(promptArg).toContain("Count log groups");
    expect(promptArg).toContain("There are 745 log groups.");
  });
});
