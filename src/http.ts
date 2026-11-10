// Shared HTTP helper for the CLI. Consolidates the authenticated and
// unauthenticated request paths so error parsing, timeouts, and the
// SplitsApiError shape stay in one place.

import { createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { DEFAULT_API_URL } from "./config.js";

// Build the User-Agent the backend's `detectPublicApiSource` parses to tag
// transactions with their origin (CLI vs. MCP vs. raw API). Without this
// header Node's default fetch sends nothing identifying, so MCP-driven
// proposals were being recorded as plain "API" calls.
const { version: PACKAGE_VERSION } = createRequire(import.meta.url)(
  "../package.json",
) as { version: string };

const IS_MCP_MODE =
  process.env.SPLITS_MCP_MODE === "1" || process.argv.includes("--mcp");

const USER_AGENT = `splits-cli/${PACKAGE_VERSION}${IS_MCP_MODE ? " (mcp)" : ""}`;

// Typed error thrown by httpRequest so callers (including MCP consumers) can
// branch on machine-readable backend error codes like SELF_TAKEOVER_BLOCKED,
// PASSKEY_NOT_AVAILABLE, SMART_ACCOUNT_STATE_CHANGE_IN_PROGRESS, etc. Also
// used for client-side conditions like missing credentials and network
// timeouts; those set status to 0 so callers can distinguish them from HTTP
// failures. Field name mirrors the backend SplitsError contract.
export class SplitsApiError extends Error {
  readonly splitsCode: string | undefined;
  readonly status: number;
  constructor(splitsCode: string | undefined, status: number, message: string) {
    super(message);
    this.name = "SplitsApiError";
    this.splitsCode = splitsCode;
    this.status = status;
  }
}

// Wire facts of the Base-plan limiter in 0xSplits/splits
// (src/middleware/base_plan_api_rate_limit.ts). The server names neither the
// plan nor the limiter, so both must match; a server rewording degrades to
// the generic message, never to a false Base claim.
const BASE_LIMIT_BODY = "Too many requests, please try again in a second";
const BASE_LIMIT_HEADER = "1"; // x-ratelimit-limit

const PRO_UPGRADE_PATH = "/settings/team/upgrade?plan=pro";
const PRO_UPGRADE_URL = `https://app.splits.org${PRO_UPGRADE_PATH}`;
const PRO_TERMS = "a subscription or a qualifying Earn balance";

// Agent-facing passage. Lives beside the error copy so the limit, the plan
// wording and the URL have one source; README.md's "Rate limits" section is
// the one hand-synced copy.
export const RATE_LIMIT_NOTE =
  "Rate limits: a workspace on the Base plan can make 1 API request per second across the whole organization, so on Base send at most one request per second. " +
  "Every plan also has other limits, per IP address and on some routes. " +
  "A request over any limit fails with HTTP 429 and the error says how long to wait; wait, then retry. " +
  "The API does not report a workspace's plan: a 429 error that names the Base plan is how you learn it. " +
  "Workspaces on the Pro plan are not held to the Base limit. " +
  `Changing plan is optional and is a person's decision, not an agent's: a workspace owner can review Pro (${PRO_TERMS}) at ${PRO_UPGRADE_URL}`;

// The HTTP-date form of Retry-After is ignored: the API's limiters only send
// whole seconds.
const retryAfterSeconds = (res: Response): number | null => {
  const header = res.headers.get("retry-after")?.trim() ?? "";
  return /^\d+$/.test(header) ? Number(header) : null;
};

// The server sends 0 when the window reset while it was answering, and
// windows run from one second to one day.
const waitSentence = (seconds: number | null): string => {
  if (seconds === null) return "Wait before retrying.";
  if (seconds === 0) return "Wait a moment, then retry.";
  if (seconds === 1) return "Wait 1 second, then retry.";
  if (seconds < 120) return `Wait ${seconds} seconds, then retry.`;
  const about =
    seconds < 7200
      ? `${Math.ceil(seconds / 60)} minutes`
      : `${Math.ceil(seconds / 3600)} hours`;
  return `Wait ${seconds} seconds (about ${about}), then retry.`;
};

const isBasePlanLimit = (res: Response, body: string): boolean =>
  res.status === 429 &&
  res.headers.get("x-ratelimit-limit") === BASE_LIMIT_HEADER &&
  body.trim() === BASE_LIMIT_BODY;

// The one place a 429 without a server error envelope becomes an error. The
// message is final here because MCP forwards nothing but the message text.
// Pure, so a retry loop can call it when it gives up. The codes are for
// in-process callers; incur prints neither.
export const rateLimitError = (
  res: Response,
  body: string,
  apiUrl: string,
): SplitsApiError => {
  const wait = waitSentence(retryAfterSeconds(res));
  if (!isBasePlanLimit(res, body)) {
    return new SplitsApiError(
      "rate-limited",
      429,
      `Rate limited (HTTP 429): too many requests. ${wait}`,
    );
  }
  // Only production's web origin is known.
  const upgradeAt =
    apiUrl === DEFAULT_API_URL
      ? PRO_UPGRADE_URL
      : `${PRO_UPGRADE_PATH} in the Splits web app.`;
  return new SplitsApiError(
    "rate-limited-base-plan",
    429,
    "Rate limited (HTTP 429): this workspace is on the Base plan, which allows 1 API request per second for the whole organization. " +
      `${wait} Waiting is all this request needs. ` +
      `Optional: workspaces on the Pro plan are not held to this limit; a workspace owner can review Pro (${PRO_TERMS}) at ${upgradeAt}`,
  );
};

// 30s default — generous for chain-heavy endpoints, short enough that a
// wedged TCP connection doesn't hang an MCP tool call indefinitely.
const REQUEST_TIMEOUT_MS = 30_000;

type HttpOptions = {
  method?: "GET" | "PUT" | "POST" | "DELETE";
  body?: Record<string, unknown>;
  requireAuth: boolean;
};

export type Credentials = { apiKey: string | null; apiUrl: string };

export async function httpRequest<T = unknown>(
  credentials: Credentials,
  path: string,
  options: HttpOptions,
): Promise<T> {

  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (options.requireAuth) {
    if (credentials.apiKey === null) {
      throw new SplitsApiError(
        "no-api-key",
        0,
        "No API key configured. Run `splits auth login`, pick a workspace with `splits auth use`, or export SPLITS_API_KEY.",
      );
    }
    headers["Authorization"] = `Bearer ${credentials.apiKey}`;
  }
  if (options.body) {
    headers["Content-Type"] = "application/json";
  }

  const url = `${credentials.apiUrl}/public/v1${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new SplitsApiError(
        "network-timeout",
        0,
        `Request to ${path} timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`,
      );
    }
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let errObj: { code?: string; message?: string } | undefined;
    try {
      errObj = (JSON.parse(text) as { error?: typeof errObj } | null)?.error;
    } catch {
      // not JSON: errObj stays undefined
    }
    if (res.status === 429 && errObj === undefined) {
      throw rateLimitError(res, text, credentials.apiUrl);
    }
    throw new SplitsApiError(
      errObj?.code,
      res.status,
      errObj?.message ?? `API error: ${res.status}`,
    );
  }
  return res.json() as Promise<T>;
}

// Generated reports are uploaded to the asset host and handed back as a plain
// URL, so the download is an unauthenticated GET. Kept separate from
// httpRequest because the body is a file, not JSON.
const DOWNLOAD_TIMEOUT_MS = 120_000;

export async function downloadToFile(
  url: string,
  destination: string,
): Promise<{ path: string; bytes: number }> {
  if (!url.startsWith("https://")) {
    throw new SplitsApiError(
      "invalid-download-url",
      0,
      `Refusing to download a report over a non-https URL: ${url}`,
    );
  }

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new SplitsApiError(
        "network-timeout",
        0,
        `Report download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s.`,
      );
    }
    throw err;
  }

  if (!res.ok || !res.body) {
    throw new SplitsApiError(
      "report-download-failed",
      res.status,
      `Report download failed: ${res.status}`,
    );
  }

  // Streamed so a large report never sits in memory, and written beside the
  // destination first so a failed download leaves no truncated file behind.
  const partial = `${destination}.partial`;
  try {
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream),
      createWriteStream(partial),
    );
    await rename(partial, destination);
  } catch (err) {
    await rm(partial, { force: true });
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new SplitsApiError(
        "network-timeout",
        0,
        `Report download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s.`,
      );
    }
    throw err;
  }

  const { size } = await stat(destination);
  return { path: resolve(destination), bytes: size };
}
