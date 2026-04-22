#!/usr/bin/env node
import { Cli, z } from "incur";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  CONFIG_FILE_PATH,
  defaultKeyName,
  loadLocalKeyPublic,
  loadLocalPrivateKey,
  removeApiKey,
  removeKey,
  resolveApiKey,
  resolveApiUrl,
  saveApiKey,
  saveKey,
  type ResolvedApiKey,
} from "./config.js";
import { evmAddress, transactionId } from "./schemas.js";

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

// Typed error thrown by apiRequest so callers (including MCP consumers) can
// branch on machine-readable backend error codes like SELF_TAKEOVER_BLOCKED,
// PASSKEY_NOT_AVAILABLE, SMART_ACCOUNT_STATE_CHANGE_IN_PROGRESS, etc. Also
// used for client-side conditions like missing credentials; those set status
// to 0 so callers can distinguish them from HTTP failures.
export class SplitsApiError extends Error {
  readonly code: string | undefined;
  readonly status: number;
  constructor(code: string | undefined, status: number, message: string) {
    super(code ? `[${code}] ${message}` : message);
    this.name = "SplitsApiError";
    this.code = code;
    this.status = status;
  }
}

const mcpMode = (): boolean => process.env.SPLITS_MCP_MODE === "1";

// Helper: make authenticated request. Resolves API key + URL lazily (env >
// config file); throws a structured 'no-api-key' error when neither source
// has a value so MCP / scripts can branch cleanly.
async function apiRequest<T = unknown>(
  env: AuthEnv,
  path: string,
  options?: {
    method?: "GET" | "PUT" | "POST" | "DELETE";
    body?: Record<string, unknown>;
  },
): Promise<T> {
  const resolved = await resolveApiKey(env);
  if (!resolved) {
    throw new SplitsApiError(
      "no-api-key",
      0,
      "No API key configured. Run `splits auth login` or export SPLITS_API_KEY.",
    );
  }
  const apiUrl = await resolveApiUrl(env);

  const res = await fetch(`${apiUrl}/public/v1${path}`, {
    method: options?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${resolved.value}`,
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const errObj = (body as { error?: { code?: string; message?: string } })
      ?.error;
    const code = errObj?.code;
    const message = errObj?.message ?? `API error: ${res.status}`;
    throw new SplitsApiError(code, res.status, message);
  }
  return res.json() as Promise<T>;
}

// Read the next chunk of stdin until EOF. Used by `auth login` and
// `auth import-key` so secrets never appear on the command line.
// Under MCP mode there is no TTY and no piped input — refuse fast rather
// than hanging on an empty stream until the MCP call times out.
const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) return "";
  if (mcpMode()) {
    throw new Error(
      "Secrets cannot be piped into an MCP tool call. " +
        "Run `auth login` / `auth import-key` outside MCP, or set SPLITS_API_KEY in the MCP server's environment.",
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer),
    );
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
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
    "and any local EOA signing key saved by `splits auth create-key`.",
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
    const response = await apiRequest<{
      data: Record<string, unknown>;
    }>(env, "/auth/whoami");
    const localKey = await loadLocalKeyPublic();
    return {
      ...response,
      data: {
        ...response.data,
        apiKeySource: resolved.source,
        ...(localKey ? { localKey } : {}),
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
        "--api-key flag is refused under SPLITS_MCP_MODE=1. Pipe the key via stdin instead.",
      );
    }

    let value = options.apiKey ?? (await readStdin());
    value = value.trim();
    if (value.length === 0) {
      throw new Error(
        "No API key provided. Pass --api-key, pipe via stdin, or set SPLITS_MCP_MODE=0 and use --api-key for interactive use.",
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
    "Use `splits accounts update-signers <account> --generate-eoa` for a one-shot " +
    "generate-and-register flow. Refuses if a key already exists — delete it first.",
  options: z.object({
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional human-readable label. Defaults to a short form of the address.",
      ),
  }),
  async run({ options }) {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const name = options.name ?? defaultKeyName(account.address);

    await saveKey({
      name,
      address: account.address,
      privateKey,
    });

    return {
      name,
      address: account.address,
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
        "--private-key flag is refused under SPLITS_MCP_MODE=1. Pipe the key via stdin instead.",
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
    "Primary use case: adding an external (EOA) key so an agent or automation can operate on the account headlessly " +
    "— passkeys require a biometric 2nd factor that agents cannot provide. " +
    "Added EOA signers are attributed to the user that owns the API key making the request; " +
    "you cannot add an EOA on behalf of another user via this command. " +
    "The proposal is created immediately; it must be approved and signed on the web via the printed Sign URL. " +
    "Poll 'transactions get <id>' to watch status transition from CREATED to EXECUTED. " +
    "If this returns 409 SMART_ACCOUNT_STATE_CHANGE_IN_PROGRESS, call 'transactions list --account <address>' " +
    "to find the pending proposal; it must be signed (web) or cancelled before retrying. " +
    "Recovery / resetting signers stays web-only. " +
    "Updates apply to every active network on the org automatically. " +
    "Use 'accounts signers <address>' to discover existing signer IDs (passkeys and EOAs). " +
    "Requires owner-scoped API key.",
  env: authEnv,
  args: z.object({
    account: evmAddress.describe("Subaccount address (0x...)"),
  }),
  options: z.object({
    addEoaAddresses: csvEvmAddresses("--add-eoa-addresses").describe(
      "Comma-separated EOA addresses to add as signers (e.g. 0xabc...,0xdef...)",
    ),
    addEoaNames: z
      .string()
      .optional()
      .describe(
        "Optional comma-separated human-readable names aligned by index with --add-eoa-addresses. " +
          "Count must match --add-eoa-addresses if provided. Use empty slots to skip (e.g. ',Agent Two').",
      ),
    removeEoaIds: z
      .string()
      .optional()
      .describe(
        "Comma-separated EOA signer IDs (from 'accounts get <address>') to remove",
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
    generateEoa: z
      .boolean()
      .default(false)
      .describe(
        "Generate a new local EOA (via `auth create-key`) and register its address " +
          "as a signer in a single call. Mutually exclusive with --add-eoa-addresses; " +
          "refuses if a local key already exists (run `auth delete-key` first).",
      ),
    generateEoaName: z
      .string()
      .optional()
      .describe(
        "Optional name for the key created by --generate-eoa. " +
          "Defaults to a short form of the address.",
      ),
  }),
  async run({ env, args, options }) {
    const addEoaAddresses = splitCsv(options.addEoaAddresses);
    // Preserve empty slots here so names align by index with addresses, even
    // when the user wants to skip a middle entry (e.g. ",Agent Two").
    const splitAligned = (s: string | undefined): string[] =>
      s === undefined ? [] : s.split(",").map((x) => x.trim());
    const addEoaNames = splitAligned(options.addEoaNames);
    if (addEoaNames.length > 0 && addEoaNames.length !== addEoaAddresses.length)
      throw new Error(
        `--add-eoa-names count (${addEoaNames.length}) must match --add-eoa-addresses count (${addEoaAddresses.length})`,
      );

    // The added signer is attributed to the API key's user server-side; no
    // email is sent from the client.
    const addEoaSigners: Array<{ address: string; name?: string }> =
      addEoaAddresses.map((address, i) => {
        const name = addEoaNames[i];
        return {
          address,
          ...(name ? { name } : {}),
        };
      });

    // --generate-eoa: create a local key and register its address in one shot.
    // Mirrors `auth create-key` refuse-on-exists policy; on API failure we
    // roll back the local key so the user isn't left with an orphaned one.
    let generatedAddress: `0x${string}` | null = null;
    if (options.generateEoa) {
      if (addEoaAddresses.length > 0) {
        throw new Error(
          "--generate-eoa and --add-eoa-addresses are mutually exclusive. Use one or the other.",
        );
      }
      const privateKey = generatePrivateKey();
      const account = privateKeyToAccount(privateKey);
      const name = options.generateEoaName ?? defaultKeyName(account.address);
      await saveKey({
        name,
        address: account.address,
        privateKey,
      });
      generatedAddress = account.address;
      addEoaSigners.push({ address: account.address, name });
    }

    const body = {
      account: args.account,
      addPasskeyIds: splitCsv(options.addPasskeyIds),
      removePasskeyIds: splitCsv(options.removePasskeyIds),
      addEoaSigners,
      removeEoaSignerIds: splitCsv(options.removeEoaIds),
      ...(options.threshold !== undefined && { threshold: options.threshold }),
      ...(options.memo !== undefined && { memo: options.memo }),
    } satisfies Record<string, unknown>;

    let result: { data?: { signUrl?: string } };
    try {
      result = await apiRequest<{ data?: { signUrl?: string } }>(
        env,
        "/proposals/update_signers",
        { method: "POST", body },
      );
    } catch (err) {
      if (generatedAddress !== null) {
        // Roll back so the user isn't left with a saved key that was never
        // registered. We surface the address in the thrown error so they can
        // retry with `update-signers --add-eoa-addresses <addr>` if desired.
        await removeKey().catch(() => undefined);
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to register generated EOA ${generatedAddress}: ${message}\n` +
            `The local key was rolled back. To re-register the same address, ` +
            `first restore it with \`auth import-key\` and then run ` +
            `\`update-signers --add-eoa-addresses ${generatedAddress}\`.`,
        );
      }
      throw err;
    }

    if (result.data?.signUrl) {
      process.stdout.write(`Sign URL: ${result.data.signUrl}\n`);
    }
    return {
      ...result,
      ...(generatedAddress !== null ? { generatedAddress } : {}),
    };
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
    const privateKey = await loadLocalPrivateKey();
    const publicInfo = await loadLocalKeyPublic();
    if (privateKey === null || publicInfo === null) {
      throw new SplitsApiError(
        "no-local-key",
        0,
        "No local signing key. Run `splits auth create-key` or `splits auth import-key` first.",
      );
    }

    const account = privateKeyToAccount(privateKey);
    const submit = !options.noSubmit;

    type TxGetResponse = { data: { signingHash?: string | null } };
    type SignResponse = {
      data: {
        id: string;
        status: string;
        signerId: string;
        submitted: boolean;
        userOpHash: string | null;
        submissionError: string | null;
      };
    };

    // The signingHash is the single piece of data this command actually signs.
    // Validate shape before passing to viem so a malformed API response can't
    // coerce the CLI into signing attacker-chosen bytes as raw message input.
    // Exact 32-byte keccak output: "0x" + 64 hex chars.
    const SIGNING_HASH_RE = /^0x[0-9a-f]{64}$/i;
    const fetchSigningHash = async (): Promise<`0x${string}`> => {
      const tx = await apiRequest<TxGetResponse>(
        env,
        `/transactions/${args.id}`,
      );
      const hash = tx.data.signingHash;
      if (hash === null || hash === undefined) {
        throw new SplitsApiError(
          "transaction-not-cli-signable",
          0,
          "This transaction does not expose a signingHash (e.g. merkle or deploy paths). Sign via the web app.",
        );
      }
      if (typeof hash !== "string" || !SIGNING_HASH_RE.test(hash)) {
        throw new SplitsApiError(
          "invalid-signing-hash",
          0,
          `Backend returned a malformed signingHash (${JSON.stringify(hash)}). Refusing to sign.`,
        );
      }
      return hash as `0x${string}`;
    };

    const postSignature = async (
      signingHash: `0x${string}`,
    ): Promise<SignResponse> => {
      const signature = await account.signMessage({
        message: { raw: signingHash },
      });
      return apiRequest<SignResponse>(env, `/transactions/${args.id}/sign`, {
        method: "POST",
        body: {
          eoaSigner: account.address,
          signature,
          submit,
        },
      });
    };

    let signingHash = await fetchSigningHash();
    try {
      const result = await postSignature(signingHash);
      return result;
    } catch (err) {
      // Nonce-stale races happen under active multisig use; retry once with a
      // fresh GET + re-sign. A second failure is surfaced verbatim.
      if (
        err instanceof SplitsApiError &&
        err.code === "INVALID_SIGNER_NONCE"
      ) {
        signingHash = await fetchSigningHash();
        return await postSignature(signingHash);
      }
      // Annotate signer-auth errors with the local address so users can see
      // which key the CLI tried to sign with; caller still gets the backend
      // code to branch on.
      if (err instanceof SplitsApiError && err.code === "INVALID_SIGNER") {
        throw new SplitsApiError(
          "signer-not-authorized",
          err.status,
          `Local key ${account.address} is not an authorized signer on this transaction. ` +
            `If you just registered this key via update-signers, the registration proposal ` +
            `must be approved and executed before it can sign other transactions.`,
        );
      }
      throw err;
    }
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

// Request helper without auth header for unauthenticated endpoints
async function publicRequest<T = unknown>(
  env: { SPLITS_API_URL?: string },
  path: string,
  options?: {
    method?: "GET" | "POST";
    body?: Record<string, unknown>;
  },
): Promise<T> {
  const apiUrl = await resolveApiUrl(env);
  const res = await fetch(`${apiUrl}/public/v1${path}`, {
    method: options?.method ?? "GET",
    headers: {
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const errObj = (body as { error?: { code?: string; message?: string } })
      ?.error;
    const code = errObj?.code;
    const message = errObj?.message ?? `API error: ${res.status}`;
    throw new SplitsApiError(code, res.status, message);
  }
  return res.json() as Promise<T>;
}

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
    return publicRequest(env, "/auth/send-create-org-link", {
      method: "POST",
      body: { email: options.email },
    });
  },
});

cli.command(org);

cli.serve();
export default cli;
