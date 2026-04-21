---
status: complete
priority: p1
issue_id: "001"
tags: [code-review, security, correctness]
dependencies: []
---

# Validate signingHash shape before personal_sign

## Problem Statement
`transactions sign` fetches `signingHash` from `GET /v1/transactions/:id`, null-checks it, then casts to `` `0x${string}` `` and passes straight into `account.signMessage({ message: { raw: hash } })`. A malformed response (e.g. truncated hex, missing prefix) would sign attacker-chosen bytes silently — the one load-bearing piece of data the CLI ever signs is currently unvalidated.

## Findings
- **Source:** Kieran TS (#1), Security Sentinel (tracking item)
- **File:** `src/cli.ts:1063` in `fetchSigningHash`

## Proposed Solutions
Add a regex check before returning:
```ts
if (!/^0x[0-9a-f]+$/i.test(hash) || hash.length > 66 || hash.length < 4) {
  throw new SplitsApiError("invalid-signing-hash", 0,
    "Backend returned a malformed signingHash; refusing to sign.");
}
return hash as `0x${string}`
```

Alternative: parse the GET response through a Zod schema (`z.object({ data: z.object({ signingHash: z.string().regex(...).nullable() }) })`) so the narrowing is load-bearing and reusable.

## Acceptance Criteria
- [ ] Malformed `signingHash` surfaces a structured error before `signMessage` is called
- [ ] Test: mock GET response with `signingHash: "abc"` → error, no signature attempted

## Work Log
| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-21 | Created from post-ship review | |
