#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Cli, z } from "incur";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  CONFIG_FILE_PATH,
  defaultKeyName,
  loadLocalKeyPublic,
  removeApiKey,
  removeKey,
  resolveApiKey,
  saveApiKey,
  saveKey,
} from "./config.js";
import { downloadToFile, httpRequest, SplitsApiError } from "./http.js";
import { PERIODS, resolvePeriod, type Period } from "./periods.js";
import { bytes32Hash, evmAddress, transactionId } from "./schemas.js";
import { signTransactionLocally } from "./signing.js";

const AMOUNT_REGEX = /^(0|[1-9]\d*)(\.\d+)?$/;

const packageJsonPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "package.json",
);
const { version: cliVersion } = JSON.parse(
  readFileSync(packageJsonPath, "utf8"),
) as { version: string };

const cli = Cli.create("splits", {
  version: cliVersion,
  description: "Splits CLI — programmatic access to the Splits platform",
});

// Auth config (reads from env; both values also resolvable from
// ~/.splits/config.json via `splits auth login`). Env takes precedence.
const authEnv = z.object({
  SPLITS_API_KEY: z
    .string()
    .optional()
    .describe(
      "Splits API key (sk_read_... or legacy hex key). " +
        "Falls back to the key saved by `splits auth login` when unset.",
    ),
  SPLITS_API_URL: z
    .string()
    .optional()
    .describe(
      "Splits API base URL. " +
        "Falls back to the URL saved by `splits auth login`, then to the production URL.",
    ),
});

type AuthEnv = z.infer<typeof authEnv>;

// Shortcut: forward to the shared http helper with auth required.
const apiRequest = <T = unknown>(
  env: AuthEnv,
  path: string,
  options?: {
    method?: "GET" | "PUT" | "POST" | "DELETE";
    body?: Record<string, unknown>;
  },
): Promise<T> => httpRequest<T>(env, path, { ...options, requireAuth: true });

// MCP mode covers both invocations the harness might use: the explicit
// SPLITS_MCP_MODE=1 env (used in tests) and the documented `npx
// @splits/splits-cli --mcp` entrypoint that incur's stdio transport uses.
// Either one gates the secret-flag refusals and stdin-fast-fail.
const mcpMode = (): boolean =>
  process.env.SPLITS_MCP_MODE === "1" || process.argv.includes("--mcp");

const STDIN_TIMEOUT_MS = 5_000;

// Read stdin until EOF. Used by `auth login` and `auth import-key` so secrets
// never appear on the command line. Under MCP, stdin is closed — refuse fast
// rather than hanging. Under a non-TTY non-MCP path (cron, CI with stdin from
// /dev/null, orphaned subprocess), time out after STDIN_TIMEOUT_MS so a wedged
// parent can't hang the CLI indefinitely.
const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) return "";
  if (mcpMode()) {
    throw new Error(
      "Secrets cannot be piped into an MCP tool call. " +
        "Run `auth login` / `auth import-key` outside MCP, or set SPLITS_API_KEY in the MCP server's environment.",
    );
  }

  const read = (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string),
      );
    }
    return Buffer.concat(chunks).toString("utf-8").trim();
  })();

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(
            `No input on stdin after ${STDIN_TIMEOUT_MS / 1000}s. ` +
              `Pipe a value (e.g. \`echo "$SECRET" | splits auth login\`).`,
          ),
        ),
      STDIN_TIMEOUT_MS,
    ).unref(),
  );

  return Promise.race([read, timeout]);
};

// Helper: split a CSV string into trimmed, non-empty tokens.
const splitCsv = (s: string | undefined): string[] =>
  s
    ? s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

// Helper: refine a CSV string so each comma-separated token is a valid EVM
// address. Fails client-side before the HTTP call. Uses superRefine so the
// error message can name the offending token.
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const csvEvmAddresses = (fieldHint: string) =>
  z
    .string()
    .optional()
    .superRefine((s, ctx) => {
      if (!s) return;
      const bad = splitCsv(s).find((t) => !EVM_ADDRESS_RE.test(t));
      if (bad !== undefined) {
        ctx.addIssue({
          code: "custom",
          message:
            `${fieldHint} must be a comma-separated list of 0x-prefixed ` +
            `40-hex-char EVM addresses (invalid: ${bad})`,
        });
      }
    });

// Helper: build query string from params object
function buildQuery(
  params: Record<string, string | number | boolean | undefined>,
): string {
  const searchParams = new URLSearchParams();
  // Skip undefined and false — boolean flags are only sent when truthy
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== false) {
      searchParams.set(key, String(value));
    }
  }
  const query = searchParams.toString();
  return query ? `?${query}` : "";
}

// Day-only YYYY-MM-DD inputs are interpreted as local midnight; anything else
// passes through for the API to validate as ISO 8601.
const normalizeDateInput = (value: string | undefined) => {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(y, m - 1, d).toISOString();
  }
  return value;
};

// --period is shorthand for a start/end pair, so it cannot be combined with
// explicit bounds.
const resolveDateRange = (options: {
  startDate?: string;
  endDate?: string;
  period?: string;
}): { startDate?: string; endDate?: string } => {
  if (options.period && (options.startDate || options.endDate)) {
    throw new Error(
      `Cannot use --period together with --startDate or --endDate. Use one or the other. Valid --period values: ${PERIODS.join(", ")}.`,
    );
  }

  if (options.period) return resolvePeriod(options.period as Period);

  return {
    startDate: normalizeDateInput(options.startDate),
    endDate: normalizeDateInput(options.endDate),
  };
};

// =============================================================================
// auth
// =============================================================================

const auth = Cli.create("auth", {
  description: "Authentication and identity",
});

auth.command("whoami", {
  description:
    "Show current org, API key name, and scopes. " +
    "Also reports whether credentials came from the environment or the local keystore " +
    "and any local EOA signing key saved by `splits auth create-key`. When a local " +
    "key exists and has been registered with the backend, `localKey.signerId` is the " +
    "id needed by `accounts update-signers --add-eoa-signer-ids`; null means the key " +
    "exists locally but has not been registered (see `auth register-signer`).",
  env: authEnv,
  async run({ env }) {
    const resolved = await resolveApiKey(env);
    if (!resolved) {
      throw new SplitsApiError(
        "no-api-key",
        0,
        "No API key configured. Run `splits auth login` or export SPLITS_API_KEY.",
      );
    }
    const [response, localKey] = await Promise.all([
      apiRequest<{ data: Record<string, unknown> }>(env, "/auth/whoami"),
      loadLocalKeyPublic(),
    ]);

    let localKeyPayload:
      | (typeof localKey & { signerId: string | null })
      | null = null;
    if (localKey) {
      // Look up the registered signer id for this address, if any. One extra
      // GET per whoami, tolerant of failure — whoami is meant to be cheap and
      // machine-parseable, not a hard correctness boundary.
      let signerId: string | null = null;
      try {
        const signers = await apiRequest<{
          data: Array<{ id: string; address: string }>;
        }>(env, "/eoa_signers");
        const match = signers.data.find(
          (s) => s.address.toLowerCase() === localKey.address.toLowerCase(),
        );
        signerId = match?.id ?? null;
      } catch {
        // Swallow: whoami still reports the local key even if the signer
        // lookup fails (rate limit, transient 5xx, etc).
      }
      localKeyPayload = { ...localKey, signerId };
    }

    return {
      ...response,
      data: {
        ...response.data,
        apiKeySource: resolved.source,
        ...(localKeyPayload ? { localKey: localKeyPayload } : {}),
      },
    };
  },
});

auth.command("login", {
  description:
    "Save a Splits API key to the local config (~/.splits/config.json, mode 0600). " +
    "Prefer stdin to avoid leaking the key to shell history or tool-call transcripts: " +
    "  `echo $SPLITS_API_KEY | splits auth login`. " +
    "The saved key is only used when the SPLITS_API_KEY env var is not set — env always wins.",
  options: z.object({
    apiKey: z
      .string()
      .optional()
      .describe(
        "API key value. Refused under MCP mode; prefer stdin for secrets.",
      ),
    apiUrl: z
      .string()
      .url()
      .optional()
      .describe(
        "Optional API base URL override to persist alongside the key (e.g. staging).",
      ),
  }),
  async run({ options }) {
    if (options.apiKey !== undefined && mcpMode()) {
      throw new Error(
        "--api-key flag is refused in MCP mode (`--mcp` or SPLITS_MCP_MODE=1). " +
          "Set SPLITS_API_KEY in the MCP server's environment, or run `auth login` outside MCP.",
      );
    }

    let value = options.apiKey ?? (await readStdin());
    value = value.trim();
    if (value.length === 0) {
      throw new Error(
        "No API key provided. Pass --api-key, pipe via stdin, or export SPLITS_API_KEY.",
      );
    }

    await saveApiKey(value, { apiUrl: options.apiUrl });

    const envAlreadySet =
      typeof process.env.SPLITS_API_KEY === "string" &&
      process.env.SPLITS_API_KEY.length > 0;
    if (envAlreadySet) {
      process.stderr.write(
        "Warning: SPLITS_API_KEY env var is set and will take precedence. " +
          "The saved key is used only when the env var is unset.\n",
      );
    }

    return {
      saved: true,
      source: "keystore" as const,
      apiUrl: options.apiUrl ?? null,
      path: CONFIG_FILE_PATH,
    };
  },
});

