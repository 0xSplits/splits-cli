import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const hostedPath = fileURLToPath(new URL("./hosted.ts", import.meta.url));
const mcpPublicUrl = "https://mcp.example.test/mcp";
const backendDelayMs = 200;
const reportDownloadUrl = "https://reports.example.test/report-1.csv";
const backendErrorStatusByToken: Record<string, number> = {
  "token-expired": 401,
  "token-forbidden": 403,
};
const challenge =
  'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"';

const excludedToolNames = [
  "accounting_assertions_bulk",
  "accounting_categorize_bulk",
  "accounts_sign-message",
  "auth_create-key",
  "auth_delete-key",
  "auth_import-key",
  "auth_login",
  "auth_login-start",
  "auth_login-status",
  "auth_logout",
  "auth_register-signer",
  "auth_use",
  "auth_workspaces",
  "org_create",
  "transactions_sign",
  "workspace_create",
  "workspace_create-agent-owned",
];
const hiddenOptionNames = ["workspace", "out", "force"];
const servedToolNames = [
  "accounting_assertions_designate",
  "accounting_assertions_edit",
  "accounting_assertions_revoke",
  "accounting_assertions_seed",
  "accounting_categories_archive",
  "accounting_categories_create",
  "accounting_categories_list",
  "accounting_categories_update",
  "accounting_categorize_revoke",
  "accounting_categorize_set",
  "accounting_imports_create",
  "accounting_imports_list",
  "accounting_imports_status",
  "accounting_lots_assertions",
  "accounting_lots_list",
  "accounting_recompute_current",
  "accounting_recompute_job",
  "accounting_recompute_run",
  "accounting_reports_generate",
  "accounting_reports_job",
  "accounting_reports_list",
  "accounting_rules_create",
  "accounting_rules_delete",
  "accounting_rules_list",
  "accounting_rules_update",
  "accounts_add-networks",
  "accounts_archive",
  "accounts_balances",
  "accounts_chains",
  "accounts_create",
  "accounts_deploy",
  "accounts_get",
  "accounts_list",
  "accounts_networks",
  "accounts_remove-networks",
  "accounts_rename",
  "accounts_signers",
  "accounts_unarchive",
  "accounts_update-signers",
  "auth_signers",
  "auth_whoami",
  "automations_create",
  "automations_list",
  "chains_get",
  "chains_list",
  "contacts_list",
  "contacts_lookup",
  "feedback_send",
  "invoices_create",
  "invoices_get",
  "invoices_list",
  "members_list",
  "members_signers",
  "offramp_external-accounts",
  "settings_get",
  "tokens_blocklist",
  "tokens_metadata",
  "tokens_whitelist",
  "transactions_cancel",
  "transactions_create_auto-earn-off",
  "transactions_create_auto-earn-on",
  "transactions_create_custom",
  "transactions_create_earn-deposit",
  "transactions_create_earn-withdraw",
  "transactions_create_offramp",
  "transactions_create_swap",
  "transactions_create_transfer",
  "transactions_get",
  "transactions_list",
  "transactions_memo",
  "transactions_properties_clear",
  "transactions_properties_replace",
  "transactions_properties_set",
  "transactions_update-gas-estimation",
];
const hostLocalKey = {
  address: "0x3333333333333333333333333333333333333333",
  privateKey: `0x${"11".repeat(32)}`,
};

type BackendRequest = {
  method: string;
  url: string;
  authorization: string | undefined;
  userAgent: string | undefined;
};

const backendRequests: BackendRequest[] = [];
let inFlight = 0;
let maxInFlight = 0;
let backend: Server;
let hosted: ChildProcess;
let hostedUrl: URL;
let home: string;

const tokenOf = (authorization: string | undefined): string =>
  authorization?.replace(/^Bearer /, "") ?? "";

