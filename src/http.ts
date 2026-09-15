// Shared HTTP helper for the CLI. Consolidates the authenticated and
// unauthenticated request paths so error parsing, timeouts, and the
// SplitsApiError shape stay in one place.

import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { resolveApiKey, resolveApiUrl } from "./config.js";

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

type HttpEnv = {
  SPLITS_API_KEY?: string;
  SPLITS_API_URL?: string;
};

type HttpOptions = {
  method?: "GET" | "PUT" | "POST" | "DELETE";
  body?: Record<string, unknown>;
  requireAuth: boolean;
};

export async function httpRequest<T = unknown>(
  env: HttpEnv,
  path: string,
  options: HttpOptions,
): Promise<T> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (options.requireAuth) {
    const resolved = await resolveApiKey(env);
    if (!resolved) {
      throw new SplitsApiError(
        "no-api-key",
        0,
        "No API key configured. Run `splits auth login` or export SPLITS_API_KEY.",
      );
    }
    headers["Authorization"] = `Bearer ${resolved.value}`;
  }
  if (options.body) {
    headers["Content-Type"] = "application/json";
  }

  const apiUrl = await resolveApiUrl(env);
  const url = `${apiUrl}/public/v1${path}`;

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

  if (!res.ok) {
    throw new SplitsApiError(
      "report-download-failed",
      res.status,
      `Report download failed: ${res.status}`,
    );
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(destination, buffer);

  return { path: resolve(destination), bytes: buffer.byteLength };
}
