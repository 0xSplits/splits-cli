import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { verifyMessage } from "viem";

const home = await fs.mkdtemp(join(tmpdir(), "splits-cli-signing-"));
process.env.HOME = home;
const config = await import("./config.js");
const { computeCallsHash, signTransactionLocally } = await import(
  "./signing.js"
);

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const txId = "8f0c8d7e-3f4a-4b2c-9d1e-2a3b4c5d6e7f";
const signingHash = `0x${"ab".repeat(32)}` as const;
const rotatedSigningHash = `0x${"cd".repeat(32)}` as const;
const KEY = {
  name: "ops",
  address: "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23",
  privateKey:
    "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
} as const;

const usdcTransfer = {
  to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  value: "0",
  data: "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dEaD0000000000000000000000000000000000000000000000000000000000989680",
};
const attackerTransfer = {
  ...usdcTransfer,
  data: "0xa9059cbb000000000000000000000000000000000000000000000000000000000000bEEF0000000000000000000000000000000000000000000000000000000000989680",
};
const ethTransfer = {
  to: "0x000000000000000000000000000000000000dEaD",
  value: "1000000000000000",
  data: "0x",
};

const singleNetwork = (
  calls: unknown,
  overrides: Record<string, unknown> = {},
) => ({
  id: txId,
  chainId: 8453,
  dataType: "transaction",
  signingHash,
  callsHash: computeCallsHash([
    { chainId: 8453, calls: calls as (typeof usdcTransfer)[] },
  ]),
  transactionData: { calls },
  ...overrides,
});

type SignBody = { eoaSigner: string; signature: `0x${string}`; submit: boolean };

let server: Server;
let apiUrl: string;
let transactionResponses: unknown[];
let signResponses: { status: number; body: unknown }[];
let signBodies: SignBody[];
let getCount: number;

const okSign = {
  status: 200,
  body: {
    data: {
      id: txId,
      status: "PENDING",
      signerId: "s1",
      submitted: false,
      userOpHash: null,
      submissionError: null,
    },
  },
};