auth.command("logout", {
  description:
    "Remove the saved API key and API URL override from the local config. " +
    "Does not affect the SPLITS_API_KEY env var or any saved local EOA key — " +
    "use `splits auth delete-key` to remove a local EOA.",
  async run() {
    const result = await removeApiKey();
    return {
      loggedOut: true,
      removedApiKey: result.hadApiKey,
      removedApiUrl: result.hadApiUrl,
    };
  },
});

auth.command("create-key", {
  description:
    "Generate a new local Ethereum EOA and save it to ~/.splits/config.json (mode 0600). " +
    "The key is used by `splits transactions sign` to approve multisig transactions locally. " +
    "By default creates the key only; pass --register to also register the address with the " +
    "backend in one call (equivalent to `create-key` + `register-signer <address>`). On " +
    "registration failure the local key is removed so the next attempt starts fresh. " +
    "Refuses if a key already exists — delete it first.",
  env: authEnv,
  options: z.object({
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional human-readable label. Defaults to a short form of the address.",
      ),
    register: z
      .boolean()
      .default(false)
      .describe(
        "Also register the new address with the backend so it can be attached " +
          "as a signer. On backend failure the local key is rolled back.",
      ),
  }),
  async run({ env, options }) {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const name = options.name ?? defaultKeyName(account.address);

    await saveKey({
      name,
      address: account.address,
      privateKey,
    });

    type RegisterResponse = {
      data: {
        id: string;
        address: string;
        name: string | null;
        email: string | null;
        lastVerifiedAt: string | null;
      };
    };

    let registered: RegisterResponse["data"] | null = null;
    if (options.register) {
      try {
        const result = await apiRequest<RegisterResponse>(env, "/eoa_signers", {
          method: "POST",
          body: {
            address: account.address,
            ...(options.name !== undefined && { name: options.name }),
          },
        });
        registered = result.data;
      } catch (err) {
        // Rollback: the local key is only useful once registered; leaving a
        // dangling local key with no backend record would confuse the next
        // run of `create-key` (it refuses when a key exists).
        await removeKey().catch(() => {
          // If rollback fails the address is already in the user's
          // terminal; the re-thrown error below tells them how to recover.
        });
        if (err instanceof SplitsApiError) {
          throw new SplitsApiError(
            err.splitsCode,
            err.status,
            `Registration failed for ${account.address}; local key removed. ` +
              `Original error: ${err.message}`,
          );
        }
        throw err;
      }
    }

    return {
      name,
      address: account.address,
      ...(registered ? { signerId: registered.id } : {}),
      warning:
        "This key is the only copy. Back up ~/.splits/config.json. Any CLI dependency can read this file.",
      path: CONFIG_FILE_PATH,
    };
  },
});

auth.command("delete-key", {
  description:
    "Remove the local EOA signing key from ~/.splits/config.json. " +
    "Does NOT revoke the signer on-chain — if the key was registered via " +
    "`update-signers`, run that command again (or the web app) to remove it.",
  async run() {
    const { previousAddress } = await removeKey();
    return {
      deleted: previousAddress !== null,
      previousAddress,
    };
  },
});

auth.command("import-key", {
  description:
    "Import an existing Ethereum private key into the local config. " +
    "Prefer stdin to avoid leaking the key to shell history or tool-call transcripts: " +
    "  `echo $PRIVATE_KEY | splits auth import-key`. " +
    "The derived address is echoed to stderr before writing; the key itself is never returned.",
  options: z.object({
    privateKey: z
      .string()
      .optional()
      .describe(
        "Private key (0x-prefixed or raw hex). Refused under MCP mode; prefer stdin.",
      ),
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional human-readable label. Defaults to a short form of the address.",
      ),
  }),
  async run({ options }) {
    if (options.privateKey !== undefined && mcpMode()) {
      throw new Error(
        "--private-key flag is refused in MCP mode (`--mcp` or SPLITS_MCP_MODE=1). " +
          "Run `auth import-key` outside MCP so the key doesn't land in the tool-call transcript.",
      );
    }

    let raw = options.privateKey ?? (await readStdin());
    raw = raw.trim();
    if (raw.length === 0) {
      throw new Error(
        "No private key provided. Pass --private-key or pipe via stdin.",
      );
    }
    const normalized = (
      raw.startsWith("0x") || raw.startsWith("0X")
        ? `0x${raw.slice(2)}`
        : `0x${raw}`
    ) as `0x${string}`;

    // viem validates length, hex shape, and curve-order internally.
    const account = privateKeyToAccount(normalized);
    const name = options.name ?? defaultKeyName(account.address);

    process.stderr.write(`Imported address: ${account.address}\n`);

    await saveKey({
      name,
      address: account.address,
      privateKey: normalized,
    });

    return {
      name,
      address: account.address,
      path: CONFIG_FILE_PATH,
    };
  },
});

auth.command("register-signer", {
  description:
    "Register an EOA address with the Splits backend so it can be attached " +
    "to smart accounts as a signer. Idempotent — re-running with the same " +
    "address returns the same id (and preserves the first name). The " +
    "returned id is what `splits accounts update-signers --add-eoa-signer-ids` " +
    "expects. The address is attributed to the user that owns the API key; " +
    "you cannot register an address on behalf of another user. " +
    "A registered EOA counts toward threshold identically to a passkey.",
  env: authEnv,
  args: z.object({
    address: evmAddress.describe("EOA address to register (0x...)"),
  }),
  options: z.object({
    name: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Optional human-readable name for this signer. First name wins — " +
          "re-registering with a different name keeps the original.",
      ),
  }),
  async run({ env, args, options }) {
    const body = {
      address: args.address,
      ...(options.name !== undefined && { name: options.name }),
    };
    const result = await apiRequest<{
      data: {
        id: string;
        address: string;
        name: string | null;
        email: string | null;
        lastVerifiedAt: string | null;
      };
    }>(env, "/eoa_signers", { method: "POST", body });
    return result;
  },
});

auth.command("signers", {
  description:
    "List EOA signers registered under the acting user. Returns the ids " +
    "needed by `splits accounts update-signers --add-eoa-signer-ids` plus " +
    "each signer's address, display name, and last verification timestamp.",
  env: authEnv,
  async run({ env }) {
    return apiRequest<{
      data: Array<{
        id: string;
        address: string;
        name: string | null;
        email: string | null;
        lastVerifiedAt: string | null;
      }>;
    }>(env, "/eoa_signers");
  },
});

cli.command(auth);

// =============================================================================
// accounts
// =============================================================================

const accounts = Cli.create("accounts", {
  description:
    "Manage accounts. Splits accounts are audited ERC-4337 smart accounts " +
    "(source: github.com/0xSplits/splits-contracts-monorepo) linked by an ownership " +
    "chain that is fixed at creation and identical on every EVM network " +
    "(CREATE2-deterministic addresses): your org's root account sits at the top with " +
    "no owner — your recovery wallets are its m-of-n signer set — the root owns the " +
    "treasury, and the treasury owns each subaccount. " +
    "Onchain, signers authorize transactions against a single m-of-n threshold — " +
    "passkeys and EOAs count equally, with no per-signer or per-operation scoping; " +
    "implementation upgrades are owner-only and unreachable by an owned account's " +
    "signers. Ownership is the recovery mechanism and cannot be altered by any " +
    "threshold of the owned account's signatures: a compromised signer key is bounded " +
    "by its subaccount and is always evictable by the owner one level up, with all " +
    "addresses unchanged. Web-approval " +
    "requirements described below are platform policy layered on top; the chain " +
    "enforces only threshold and ownership, and signing keys live with signers, " +
    "not with Splits.",
});

