# Contributing

## Setup

```sh
pnpm install
```

## Development

```sh
export SPLITS_API_KEY="<your_api_key>"

# Run locally via tsx
pnpm dev accounts list
pnpm dev transactions list --limit 5
```

## Build

```sh
pnpm build
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

Preview what will be published:

```sh
npm pack --dry-run
```
