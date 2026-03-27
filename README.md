# @0xsplits/cli

CLI and MCP server for the Splits platform. Built with [incur](https://github.com/wevm/incur).

## Setup

```bash
pnpm install
```

## Usage

### CLI

```bash
# Set your API key
export SPLITS_API_KEY="<your_api_key>"
export SPLITS_API_URL="http://localhost:8080"

# List accounts
pnpm dev accounts list

# List transactions
pnpm dev transactions list --limit 5

# Filter transactions by account address
pnpm dev transactions list --account 0xYourAddress --limit 10

# Get transaction details
pnpm dev transactions get <transaction_id>

# JSON output
pnpm dev transactions list --json
```

### MCP Server

Register with Claude Code:

```bash
claude mcp add splits -- pnpm tsx /Users/willdrach/Git/splits-workspace/splits-cli/src/cli.ts --mcp
```

The MCP server exposes these tools:
- `accounts_list` — List accounts in your org
- `accounts_get` — Get account details by address
- `transactions_list` — List transactions for your org
- `transactions_get` — Get transaction details

**Note:** `SPLITS_API_KEY` and `SPLITS_API_URL` environment variables must be set for the MCP server process. You can configure these in your Claude Code MCP settings.
