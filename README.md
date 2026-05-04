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

Get an API key from [Teams Settings](https://teams.splits.org/settings/team/api-keys/). Two options:

**Environment variable** (preferred for CI and headless contexts):

```sh
export SPLITS_API_KEY=sk_...
```

**Local config** (convenient for MCP and interactive use):

```sh
# Pipe from stdin so the key doesn't land in shell history or tool-call transcripts
echo $SPLITS_API_KEY | splits auth login

# Or, for interactive use only (refused under SPLITS_MCP_MODE=1):
splits auth login --api-key sk_...

# Log out (removes the key and optional URL override; doesn't touch the env var)
splits auth logout
```

Precedence is `SPLITS_API_KEY` env var → saved local config → error. `splits auth whoami` reports `apiKeySource` so you can tell where credentials came from. The same file (`~/.splits/config.json`, mode 0600, auto-gitignored) can also hold a local signing key — see below.

## Local signing key

The CLI can generate or import an EOA (Ethereum Externally Owned Account) and use it to sign pending multisig transactions locally, instead of opening the web app for the "Sign URL" flow. Useful for agents, automations, and MCP-driven workflows.

```sh
# Generate a new EOA and save it locally (single key in v1)
splits auth create-key

# Import an existing private key (stdin preferred; flag refused under MCP mode)
echo $PRIVATE_KEY | splits auth import-key

# Remove the local key (does not revoke the on-chain signer)
splits auth delete-key
```

The private key never appears in any command's response — only the derived address and a warning. The file at `~/.splits/config.json` is the only copy; back it up if the key will hold funds.

## Registered EOA signers

To use an EOA as a signer on one or more smart accounts, first register it under your user, then attach the returned id via `accounts update-signers`. Registration is a one-time step per address; the same id can be attached to any number of accounts.

```sh
# Register the local key (or any address you control) so it can be attached
splits auth register-signer <address> --name "Agent One"

# List registered EOA signers — returns ids needed by update-signers
splits auth signers

# Attach a registered signer to an account (repeat per account as needed)
splits accounts update-signers <account> --add-eoa-signer-ids <id>
```

Registration is idempotent: re-running `register-signer` with the same address returns the same id (and preserves the first name).

Once the EOA is attached to the account's signer set, sign pending multisig transactions:

```sh
# Auto-submit when this signature meets threshold (default)
splits transactions sign <transaction-id>

# Record the signature without submitting the UserOp
splits transactions sign <transaction-id> --no-submit
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

# Sign a pending multisig transaction with the local EOA
splits transactions sign <id>
splits transactions sign <id> --no-submit
```

For multisig transactions, gas can only be refreshed when exactly one signer remains. `transactions sign` requires a local EOA (see "Local signing key" above) and that the address is already an authorized signer on the transaction's smart account.

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

# Look up a transaction by its on-chain hash (matches both splits-initiated
# transactions and asset transfers; combine with --chain-id when the same hash
# could exist on multiple chains)
splits transactions list --transaction-hash 0xabc...def --chain-id 8453

# Look up a transaction by its ERC-4337 user-op hash
splits transactions list --user-op-hash 0x1dfe...dcf
```

Each row in the response includes a `direction` field (`inbound` or `outbound`) so you can verify the filter result. Splits-initiated transactions are always `outbound`. Each row also includes `transactionHash` and `userOpHash` (both nullable) so you can correlate splits records with explorers and bundler webhooks; the same two fields are returned by `splits transactions get`.

`--period` is mutually exclusive with `--start-date` / `--end-date`. Valid period values: `thisWeek`, `thisMonth`, `thisYear`, `lastWeek`, `lastMonth`, `lastYear`, `last30Days`, `last90Days`, `last6Months`.

### Accounts

```sh
# List accounts
splits accounts list
splits accounts list --includeArchived

# Get account details
splits accounts get <address>

# List signers (passkeys + EOAs) and threshold for a subaccount
splits accounts signers <address>

# Archive a subaccount (requires owner-scoped API key)
splits accounts archive <address>

# Unarchive a subaccount (requires owner-scoped API key)
splits accounts unarchive <address>

# Rename a subaccount (requires owner-scoped API key)
splits accounts rename <address> --name "New Name"

# Create a subaccount (requires owner-scoped API key)
# EOAs must be registered first via `splits auth register-signer <address>`.
# Prefer ids when you have them; addresses are accepted as a convenience and
# resolve to ids server-side (each must already be registered to you).
splits accounts create --name "Operations" --passkeyIds <id1>,<id2> --threshold 1
splits accounts create --name "Ops"  --eoaSignerIds <eoa-id1>,<eoa-id2>     --threshold 2
splits accounts create --name "Bots" --eoaAddresses 0xabc...,0xdef...        --threshold 1
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
- `accounts_signers` — List passkey + EOA signers and threshold for a subaccount
- `accounts_archive` — Archive a subaccount
- `accounts_unarchive` — Unarchive a subaccount
- `accounts_rename` — Rename a subaccount
- `accounts_create` — Create a new subaccount
- `accounts_update_signers` — Propose adding/removing signers (EOA adds reference ids from `auth_register_signer`)
- `transactions_sign` — Sign a pending multisig transaction with the local EOA
- `auth_whoami` — Show org, API key source, and local signing key (if any)
- `auth_login` / `auth_logout` — Save or remove a local API key (stdin-preferred; `--api-key` flag refused under MCP)
- `auth_create_key` / `auth_delete_key` / `auth_import_key` — Manage a local EOA signing key
- `auth_register_signer` / `auth_signers` — Register and list EOA signers under the acting user
- `members_list` — List org members
- `members_signers` — List passkey signers for a member

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SPLITS_API_KEY` | No\* | API key from [Teams Settings](https://teams.splits.org/settings/team/api-keys/). Takes precedence over `splits auth login`. |
| `SPLITS_API_URL` | No | Override the API base URL (defaults to production). Takes precedence over any URL saved by `auth login --api-url`. |
| `SPLITS_MCP_MODE` | No | Set to `1` when running as an MCP server. Refuses flag-based secrets (`--api-key`, `--private-key`) so secrets don't appear in tool-call transcripts. |

\* At least one credential source is required: either the env var or a key saved via `splits auth login`.
