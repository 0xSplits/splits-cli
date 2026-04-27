#!/usr/bin/env node
import { Cli, z } from "incur";

import { PERIODS, resolvePeriod, type Period } from "./periods.js";
import { evmAddress, transactionId } from "./schemas.js";

const AMOUNT_REGEX = /^(0|[1-9]\d*)(\.\d+)?$/;

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

// Helper: make authenticated request
async function apiRequest(
  env: { SPLITS_API_KEY: string; SPLITS_API_URL: string },
  path: string,
  options?: {
    method?: "GET" | "PUT" | "POST" | "DELETE";
    body?: Record<string, unknown>;
  },
) {
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
    throw new Error(
      (body as { error?: { message?: string } })?.error?.message ??
        `API error: ${res.status}`,
    );
  }
  return res.json();
}

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
      const result = (await apiRequest(env, "/org/accounts")) as {
        data: Array<{ address: string }>;
      };
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
    eoaAddresses: z
      .string()
      .optional()
      .describe(
        "Comma-separated EOA signer addresses (e.g. 0xabc...,0xdef...)",
      ),
    threshold: z
      .number()
      .int()
      .min(1)
      .describe("Number of signers required to approve transactions"),
  }),
  async run({ env, options }) {
    const passkeyIds = options.passkeyIds
      ? options.passkeyIds.split(",").filter(Boolean)
      : [];
    const eoaSigners = options.eoaAddresses
      ? options.eoaAddresses
          .split(",")
          .filter(Boolean)
          .map((address) => ({ address }))
      : [];
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

cli.command(accounts);

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
    "specific transaction by memo with explicit dates: { memo: 'Q1 payroll', startDate: '2026-01-01T00:00:00Z', endDate: '2026-04-01T00:00:00Z' }",
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
        "Case-insensitive substring search across transaction and asset-transfer memos. Min 3, max 500 chars. SQL wildcards (% and _) are escaped, not interpreted. Most efficient combined with --account, --chainId, or a date range.",
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        "Pagination cursor from a previous response. You MUST replay the same filter values used on the request that produced this cursor.",
      ),
  }),
  async run({ env, options }) {
    // Mutual exclusion: --period vs explicit dates
    if (options.period && (options.startDate || options.endDate)) {
      throw new Error(
        `Cannot use --period together with --startDate or --endDate. Use one or the other. Valid --period values: ${PERIODS.join(", ")}.`,
      );
    }

    // Day-only YYYY-MM-DD inputs are interpreted as local midnight.
    const normalizeDateInput = (value: string | undefined) => {
      if (!value) return undefined;
      // Match plain YYYY-MM-DD (no time component)
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const [y, m, d] = value.split("-").map(Number);
        return new Date(y, m - 1, d).toISOString();
      }
      // Otherwise pass through; the API will validate as ISO 8601
      return value;
    };

    let startDate = normalizeDateInput(options.startDate);
    let endDate = normalizeDateInput(options.endDate);

    if (options.period) {
      const resolved = resolvePeriod(options.period as Period);
      startDate = resolved.startDate;
      endDate = resolved.endDate;
    }

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
    const body: Record<string, unknown> = {
      account: options.account,
      chainId: options.chainId,
      recipient: options.recipient,
      token: options.token,
      amount: options.amount,
    };
    if (options.memo !== undefined) body.memo = options.memo;
    if (options.name !== undefined) body.name = options.name;
    if (options.validUntil !== undefined) body.validUntil = options.validUntil;
    return apiRequest(env, "/proposals/transfer", {
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
    const body: Record<string, unknown> = {
      account: options.account,
      chainId: options.chainId,
      calls: options.calls,
    };
    if (options.memo !== undefined) body.memo = options.memo;
    if (options.name !== undefined) body.name = options.name;
    if (options.validUntil !== undefined) body.validUntil = options.validUntil;
    return apiRequest(env, "/proposals/custom", {
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
    const result = (await apiRequest(env, "/chains")) as {
      data: Array<{ chainId: number }>;
    };
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
async function publicRequest(
  env: { SPLITS_API_URL: string },
  path: string,
  options?: {
    method?: "GET" | "POST";
    body?: Record<string, unknown>;
  },
) {
  const res = await fetch(`${env.SPLITS_API_URL}/public/v1${path}`, {
    method: options?.method ?? "GET",
    headers: {
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: { message?: string } })?.error?.message ??
        `API error: ${res.status}`,
    );
  }
  return res.json();
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
