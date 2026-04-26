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
splits transactions list --chain-id 1 --limit 100
splits transactions list --account 0x... --cursor <cursor>

# Get a specific transaction
splits transactions get <id>

# Update gas estimates for an existing transaction
splits transactions update-gas-estimation <id>
```

For multisig transactions, gas can only be refreshed when exactly one signer remains.

#### Filtering

`splits transactions list` accepts the same filter set as the Accounting view in the web app:

```sh
# Filter by inflow / outflow
splits transactions list --direction inbound
splits transactions list --direction outbound

# Filter by USD value range (compared against absolute value)
splits transactions list --min-amount 100 --max-amount 10000

# Filter by date range (endDate is EXCLUSIVE)
splits transactions list --start-date 2026-03-01 --end-date 2026-04-01

# Or use a period shorthand (resolved in your local timezone)
splits transactions list --period thisMonth
splits transactions list --period lastMonth
splits transactions list --period last30Days

# Search by memo (case-insensitive substring; min 3 chars; combine with another filter)
splits transactions list --memo "payroll" --chain-id 8453

# Multi-account: comma-separated addresses
splits transactions list --account 0xa...,0xb...

# Combined: find a ~$5k outbound payment to Acme last month
splits transactions list --period lastMonth --memo "Acme" \
  --min-amount 4500 --max-amount 5500 --direction outbound
```

Each row in the response includes a `direction` field (`inbound` or `outbound`) so you can verify the filter result. Splits-initiated transactions are always `outbound`.

`--period` is mutually exclusive with `--start-date` / `--end-date`. Valid period values: `thisWeek`, `thisMonth`, `thisYear`, `lastWeek`, `lastMonth`, `lastYear`, `last30Days`, `last90Days`, `last6Months`.

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

# Create a subaccount (requires owner-scoped API key)
splits accounts create --name "Operations" --passkeyIds <id1>,<id2> --threshold 1
splits accounts create --name "Ops" --eoaAddresses 0xabc...,0xdef... --threshold 2
```

### Members

```sh
# List org members
splits members list

# List passkey signers for a member (use for account creation)
splits members signers <userId>
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
- `accounts_create` — Create a new subaccount
- `members_list` — List org members
- `members_signers` — List passkey signers for a member

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SPLITS_API_KEY` | Yes | API key from [Teams Settings](https://teams.splits.org/settings/team/api-keys/) |
| `SPLITS_API_URL` | No | Override the API base URL (defaults to production) |
