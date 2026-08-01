# bench-aws

A benchmark that compares three ways an AI agent can talk to AWS: the raw
`aws` CLI, the [`aws-axi`](https://github.com/thatdudealso/aws-axi) wrapper,
and the hosted [AWS MCP server](https://github.com/awslabs/mcp).

## Conditions

| Condition             | Interface      | How the agent reaches AWS                                              |
| ---------------------- | --------------- | ------------------------------------------------------------------------ |
| `cli`                   | `aws` CLI       | Baseline. Plain shell commands.                                          |
| `axi`                   | `aws-axi`       | Compact TOON-style output with pre-computed summaries.                   |
| `mcp-with-toolsearch`   | AWS MCP server  | Tools are found via ToolSearch, then called.                             |
| `mcp-no-toolsearch`     | AWS MCP server  | All tool schemas load upfront; ToolSearch is disabled.                   |