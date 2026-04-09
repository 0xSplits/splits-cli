---
title: "Transactions refresh-gas: positional IDs and explicit multisig preconditions"
category: integration-issues
date: 2026-04-09
tags:
  - cli
  - mcp
  - transactions
  - gas-estimation
  - incur
  - command-design
components:
  - src/cli.ts
  - README.md
symptoms:
  - "`splits transactions refresh-gas --id <id>` diverges from sibling transaction commands"
  - "Single-resource mutation requires an avoidable flag instead of a positional identifier"
  - "CLI help omits that multisig gas refresh only works when exactly one signer remains"
---

# Transactions `refresh-gas`: positional IDs and explicit multisig preconditions

## Problem

The new `splits transactions refresh-gas` command was added as `splits transactions refresh-gas --id <id>`. That made it inconsistent with the rest of the `transactions` command family, where the transaction id is positional (`get <id>`, `memo <id> --memo ...`). It also left out an important operational detail: multisig gas refresh only succeeds when exactly one signer remains.

## Root Cause

When `refresh-gas` was introduced, the transaction id was modeled as an `options.id` flag even though it is the required resource identifier interpolated directly into `/transactions/:id/refresh-gas`. That drifted from the CLI's existing pattern: positional args identify the primary resource, while options are reserved for filters or secondary write parameters.

The command description also mirrored the endpoint name too literally and did not surface the multisig precondition that matters to both human users and agent callers.

## Solution

Switch `refresh-gas` from `options.id` to `args.id`, keeping the command shape aligned with the rest of the `transactions` group and with the underlying REST path. Update the command description and README example so the multisig constraint is explicit at the point of use.

### Before

```typescript
transactions.command("refresh-gas", {
  description: "Refresh gas estimates for an existing transaction",
  env: authEnv,
  options: z.object({
    id: z.string().uuid("Invalid transaction ID").describe("Transaction ID"),
  }),
  async run({ env, options }) {
    return apiRequest(env, `/transactions/${options.id}/refresh-gas`, {
      method: "PUT",
    });
  },
});
```

### After

```typescript
transactions.command("refresh-gas", {
  description:
    "Refresh gas estimates for an existing transaction. For multisig, run this when one signer remains.",
  env: authEnv,
  args: z.object({
    id: z.string().uuid("Invalid transaction ID").describe("Transaction ID"),
  }),
  async run({ env, args }) {
    return apiRequest(env, `/transactions/${args.id}/refresh-gas`, {
      method: "PUT",
    });
  },
});
```

### CLI / README Usage

```sh
splits transactions refresh-gas <id>
```

For multisig transactions, gas can only be refreshed when exactly one signer remains.

## Prevention / Best Practices

- If a value is required to identify the primary REST resource in a command path, make it a positional `args` field even when the command performs a mutation.
- Keep command families internally consistent. A user or agent should be able to predict a new command from nearby commands without reading the source.
- Reserve `options` for filters, pagination, and secondary write inputs such as `--memo`.
- Put critical backend preconditions in the command description and README so they are visible in CLI help, MCP metadata, and examples.

## References

- Commit: `5d0ca99` (`transactions:refresh-gas`)
- Branch: `feature/pe-6783-cli-interface-gas-estimation`
- Files: `src/cli.ts`, `README.md`
