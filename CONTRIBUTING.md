# Contributing

## Setup

```sh
pnpm install
```

## Development

The published package only talks to the production API. When you run the CLI from source (`pnpm dev`, or `tsx src/cli.ts`), it keeps the URL overrides: `SPLITS_API_URL`, `auth login --api-url` and the URL saved with each workspace.

You can run locally via `tsx`
```sh
export SPLITS_API_KEY="<your_api_key>"
export SPLITS_API_URL="http://localhost:8080"

# Run locally via tsx
pnpm dev accounts list
pnpm dev transactions list --limit 5
```

Or add it as a server in your Claude settings.json
```json
{
  "mcpServers": {
    "splits-dev": {
      "command": "npx",
      "args": [
        "tsx",
        "<your splits-cli repo location>/src/cli.ts"
      ],
      "env": {
        "SPLITS_API_KEY": "<your_api_key",
        "SPLITS_API_URL": "http://localhost:8080"
      }
    }
  }
}
```

## Build

```sh
pnpm build        # non-prod build: keeps the URL overrides
pnpm build:prod   # prod build: production API only; prepublishOnly runs this
```

## Release

```sh
# Patch release (0.0.1 -> 0.0.2)
pnpm release

# Minor or major
npm version minor && pnpm publish --access public
npm version major && pnpm publish --access public
```

`npm version` bumps `package.json`, creates a git commit, and tags it. The `prepublishOnly` script runs `pnpm build` automatically before publishing.

### MCP Registry

The MCP server is listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.0xSplits/splits-cli`. The listing pins an npm version, so it does not follow new releases on its own. To update it after publishing to npm:

1. Set both `version` fields in `server.json` to the version you just published. Published registry versions can't be edited.
2. Run `mcp-publisher validate server.json`.
3. As an 0xSplits org Owner, run `mcp-publisher login github --token <PAT>` with a classic PAT that has `read:org`, then `mcp-publisher publish`.

Preview what will be published:

```sh
npm pack --dry-run
```
