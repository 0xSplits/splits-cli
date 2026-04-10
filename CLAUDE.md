# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`@splits/splits-cli` — a single-binary CLI and MCP server for the Splits platform. Published to npm; exposed as the `splits` command and as an MCP server via `npx @splits/splits-cli --mcp`. The CLI talks to the Splits public org API at `/public/v1`.

## Stack

- Node.js 22+
- TypeScript, ESM (`"type": "module"`)
- `pnpm` for package management
- [`incur`](https://www.npmjs.com/package/incur) for CLI command definitions, validation, help, schemas, and LLM manifests
- Native `fetch` for API calls

## Commands

```sh
pnpm install                                    # install deps
pnpm dev <command>                              # run locally via tsx (e.g. pnpm dev accounts list)
pnpm build                                      # tsc → dist/
pnpm release                                    # patch bump + publish (runs build via prepublishOnly)
npm version minor && pnpm publish --access public   # minor release
npm version major && pnpm publish --access public   # major release
npm pack --dry-run                              # preview published package contents
```

There are no lint, typecheck, or test scripts — `pnpm build` (tsc in strict mode) is the only static check. `SPLITS_API_KEY` must be set in the environment for any command that hits the API.

## Architecture

The entire CLI lives in a single file: `src/cli.ts`. This is intentional — do not split it into per-command files unless it becomes unmanageable. The published binary points at `dist/cli.js`; do not edit `dist/` manually, rebuild instead.

- **Framework**: `incur` provides the `Cli.create` / `command` / `z` (Zod) API. Each top-level namespace (`accounts`, `transactions`, `contacts`, `tokens`, `chains`, `members`, `settings`, `automations`, `auth`) is its own `Cli.create(...)` sub-CLI, registered onto the root via `cli.command(sub)`.
- **MCP server**: `cli.serve()` at the bottom of the file both runs the CLI and exposes the same commands as MCP tools when invoked with `--mcp`. Adding a new command automatically makes it available as an MCP tool — there is no separate MCP registration step.
- **Auth**: every command declares `env: authEnv`, which Zod-validates `SPLITS_API_KEY` (required) and `SPLITS_API_URL` (defaults to `https://server.production.splits.org`) from the environment. Reuse the shared `authEnv` object instead of introducing command-specific auth handling.
- **API calls**: all requests go through the `apiRequest(env, path, options?)` helper, which hits `${SPLITS_API_URL}/public/v1${path}` with a `Bearer` token and unwraps `{ error: { message } }` responses into thrown `Error`s. Never call `fetch` directly from a command.
- **Query strings**: use the `buildQuery` helper — it skips `undefined` and `false` values, so boolean flags only get sent when truthy.
- **Return values**: commands should return plain JSON-compatible data so incur can expose them cleanly through `--format`, `--schema`, and `--llms`.
- **Schemas**: commands use `args` for positional arguments and `options` for flags, both as `z.object(...)`. Address args should use the `/^0x[a-fA-F0-9]{40}$/` regex; transaction IDs use `z.string().uuid()`.

## Command design conventions

- Prefer clear, predictable command names over rigid grammatical patterns. Optimize for both agent use and human scanability.
- Keep top-level groups aligned with backend resources: `accounts`, `transactions`, `contacts`, `tokens`, `chains`, `members`, `settings`, `automations`.
- Use positional `args` for the primary identifier of single-resource commands; reserve `options` for filters, toggles, and mutation payloads.
- Keep option names aligned with backend query/body field names to reduce translation overhead.
- When a backend route has an important eligibility constraint (e.g. `transactions update-gas-estimation` only works with one signer remaining), include it in the command description and README example.
- When a command targets a single resource and the org only has one of them (see `accounts balances`), auto-select it rather than requiring the address, and throw a clear error listing the options when there are multiple.
- Don't force every command into the same shape — predictable names, bounded output, actionable errors, and structured returns matter more than uniformity.

## Verification

- Run `pnpm build` after changing command definitions or argument schemas.
- When changing command shape or docs, verify generated help and schema output from the built CLI:
  - `node dist/cli.js <command> --help`
  - `node dist/cli.js <command> --schema`
- Update `README.md` when adding, removing, or changing a user-facing command.

## Environment

| Variable | Required | Description |
|---|---|---|
| `SPLITS_API_KEY` | Yes | Splits API key |
| `SPLITS_API_URL` | No | Defaults to `https://server.production.splits.org` |

## Monorepo context

This directory is part of `splits-mono` but has its own git repo — run all git commands from inside `cli/`. The root `splits-mono/CLAUDE.md` also applies: do not include "Co-Authored-By" or "Generated with Claude Code" lines in commits or PR descriptions.
