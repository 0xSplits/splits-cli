// Shared HTTP helper for the CLI. Consolidates the authenticated and
// unauthenticated request paths so error parsing, timeouts, and the
// SplitsApiError shape stay in one place.

import { createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";


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

// 30s default — generous for chain-heavy endpoints, short enough that a
// wedged TCP connection doesn't hang an MCP tool call indefinitely.
const REQUEST_TIMEOUT_MS = 30_000;
const RATE_LIMIT_RETRIES = 3;

/** Accept both Retry-After formats and fall back to one second when absent. */
const retryAfterMs = (header: string | null): number => {
  if (header === null) return 1_000;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? 1_000 : Math.max(0, date - Date.now());
};

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
  const method = options.method ?? "GET";

  for (let attempt = 0; attempt <= RATE_LIMIT_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
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

    if (res.status === 429) {
      const body = await res.text();
      let errObj: { code?: string; message?: string } | undefined;
      try {
        errObj = (JSON.parse(body) as { error?: typeof errObj }).error;
      } catch {
        // The API's rate-limit middleware returns plain text.
      }
      // The API's rate-limit middleware sets Retry-After before a route runs.
      // Other 429s (for example TOO_MANY_IN_FLIGHT) are application errors.
      const retryable =
        res.headers.has("Retry-After") ||
        (method === "GET" && !errObj?.code);
      if (retryable && attempt < RATE_LIMIT_RETRIES) {
        await sleep(
          retryAfterMs(res.headers.get("Retry-After")) + Math.random() * 100,
        );
        continue;
      }
      if (!retryable) {
        throw new SplitsApiError(
          errObj?.code,
          429,
          errObj?.message || body.trim() || "API error: 429",
        );
      }
      const limit =
        res.headers.get("x-ratelimit-limit") ??
        res.headers.get("ratelimit-limit");
      const serverMessage = errObj?.message ?? body.trim();
      throw new SplitsApiError(
        "rate_limited",
        429,
        `Rate limited by the Splits API${limit ? ` (limit: ${limit})` : ""}; ` +
          `retried ${attempt} times.${serverMessage ? ` ${serverMessage}` : ""}`,
      );
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const errObj = (body as { error?: { code?: string; message?: string } })
        ?.error;
      throw new SplitsApiError(
        errObj?.code,
        res.status,
        errObj?.message ?? `API error: ${res.status}`,
      );
    }
    return res.json() as Promise<T>;
  }
  throw new Error("Unreachable rate-limit retry state");
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
