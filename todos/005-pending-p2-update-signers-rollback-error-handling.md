---
status: pending
priority: p2
issue_id: "005"
tags: [code-review, error-handling, ux]
dependencies: []
---

# `update-signers --generate-eoa` rollback swallows errors and loses SplitsApiError code

## Problem Statement
Two issues in the rollback path:

1. `await removeKey().catch(() => undefined)` silently discards rollback failures. If the rollback write itself fails (EACCES, disk full), the user is told the key was rolled back — but it still sits in `~/.splits/config.json`. They now have an orphaned registered EOA they don't know is persisted locally.

2. The rollback wraps the API error in a plain `Error`, so the backend `code` and HTTP `status` from the original `SplitsApiError` are lost. MCP consumers that branch on `err.code` can't tell what actually failed.

## Findings
- **Source:** Security Sentinel (Medium #2), Kieran TS (#8)
- **File:** `src/cli.ts:707-722`

## Proposed Solutions
```ts
} catch (err) {
  if (generatedAddress !== null) {
    const rollback = await removeKey().catch((rollbackErr) => rollbackErr);
    const code = err instanceof SplitsApiError ? err.code : undefined;
    const status = err instanceof SplitsApiError ? err.status : 0;
    const apiMsg = err instanceof Error ? err.message : String(err);

    if (rollback instanceof Error) {
      throw new SplitsApiError(
        "generate-eoa-orphaned",
        status,
        `Failed to register generated EOA ${generatedAddress}: ${apiMsg}. ` +
          `The local key could NOT be removed (${rollback.message}); ` +
          `delete ~/.splits/config.json manually to discard it.`
      );
    }
    throw new SplitsApiError(
      code ?? "generate-eoa-rolled-back",
      status,
      `Failed to register generated EOA ${generatedAddress}: ${apiMsg}. ` +
        `The local key was rolled back; re-run update-signers to retry.`
    );
  }
  throw err;
}
```

## Acceptance Criteria
- [ ] Rollback failure surfaces a distinct error (`generate-eoa-orphaned`) naming the config path
- [ ] Rollback success preserves the backend error `code` where present
- [ ] Error messages trimmed vs today's three-sentence sprawl

## Work Log
| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-21 | Created from post-ship review | |