before(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === `/public/v1/transactions/${txId}`) {
      const response =
        transactionResponses[Math.min(getCount, transactionResponses.length - 1)];
      getCount += 1;
      return send(200, { data: response });
    }
    if (
      req.method === "PUT" &&
      req.url === `/public/v1/transactions/${txId}/sign`
    ) {
      signBodies.push(
        JSON.parse(Buffer.concat(chunks).toString("utf8")) as SignBody,
      );
      const response = signResponses.shift() ?? okSign;
      return send(response.status, response.body);
    }
    send(404, { error: { message: "not found" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await config.saveKey(KEY);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(home, { recursive: true, force: true });
});

beforeEach(() => {
  transactionResponses = [];
  signResponses = [];
  signBodies = [];
  getCount = 0;
});

const sign = (callsHash: string | undefined) =>
  signTransactionLocally({ apiKey: "sk_test", apiUrl }, txId, {
    submit: false,
    keyAddress: KEY.address,
    callsHash,
  });

const rejectsWithCode = async (
  promise: Promise<unknown>,
  code: string,
  check?: (message: string) => void,
) =>
  assert.rejects(promise, (error: Error & { code?: string }) => {
    assert.equal(error.code, code);
    check?.(error.message);
    return true;
  });

describe("computeCallsHash", () => {
  it("matches the fixed vector shared with the backend", () => {
    assert.equal(
      computeCallsHash([{ chainId: 8453, calls: [usdcTransfer] }]),
      "0xb41c1d4540c3ec6a099bc4319bbf0fc87a2185f64fc8f35f77cc88eca0c08541",
    );
  });

  it("hashes networks in chainId order whatever order they come in", () => {
    const base = { chainId: 8453, calls: [usdcTransfer] };
    const mainnet = { chainId: 1, calls: [ethTransfer] };
    assert.equal(
      computeCallsHash([base, mainnet]),
      computeCallsHash([mainnet, base]),
    );
  });
});

describe("transactions sign", () => {
  it("refuses without --calls-hash, returns the calls and the digest, and sends no PUT", async () => {
    transactionResponses = [singleNetwork([usdcTransfer])];
    const expected = computeCallsHash([
      { chainId: 8453, calls: [usdcTransfer] },
    ]);

    await rejectsWithCode(sign(undefined), "CALLS_HASH_REQUIRED", (message) => {
      assert.ok(
        message.includes(
          `--calls-hash ${expected} --no-submit --key ${KEY.address}`,
        ),
      );
      const payload = JSON.parse(message.slice(message.indexOf("{"))) as unknown;
      assert.deepEqual(payload, {
        transactionId: txId,
        callsHash: expected,
        chains: [{ chainId: 8453, calls: [usdcTransfer] }],
      });
    });
    assert.equal(signBodies.length, 0);
  });

  it("signs the signingHash when the digest matches", async () => {
    const tx = singleNetwork([usdcTransfer]);
    transactionResponses = [tx];

    await sign(tx.callsHash.toUpperCase().replace("0X", "0x"));

    assert.equal(signBodies.length, 1);
    assert.equal(signBodies[0].eoaSigner, KEY.address);
    assert.ok(
      await verifyMessage({
        address: KEY.address,
        message: { raw: signingHash },
        signature: signBodies[0].signature,
      }),
    );
  });

  it("refuses when --calls-hash does not match the calls", async () => {
    transactionResponses = [singleNetwork([attackerTransfer])];
    const reviewed = computeCallsHash([
      { chainId: 8453, calls: [usdcTransfer] },
    ]);

    await rejectsWithCode(sign(reviewed), "CALLS_HASH_MISMATCH", (message) => {
      assert.ok(message.includes(attackerTransfer.data));
    });
    assert.equal(signBodies.length, 0);
  });

  it("refuses when the server's callsHash disagrees with its own calls", async () => {
    const reviewed = computeCallsHash([
      { chainId: 8453, calls: [usdcTransfer] },
    ]);
    transactionResponses = [
      singleNetwork([attackerTransfer], { callsHash: reviewed }),
    ];

    await rejectsWithCode(sign(reviewed), "SERVER_CALLS_HASH_MISMATCH");
    assert.equal(signBodies.length, 0);
  });

  it("refuses when the backend returns no calls, and never signs blind", async () => {
    const { transactionData: _calls, callsHash: _hash, ...legacy } =
      singleNetwork([usdcTransfer]);
    transactionResponses = [{ ...legacy, transactionData: {} }];

    await rejectsWithCode(sign(undefined), "CALLS_NOT_EXPOSED");
    await rejectsWithCode(
      sign(computeCallsHash([{ chainId: 8453, calls: [usdcTransfer] }])),
      "CALLS_NOT_EXPOSED",
    );
    assert.equal(signBodies.length, 0);
  });

  it("refuses when the calls are present but the callsHash is not", async () => {
    transactionResponses = [
      singleNetwork([usdcTransfer], { callsHash: undefined }),
    ];

    await rejectsWithCode(sign(undefined), "CALLS_NOT_EXPOSED");
    assert.equal(signBodies.length, 0);
  });

  it("refuses malformed calls", async () => {
    transactionResponses = [
      {
        ...singleNetwork([usdcTransfer]),
        transactionData: { calls: [{ ...usdcTransfer, value: "-1" }] },
      },
    ];

    await rejectsWithCode(sign(undefined), "INVALID_CALLS");
    assert.equal(signBodies.length, 0);
  });

  it("re-checks the digest on the stale-nonce retry and refuses changed calls", async () => {
    const reviewedTx = singleNetwork([usdcTransfer]);
    transactionResponses = [
      reviewedTx,
      singleNetwork([attackerTransfer], { signingHash: rotatedSigningHash }),
    ];
    signResponses = [
      {
        status: 400,
        body: { error: { code: "INVALID_SIGNER_NONCE", message: "stale" } },
      },
    ];

    await rejectsWithCode(sign(reviewedTx.callsHash), "CALLS_HASH_MISMATCH");
    assert.equal(getCount, 2);
    assert.equal(signBodies.length, 1);
  });

  it("signs the rotated signingHash on the stale-nonce retry when the calls are unchanged", async () => {
    const reviewedTx = singleNetwork([usdcTransfer]);
    transactionResponses = [
      reviewedTx,
      { ...reviewedTx, signingHash: rotatedSigningHash },
    ];
    signResponses = [
      {
        status: 400,
        body: { error: { code: "INVALID_SIGNER_NONCE", message: "stale" } },
      },
    ];

    await sign(reviewedTx.callsHash);

    assert.equal(signBodies.length, 2);
    assert.ok(
      await verifyMessage({
        address: KEY.address,
        message: { raw: rotatedSigningHash },
        signature: signBodies[1].signature,
      }),
    );
  });

  it("hashes a merkle transaction's networks in chainId order and shows each network's calls", async () => {
    const chainCalls = [
      { chainId: 8453, calls: [usdcTransfer] },
      { chainId: 1, calls: [ethTransfer] },
    ];
    const callsHash = computeCallsHash(chainCalls);
    transactionResponses = [
      {
        id: txId,
        chainId: null,
        dataType: "merkleTransaction",
        signingHash,
        callsHash,
        merkleTransactionData: {
          chainTransactions: chainCalls.map(({ chainId, calls }) => ({
            chainId,
            transactionData: { calls },
          })),
        },
      },
    ];

    await rejectsWithCode(sign(undefined), "CALLS_HASH_REQUIRED", (message) => {
      const payload = JSON.parse(message.slice(message.indexOf("{"))) as {
        chains: { chainId: number }[];
      };
      assert.deepEqual(
        payload.chains.map(({ chainId }) => chainId),
        [1, 8453],
      );
    });
    await sign(callsHash);
    assert.equal(signBodies.length, 1);
  });

  it("refuses a merkle transaction when one network has no calls", async () => {
    transactionResponses = [
      {
        id: txId,
        chainId: null,
        dataType: "merkleTransaction",
        signingHash,
        callsHash: computeCallsHash([{ chainId: 1, calls: [ethTransfer] }]),
        merkleTransactionData: {
          chainTransactions: [
            { chainId: 1, transactionData: { calls: [ethTransfer] } },
            { chainId: 8453, transactionData: {} },
          ],
        },
      },
    ];

    await rejectsWithCode(sign(undefined), "CALLS_NOT_EXPOSED");
    assert.equal(signBodies.length, 0);
  });

  it("gives an MCP client the calls and the digest in the transactions_sign refusal", async () => {
    transactionResponses = [singleNetwork([usdcTransfer])];
    const expected = computeCallsHash([
      { chainId: 8453, calls: [usdcTransfer] },
    ]);
    const client = new Client({ name: "signing-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", cliPath, "--mcp"],
        env: {
          ...(process.env as Record<string, string>),
          HOME: home,
          SPLITS_API_KEY: "sk_test",
          SPLITS_API_URL: apiUrl,
        },
      }),
    );
    try {
      const result = (await client.callTool({
        name: "transactions_sign",
        arguments: { id: txId },
      })) as { isError?: boolean; content: { type: string; text: string }[] };

      assert.equal(result.isError, true);
      const text = result.content[0].text;
      assert.ok(text.includes(`--calls-hash ${expected}`));
      assert.ok(text.includes(usdcTransfer.data));
      assert.equal(signBodies.length, 0);
    } finally {
      await client.close();
    }
  });
});
