---
status: complete
priority: p1
issue_id: "002"
tags: [code-review, mcp, ux]
dependencies: []
---

# `auth login` / `import-key` hang under MCP mode when no input is provided

## Problem Statement
`readStdin()` returns `""` only when `process.stdin.isTTY` is true. Under MCP the stdin is neither a TTY nor a piped source, so `for await (chunk of process.stdin)` blocks until the MCP call times out. Agents that invoke `auth login` or `auth import-key` without passing `--api-key` / `--private-key` (which are refused under `SPLITS_MCP_MODE=1`) deadlock instead of getting a clear error.

## Findings
- **Source:** Agent-native reviewer (Finding #1)
- **File:** `src/cli.ts:116-119` (`readStdin`), `cli.ts:232-236` (login), `cli.ts:358-362` (import-key)

## Proposed Solutions
Fail fast when MCP mode is on and there's nothing to read:
```ts
if (mcpMode() && process.stdin.isTTY !== false) {
  throw new Error(
    "Secrets cannot be piped into an MCP tool call. " +
    "Run `auth login` / `auth import-key` outside MCP, or set SPLITS_API_KEY in the MCP server's environment."
  );
}
```
Apply before `await readStdin()` in both commands.

## Acceptance Criteria
- [ ] `SPLITS_MCP_MODE=1 splits auth login` (no flag, no pipe) errors within <1s with the recovery hint
- [ ] Same for `import-key`

## Work Log
| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-21 | Created from post-ship review | |
