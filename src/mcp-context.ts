import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export type ElicitationSchema = {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
};

export type ElicitationResult = {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
};

type ProtocolServer = {
  getClientCapabilities(): { elicitation?: unknown } | undefined;
  elicitInput(
    params: { message: string; requestedSchema: ElicitationSchema },
    options: { relatedRequestId?: string | number; timeout: number },
  ): Promise<ElicitationResult>;
};

type ToolCall = { server: ProtocolServer; requestId?: string | number };

type ToolHandler = (...args: unknown[]) => unknown;

type McpServerClass = {
  prototype: {
    server: ProtocolServer;
    registerTool(name: string, config: unknown, handler: ToolHandler): unknown;
  };
};

const toolCalls = new AsyncLocalStorage<ToolCall>();

const ELICITATION_TIMEOUT_MS = 10 * 60_000;

const loadIncurMcpServer = async (): Promise<McpServerClass> => {
  const incurRequire = createRequire(import.meta.resolve("incur"));
  const cjsPath = incurRequire.resolve(
    "@modelcontextprotocol/sdk/server/mcp.js",
  );
  const esmPath = cjsPath.replace(
    /([\\/])dist[\\/]cjs[\\/]/,
    "$1dist$1esm$1",
  );
  const module = (await import(pathToFileURL(esmPath).href)) as {
    McpServer: McpServerClass;
  };
  return module.McpServer;
};

export const captureMcpToolCalls = async () => {
  const { prototype } = await loadIncurMcpServer();
  const registerTool = prototype.registerTool;
  prototype.registerTool = function (name, config, handler) {
    const server = this.server;
    return registerTool.call(this, name, config, (...args: unknown[]) => {
      const extra = args[args.length - 1] as { requestId?: string | number };
      return toolCalls.run({ server, requestId: extra?.requestId }, () =>
        handler(...args),
      );
    });
  };
};

export const canAskPerson = (): boolean =>
  toolCalls.getStore()?.server.getClientCapabilities()?.elicitation !==
  undefined;

export const askPerson = async (params: {
  message: string;
  requestedSchema: ElicitationSchema;
}): Promise<ElicitationResult> => {
  const call = toolCalls.getStore();
  if (call === undefined) {
    throw new Error("No MCP client is connected to ask the person.");
  }
  return call.server.elicitInput(params, {
    relatedRequestId: call.requestId,
    timeout: ELICITATION_TIMEOUT_MS,
  });
};
