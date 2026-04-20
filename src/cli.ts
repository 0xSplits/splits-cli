#!/usr/bin/env node
import { Cli, z } from "incur";

import { evmAddress, transactionId } from "./schemas.js";

const cli = Cli.create("splits", {
  version: "0.0.1",
  description: "Splits CLI — programmatic access to the Splits platform",
});

// Auth config (reads from env)
const authEnv = z.object({
  SPLITS_API_KEY: z
    .string()
    .describe("Splits API key (sk_read_... or legacy hex key)"),
  SPLITS_API_URL: z
    .string()
    .default("https://server.production.splits.org")
    .describe("Splits API base URL"),
});

// Typed error thrown by apiRequest so callers (including MCP consumers) can
// branch on machine-readable backend error codes like SELF_TAKEOVER_BLOCKED,
// PASSKEY_NOT_AVAILABLE, SMART_ACCOUNT_STATE_CHANGE_IN_PROGRESS, etc.
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

// Helper: make authenticated request
async function apiRequest<T = unknown>(
  env: { SPLITS_API_KEY: string; SPLITS_API_URL: string },
  path: string,
  options?: {
    method?: "GET" | "PUT" | "POST" | "DELETE";
    body?: Record<string, unknown>;
  },
): Promise<T> {
  const res = await fetch(`${env.SPLITS_API_URL}/public/v1${path}`, {
    method: options?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${env.SPLITS_API_KEY}`,
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
  description: "Show current org, API key name, and scopes",
  env: authEnv,
  async run({ env }) {
    return apiRequest(env, "/auth/whoami");
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
    "The proposal is created immediately; it must be approved and signed on the web via the printed Sign URL. " +
    "Poll 'transactions get <id>' to watch status transition from CREATED to EXECUTED. " +
    "If this returns 409 SMART_ACCOUNT_STATE_CHANGE_IN_PROGRESS, call 'transactions list --account <address>' " +
    "to find the pending proposal; it must be signed (web) or cancelled before retrying. " +
    "Recovery / resetting signers stays web-only. " +
    "Updates apply to every active network on the org automatically. " +
    "Use 'accounts get <address>' to discover existing signer IDs (passkeys and EOAs). " +
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
    addEoaEmails: z
      .string()
      .optional()
      .describe(
        "Optional comma-separated contact emails aligned by index with --add-eoa-addresses. " +
          "Count must match --add-eoa-addresses if provided. Use empty slots to skip (e.g. 'ops@x.com,').",
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
  }),
  async run({ env, args, options }) {
    const addEoaAddresses = splitCsv(options.addEoaAddresses);
    // Preserve empty slots here so names/emails align by index with addresses,
    // even when the user wants to skip a middle entry (e.g. ",Agent Two").
    const splitAligned = (s: string | undefined): string[] =>
      s === undefined ? [] : s.split(",").map((x) => x.trim());
    const addEoaNames = splitAligned(options.addEoaNames);
    const addEoaEmails = splitAligned(options.addEoaEmails);
    if (addEoaNames.length > 0 && addEoaNames.length !== addEoaAddresses.length)
      throw new Error(
        `--add-eoa-names count (${addEoaNames.length}) must match --add-eoa-addresses count (${addEoaAddresses.length})`,
      );
    if (
      addEoaEmails.length > 0 &&
      addEoaEmails.length !== addEoaAddresses.length
    )
      throw new Error(
        `--add-eoa-emails count (${addEoaEmails.length}) must match --add-eoa-addresses count (${addEoaAddresses.length})`,
      );

    const addEoaSigners = addEoaAddresses.map((address, i) => {
      const name = addEoaNames[i];
      const email = addEoaEmails[i];
      return {
        address,
        ...(name ? { name } : {}),
        ...(email ? { email } : {}),
      };
    });

    const body = {
      account: args.account,
      addPasskeyIds: splitCsv(options.addPasskeyIds),
      removePasskeyIds: splitCsv(options.removePasskeyIds),
      addEoaSigners,
      removeEoaSignerIds: splitCsv(options.removeEoaIds),
      ...(options.threshold !== undefined && { threshold: options.threshold }),
      ...(options.memo !== undefined && { memo: options.memo }),
    } satisfies Record<string, unknown>;

    const result = await apiRequest<{ data?: { signUrl?: string } }>(
      env,
      "/proposals/update_signers",
      { method: "POST", body },
    );

    if (result.data?.signUrl) {
      process.stdout.write(`Sign URL: ${result.data.signUrl}\n`);
    }
    return result;
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

// Env for commands that don't require an API key
const publicEnv = z.object({
  SPLITS_API_URL: z
    .string()
    .default("https://server.production.splits.org")
    .describe("Splits API base URL"),
});

// Request helper without auth header for unauthenticated endpoints
async function publicRequest<T = unknown>(
  env: { SPLITS_API_URL: string },
  path: string,
  options?: {
    method?: "GET" | "POST";
    body?: Record<string, unknown>;
  },
): Promise<T> {
  const res = await fetch(`${env.SPLITS_API_URL}/public/v1${path}`, {
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