accounts.command("list", {
  description: "List accounts in your org",
  env: authEnv,
  options: z.object({
    includeArchived: z
      .boolean()
      .default(false)
      .describe("Include archived accounts"),
  }),
  async run({ env, options }) {
    return apiRequest(
      env,
      `/org/accounts${buildQuery({ includeArchived: options.includeArchived })}`,
    );
  },
});

accounts.command("get", {
  description: "Get account details by address",
  env: authEnv,
  args: z.object({
    address: evmAddress.describe("Account address (0x...)"),
  }),
  async run({ env, args }) {
    return apiRequest(env, `/org/accounts/${args.address}`);
  },
});

accounts.command("balances", {
  description: "Get token balances for an account",
  env: authEnv,
  args: z.object({
    address: evmAddress
      .optional()
      .describe(
        "Account address (0x...). Auto-selected if org has one account.",
      ),
  }),
  options: z.object({
    chainIds: z
      .string()
      .optional()
      .describe("Comma-separated chain IDs to filter (e.g. 1,8453)"),
  }),
  async run({ env, args, options }) {
    let address = args.address;
    if (!address) {
      const result = await apiRequest<{
        data: Array<{ address: string }>;
      }>(env, "/org/accounts");
      if (result.data.length === 1) {
        address = result.data[0].address;
      } else {
        throw new Error(
          `Multiple accounts found. Specify an address: ${result.data.map((a) => a.address).join(", ")}`,
        );
      }
    }
    return apiRequest(
      env,
      `/org/accounts/${address}/balances${buildQuery({ chainIds: options.chainIds })}`,
    );
  },
});

accounts.command("chains", {
  description: "List chains an account is deployed/synced on",
  env: authEnv,
  args: z.object({
    address: evmAddress.describe("Account address (0x...)"),
  }),
  async run({ env, args }) {
    return apiRequest(env, `/org/accounts/${args.address}/chains`);
  },
});

accounts.command("signers", {
  description:
    "List passkey and EOA signers (with current threshold) for a subaccount. " +
    "Returns the signer IDs needed by 'accounts update-signers' to add or remove signers.",
  env: authEnv,
  args: z.object({
    address: evmAddress.describe("Account address (0x...)"),
  }),
  async run({ env, args }) {
    return apiRequest(env, `/org/accounts/${args.address}/signers`);
  },
});

accounts.command("archive", {
  description:
    "Archive a subaccount by address. Fails if the account has pending state changes. Requires owner-scoped API key.",
  env: authEnv,
  args: z.object({
    address: evmAddress.describe("Account address (0x...)"),
  }),
  async run({ env, args }) {
    return apiRequest(env, `/org/accounts/${args.address}/archive`, {
      method: "PUT",
    });
  },
});

accounts.command("unarchive", {
  description:
    "Unarchive a previously archived subaccount by address. " +
    "Fails if the account has required state updates pending. Requires owner-scoped API key.",
  env: authEnv,
  args: z.object({
    address: evmAddress.describe("Account address (0x...)"),
  }),
  async run({ env, args }) {
    return apiRequest(env, `/org/accounts/${args.address}/unarchive`, {
      method: "PUT",
    });
  },
});

accounts.command("rename", {
  description:
    "Rename a subaccount by address. Name max 255 chars, trimmed. Requires owner-scoped API key.",
  env: authEnv,
  args: z.object({
    address: evmAddress.describe("Account address (0x...)"),
  }),
  options: z.object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .describe("New account name (max 255 chars)"),
  }),
  async run({ env, args, options }) {
    return apiRequest(env, `/org/accounts/${args.address}/rename`, {
      method: "PUT",
      body: { name: options.name },
    });
  },
});

accounts.command("create", {
  description:
    "Create a new subaccount with specified signers and threshold. " +
    "The subaccount is deployed with your org's treasury account as its onchain owner; " +
    "signers transact, the owner recovers (see 'splits accounts'). " +
    "Use 'members signers <userId>' to discover passkey IDs and " +
    "'auth signers' to discover EOA signer ids (register new ones with " +
    "'auth register-signer' first). Requires owner-scoped API key.",
  env: authEnv,
  options: z.object({
    name: z.string().min(1).max(255).describe("Account name (max 255 chars)"),
    passkeyIds: z
      .string()
      .optional()
      .describe(
        "Comma-separated passkey IDs from 'members signers' (e.g. id1,id2)",
      ),
    eoaSignerIds: z
      .string()
      .optional()
      .describe(
        "Preferred. Comma-separated EOA signer ids from 'auth signers' / 'auth register-signer'.",
      ),
    eoaAddresses: csvEvmAddresses("--eoa-addresses").describe(
      "Comma-separated EOA signer addresses. Each must already be registered " +
        "to your acting user via 'auth register-signer'. Convenience " +
        "alternative to `--eoa-signer-ids`.",
    ),
    threshold: z
      .number()
      .int()
      .min(1)
      .describe("Number of signers required to approve transactions"),
  }),
  async run({ env, options }) {
    const passkeyIds = splitCsv(options.passkeyIds);
    const eoaSignerIds = splitCsv(options.eoaSignerIds);
    const eoaSigners = splitCsv(options.eoaAddresses).map((address) => ({
      address,
    }));
    return apiRequest(env, "/org/accounts", {
      method: "POST",
      body: {
        name: options.name,
        passkeyIds,
        eoaSignerIds,
        eoaSigners,
        threshold: options.threshold,
      },
    });
  },
});

accounts.command("update-signers", {
  description:
    "Propose adding or removing signers (passkeys and/or EOAs) and/or changing the threshold on a subaccount. " +
    "EOA adds reference ids returned by `splits auth register-signer`; register the address first, then attach " +
    "its id here. The same id can be attached to any number of accounts. " +
    "Primary use case: adding an external (EOA) key so an agent or automation can operate on the account headlessly " +
    "— passkeys require a biometric 2nd factor that agents cannot provide. " +
    "The proposal is created immediately; it must be approved and signed on the web via the returned signUrl. " +
    "(The web-approval step is platform policy, not onchain enforcement — size thresholds assuming any " +
    "threshold-meeting signer set can change signers.) " +
    "Poll 'transactions get <id>' to watch status transition from CREATED to EXECUTED. " +
    "If this returns 409 SMART_ACCOUNT_STATE_CHANGE_IN_PROGRESS, call 'transactions list --account <address>' " +
    "to find the pending proposal; it must be signed (web) or cancelled before retrying. " +
    "Recovery / resetting signers stays web-only — no CLI or API route exists. " +
    "(Recovery is the owning account's contract-enforced right — see 'splits accounts'; the root account " +
    "has no owner and cannot be recovered from above.) " +
    "Updates apply to every active network on the org automatically. " +
    "Use 'accounts signers <address>' to discover existing signer IDs (passkeys and EOAs), and " +
    "`auth signers` to list the EOA ids registered under the acting user. " +
    "Requires owner-scoped API key.",
  env: authEnv,
  args: z.object({
    account: evmAddress.describe("Subaccount address (0x...)"),
  }),
  options: z.object({
    addEoaSignerIds: z
      .string()
      .optional()
      .describe(
        "Preferred. Comma-separated EOA signer ids (from `auth register-signer` / `auth signers`) to attach. " +
          "The same id can be attached to multiple accounts.",
      ),
    addEoaAddresses: csvEvmAddresses("--add-eoa-addresses").describe(
      "Comma-separated EOA signer addresses to attach. Each must already be " +
        "registered to your acting user via `auth register-signer`. " +
        "Convenience alternative to `--add-eoa-signer-ids` when you have the " +
        "address but not the id.",
    ),
    removeEoaIds: z
      .string()
      .optional()
      .describe(
        "Comma-separated EOA signer IDs (from 'accounts signers <address>') to remove",
      ),
    addPasskeyIds: z
      .string()
      .optional()
      .describe(
        "Comma-separated passkey authenticator IDs to add (from 'members signers')",
      ),
    removePasskeyIds: z
      .string()
      .optional()
      .describe(
        "Comma-separated passkey authenticator IDs to remove (from 'members signers')",
      ),
    threshold: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("New signer threshold. Unchanged if omitted."),
    memo: z.string().optional().describe("Optional memo (max 500 chars)"),
  }),
  async run({ env, args, options }) {
    const body = {
      account: args.account,
      addPasskeyIds: splitCsv(options.addPasskeyIds),
      removePasskeyIds: splitCsv(options.removePasskeyIds),
      addEoaSignerIds: splitCsv(options.addEoaSignerIds),
      addEoaSigners: splitCsv(options.addEoaAddresses).map((address) => ({
        address,
      })),
      removeEoaSignerIds: splitCsv(options.removeEoaIds),
      ...(options.threshold !== undefined && { threshold: options.threshold }),
      ...(options.memo !== undefined && { memo: options.memo }),
    } satisfies Record<string, unknown>;

    return apiRequest<{ data?: { signUrl?: string } }>(
      env,
      "/proposals/update_signers",
      { method: "POST", body },
    );
  },
});

