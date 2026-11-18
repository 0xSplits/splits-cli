#!/usr/bin/env node
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Cli, Mcp, z } from "incur";

import cli from "./cli.js";
import { hostedCredentials } from "./config.js";

const DEFAULT_PORT = 3000;
const MAX_BODY_BYTES = 1_000_000;
const MCP_PATH = "/mcp";
const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
const PROTECTED_RESOURCE_METADATA_PATHS = new Set([
  PROTECTED_RESOURCE_METADATA_PATH,
  `${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH}`,
]);
const BEARER_TOKEN_PATTERN = /^Bearer\s+(\S+)$/i;

const EXCLUDED_TOOL_NAMES = new Set([
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
]);
const HIDDEN_OPTION_NAMES = new Set(["workspace", "out", "force"]);

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be set to run the hosted MCP server.`);
  }
  return value;
};

const assertAllPresent = (
  kind: string,
  names: Set<string>,
  present: Set<string>,
): void => {
  const missing = [...names].filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(
      `The hosted MCP server hides ${kind} that no longer exist: ${missing.join(", ")}. Check whether they were renamed.`,
    );
  }
};

const apiUrl = requireEnv("SPLITS_API_URL");
const mcpUrl = requireEnv("SPLITS_MCP_URL");
const port = Number(process.env.PORT ?? DEFAULT_PORT);

const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const protectedResourceMetadata = JSON.stringify({
  resource: mcpUrl,
  authorization_servers: [apiUrl],
  bearer_methods_supported: ["header"],
});
const wwwAuthenticate = `Bearer resource_metadata="${new URL(mcpUrl).origin}${PROTECTED_RESOURCE_METADATA_PATH}"`;

const collectedTools = Mcp.collectTools(Cli.toCommands.get(cli as never)!, []);
assertAllPresent(
  "tools",
  EXCLUDED_TOOL_NAMES,
  new Set(collectedTools.map((tool) => tool.name)),
);

const hostedTools = collectedTools
  .filter((tool) => !EXCLUDED_TOOL_NAMES.has(tool.name))
  .map((tool) => {
    const entries = Object.entries({
      ...tool.command.args?.shape,
      ...tool.command.options?.shape,
    } as z.ZodRawShape);
    return {
      tool,
      inputNames: entries.map(([name]) => name),
      inputSchema: z.object(
        Object.fromEntries(
          entries.filter(([name]) => !HIDDEN_OPTION_NAMES.has(name)),
        ),
      ),
    };
  });
assertAllPresent(
  "options",
  HIDDEN_OPTION_NAMES,
  new Set(hostedTools.flatMap(({ inputNames }) => inputNames)),
);

const handleMcp = async (request: Request): Promise<Response> => {
  const server = new McpServer({ name: cli.name, version });
  for (const { tool, inputSchema } of hostedTools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema },
      (params, extra) =>
        Mcp.callTool(tool, params, { extra, name: cli.name, version }),
    );
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
};

const readBody = (req: IncomingMessage): Promise<string | null> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const toRequest = (req: IncomingMessage, body: string): Request => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    for (const item of [value ?? []].flat()) headers.append(name, item);
  }
  return new Request(mcpUrl, { method: "POST", headers, body });
};

const send = async (res: ServerResponse, response: Response): Promise<void> => {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
};

const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const { pathname } = new URL(req.url ?? "/", mcpUrl);

  if (req.method === "GET" && PROTECTED_RESOURCE_METADATA_PATHS.has(pathname)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(protectedResourceMetadata);
    return;
  }

  if (pathname !== MCP_PATH) {
    res.writeHead(404).end();
    return;
  }

  const apiKey = req.headers.authorization?.match(BEARER_TOKEN_PATTERN)?.[1];
  if (apiKey === undefined) {
    res.writeHead(401, { "WWW-Authenticate": wwwAuthenticate }).end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" }).end();
    return;
  }

  const body = await readBody(req);
  if (body === null) {
    res.writeHead(413).end();
    return;
  }

  const response = await hostedCredentials.run({ apiKey, apiUrl }, () =>
    handleMcp(toRequest(req, body)),
  );
  await send(res, response);
};

const server = createServer((req, res) => {
  route(req, res).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

server.listen(port, () => {
  process.stdout.write(
    `Splits hosted MCP server listening on port ${(server.address() as AddressInfo).port}\n`,
  );
});
