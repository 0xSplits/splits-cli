import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { DEFAULT_API_URL } from "./config.js";
import { RATE_LIMIT_NOTE, rateLimitError } from "./http.js";

const BASE_BODY = "Too many requests, please try again in a second";
const OTHER_BODY = "Too many requests, please try again in a few minutes";
const UPGRADE_PATH = "/settings/team/upgrade?plan=pro";
const PLAN_TALK = /\b(Base|Pro)\b/;

const limiter429 = (headers: Record<string, string>) =>
  new Response(null, {
    status: 429,
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  });

const base429 = (retryAfter = "1") =>
  limiter429({ "Retry-After": retryAfter, "X-RateLimit-Limit": "1" });

const generic = (headers: Record<string, string>, body = OTHER_BODY) =>
  rateLimitError(limiter429(headers), body, DEFAULT_API_URL);

test("a Base limiter 429 names the plan, the wait and the upgrade page", () => {
  const err = rateLimitError(base429(), BASE_BODY, DEFAULT_API_URL);
  assert.equal(err.splitsCode, "rate-limited-base-plan");
  assert.equal(err.status, 429);
  assert.equal(
    err.message,
    "Rate limited (HTTP 429): this workspace is on the Base plan, which allows 1 API request per second for the whole organization. Wait 1 second, then retry. Waiting is all this request needs. Optional: workspaces on the Pro plan are not held to this limit; a workspace owner can review Pro (a subscription or a qualifying Earn balance) at https://app.splits.org/settings/team/upgrade?plan=pro",
  );
});

test("a Base limiter 429 from a non-production API gives the upgrade path only", () => {
  const err = rateLimitError(base429(), BASE_BODY, "http://127.0.0.1:4000");
  assert.equal(err.splitsCode, "rate-limited-base-plan");
  assert.ok(err.message.endsWith(`at ${UPGRADE_PATH} in the Splits web app.`));
  assert.ok(!err.message.includes("https://app.splits.org"));
});

test("a Base limiter 429 with Retry-After 0 keeps the plan text", () => {
  const err = rateLimitError(base429("0"), BASE_BODY, DEFAULT_API_URL);
  assert.equal(err.splitsCode, "rate-limited-base-plan");
  assert.match(err.message, /Base plan.*Wait a moment, then retry\./);
});

test("any other limiter 429 gives the wait and no plan talk", () => {
  const err = generic({ "Retry-After": "1", "X-RateLimit-Limit": "20" });
  assert.equal(err.splitsCode, "rate-limited");
  assert.equal(err.status, 429);
  assert.equal(
    err.message,
    "Rate limited (HTTP 429): too many requests. Wait 1 second, then retry.",
  );
  assert.doesNotMatch(err.message, PLAN_TALK);
  assert.ok(!err.message.includes("few minutes"));
});

test("a bare 429 gives no number and no plan talk", () => {
  const err = rateLimitError(
    new Response(null, { status: 429 }),
    "",
    DEFAULT_API_URL,
  );
  assert.equal(err.splitsCode, "rate-limited");
  assert.equal(
    err.message,
    "Rate limited (HTTP 429): too many requests. Wait before retrying.",
  );
});

test("one Base signal without the other is not a Base claim", () => {
  for (const err of [
    generic({ "Retry-After": "1", "X-RateLimit-Limit": "1" }, OTHER_BODY),
    generic({ "Retry-After": "1", "X-RateLimit-Limit": "20" }, BASE_BODY),
    generic({ "Retry-After": "1" }, BASE_BODY),
  ]) {
    assert.equal(err.splitsCode, "rate-limited");
    assert.doesNotMatch(err.message, PLAN_TALK);
  }
});

test("Retry-After as an HTTP date gives no number", () => {
  const err = generic({ "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" });
  assert.equal(
    err.message,
    "Rate limited (HTTP 429): too many requests. Wait before retrying.",
  );
});

test("wait wording covers second, minute, hour and day windows", () => {
  for (const [retryAfter, sentence] of [
    ["0", "Wait a moment, then retry."],
    ["60", "Wait 60 seconds, then retry."],
    ["119", "Wait 119 seconds, then retry."],
    ["120", "Wait 120 seconds (about 2 minutes), then retry."],
    ["3600", "Wait 3600 seconds (about 60 minutes), then retry."],
    ["7200", "Wait 7200 seconds (about 2 hours), then retry."],
    ["86400", "Wait 86400 seconds (about 24 hours), then retry."],
  ] as const) {
    assert.equal(
      generic({ "Retry-After": retryAfter }).message,
      `Rate limited (HTTP 429): too many requests. ${sentence}`,
    );
  }
});

test("the README and the agent note agree on the upgrade page and say plan, not tier", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(readme.includes(UPGRADE_PATH));
  assert.ok(RATE_LIMIT_NOTE.includes(UPGRADE_PATH));
  assert.doesNotMatch(RATE_LIMIT_NOTE, /tier/i);
});