cli.command(accounts);

// =============================================================================
// accounting
// =============================================================================

const accounting = Cli.create("accounting", {
  description: "Tax lots, lot assertions, accounting reports, and imports",
});

const REPORT_NAMES = [
  "transactions",
  "lots",
  "lot-timeline",
  "realized-gains",
  "tokens",
  "statement",
] as const;

const REPORT_POLL_INTERVAL_MS = 2_000;

type GenerateReportResponse = {
  data: {
    reportId: string;
    fileName: string;
    userFriendlyFileName: string;
    isLongRunningOperation: boolean;
    csvDownloadUrl: string | null;
    jobId: string | null;
  };
};

type ReportJobResponse = {
  data: {
    reportId: string;
    status: string;
    fileName: string;
    csvDownloadUrl: string | null;
    failed: boolean;
    failureReason: string | null;
  };
};

// Not unref'd: while a report is generating this timer is the only thing
// keeping the process alive.
const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// A report big enough to outrun the request comes back as a job id instead of
// a URL, so every caller that wants a file has to poll for one.
const waitForReportUrl = async (
  env: AuthEnv,
  jobId: string,
  timeoutSeconds: number,
): Promise<string> => {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    await sleep(REPORT_POLL_INTERVAL_MS);
    const { data } = await apiRequest<ReportJobResponse>(
      env,
      `/accounting/reports/jobs/${jobId}`,
    );
    if (data.failed) {
      throw new Error(
        `Report generation failed (job ${jobId})${
          data.failureReason ? `: ${data.failureReason}` : ""
        }. Report jobs do not retry; run the command again.`,
      );
    }
    if (data.csvDownloadUrl) return data.csvDownloadUrl;
  }

  throw new Error(
    `Report is still generating after ${timeoutSeconds}s. Poll it with \`splits accounting reports job ${jobId}\`, or retry with a longer --timeout.`,
  );
};

// --out takes either a file path or a directory to drop the report into.
const resolveReportPath = (out: string, fileName: string, extension: string) => {
  const isDirectory =
    out.endsWith("/") ||
    (existsSync(out) && statSync(out).isDirectory());
  return isDirectory ? join(out, `${fileName}.${extension}`) : out;
};

const reports = Cli.create("reports", {
  description: "Generate and download accounting reports",
});

reports.command("list", {
  description:
    "List the 50 most recent reports generated for your org, newest first. " +
    "A ready report carries a downloadUrl you can fetch directly.",
  env: authEnv,
  async run({ env }) {
    return apiRequest(env, "/accounting/reports");
  },
});

reports.command("generate", {
  description:
    "Generate a report and return its download URL, or write it to disk with --out. " +
    "Waits for reports large enough to be queued, up to --timeout. " +
    "Reports: transactions (all activity), lots (open inventory as of a date), " +
    "lot-timeline (per-lot open and close events), realized-gains (RGL), " +
    "tokens (per-token balances), statement (transactions + tokens + gains, always PDF). " +
    "Examples: { report: 'realized-gains', period: 'lastYear', fileFormat: 'pdf', out: './rgl.pdf' }; " +
    "{ report: 'lots', openAsOf: '2026-12-31' }",
  env: authEnv,
  args: z.object({
    report: z.enum(REPORT_NAMES).describe("Which report to generate"),
  }),
  options: z.object({
    fileFormat: z
      .enum(["csv", "pdf"])
      .default("csv")
      .describe(
        "File format to generate. The statement is always a PDF regardless of this flag.",
      ),
    out: z
      .string()
      .optional()
      .describe(
        "Write the report to this path instead of returning a URL. A directory (or a path ending in '/') writes under the report's generated filename.",
      ),
    timeout: z
      .number()
      .min(10)
      .max(1800)
      .default(300)
      .describe(
        "Seconds to wait for a queued report before giving up and returning its job id.",
      ),
    accountIds: z
      .string()
      .optional()
      .describe(
        "Comma-separated account ids to limit the report to (ids come from 'accounts list', not addresses). Omit for every account.",
      ),
    chainIds: z
      .string()
      .optional()
      .describe("Comma-separated chain ids (e.g. '8453,1'). Omit for all chains."),
    tokens: z
      .string()
      .optional()
      .describe("Comma-separated token addresses to limit the report to"),
    search: z
      .string()
      .optional()
      .describe("Substring search, applied to memos or token symbols depending on the report"),
    openAsOf: z
      .string()
      .optional()
      .describe(
        "For the lots report: the instant to read open inventory at. ISO 8601. Defaults to now.",
      ),
    startDate: z
      .string()
      .optional()
      .describe("Inclusive lower bound on the reporting period. ISO 8601."),
    endDate: z
      .string()
      .optional()
      .describe("EXCLUSIVE upper bound on the reporting period. ISO 8601."),
    period: z
      .enum(PERIODS)
      .optional()
      .describe(
        "Date range shorthand resolved in your local timezone. Mutually exclusive with --startDate / --endDate.",
      ),
  }),
  async run({ env, args, options }) {
    const { startDate, endDate } = resolveDateRange(options);
    const fileFormat =
      args.report === "statement" ? "pdf" : options.fileFormat;

    const { data } = await apiRequest<GenerateReportResponse>(
      env,
      `/accounting/reports/${args.report}${buildQuery({
        format: fileFormat,
        accountIds: options.accountIds,
        chainIds: options.chainIds,
        tokens: options.tokens,
        search: options.search,
        openAsOf: normalizeDateInput(options.openAsOf),
        startDate,
        endDate,
      })}`,
      // Generating writes a report row and can queue a job, so it is a PUT
      // and needs a write-scoped key.
      { method: "PUT" },
    );

    const downloadUrl =
      data.csvDownloadUrl ??
      (data.jobId
        ? await waitForReportUrl(env, data.jobId, options.timeout)
        : null);

    if (!downloadUrl) {
      throw new Error(
        `Report ${data.reportId} finished without a download URL. Check 'accounting reports list' for its status.`,
      );
    }

    if (!options.out) {
      return {
        report: args.report,
        reportId: data.reportId,
        fileFormat,
        fileName: data.userFriendlyFileName,
        queued: data.isLongRunningOperation,
        downloadUrl,
      };
    }

    const { path, bytes } = await downloadToFile(
      downloadUrl,
      resolveReportPath(options.out, data.userFriendlyFileName, fileFormat),
    );

    return {
      report: args.report,
      reportId: data.reportId,
      fileFormat,
      queued: data.isLongRunningOperation,
      path,
      bytes,
    };
  },
});

reports.command("job", {
  description:
    "Check a queued report. Returns its download URL once the file is written. " +
    "Report jobs do not retry, so failed is final.",
  env: authEnv,
  args: z.object({
    jobId: z.string().describe("Job id returned by 'accounting reports generate'"),
  }),
  async run({ env, args }) {
    return apiRequest(env, `/accounting/reports/jobs/${args.jobId}`);
  },
});

accounting.command(reports);

const lots = Cli.create("lots", {
  description: "Read tax lots and their assertion history",
});

lots.command("list", {
  description:
    "List tax lots, one page at a time. Use this to find the lot id, target key, " +
    "anchor transfer, or transfer id an assertion needs to name.",
  env: authEnv,
  options: z.object({
    pageIndex: z.number().min(0).default(0).describe("Zero-based page index"),
    pageSize: z.number().min(1).max(50).default(50).describe("Rows per page, max 50"),
    accountIds: z
      .string()
      .optional()
      .describe("Comma-separated account ids (from 'accounts list')"),
    chainIds: z.string().optional().describe("Comma-separated chain ids"),
    tokens: z.string().optional().describe("Comma-separated token addresses"),
    status: z
      .enum(["open", "closed", "all"])
      .optional()
      .describe("Which lots to include. Defaults to open."),
    openAsOf: z
      .string()
      .optional()
      .describe("Read open inventory as of this instant. ISO 8601. Defaults to now."),
    search: z.string().optional().describe("Substring search across token symbol and name"),
    acquiredAfter: z
      .string()
      .optional()
      .describe("Only lots acquired at or after this instant. ISO 8601."),
    minRemaining: z
      .string()
      .optional()
      .describe("Inclusive lower bound on remaining quantity, in whole tokens"),
    maxRemaining: z
      .string()
      .optional()
      .describe("Inclusive upper bound on remaining quantity, in whole tokens"),
    minCostBasis: z
      .string()
      .optional()
      .describe("Inclusive lower bound on cost basis, in USD"),
    maxCostBasis: z
      .string()
      .optional()
      .describe("Inclusive upper bound on cost basis, in USD"),
    sortBy: z
      .enum(["acquisitionTime", "costBasis"])
      .optional()
      .describe("Sort column"),
    sortDirection: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
  }),
  async run({ env, options }) {
    return apiRequest(
      env,
      `/accounting/lots${buildQuery({
        pageIndex: options.pageIndex,
        pageSize: options.pageSize,
        accountIds: options.accountIds,
        chainIds: options.chainIds,
        tokens: options.tokens,
        status: options.status,
        openAsOf: normalizeDateInput(options.openAsOf),
        search: options.search,
        startDate: normalizeDateInput(options.acquiredAfter),
        minRemaining: options.minRemaining,
        maxRemaining: options.maxRemaining,
        minCostBasis: options.minCostBasis,
        maxCostBasis: options.maxCostBasis,
        sortBy: options.sortBy,
        sortDirection: options.sortDirection,
      })}`,
    );
  },
});

