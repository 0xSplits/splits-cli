import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { httpRequest, SplitsApiError } from "./http.js";

test("retries a pre-handler 429 before creating a resource", async () => {
  let attempts = 0;
  let created = 0;
  const server = createServer((req, res) => {
    attempts++;
    assert.equal(req.method, "POST");
    if (attempts === 1) {
      res.writeHead(429, { "Retry-After": "1", "x-ratelimit-limit": "3" });
      res.end("Too many requests, please try again in a second");
      return;
    }
    created++;
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end('{"data":{"id":"created"}}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const started = Date.now();
    const result = await httpRequest<{ data: { id: string } }>(
      { apiUrl, apiKey: "sk_test" },
      "/messages",
      { method: "POST", requireAuth: true, body: { message: "hello" } },
    );
    assert.deepEqual(result, { data: { id: "created" } });
    assert.equal(attempts, 2);
    assert.equal(created, 1);
    assert.ok(Date.now() - started >= 1_000);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("exhausted retries identify the rate limit and preserve the server message", async () => {
  let attempts = 0;
  const server = createServer((_req, res) => {
    attempts++;
    res.writeHead(429, { "Retry-After": "0", "x-ratelimit-limit": "3" });
    res.end("Too many requests, please try again in a second");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await assert.rejects(
      httpRequest({ apiUrl, apiKey: "sk_test" }, "/accounts", {
        requireAuth: true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof SplitsApiError);
        assert.equal(error.status, 429);
        assert.equal(error.splitsCode, "rate_limited");
        assert.match(error.message, /limit: 3/);
        assert.match(error.message, /retried 3 times/);
        assert.match(error.message, /Too many requests/);
        return true;
      },
    );
    assert.equal(attempts, 4);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("does not retry an application 429 from a POST", async () => {
  let attempts = 0;
  const server = createServer((_req, res) => {
    attempts++;
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end('{"error":{"code":"TOO_MANY_IN_FLIGHT","message":"Too much work already queued"}}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await assert.rejects(
      httpRequest({ apiUrl, apiKey: "sk_test" }, "/accounting/reports", {
        method: "POST",
        requireAuth: true,
        body: { report: "test" },
      }),
      (error: unknown) => {
        assert.ok(error instanceof SplitsApiError);
        assert.equal(error.splitsCode, "TOO_MANY_IN_FLIGHT");
        assert.equal(error.message, "Too much work already queued");
        return true;
      },
    );
    assert.equal(attempts, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
