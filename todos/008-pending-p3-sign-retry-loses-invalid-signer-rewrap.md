---
status: pending
priority: p3
issue_id: "008"
tags: [code-review, error-handling]
dependencies: []
---

# `transactions sign` retry path skips the signer-not-authorized rewrap

## Problem Statement
On `INVALID_SIGNER_NONCE` we re-GET the hash and re-POST. If the retry throws `INVALID_SIGNER` (because, e.g., the registration proposal was just executed with a different signer set mid-race), the user sees the raw backend error — not the friendly "signer-not-authorized + check registration status" rewrap applied to the first attempt.

## Findings
- **Source:** Kieran TS (#7)
- **File:** `src/cli.ts:1090-1101`

## Proposed Solutions
Extract the error-mapping into a small helper and apply it to both call sites:
```ts
const mapSignError = (err: unknown, signer: string): never => {
  if (err instanceof SplitsApiError && err.code === "INVALID_SIGNER") {
    throw new SplitsApiError("signer-not-authorized", err.status,
      `Local key ${signer} is not an authorized signer on this transaction. ` +
      `If you just registered this key via update-signers, the registration ` +
      `proposal must be approved and executed before it can sign other transactions.`);
  }
  throw err;
};

try {
  return await postSignature(signingHash);
} catch (err) {
  if (err instanceof SplitsApiError && err.code === "INVALID_SIGNER_NONCE") {
    try {
      signingHash = await fetchSigningHash();
      return await postSignature(signingHash);
    } catch (retryErr) {
      mapSignError(retryErr, account.address);
    }
  }
  mapSignError(err, account.address);
}
```

## Acceptance Criteria
- [ ] Retry path also rewraps `INVALID_SIGNER` as `signer-not-authorized`
- [ ] No duplication of the error message string

## Work Log
| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-21 | Created from post-ship review | |