before(async () => {
  backend = createServer(async (req, res) => {
    backendRequests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      authorization: req.headers.authorization,
      userAgent: req.headers["user-agent"],
    });
    const { pathname } = new URL(req.url ?? "/", "http://backend");
    const errorStatus = backendErrorStatusByToken[tokenOf(req.headers.authorization)];
    if (errorStatus !== undefined) {
      res.writeHead(errorStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "REJECTED", message: `status ${errorStatus}` } }));
      return;
    }
    if (pathname === "/public/v1/auth/whoami") {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, backendDelayMs));
      inFlight -= 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: { orgId: `org-${tokenOf(req.headers.authorization)}`, orgName: null },
        }),
      );
      return;
    }
    if (pathname === "/public/v1/accounting/reports/transactions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: {
            reportId: "report-1",
            csvDownloadUrl: reportDownloadUrl,
            userFriendlyFileName: "report-1.csv",
            isLongRunningOperation: false,
            jobId: null,
          },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));

  home = await mkdtemp(join(tmpdir(), "splits-cli-hosted-"));
  await mkdir(join(home, ".splits"), { mode: 0o700 });
  await writeFile(
    join(home, ".splits", "config.json"),
    JSON.stringify({
      version: 2,
      activeWorkspace: null,
      workspaces: {},
      keys: {
        [hostLocalKey.address]: { name: "host-key", privateKey: hostLocalKey.privateKey },
      },
    }),
    { mode: 0o600 },
  );
  hosted = spawn(process.execPath, ["--import", "tsx", hostedPath], {
    env: {
      ...process.env,
      HOME: home,
      PORT: "0",
      SPLITS_API_URL: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`,
      SPLITS_MCP_URL: mcpPublicUrl,
      SPLITS_API_KEY: "sk_host_env_key",
      SPLITS_WORKSPACE: "host-workspace",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    hosted.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const match = stdout.match(/listening on port (\d+)/);
      if (match) resolve(match[1]);
    });
    hosted.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    hosted.on("exit", (code) =>
      reject(new Error(`hosted server exited with ${code}: ${stderr}`)),
    );
  });
  hostedUrl = new URL(`http://127.0.0.1:${port}/mcp`);
});

after(async () => {
  hosted.kill();
  await new Promise<void>((resolve) => backend.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
});

const connect = async (token: string): Promise<Client> => {
  const client = new Client({ name: `test-${token}`, version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(hostedUrl, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
};

const callJson = async (
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> => {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const [content] = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content.text) as unknown;
};

test("a request without a bearer token gets a 401 that points at the resource metadata and never reaches the backend", async () => {
  const before = backendRequests.length;

  const response = await fetch(hostedUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), challenge);
  assert.equal(backendRequests.length, before);
});

test("the protected resource metadata names the MCP URL and the API as its authorization server", async () => {
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    const response = await fetch(new URL(path, hostedUrl));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      resource: mcpPublicUrl,
      authorization_servers: [
        `http://127.0.0.1:${(backend.address() as AddressInfo).port}`,
      ],
      bearer_methods_supported: ["header"],
    });
  }
});

test("tools/list leaves out the local-only tools and the server-local options", async () => {
  const client = await connect("token-list");
  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    assert.deepEqual([...names].sort(), servedToolNames);
    for (const excluded of excludedToolNames) {
      assert.ok(!names.includes(excluded), `${excluded} is exposed`);
    }
    for (const tool of tools) {
      for (const hidden of hiddenOptionNames) {
        assert.ok(
          !(hidden in (tool.inputSchema.properties ?? {})),
          `${tool.name} exposes ${hidden}`,
        );
      }
    }
  } finally {
    await client.close();
  }
});

test("each call reaches the backend with its own request token, also when two calls overlap", async () => {
  const [clientA, clientB] = await Promise.all([
    connect("token-A"),
    connect("token-B"),
  ]);
  try {
    const before = backendRequests.length;
    maxInFlight = 0;

    const [whoamiA, whoamiB] = await Promise.all([
      callJson(clientA, "auth_whoami", {}),
      callJson(clientB, "auth_whoami", { workspace: "host-workspace" }),
    ]);

    const expected = (token: string) => ({
      data: {
        orgId: `org-${token}`,
        orgName: null,
        workspace: null,
        apiKeySource: "request",
        localKeys: [],
      },
    });
    assert.deepEqual(whoamiA, expected("token-A"));
    assert.deepEqual(whoamiB, expected("token-B"));
    assert.equal(maxInFlight, 2);

    const calls = backendRequests.slice(before);
    assert.deepEqual(
      calls.map(({ method, url, authorization }) => ({ method, url, authorization })).sort(
        (a, b) => (a.authorization ?? "").localeCompare(b.authorization ?? ""),
      ),
      [
        { method: "GET", url: "/public/v1/auth/whoami", authorization: "Bearer token-A" },
        { method: "GET", url: "/public/v1/auth/whoami", authorization: "Bearer token-B" },
      ],
    );
    for (const { userAgent } of calls) assert.match(userAgent ?? "", / \(mcp\)$/);
  } finally {
    await Promise.all([clientA.close(), clientB.close()]);
  }
});

test("an out path passed to reports generate is dropped, so the report comes back as a URL and nothing is written", async () => {
  const client = await connect("token-report");
  const out = join(home, "report.csv");
  try {
    const result = await callJson(client, "accounting_reports_generate", {
      report: "transactions",
      out,
      force: true,
    });

    assert.deepEqual(result, {
      report: "transactions",
      reportId: "report-1",
      fileFormat: "csv",
      fileName: "report-1.csv",
      queued: false,
      downloadUrl: reportDownloadUrl,
    });
    assert.equal(existsSync(out), false);
  } finally {
    await client.close();
  }
});

const callWhoamiOverHttp = (token: string): Promise<Response> =>
  fetch(hostedUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "auth_whoami", arguments: {} },
    }),
  });

test("a token the API rejects with 401 gets an HTTP 401 with the same challenge, so the client can refresh it", async () => {
  const response = await callWhoamiOverHttp("token-expired");

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), challenge);
});

test("other API errors, such as a 403 for a missing scope, stay tool errors inside an HTTP 200", async () => {
  const response = await callWhoamiOverHttp("token-forbidden");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("www-authenticate"), null);
  const body = (await response.json()) as {
    result: { isError: boolean; content: Array<{ text: string }> };
  };
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /status 403/);
});

const postToMcp = (headers: Record<string, string>, body: string): Promise<Response> =>
  fetch(hostedUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });

const oversizedBody = "x".repeat(1_000_001);

test("a body over the size limit gets a 413", async () => {
  const response = await postToMcp({ Authorization: "Bearer token-large" }, oversizedBody);

  assert.equal(response.status, 413);
});

test("an oversized body with no token gets a 401, so the token check runs before the body is read", async () => {
  const response = await postToMcp({}, oversizedBody);

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), challenge);
});

test("a GET on the MCP path gets a 405 that allows only POST", async () => {
  const response = await fetch(hostedUrl, { headers: { Authorization: "Bearer token-get" } });

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});

test("an unknown path gets a 404", async () => {
  const response = await fetch(new URL("/other", hostedUrl), {
    headers: { Authorization: "Bearer token-other" },
  });

  assert.equal(response.status, 404);
});
