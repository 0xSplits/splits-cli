import { Cli, z } from "incur";

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
    .default("http://localhost:8080")
    .describe("Splits API base URL"),
});

// Helper: make authenticated request
async function apiRequest(
  env: { SPLITS_API_KEY: string; SPLITS_API_URL: string },
  path: string,
) {
  const res = await fetch(`${env.SPLITS_API_URL}/public/v1${path}`, {
    headers: { Authorization: `Bearer ${env.SPLITS_API_KEY}` },
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

// transactions command group
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
    const params = new URLSearchParams();
    if (options.chainId) params.set("chainId", String(options.chainId));
    if (options.limit) params.set("limit", String(options.limit));
    if (options.account) params.set("account", options.account);
    if (options.cursor) params.set("cursor", options.cursor);
    const query = params.toString();
    return apiRequest(env, `/transactions${query ? `?${query}` : ""}`);
  },
});

transactions.command("get", {
  description: "Get details for a specific transaction",
  env: authEnv,
  args: z.object({
    id: z.string().describe("Transaction ID"),
  }),
  async run({ env, args }) {
    return apiRequest(env, `/transactions/${args.id}`);
  },
});

cli.command(transactions);

// accounts command group
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
    const params = new URLSearchParams();
    if (options.includeArchived) params.set("includeArchived", "true");
    const query = params.toString();
    return apiRequest(env, `/org/accounts${query ? `?${query}` : ""}`);
  },
});

accounts.command("get", {
  description: "Get account details by address",
  env: authEnv,
  args: z.object({
    address: z.string().describe("Account address (0x...)"),
  }),
  async run({ env, args }) {
    return apiRequest(env, `/org/accounts/${args.address}`);
  },
});

cli.command(accounts);

cli.serve();
export default cli;
