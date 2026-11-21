import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  type AgentLoginPoll,
  createPkcePair,
  describeCreatedWorkspace,
  describeOtherTreasurySigners,
  pollIntervalMs,
  resolveLoginInput,
  waitForAgentLogin,
} from "./agent-login.js";
import { SplitsApiError } from "./http.js";

describe("auth login input", () => {
  it("logs in through the browser when no key is given at all", () => {
    assert.deepEqual(resolveLoginInput({ flag: undefined, stdin: "" }), {
      kind: "browser",
    });
  });

  it("uses a key from the flag or from stdin", () => {
    assert.deepEqual(resolveLoginInput({ flag: " sk_a ", stdin: "" }), {
      kind: "key",
      apiKey: "sk_a",
    });
    assert.deepEqual(resolveLoginInput({ flag: undefined, stdin: "sk_b\n" }), {
      kind: "key",
      apiKey: "sk_b",
    });
  });

  it("refuses an empty --api-key instead of starting a browser login", () => {
    assert.throws(
      () => resolveLoginInput({ flag: "", stdin: "" }),
      /API key on --api-key or stdin is empty/,
    );
  });

  it("refuses a blank value piped on stdin", () => {
    assert.throws(
      () => resolveLoginInput({ flag: undefined, stdin: "\n" }),
      /API key on --api-key or stdin is empty/,
    );
  });
});

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

  it("keeps waiting through rate limits and server errors", async () => {
    const failures = [
      new SplitsApiError(undefined, 429, "Too many requests"),
      new SplitsApiError(undefined, 502, "Bad gateway"),
      new TypeError("fetch failed"),
    ];
    const clock = fakeClock();

    const result = await waitForAgentLogin({
      poll: async () => {
        const failure = failures.shift();
        if (failure) throw failure;
        return { status: "denied", reason: "person_declined" };
      },
      expiresAt: new Date(clock.now() + 600_000).toISOString(),
      sleep: clock.sleep,
      now: clock.now,
    });

    assert.deepEqual(result, { status: "denied", reason: "person_declined" });
  });

  it("stops on an error that waiting cannot fix", async () => {
    const clock = fakeClock();

    await assert.rejects(
      waitForAgentLogin({
        poll: async () => {
          throw new SplitsApiError("VALIDATION_ERROR", 400, "Bad verifier");
        },
        expiresAt: new Date(clock.now() + 600_000).toISOString(),
        sleep: clock.sleep,
        now: clock.now,
      }),
      /Bad verifier/,
    );
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

describe("created workspace diagram", () => {
  const agentKey = "0x1111111111111111111111111111111111111111";
  const created = {
    rootAddress: "0x2222222222222222222222222222222222222222",
    treasuryAddress: "0x4444444444444444444444444444444444444444",
    chainIds: [8453],
    recoveryEmail: "ops@acme.com",
  };

  it("lists every treasury signer the server returns, with the threshold", () => {
    const diagram = describeCreatedWorkspace({
      orgName: "Acme",
      signerAddress: agentKey,
      created: {
        ...created,
        treasurySigners: [
          { address: agentKey, name: "Claude Code" },
          { address: "0x3333333333333333333333333333333333333333", name: "Judge bot" },
        ],
        treasuryThreshold: 2,
      },
    });

    assert.match(
      diagram,
      /Treasury 0x4{40} {2}2 of 2: this agent's key 0x1{40}, Judge bot 0x3{40}/,
    );
  });

  it("shows the agent key alone when the server returns no treasury signers", () => {
    const diagram = describeCreatedWorkspace({
      orgName: "Acme",
      signerAddress: agentKey,
      created,
    });

    assert.match(diagram, /Treasury 0x4{40} {2}1 of 1: this agent's key 0x1{40}$/m);
  });
});

describe("other treasury signers guidance", () => {
  const agentKey = "0x1111111111111111111111111111111111111111";
  const created = {
    rootAddress: "0x2222222222222222222222222222222222222222",
    treasuryAddress: "0x4444444444444444444444444444444444444444",
    chainIds: [8453],
    recoveryEmail: "ops@acme.com",
  };

  it("says how each other signer approves, and who approves another agent's login", () => {
    const guidance = describeOtherTreasurySigners({
      signerAddress: agentKey,
      approver: "the person, as an owner,",
      created: {
        ...created,
        treasurySigners: [
          { address: agentKey, name: "Claude Code" },
          { address: "0x3333333333333333333333333333333333333333", name: "Judge bot" },
        ],
        treasuryThreshold: 2,
      },
    });

    assert.match(guidance ?? "", /needs 2 of 2 signatures/);
    assert.match(guidance ?? "", /Judge bot 0x3{40}/);
    assert.match(guidance ?? "", /opens its signUrl and connects the wallet/);
    assert.match(guidance ?? "", /the person, as an owner, approves the login/);
  });

  it("says nothing when this agent's key is the only treasury signer", () => {
    assert.equal(
      describeOtherTreasurySigners({
        signerAddress: agentKey,
        approver: "the person, as an owner,",
        created: {
          ...created,
          treasurySigners: [{ address: agentKey, name: "Claude Code" }],
          treasuryThreshold: 1,
        },
      }),
      null,
    );
    assert.equal(
      describeOtherTreasurySigners({
        signerAddress: agentKey,
        approver: "the person, as an owner,",
        created,
      }),
      null,
    );
  });
});
