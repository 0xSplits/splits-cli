---
status: pending
priority: p2
issue_id: "003"
tags: [code-review, concurrency, data-integrity]
dependencies: []
---

# Keystore writes aren't atomic or concurrency-safe

## Problem Statement
`saveKey` and `saveApiKey` do `readRaw()` → `writeRaw()` with no lock. `writeRaw` uses `fs.writeFile` directly (not `open`+`rename`). Two concurrent `splits` processes (parallel agent calls, MCP + shell, `update-signers --generate-eoa` rerun) can:
(a) both observe "no key," generate two EOAs, one clobbers the other — leaving an orphaned registered signer;
(b) interleave bytes mid-write, corrupting the file into the "invalid shape" error path.

## Findings
- **Source:** Security Sentinel (Medium #1)
- **File:** `src/config.ts:95-98` (`writeRaw`), `src/config.ts:148-158` (`saveKey`)

## Proposed Solutions
Two-step fix:

1. Atomic write — write to `config.json.tmp` with `{ flag: "wx", mode: 0o600 }`, then `fs.rename` to `config.json`. Rename is atomic on POSIX.
2. Either add `proper-lockfile` (new dep) around read-modify-write, or document the known race (single-process expected use) and rely on atomic write to at least prevent corruption.

Minimal v1: just the atomic-write half. The race window for the double-generate is narrow and self-correcting (second run's `saveKey` will see the first's write and throw refuse-on-exists).

## Acceptance Criteria
- [ ] `writeRaw` uses tmp-file + rename
- [ ] Partial write cannot leave `config.json` in an unparseable state

## Work Log
| Date | Action | Learnings |
|------|--------|-----------|
| 2026-04-21 | Created from post-ship review | |
