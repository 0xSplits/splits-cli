# @splits/splits-cli

CLI and MCP server for the [Splits](https://splits.org) platform.

## Install

```sh
npm install -g @splits/splits-cli
```

This makes the `splits` command available globally.

Alternatively, run without installing:

```sh
npx @splits/splits-cli <command>
```

## Authentication

Get an API key from [Teams Settings](https://teams.splits.org/settings/team/api-keys/) and set it as an environment variable:

```sh
export SPLITS_API_KEY=sk_...
```

## Usage

### Transactions

```sh
# List transactions
splits transactions list
splits transactions list --chainId 1 --limit 100
splits transactions list --account 0x... --cursor <cursor>

# Get a specific transaction
splits transactions get <id>

# Update gas estimates for an existing transaction
splits transactions update-gas-estimation <id>
```

For multisig transactions, gas can only be refreshed when exactly one signer remains.

### Accounts

```sh
# List accounts
splits accounts list
splits accounts list --includeArchived

# Get account details
splits accounts get <address>

# Archive a subaccount (requires owner-scoped API key)
splits accounts archive <address>

# Unarchive a subaccount (requires owner-scoped API key)
splits accounts unarchive <address>

# Rename a subaccount (requires owner-scoped API key)
splits accounts rename <address> --name "New Name"
```

## MCP Server (Claude Code)

Register the CLI as an MCP server so Claude can use Splits tools directly:

```sh
# Using the built-in command (auto-detects Claude Code, Cursor, etc.)
splits mcp add

# Or manually with Claude Code
claude mcp add splits -e SPLITS_API_KEY=sk_read_... -- npx @splits/splits-cli --mcp
```

The MCP server exposes these tools:
- `transactions_list` — List transactions for your org
- `transactions_get` — Get transaction details
- `transactions_update_gas_estimation` — Update gas estimates for an existing transaction
- `accounts_list` — List accounts in your org
- `accounts_get` — Get account details by address
- `accounts_archive` — Archive a subaccount
- `accounts_unarchive` — Unarchive a subaccount
- `accounts_rename` — Rename a subaccount

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SPLITS_API_KEY` | Yes | API key from [Teams Settings](https://teams.splits.org/settings/team/api-keys/) |
| `SPLITS_API_URL` | No | Override the API base URL (defaults to production) |
