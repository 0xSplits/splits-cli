import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  type AgentLoginPoll,
  createPkcePair,
  pollIntervalMs,
  waitForAgentLogin,
} from "./agent-login.js";

describe("browser login", () => {
  it("derives the S256 challenge from the verifier", () => {
    const { codeVerifier, codeChallenge } = createPkcePair();

    assert.match(codeVerifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(
      codeChallenge,
      createHash("sha256").update(codeVerifier).digest("base64url"),
    );
  });

  it("polls every 2 s for the first minute, then every 5 s", () => {
    assert.equal(pollIntervalMs(0), 2_000);
    assert.equal(pollIntervalMs(59_999), 2_000);
    assert.equal(pollIntervalMs(60_000), 5_000);
  });

  it("stops at the first answer that is not pending", async () => {
    const answers: AgentLoginPoll[] = [
      { status: "pending" },
      { status: "pending" },
      {
        status: "approved",
        apiKey: "sk_test",
        orgId: "org",
        orgName: "Acme",
        scopes: ["read"],
        created: null,
      },
    ];
    const clock = fakeClock();

    const result = await waitForAgentLogin({
      poll: async () => answers.shift() ?? { status: "pending" },
      expiresAt: new Date(clock.now() + 600_000).toISOString(),
      sleep: clock.sleep,
      now: clock.now,
    });

    assert.equal(result.status, "approved");
    assert.deepEqual(clock.sleeps, [2_000, 2_000, 2_000]);
  });

  it("reports expired once the request outlives its deadline", async () => {
    const clock = fakeClock();
    let polls = 0;

    const result = await waitForAgentLogin({
      poll: async () => {
        polls += 1;
        return { status: "pending" };
      },
      expiresAt: new Date(clock.now() + 70_000).toISOString(),
      sleep: clock.sleep,
      now: clock.now,
    });

    assert.deepEqual(result, { status: "expired" });
    assert.equal(polls, 32);
  });
});

function fakeClock() {
  let time = Date.parse("2026-10-07T00:00:00.000Z");
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}