lots.command("assertions", {
  description:
    "List every assertion written against a lot, oldest first, with the value each one replaced. " +
    "An unknown lot reads as empty.",
  env: authEnv,
  args: z.object({
    lotId: z.string().describe("Lot id from 'accounting lots list'"),
  }),
  async run({ env, args }) {
    return apiRequest(env, `/accounting/lots/${args.lotId}/assertions`);
  },
});

accounting.command(lots);

const assertions = Cli.create("assertions", {
  description: "Seed, edit, revoke, and designate tax lots",
});

type LotAssertion = Record<string, unknown>;

const writeAssertion = (env: AuthEnv, assertion: LotAssertion) =>
  apiRequest(env, "/accounting/lot-assertions", {
    method: "PUT",
    body: { assertion },
  });

// Every assertion names the account, chain, and token it applies to.
const assertionTarget = {
  accountId: z
    .string()
    .describe("Account id the lot belongs to (from 'accounts list')"),
  chainId: z.number().int().positive().describe("Chain id"),
  token: evmAddress.describe("Token contract address (0x...)"),
};

assertions.command("seed", {
  description:
    "Seed opening inventory: a lot that predates Splits custody. " +
    "Requires unit price, acquisition time, and quantity together, since a seed materializes the whole lot. " +
    "Quantity is in base units (wei for ETH, 6-decimal units for USDC).",
  env: authEnv,
  options: z.object({
    ...assertionTarget,
    unitPrice: z
      .string()
      .regex(AMOUNT_REGEX, "Must be a non-negative decimal (e.g. '1500.50')")
      .describe("Cost basis per whole token, in USD"),
    acquiredAt: z
      .string()
      .describe("When the lot was acquired. ISO 8601, must be in the past."),
    quantity: z
      .string()
      .regex(/^\d+$/, "Must be an integer amount in base units")
      .describe("Lot size in base units"),
    targetKey: z
      .string()
      .min(1)
      .describe(
        "Caller-chosen key naming the seeded lot. Reuse it to correct that lot; pick a new one for a new lot. " +
          "Rerunning with the same key updates the lot instead of creating a second one.",
      ),
  }),
  async run({ env, options }) {
    return writeAssertion(env, {
      kind: "seed",
      smartAccountId: options.accountId,
      chainId: options.chainId,
      tokenAddress: options.token,
      unitPrice: options.unitPrice,
      acquisitionTime: normalizeDateInput(options.acquiredAt),
      quantity: options.quantity,
      targetKey: options.targetKey,
    });
  },
});

assertions.command("edit", {
  description:
    "Correct a lot the engine derived, naming it by the transfer it opened from. " +
    "Asserts at least one of unit price, acquisition time, or origin lot. " +
    "Quantity is never editable: the account's real balance is ground truth.",
  env: authEnv,
  options: z.object({
    ...assertionTarget,
    sourceTransferId: z
      .string()
      .describe("Transfer the lot opened from ('sourceTransferId' on the lot)"),
    anchorOriginLotId: z
      .string()
      .optional()
      .describe(
        "Origin lot currently on the lot being edited ('originLotId'). Part of the lot's identity, not a new value.",
      ),
    unitPrice: z
      .string()
      .regex(AMOUNT_REGEX, "Must be a non-negative decimal (e.g. '1500.50')")
      .optional()
      .describe("Corrected cost basis per whole token, in USD"),
    acquiredAt: z
      .string()
      .optional()
      .describe("Corrected acquisition time. ISO 8601, must be in the past."),
    originLotId: z
      .string()
      .optional()
      .describe("Corrected lot this one carries basis from"),
  }),
  async run({ env, options }) {
    if (!options.unitPrice && !options.acquiredAt && !options.originLotId) {
      throw new Error(
        "An edit must assert at least one of --unit-price, --acquired-at, or --origin-lot-id.",
      );
    }

    return writeAssertion(env, {
      kind: "edit",
      smartAccountId: options.accountId,
      chainId: options.chainId,
      tokenAddress: options.token,
      anchor: {
        sourceTransferId: options.sourceTransferId,
        originLotId: options.anchorOriginLotId ?? null,
      },
      unitPrice: options.unitPrice,
      acquisitionTime: normalizeDateInput(options.acquiredAt),
      originLotId: options.originLotId,
    });
  },
});

assertions.command("revoke", {
  description:
    "Withdraw an earlier assertion, returning the lot to what the engine derived. " +
    "Names exactly one of --target-key (a seed), --source-transfer-id (an edit), or --transfer-id (a designation).",
  env: authEnv,
  options: z.object({
    ...assertionTarget,
    targetKey: z.string().optional().describe("Target key of a seeded lot"),
    sourceTransferId: z
      .string()
      .optional()
      .describe("Transfer an edited lot opened from"),
    anchorOriginLotId: z
      .string()
      .optional()
      .describe("Origin lot on the edited lot, when it has one"),
    transferId: z
      .string()
      .optional()
      .describe("Inbound transfer a designation marked"),
  }),
  async run({ env, options }) {
    const named = [
      options.targetKey,
      options.sourceTransferId,
      options.transferId,
    ].filter((value) => value !== undefined);

    if (named.length !== 1) {
      throw new Error(
        "A revoke names exactly one of --target-key, --source-transfer-id, or --transfer-id.",
      );
    }

    return writeAssertion(env, {
      kind: "revoke",
      smartAccountId: options.accountId,
      chainId: options.chainId,
      tokenAddress: options.token,
      targetKey: options.targetKey,
      anchor: options.sourceTransferId
        ? {
            sourceTransferId: options.sourceTransferId,
            originLotId: options.anchorOriginLotId ?? null,
          }
        : undefined,
      transferId: options.transferId,
    });
  },
});

assertions.command("designate", {
  description:
    "Mark an inbound transfer as drawing from seeded inventory, so it carries basis " +
    "from the seed instead of opening a fresh lot at the transfer's price.",
  env: authEnv,
  options: z.object({
    ...assertionTarget,
    transferId: z
      .string()
      .describe("Inbound transfer to designate"),
  }),
  async run({ env, options }) {
    return writeAssertion(env, {
      kind: "designate",
      smartAccountId: options.accountId,
      chainId: options.chainId,
      tokenAddress: options.token,
      transferId: options.transferId,
    });
  },
});

assertions.command("bulk", {
  description:
    "Write up to 250 assertions from a JSON file, as one atomic insert: a rejected row leaves nothing behind. " +
    "The file holds an array of assertion objects, each shaped like the body the single-assertion commands send " +
    "({ kind, smartAccountId, chainId, tokenAddress, ... }). Every seed must carry a targetKey, so re-running the " +
    "same file corrects those lots instead of creating a second set of them.",
  env: authEnv,
  options: z.object({
    file: z
      .string()
      .describe("Path to a JSON file holding an array of assertions"),
  }),
  async run({ env, options }) {
    const parsed: unknown = JSON.parse(readFileSync(options.file, "utf8"));

    if (!Array.isArray(parsed)) {
      throw new Error(
        `${options.file} must hold a JSON array of assertion objects.`,
      );
    }

    return apiRequest(env, "/accounting/lot-assertions/bulk", {
      method: "PUT",
      body: { assertions: parsed },
    });
  },
});

accounting.command(assertions);

const imports = Cli.create("imports", {
  description: "Import external addresses into accounting",
});

