#!/usr/bin/env node
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
import { httpRequest, SplitsApiError } from "./http.js";
import { evmAddress, transactionId } from "./schemas.js";
import { signTransactionLocally } from "./signing.js";

const cli = Cli.create("splits", {
  version: "0.0.1",
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
      const tokens = s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      const bad = tokens.find((t) => !EVM_ADDRESS_RE.test(t));
      if (bad !== undefined) {
        ctx.addIssue({
          code: "custom",
          message:
            `${fieldHint} must be a comma-separated list of 0x-prefixed ` +
            `40-hex-char EVM addresses (invalid: ${bad})`,
        });
      }
    });

// Helper: split a CSV string into trimmed, non-empty tokens.
const splitCsv = (s: string | undefined): string[] =>
  s
    ? s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

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
    "you cannot register an address on behalf of another user.",
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
  description: "Manage accounts",
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
    "Use 'members signers <userId>' to discover passkey IDs. Requires owner-scoped API key.",
  env: authEnv,
  options: z.object({
    name: z.string().min(1).max(255).describe("Account name (max 255 chars)"),
    passkeyIds: z
      .string()
      .optional()
      .describe(
        "Comma-separated passkey IDs from 'members signers' (e.g. id1,id2)",
      ),
    eoaAddresses: csvEvmAddresses("--eoa-addresses").describe(
      "Comma-separated EOA signer addresses (e.g. 0xabc...,0xdef...)",
    ),
    threshold: z
      .number()
      .int()
      .min(1)
      .describe("Number of signers required to approve transactions"),
  }),
  async run({ env, options }) {
    const passkeyIds = splitCsv(options.passkeyIds);
    const eoaSigners = splitCsv(options.eoaAddresses).map((address) => ({
      address,
    }));
    return apiRequest(env, "/org/accounts", {
      method: "POST",
      body: {
        name: options.name,
        passkeyIds,
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
    "Poll 'transactions get <id>' to watch status transition from CREATED to EXECUTED. " +
    "If this returns 409 SMART_ACCOUNT_STATE_CHANGE_IN_PROGRESS, call 'transactions list --account <address>' " +
    "to find the pending proposal; it must be signed (web) or cancelled before retrying. " +
    "Recovery / resetting signers stays web-only. " +
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
        "Comma-separated EOA signer ids (from `auth register-signer` / `auth signers`) to attach. " +
          "The same id can be attached to multiple accounts.",
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
// transactions
// =============================================================================

const transactions = Cli.create("transactions", {
  description: "Manage transactions",
});

transactions.command("list", {
  description: "List transactions for your org",
  env: authEnv,
  options: z.object({
    chainId: z.number().optional().describe("Filter by chain ID"),
    limit: z
      .number()
      .min(1)
      .max(200)
      .default(50)
      .describe("Max results to return"),
    account: z.string().optional().describe("Filter by account address"),
    cursor: z
      .string()
      .optional()
      .describe("Pagination cursor from a previous response"),
  }),
  async run({ env, options }) {
    return apiRequest(
      env,
      `/transactions${buildQuery({
        chainId: options.chainId,
        limit: options.limit,
        account: options.account,
        cursor: options.cursor,
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
      .describe(
        "The token contract address to transfer (use 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE for native ETH)",
      ),
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
    const body = {
      account: options.account,
      chainId: options.chainId,
      recipient: options.recipient,
      token: options.token,
      amount: options.amount,
      ...(options.memo !== undefined && { memo: options.memo }),
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
    const body = {
      account: options.account,
      chainId: options.chainId,
      calls: options.calls,
      ...(options.memo !== undefined && { memo: options.memo }),
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
  description: "List your org's allowlisted tokens",
  env: authEnv,
  async run({ env }) {
    return apiRequest(env, "/tokens/whitelist");
  },
});

tokens.command("blocklist", {
  description: "List your org's blocked tokens",
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
