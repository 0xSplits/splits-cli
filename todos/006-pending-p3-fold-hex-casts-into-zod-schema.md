---
status: pending
priority: p3
issue_id: "006"
tags: [code-review, types]
dependencies: []
---

# Redundant `as \`0x${string}\`` casts on schema-narrowed fields

## Problem Statement
`loadLocalKeyPublic` and `loadLocalPrivateKey` apply `as \`0x${string}\`` to values that the Zod schema already regex-validated. The cast is load-bearing only because the schema's inferred type is `string` (not the branded type). If the regex ever drifts from the branded shape, the cast silently becomes wrong.

## Findings
- **Source:** Kieran TS (#2, #5)
- **File:** `src/config.ts:184, 186, 195, 202`

## Proposed Solutions
Move the cast into the schema via `.transform`:
```ts
const hexAddressSchema = z.string().regex(HEX_ADDRESS_RE)
  .transform((s) => s as `0x${string}`);
const hexPrivateKeySchema = z.string().regex(HEX_PRIVATE_KEY_RE)
  .transform((s) => s as `0x${string}`);
```
Then `ConfigSchema` uses these; `loadLocalKeyPublic` / `loadLocalPrivateKey` / `removeKey` lose their casts. Not the deferred branded-Hex end-to-end work — just removing casts the schema can own.

## Acceptance Criteria
- [ ] Zero `as \`0x${string}\`` casts in `config.ts`
- [ ] `tsc` still passes

## Work Log
| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-21 | Created from post-ship review | |