imports.command("create", {
  description:
    "Import an address the org held before Splits, so its history feeds lot accounting. " +
    "Queues a per-chain backfill; poll it with 'accounting imports status'. " +
    "Replaying the same import returns the existing account rather than creating a second one.",
  env: authEnv,
  options: z.object({
    name: z.string().min(1).describe("Name for the imported account"),
    address: evmAddress.describe("Address to import (0x...)"),
    chainIds: z
      .string()
      .describe("Comma-separated chain ids to import history from (e.g. '8453,1')"),
    cutoffAt: z
      .string()
      .optional()
      .describe(
        "Ignore activity after this instant, e.g. the date the treasury migrated to Splits. ISO 8601. Omit to import everything.",
      ),
  }),
  async run({ env, options }) {
    const chainIds = splitCsv(options.chainIds).map((id) => {
      const parsed = Number(id);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid chain id: ${id}`);
      }
      return parsed;
    });

    if (chainIds.length === 0) {
      throw new Error("--chain-ids must name at least one chain.");
    }

    return apiRequest(env, "/accounting/imports", {
      method: "PUT",
      body: {
        name: options.name,
        address: options.address,
        chainIds,
        cutoffAt: normalizeDateInput(options.cutoffAt),
      },
    });
  },
});

imports.command("list", {
  description: "List imported accounts and their cutoff dates",
  env: authEnv,
  async run({ env }) {
    return apiRequest(env, "/accounting/imports");
  },
});

imports.command("status", {
  description:
    "Check the per-chain backfill for an import. Name the same chains the import was created with.",
  env: authEnv,
  args: z.object({
    accountId: z.string().describe("Imported account id from 'accounting imports create'"),
  }),
  options: z.object({
    chainIds: z
      .string()
      .describe("Comma-separated chain ids the import was created with"),
  }),
  async run({ env, args, options }) {
    return apiRequest(
      env,
      `/accounting/imports/${args.accountId}/jobs${buildQuery({
        chainIds: options.chainIds,
      })}`,
    );
  },
});

accounting.command(imports);

cli.command(accounting);

// =============================================================================
// transactions
// =============================================================================

const transactions = Cli.create("transactions", {
  description: "Manage transactions",
});

transactions.command("list", {
  description:
    "List transactions for your org with optional filters. Examples: " +
    "find ~$5k payment to Acme last month: { period: 'lastMonth', memo: 'Acme', minAmount: '4500', maxAmount: '5500', direction: 'outbound' }; " +
    "all inbound activity this year on Base: { chainId: 8453, period: 'thisYear', direction: 'inbound' }; " +
    "specific transaction by memo with explicit dates: { memo: 'Q1 payroll', startDate: '2026-01-01T00:00:00Z', endDate: '2026-04-01T00:00:00Z' }; " +
    "look up a transaction by its user-op hash returned from 'transactions sign': { userOpHash: '0x1dfe…dcf' }; " +
    "look up an on-chain transaction by hash: { transactionHash: '0xabc…def', chainId: 8453 }",
  env: authEnv,
  options: z.object({
    chainId: z.number().optional().describe("Filter by chain ID"),
    limit: z
      .number()
      .min(1)
      .max(200)
      .default(50)
      .describe("Max results to return"),
    account: z
      .string()
      .optional()
      .describe(
        "Filter by smart account address. Single address or comma-separated list (e.g. '0xa…,0xb…'). Results union across all listed accounts.",
      ),
    direction: z
      .enum(["inbound", "outbound"])
      .optional()
      .describe(
        "Filter by money flow. 'inbound' returns only inbound asset transfers (excludes splits-initiated transactions, which are always outbound). 'outbound' returns splits transactions plus outbound asset transfers. Omit for both.",
      ),
    minAmount: z
      .string()
      .regex(AMOUNT_REGEX, "Must be a non-negative decimal (e.g. '1500.50')")
      .optional()
      .describe(
        "Inclusive lower bound on the absolute USD value. Positive decimal string (e.g. '1500.50'). Sign-agnostic — '1500' matches both +$1500 and -$1500. Excludes transactions with no resolved USD price.",
      ),
    maxAmount: z
      .string()
      .regex(AMOUNT_REGEX, "Must be a non-negative decimal (e.g. '1500.50')")
      .optional()
      .describe(
        "Inclusive upper bound on the absolute USD value. Same format as minAmount. Excludes transactions with no resolved USD price.",
      ),
    startDate: z
      .string()
      .optional()
      .describe(
        "Inclusive lower bound on transactionTime. ISO 8601 (YYYY-MM-DD interpreted as local-midnight, then converted to UTC).",
      ),
    endDate: z
      .string()
      .optional()
      .describe(
        "EXCLUSIVE upper bound on transactionTime. ISO 8601. '2026-04-01' does NOT include April 1. Use 2026-04-02 to include April 1.",
      ),
    period: z
      .enum(PERIODS)
      .optional()
      .describe(
        "Date range shorthand resolved in your local timezone. Mutually exclusive with --startDate / --endDate. Valid values: thisWeek, thisMonth, thisYear, lastWeek, lastMonth, lastYear, last30Days, last90Days, last6Months. Omit for all time.",
      ),
    memo: z
      .string()
      .min(3, "Memo search must be at least 3 characters")
      .max(500, "Memo search must be at most 500 characters")
      .optional()
      .describe(
        "Case-insensitive substring search across transaction and asset-transfer memos. Min 3, max 500 chars. Most efficient combined with --account, --chainId, or a date range.",
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        "Pagination cursor from a previous response. You MUST replay the same filter values used on the request that produced this cursor.",
      ),
    transactionHash: bytes32Hash
      .optional()
      .describe(
        "Filter by on-chain transaction hash (0x-prefixed, 32 bytes). Matches splits-initiated transactions and asset transfers in your org. Combine with --chainId to disambiguate the same hash across chains.",
      ),
    userOpHash: bytes32Hash
      .optional()
      .describe(
        "Filter by ERC-4337 user-operation hash (0x-prefixed, 32 bytes). Returns 0 or 1 result. Only splits-initiated transactions have a userOpHash; asset-transfer rows are excluded when this filter is set. Use this to look up a transaction submitted via 'transactions sign --submit' from the returned userOpHash.",
      ),
  }),
  async run({ env, options }) {
    const { startDate, endDate } = resolveDateRange(options);

    return apiRequest(
      env,
      `/transactions${buildQuery({
        chainId: options.chainId,
        limit: options.limit,
        account: options.account,
        direction: options.direction,
        minAmount: options.minAmount,
        maxAmount: options.maxAmount,
        startDate,
        endDate,
        memo: options.memo,
        cursor: options.cursor,
        transactionHash: options.transactionHash,
        userOpHash: options.userOpHash,
      })}`,
    );
  },
});

transactions.command("get", {
  description: "Get details for a specific transaction",
  env: authEnv,
  args: z.object({
    id: transactionId.describe("Transaction ID"),
  }),
  async run({ env, args }) {
    return apiRequest(env, `/transactions/${args.id}`);
  },
});

transactions.command("memo", {
  description: "Set or clear the memo on a transaction",
  env: authEnv,
  args: z.object({
    id: transactionId.describe("Transaction ID"),
  }),
  options: z.object({
    memo: z
      .string()
      .max(500)
      .describe("New memo text (max 500 chars). Empty string clears the memo."),
  }),
  async run({ env, args, options }) {
    return apiRequest(env, `/transactions/${args.id}`, {
      method: "PUT",
      body: { memo: options.memo },
    });
  },
});

// -----------------------------------------------------------------------------
// transactions properties (subgroup)
// -----------------------------------------------------------------------------

const properties = Cli.create("properties", {
  description: "Read and write custom JSON metadata on transactions",
});

// Recursive JSON value zod schema, mirroring the server's shape but without
// the size cap (server enforces). Allows nested objects/arrays of any standard
// JSON type. Used by both the --properties option and the typed body the API
// receives. Top level must be an object whose keys are non-empty strings.
const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const propertiesObjectSchema = z.record(z.string().min(1), jsonValueSchema);
const propertiesOptionSchema = z.union([propertiesObjectSchema, z.string()]);

const parsePropertiesOption = (
  value: z.infer<typeof propertiesOptionSchema> | undefined,
): Record<string, unknown> | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return value;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid JSON object literal for --properties.");
  }

  const result = propertiesObjectSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("--properties must be a JSON object with non-empty keys.");
  }
  return result.data;
};

// Parse a single `--property key=value` argument into a [key, value] tuple.
// Splits on the first '=' so values may contain further '=' characters.
// Throws on missing '=' or empty key.
const parseProperty = (arg: string): [string, string] => {
  const eq = arg.indexOf("=");
  if (eq === -1) {
    throw new Error(
      `Invalid --property '${arg}': missing '='. Use key=value format.`,
    );
  }
  const key = arg.slice(0, eq);
  if (key.length === 0) {
    throw new Error(`Invalid --property '${arg}': empty key.`);
  }
  return [key, arg.slice(eq + 1)];
};

// Apply --property k=v overlays in order. Last write wins; warns on duplicates
// to stderr so AI agents don't silently lose data on accidental dup keys.
const applyPropertyOverlays = (
  base: Record<string, unknown>,
  overlays: string[] | undefined,
): Record<string, unknown> => {
  if (!overlays || overlays.length === 0) return base;
  const result: Record<string, unknown> = { ...base };
  const seen = new Set<string>();
  for (const arg of overlays) {
    const [key, value] = parseProperty(arg);
    if (seen.has(key)) {
      process.stderr.write(
        `warning: duplicate --property key '${key}'; last value wins\n`,
      );
    }
    seen.add(key);
    result[key] = value;
  }
  return result;
};

properties.command("set", {
  description:
    "Shallow-merge custom JSON metadata onto a transaction (≤ 500 chars minified).",
  env: authEnv,
  args: z.object({
    id: transactionId.describe("Transaction ID"),
  }),
  options: z.object({
    properties: propertiesOptionSchema
      .optional()
      .describe(
        'JSON object literal to shallow-merge into existing properties. Any --property overlays are applied on top. To load from a file, use shell substitution: --properties "$(cat props.json)"',
      ),
    property: z
      .array(z.string())
      .optional()
      .describe(
        "Set a single key/value pair as a string; repeatable. Splits on the first '='. Example: --property invoice=INV-42 --property region=us-east. Use 'replace' for non-string types or 'unset' to delete.",
      ),
    unset: z
      .array(z.string())
      .optional()
      .describe(
        "Delete a key from the existing properties; repeatable. Example: --unset oldkey",
      ),
  }),
  async run({ env, args, options }) {
    if (
      options.properties === undefined &&
      (!options.property || options.property.length === 0) &&
      (!options.unset || options.unset.length === 0)
    ) {
      throw new Error(
        "set requires at least one --properties, --property, or --unset. To clear properties entirely, use 'properties clear'.",
      );
    }
    const properties = parsePropertiesOption(options.properties);
    // Read current state for the merge.
    const current = await apiRequest<{
      data?: { properties?: Record<string, unknown> | null };
    }>(env, `/transactions/${args.id}`);
    const base: Record<string, unknown> = {
      ...(current.data?.properties ?? {}),
    };
    const merged = applyPropertyOverlays(
      { ...base, ...(properties ?? {}) },
      options.property,
    );
    if (options.unset) {
      for (const key of options.unset) delete merged[key];
    }
    return apiRequest(env, `/transactions/${args.id}`, {
      method: "PUT",
      body: { properties: merged },
    });
  },
});

properties.command("replace", {
  description:
    "Atomically replace all custom JSON metadata on a transaction (≤ 500 chars minified). Skips read-before-write.",
  env: authEnv,
  args: z.object({
    id: transactionId.describe("Transaction ID"),
  }),
  options: z.object({
    properties: propertiesOptionSchema
      .optional()
      .describe(
        'JSON object literal. Used as the base; any --property overlays are applied on top. To load from a file, use shell substitution: --properties "$(cat props.json)"',
      ),
    property: z
      .array(z.string())
      .optional()
      .describe(
        "String key/value overlays applied on top of --properties; repeatable. Splits on the first '='.",
      ),
  }),
  async run({ env, args, options }) {
    if (
      options.properties === undefined &&
      (!options.property || options.property.length === 0)
    ) {
      throw new Error(
        "replace requires at least one of --properties or --property. To clear properties entirely, use 'properties clear'.",
      );
    }
    const base: Record<string, unknown> =
      parsePropertiesOption(options.properties) ?? {};
    const next = applyPropertyOverlays(base, options.property);
    return apiRequest(env, `/transactions/${args.id}`, {
      method: "PUT",
      body: { properties: next },
    });
  },
});

properties.command("clear", {
  description: "Clear all custom JSON metadata from a transaction.",
  env: authEnv,
  args: z.object({
    id: transactionId.describe("Transaction ID"),
  }),
  async run({ env, args }) {
    return apiRequest(env, `/transactions/${args.id}`, {
      method: "PUT",
      body: { properties: null },
    });
  },
});

transactions.command(properties);

transactions.command("update-gas-estimation", {
  description:
    "Update gas estimates for an existing transaction. For multisig, run this when one signer remains.",
  env: authEnv,
  args: z.object({
    id: transactionId.describe("Transaction ID"),
  }),
  async run({ env, args }) {
    return apiRequest(env, `/transactions/${args.id}/update_gas_estimation`, {
      method: "PUT",
    });
  },
});

// -----------------------------------------------------------------------------
// transactions create (subgroup)
// -----------------------------------------------------------------------------

const create = Cli.create("create", {
  description: "Create transaction proposals",
});

create.command("transfer", {
  description:
    "Create a token transfer proposal from a smart account. Specify amount in human-readable units (e.g. '100' for 100 USDC). Returns the proposal with gas estimates.",
  env: authEnv,
  options: z.object({
    account: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address")
      .describe(
        "The smart account address to create the proposal from (0x-prefixed, 40 hex chars)",
      ),
    chainId: z
      .number()
      .describe(
        "The chain ID where the smart account is deployed (e.g., 1 for Ethereum, 8453 for Base)",
      ),
    recipient: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address")
      .describe(
        "The recipient address for the transfer (0x-prefixed, 40 hex chars, cannot be zero address)",
      ),
    token: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid token address")
      .describe("The token contract address to transfer"),
    amount: z
      .string()
      .regex(
        /^(0|[1-9]\d*)(\.\d+)?$/,
        "Must be a positive decimal number (no scientific notation, no negatives, no leading zeros)",
      )
      .describe(
        "The amount to transfer in human-readable units (e.g., '100' for 100 USDC, '0.5' for 0.5 ETH)",
      ),
    memo: z
      .string()
      .max(500)
      .optional()
      .describe("Optional memo for the transaction (max 500 chars)"),
    properties: propertiesOptionSchema
      .optional()
      .describe(
        'Optional custom JSON metadata. Total minified ≤ 500 chars. Used as the base; any --property overlays are applied on top. To load from a file, use shell substitution: --properties "$(cat props.json)"',
      ),
    property: z
      .array(z.string())
      .optional()
      .describe(
        "String key/value overlays for properties; repeatable. Splits on the first '='. Example: --property invoice=INV-42",
      ),
    name: z
      .string()
      .max(200)
      .optional()
      .describe(
        "Optional name for the proposal. If omitted, auto-generated from transfer details",
      ),
    validUntil: z
      .number()
      .optional()
      .describe(
        "Unix timestamp (seconds) when the proposal expires. Defaults to 7 days from now. Must be in the future and at most 30 days out.",
      ),
  }),
  async run({ env, options }) {
    const properties =
      options.properties !== undefined || options.property?.length
        ? applyPropertyOverlays(
            parsePropertiesOption(options.properties) ?? {},
            options.property,
          )
        : undefined;
    const body = {
      account: options.account,
      chainId: options.chainId,
      recipient: options.recipient,
      token: options.token,
      amount: options.amount,
      ...(options.memo !== undefined && { memo: options.memo }),
      ...(properties !== undefined && { properties }),
      ...(options.name !== undefined && { name: options.name }),
      ...(options.validUntil !== undefined && {
        validUntil: options.validUntil,
      }),
    } satisfies Record<string, unknown>;
    return apiRequest<{ data?: unknown }>(env, "/proposals/transfer", {
      method: "POST",
      body,
    });
  },
});

create.command("custom", {
  description:
    "Create a transaction proposal with raw EVM calls. Use for any on-chain action including contract interactions, approvals, and swaps.",
  env: authEnv,
  options: z.object({
    account: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address")
      .describe(
        "The smart account address to create the proposal from (0x-prefixed, 40 hex chars)",
      ),
    chainId: z
      .number()
      .describe(
        "The chain ID where the smart account is deployed (e.g., 1 for Ethereum, 8453 for Base)",
      ),
    calls: z
      .array(
        z.object({
          to: z
            .string()
            .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid address")
            .describe("Target contract address (0x-prefixed, 40 hex chars)"),
          data: z
            .string()
            .regex(/^0x[a-fA-F0-9]*$/, "Invalid hex calldata")
            .describe("Hex-encoded calldata (0x-prefixed)"),
          value: z
            .string()
            .default("0")
            .describe("Value in wei as a string (defaults to '0')"),
        }),
      )
      .min(1)
      .max(20)
      .describe(
        "Array of raw EVM calls to execute. Each call has 'to' (address), 'data' (hex calldata), and optional 'value' (wei as string)",
      ),
    memo: z
      .string()
      .max(500)
      .optional()
      .describe("Optional memo for the transaction (max 500 chars)"),
    properties: propertiesOptionSchema
      .optional()
      .describe(
        'Optional custom JSON metadata. Total minified ≤ 500 chars. Used as the base; any --property overlays are applied on top. To load from a file, use shell substitution: --properties "$(cat props.json)"',
      ),
    property: z
      .array(z.string())
      .optional()
      .describe(
        "String key/value overlays for properties; repeatable. Splits on the first '='.",
      ),
    name: z
      .string()
      .max(200)
      .optional()
      .describe(
        "Optional name for the proposal. If omitted, auto-generated from call details",
      ),
    validUntil: z
      .number()
      .optional()
      .describe(
        "Unix timestamp (seconds) when the proposal expires. Defaults to 7 days from now. Must be in the future and at most 30 days out.",
      ),
  }),
  async run({ env, options }) {
    const properties =
      options.properties !== undefined || options.property?.length
        ? applyPropertyOverlays(
            parsePropertiesOption(options.properties) ?? {},
            options.property,
          )
        : undefined;
    const body = {
      account: options.account,
      chainId: options.chainId,
      calls: options.calls,
      ...(options.memo !== undefined && { memo: options.memo }),
      ...(properties !== undefined && { properties }),
      ...(options.name !== undefined && { name: options.name }),
      ...(options.validUntil !== undefined && {
        validUntil: options.validUntil,
      }),
    } satisfies Record<string, unknown>;
    return apiRequest<{ data?: unknown }>(env, "/proposals/custom", {
      method: "POST",
      body,
    });
  },
});

transactions.command(create);

// -----------------------------------------------------------------------------
// transactions cancel
// -----------------------------------------------------------------------------

transactions.command("cancel", {
  description:
    "Cancel a pending transaction proposal. Only works on proposals in CREATED or DRAFTED status.",
  env: authEnv,
  args: z.object({
    id: z
      .string()
      .uuid("Invalid transaction ID")
      .describe("The proposal ID to cancel"),
  }),
  async run({ env, args }) {
    return apiRequest(env, `/proposals/${args.id}`, {
      method: "DELETE",
    });
  },
});

transactions.command("sign", {
  description:
    "Sign a pending multisig transaction with the local EOA saved by " +
    "`splits auth create-key` or `splits auth import-key`. " +
    "Fetches the transaction's signingHash, produces a personal_sign signature locally, " +
    "and submits it via POST /public/v1/transactions/:id/sign. " +
    "By default auto-submits the UserOp when this signature meets threshold; " +
    "pass --no-submit to record only. Retries once on a stale signer nonce.",
  env: authEnv,
  args: z.object({
    id: transactionId.describe("Transaction ID to sign"),
  }),
  options: z.object({
    noSubmit: z
      .boolean()
      .default(false)
      .describe(
        "Record the signature but do not auto-submit the UserOp even if this signature meets threshold.",
      ),
  }),
  async run({ env, args, options }) {
    return signTransactionLocally(env, args.id, { submit: !options.noSubmit });
  },
});

cli.command(transactions);

// =============================================================================
// contacts
// =============================================================================

const contacts = Cli.create("contacts", {
  description: "Manage contacts",
});

contacts.command("list", {
  description: "Search or list contacts for your org",
  env: authEnv,
  options: z.object({
    q: z
      .string()
      .max(200)
      .optional()
      .describe("Search term to filter contacts by name, label, or address"),
  }),
  async run({ env, options }) {
    return apiRequest(env, `/contacts${buildQuery({ q: options.q })}`);
  },
});

contacts.command("lookup", {
  description: "Batch address lookup for contact info",
  env: authEnv,
  options: z.object({
    addresses: z
      .string()
      .describe("Comma-separated Ethereum addresses to look up (max 100)"),
  }),
  async run({ env, options }) {
    return apiRequest(
      env,
      `/contacts/lookup${buildQuery({ addresses: options.addresses })}`,
    );
  },
});

cli.command(contacts);

// =============================================================================
// tokens
// =============================================================================

const tokens = Cli.create("tokens", {
  description: "Token metadata and visibility",
});

tokens.command("metadata", {
  description: "Get token metadata (symbol, decimals) by address and chain",
  env: authEnv,
  options: z.object({
    address: z.string().describe("Token contract address (0x...)"),
    chainId: z.number().describe("Chain ID"),
  }),
  async run({ env, options }) {
    return apiRequest(
      env,
      `/tokens/metadata${buildQuery({
        address: options.address,
        chainId: options.chainId,
      })}`,
    );
  },
});

tokens.command("whitelist", {
  description:
    "List your org's allowlisted tokens. Token allow/block lists affect display " +
    "and balance filtering only; they are not enforced at proposal or signing time.",
  env: authEnv,
  async run({ env }) {
    return apiRequest(env, "/tokens/whitelist");
  },
});

tokens.command("blocklist", {
  description:
    "List your org's blocked tokens. Token allow/block lists affect display " +
    "and balance filtering only; they are not enforced at proposal or signing time.",
  env: authEnv,
  async run({ env }) {
    return apiRequest(env, "/tokens/blocklist");
  },
});

cli.command(tokens);

// =============================================================================
// chains
// =============================================================================

const chains = Cli.create("chains", {
  description: "Supported blockchain networks",
});

chains.command("list", {
  description: "List all supported chains",
  env: authEnv,
  async run({ env }) {
    return apiRequest(env, "/chains");
  },
});

chains.command("get", {
  description: "Get chain info by ID",
  env: authEnv,
  args: z.object({
    chainId: z.number().describe("Chain ID (e.g. 1, 8453)"),
  }),
  async run({ env, args }) {
    const result = await apiRequest<{
      data: Array<{ chainId: number }>;
    }>(env, "/chains");
    const chain = result.data.find((c) => c.chainId === args.chainId);
    if (!chain) {
      throw new Error(`Chain not found: ${args.chainId}`);
    }
    return { data: chain };
  },
});

cli.command(chains);

// =============================================================================
// members
// =============================================================================

const members = Cli.create("members", {
  description: "Organization members",
});

members.command("list", {
  description: "List members of your org",
  env: authEnv,
  async run({ env }) {
    return apiRequest(env, "/members");
  },
});

members.command("signers", {
  description:
    "List passkey signers for a specific org member by user ID. " +
    "Use 'members list' first to find user IDs. Returns passkey IDs needed for 'accounts create'.",
  env: authEnv,
  args: z.object({
    userId: z
      .string()
      .uuid("Invalid user ID")
      .describe("Member user ID from 'members list'"),
  }),
  async run({ env, args }) {
    return apiRequest(env, `/members/${args.userId}/signers`);
  },
});

cli.command(members);

// =============================================================================
// settings
// =============================================================================

const settings = Cli.create("settings", {
  description: "Organization settings",
});

settings.command("get", {
  description: "Get your org's settings",
  env: authEnv,
  async run({ env }) {
    return apiRequest(env, "/settings");
  },
});

cli.command(settings);

// =============================================================================
// automations
// =============================================================================

const automations = Cli.create("automations", {
  description: "Automation rules",
});

automations.command("list", {
  description: "List automations for your org",
  env: authEnv,
  async run({ env }) {
    return apiRequest(env, "/automations");
  },
});

cli.command(automations);

// =============================================================================
// org (unauthenticated commands)
// =============================================================================

// Env for commands that don't require an API key. Shares URL resolution with
// authenticated commands so `auth login --api-url <staging>` affects public
// routes too (instead of silently falling back to production).
const publicEnv = z.object({
  SPLITS_API_URL: z
    .string()
    .optional()
    .describe(
      "Splits API base URL. " +
        "Falls back to the URL saved by `splits auth login`, then to the production URL.",
    ),
});

const org = Cli.create("org", {
  description: "Organization management",
});

org.command("create", {
  description:
    "Start creating a new org. Sends a setup link to the provided email — complete org creation in the web UI.",
  env: publicEnv,
  options: z.object({
    email: z
      .string()
      .email("Invalid email address")
      .describe(
        "Email address to receive the org setup link. Complete org creation in the web UI.",
      ),
  }),
  async run({ env, options }) {
    return httpRequest(env, "/auth/send-create-org-link", {
      method: "POST",
      requireAuth: false,
      body: { email: options.email },
    });
  },
});

cli.command(org);

cli.serve();
export default cli;
