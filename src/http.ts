// Shared HTTP helper for the CLI. Consolidates the authenticated and
// unauthenticated request paths so error parsing, timeouts, and the
// SplitsApiError shape stay in one place.

import { resolveApiKey, resolveApiUrl } from "./config.js";

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
  const headers: Record<string, string> = {};
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
