---
status: pending
priority: p3
issue_id: "007"
tags: [code-review, simplicity]
dependencies: []
---

# `gitignoreEnsured` process-state flag is redundant

## Problem Statement
`gitignoreEnsured` is a module-scope mutable boolean that memoizes "we already tried to write `.gitignore`." But `writeFile(..., { flag: "wx" })` already atomically rejects with `EEXIST` when the file is there — the memo saves at most one write-then-catch per process. The mutable module state earns nothing.

Also: on `EEXIST` we set `gitignoreEnsured = true` but never check the file's contents. If a user (or earlier version) wrote an empty `.gitignore`, we treat it as handled — and the commit message's "auto-gitignored" claim is false.

## Findings
- **Source:** Simplicity (#2), Security Sentinel (Low — gitignore contents)
- **File:** `src/config.ts:79-89`

## Proposed Solutions
Option A (simplest): drop the flag; let `wx`+`EEXIST` do its job every call.
```ts
const ensureDir = async (): Promise<void> => {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(GITIGNORE_PATH, "*\n", { flag: "wx", mode: 0o600 })
    .catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    });
};
```

Option B (more defensive): read existing `.gitignore` and append `*\n` if missing. Only needed if the "auto-gitignored" claim matters for users with pre-existing files.

Leaning A — one Tigris-style check: the keystore file is 0600 regardless, so a pre-existing empty `.gitignore` leaking `config.json` into a `git add .` is a dotfile-sync edge case already covered by the explicit warning copy in `create-key`.

## Acceptance Criteria
- [ ] `gitignoreEnsured` removed
- [ ] First-write behavior unchanged (new dir gets `.gitignore *`)

## Work Log
| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-21 | Created from post-ship review | |
