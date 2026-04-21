---
status: pending
priority: p2
issue_id: "004"
tags: [code-review, mcp, security]
dependencies: []
---

# `auth whoami` spreads backend response — not a load-bearing allowlist

## Problem Statement
`auth whoami` returns `{ ...response, data: { ...response.data, apiKeySource, ...(localKey ? { localKey } : {}) } }`. The `...response.data` spread passes every field from the backend straight through to the caller (including an MCP LLM). If the `/auth/whoami` endpoint ever starts returning a sensitive field, this leaks automatically.

Contrast `loadLocalKeyPublic` which explicitly picks `name + address`.

## Findings
- **Source:** Kieran TS (#3)
- **File:** `src/cli.ts:193-200`

## Proposed Solutions
Define a typed response shape and pick fields explicitly:
```ts
type WhoamiData = {
  orgId: string;
  orgName: string;
  keyName: string;
  scopes: Array<"read" | "write" | "owner">;
  accountCount: number;
};
const response = await apiRequest<{ data: WhoamiData }>(env, "/auth/whoami");
return {
  data: {
    orgId: response.data.orgId,
    orgName: response.data.orgName,
    keyName: response.data.keyName,
    scopes: response.data.scopes,
    accountCount: response.data.accountCount,
    apiKeySource: resolved.source,
    ...(localKey ? { localKey } : {}),
  },
};
```
Keeps MCP contract stable even if the backend changes.

## Acceptance Criteria
- [ ] `whoami` returns an enumerated set of fields, not a spread
- [ ] Adding a new field on the backend doesn't silently appear in CLI output

## Work Log
| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-21 | Created from post-ship review | |
