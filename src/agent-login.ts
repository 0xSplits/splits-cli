import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { httpRequest, SplitsApiError } from "./http.js";

const FAST_POLL_MS = 2_000;
const SLOW_POLL_MS = 5_000;
const FAST_POLL_WINDOW_MS = 60_000;
const VERIFIER_BYTES = 32;

export type CreatedWorkspace = {
  rootAddress: string;
  treasuryAddress: string;
  chainIds: number[];
  recoveryEmail: string;
};

export type AgentLoginGrant = {
  apiKey: string;
  orgId: string;
  orgName: string;
  scopes: string[];
  created: CreatedWorkspace | null;
};

export type FinishedAgentLogin =
  | { status: "denied" | "consumed" | "expired" }
  | ({ status: "approved" } & AgentLoginGrant);

export type AgentLoginPoll = { status: "pending" } | FinishedAgentLogin;

export type StartedAgentLogin = {
  requestId: string;
  url: string;
  expiresAt: string;
  codeVerifier: string;
};

type MessageSigner = {
  address: `0x${string}`;
  signMessage: (args: { message: string }) => Promise<`0x${string}`>;
};

export const createPkcePair = () => {
  const codeVerifier = randomBytes(VERIFIER_BYTES).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
};

export const startAgentLogin = async ({
  apiUrl,
  signer,
  clientName,
}: {
  apiUrl: string;
  signer: MessageSigner;
  clientName: string;
}): Promise<StartedAgentLogin> => {
  const credentials = { apiKey: null, apiUrl };
  const { data: challenge } = await httpRequest<{
    data: { nonce: string; message: string };
  }>(credentials, "/auth/agent-login/challenge", {
    method: "POST",
    requireAuth: false,
    body: { address: signer.address },
  }).catch((error: unknown) => {
    if (error instanceof SplitsApiError && error.status === 404) {
      throw new Error(
        `${apiUrl} does not support browser login yet. Pass an API key instead: \`echo $KEY | splits auth login\`.`,
      );
    }
    throw error;
  });

  const { codeVerifier, codeChallenge } = createPkcePair();
  const signature = await signer.signMessage({ message: challenge.message });
  const { data } = await httpRequest<{
    data: { requestId: string; url: string; expiresAt: string };
  }>(credentials, "/auth/agent-login/requests", {
    method: "POST",
    requireAuth: false,
    body: {
      codeChallenge,
      clientName,
      signer: { address: signer.address, nonce: challenge.nonce, signature },
    },
  });
  return { ...data, codeVerifier };
};

export const pollAgentLogin = async ({
  apiUrl,
  requestId,
  codeVerifier,
}: {
  apiUrl: string;
  requestId: string;
  codeVerifier: string;
}): Promise<AgentLoginPoll> => {
  try {
    const { data } = await httpRequest<{ data: AgentLoginPoll }>(
      { apiKey: null, apiUrl },
      `/auth/agent-login/requests/${encodeURIComponent(requestId)}/poll`,
      { method: "POST", requireAuth: false, body: { codeVerifier } },
    );
    return data;
  } catch (error) {
    if (error instanceof SplitsApiError && error.status === 404) {
      return { status: "expired" };
    }
    throw error;
  }
};

const isTransientPollError = (error: unknown): boolean =>
  error instanceof TypeError ||
  (error instanceof SplitsApiError &&
    (error.status === 0 || error.status === 429 || error.status >= 500));

export const pollIntervalMs = (elapsedMs: number): number =>
  elapsedMs < FAST_POLL_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS;

export const waitForAgentLogin = async ({
  poll,
  expiresAt,
  sleep,
  now = Date.now,
}: {
  poll: () => Promise<AgentLoginPoll>;
  expiresAt: string;
  sleep: (ms: number) => Promise<unknown>;
  now?: () => number;
}): Promise<FinishedAgentLogin> => {
  const startedAt = now();
  const deadline = Date.parse(expiresAt);
  while (now() < deadline) {
    await sleep(pollIntervalMs(now() - startedAt));
    const result = await poll().catch((error: unknown) => {
      if (isTransientPollError(error)) return { status: "pending" as const };
      throw error;
    });
    if (result.status !== "pending") return result;
  }
  return { status: "expired" };
};

const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

const isBrowserSafeUrl = (url: string): boolean => {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      protocol === "https:" ||
      (protocol === "http:" && LOCAL_HOSTNAMES.includes(hostname))
    );
  } catch {
    return false;
  }
};

const browserCommand = (url: string): [string, string[]] => {
  if (process.platform === "darwin") return ["open", [url]];
  if (process.platform === "win32") {
    return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  }
  return ["xdg-open", [url]];
};

export const openInBrowser = (url: string): void => {
  if (!isBrowserSafeUrl(url)) return;
  const [command, args] = browserCommand(url);
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {}
};

export type LoginInput = { kind: "key"; apiKey: string } | { kind: "browser" };

export const resolveLoginInput = ({
  flag,
  stdin,
}: {
  flag: string | undefined;
  stdin: string;
}): LoginInput => {
  if (flag === undefined && stdin.length === 0) return { kind: "browser" };
  const apiKey = (flag ?? stdin).trim();
  if (apiKey.length === 0) {
    throw new Error(
      "The API key on --api-key or stdin is empty. Pass a key, or run `splits auth login` with no key " +
        "to log in through the browser.",
    );
  }
  return { kind: "key", apiKey };
};

export const describeCreatedWorkspace = ({
  orgName,
  created,
  signerAddress,
}: {
  orgName: string;
  created: CreatedWorkspace;
  signerAddress: string;
}): string =>
  [
    `${orgName} (chains ${created.chainIds.join(", ")})`,
    `└─ Root ${created.rootAddress}  1 of 1: ${created.recoveryEmail} (recovery)`,
    `   └─ Treasury ${created.treasuryAddress}  1 of 1: this agent's key ${signerAddress}`,
  ].join("\n");
