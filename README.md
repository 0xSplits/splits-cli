# @splits/splits-cli

CLI and MCP server for the [Splits](https://splits.org) platform.

Using this CLI or MCP server with an agent? Start with the [Splits agent guide](https://splits.org/llms.txt).

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

Get an API key from [Splits Settings](https://app.splits.org/settings/team/api-keys/). Two options:

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

`auth login` checks the key against the API and saves it as a **workspace** named after the org (or `--name <alias>`), then makes it the active one. Log in once per org to keep several workspaces side by side:

```sh
echo $ACME_KEY | splits auth login              # saved as "acme"
echo $PETT_KEY | splits auth login --name pett  # saved as "pett", now active

splits auth workspaces                # list saved workspaces, marks the active one
splits auth use acme                  # switch the active workspace
splits accounts list --workspace pett # run one command in another workspace
splits auth logout pett               # remove one workspace (defaults to the active one)
```

Precedence for the API key is `SPLITS_API_KEY` env var → `--workspace` → `SPLITS_WORKSPACE` env var → active workspace → error. When `SPLITS_API_KEY` is set, saved workspaces are not used at all: requests go to `SPLITS_API_URL` (or production), and naming a workspace with `--workspace` or `SPLITS_WORKSPACE` is an error. `splits auth whoami` reports `workspace` and `apiKeySource` so you can tell where credentials came from, and updates the org id and name that `auth workspaces` shows for that workspace (a workspace carried over from an older config has none until then). The same file (`~/.splits/config.json`, mode 0600, auto-gitignored) also holds local signing keys — see below. A config file written by an older CLI keeps working: its key is read as a workspace named `default`, and the file is rewritten in the new format on the next change.

## Local signing key

The CLI can generate or import an EOA (Ethereum Externally Owned Account) and use it to sign pending multisig transactions locally, instead of opening the web app for the "Sign URL" flow. Useful for agents, automations, and MCP-driven workflows.

```sh
# Generate a new EOA and add it to the local keys
splits auth create-key

# Import an existing private key (stdin preferred; flag refused under MCP mode)
echo $PRIVATE_KEY | splits auth import-key

# Remove a local key (does not revoke the on-chain signer).
# The address can be omitted when only one key is saved.
splits auth delete-key <address>
```

Several keys can be saved, and they are not tied to a workspace. With one key, `transactions sign` uses it; with several, pass `--key <address>`.

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

# Pick the local key when several are saved
splits transactions sign <transaction-id> --key <address>
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

# Shallow-merge custom JSON metadata onto an existing transaction
splits transactions properties set <id> \
  --properties '{"email":"user@example.com","invoiceId":"ETHGLOBAL-42"}'
splits transactions properties set <id> --property invoice=ETHGLOBAL-42

# Replace or clear all custom metadata
splits transactions properties replace <id> --properties '{"userId":420}'
splits transactions properties clear <id>
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

# Get token balances. Earn rows carry an `earn` object with the underlying
# asset amount and follow their asset; `assetTotals` sums each asset with its
# Earn positions. The address is auto-selected if the org has one account.
splits accounts balances [address] --chainIds 8453,1

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

### Accounting

```sh
# Generate a report and get a download URL back
splits accounting reports generate realized-gains --period lastYear

# Or write it straight to disk (waits for large reports to finish generating)
splits accounting reports generate realized-gains --period lastYear --file-format pdf --out ./rgl.pdf
splits accounting reports generate statement --period lastMonth --out ./reports/

# Transactions-only filters mirror 'transactions list'
splits accounting reports generate transactions --period lastMonth --memo payroll --min-amount 1000 --outbound

# List reports generated for the org, and poll one that was queued
splits accounting reports list
splits accounting reports job <jobId>
```

Reports: `transactions`, `lots`, `lot-timeline`, `realized-gains`, `tokens`, `statement`. The statement is always a PDF. Filters match the app's, and each report ignores the ones it doesn't read (`--help` names which reports take which). `--account-ids` takes account ids from `splits accounts list`, not addresses. `--out` won't replace an existing file unless you pass `--force`.

```sh
# Read tax lots, and the assertion history behind one
splits accounting lots list --page-size 50 --status open
splits accounting lots list --account-ids <id> --chain-ids 8453 --sort-by costBasis --sort-direction desc
splits accounting lots assertions <lotId> --limit 50 --cursor <nextCursor>
```

```sh
# Seed opening inventory the org held before Splits (quantity is in base units).
# --target-key names the lot; rerun with the same key to correct it.
splits accounting assertions seed --smart-account-id <id> --chain-id 8453 --token-address 0xabc... \
  --unit-price 1500.50 --acquisition-time 2024-03-01 --quantity 1000000 --target-key usdc-opening-2024

# Correct a lot the engine derived, naming it by the transfer it opened from
splits accounting assertions edit --smart-account-id <id> --chain-id 8453 --token-address 0xabc... \
  --source-transfer-id <transferId> --unit-price 1600

# Mark an inbound as drawing from seeded inventory, so it carries basis
splits accounting assertions designate --smart-account-id <id> --chain-id 8453 --token-address 0xabc... \
  --transfer-id <transferId>

# Withdraw an assertion (names exactly one of the three targets)
splits accounting assertions revoke --smart-account-id <id> --chain-id 8453 --token-address 0xabc... --target-key <key>

# Write up to 250 at once, as one atomic insert
splits accounting assertions bulk --file ./seeds.json
```

```sh
# Import an address the org held before Splits and poll its backfill
splits accounting imports create --name "Old treasury" --address 0xabc... \
  --chain-ids 8453,1 --cutoff-at 2026-01-15
splits accounting imports list
splits accounting imports status <smartAccountId> --chain-ids 8453,1
```

```sh
# Assertion writes queue a lot recompute; lots and reports reflect a write once it settles
splits accounting recompute current
splits accounting recompute job <jobId>
splits accounting recompute run   # force a full rebuild
```

Writing assertions, creating imports, and generating reports need a write-scoped, user-bound API key. Queueing a recompute needs write scope.

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
- `transactions_sign` — Sign a pending multisig transaction with a local EOA
- `auth_whoami` — Show org, workspace, API key source, and local signing keys
- `auth_login` / `auth_logout` — Save or remove a workspace (stdin-preferred; `--api-key` flag refused under MCP)
- `auth_workspaces` / `auth_use` — List saved workspaces, switch the active one
- `auth_create_key` / `auth_delete_key` / `auth_import_key` — Manage local EOA signing keys

Every tool that calls the API takes an optional `workspace` argument, so one MCP server can work across several saved workspaces.
- `auth_register_signer` / `auth_signers` — Register and list EOA signers under the acting user
- `members_list` — List org members
- `members_signers` — List passkey signers for a member
- `accounting_reports_generate` — Generate an accounting report and return a URL or write it to disk
- `accounting_reports_list` / `accounting_reports_job` — List generated reports, poll a queued one
- `accounting_lots_list` / `accounting_lots_assertions` — Read tax lots and a lot's assertion history
- `accounting_assertions_seed` / `_edit` / `_revoke` / `_designate` / `_bulk` — Write lot assertions
- `accounting_imports_create` / `_list` / `_status` — Import an external address and poll its backfill
- `accounting_recompute_current` / `_job` / `_run` — Track or force the lot recompute that applies assertion writes

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SPLITS_API_KEY` | No\* | API key from [Splits Settings](https://app.splits.org/settings/team/api-keys/). Takes precedence over `splits auth login`; saved workspaces are not used while it is set. |
| `SPLITS_API_URL` | No | Override the API base URL (defaults to production). Takes precedence over any URL saved by `auth login --api-url`. |
| `SPLITS_WORKSPACE` | No | Workspace alias to use instead of the active one. `--workspace` takes precedence over it. |
| `SPLITS_MCP_MODE` | No | Set to `1` when running as an MCP server. Refuses flag-based secrets (`--api-key`, `--private-key`) so secrets don't appear in tool-call transcripts. |

\* At least one credential source is required: either the env var or a workspace saved via `splits auth login`.
