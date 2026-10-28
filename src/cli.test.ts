import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const account = "0x1111111111111111111111111111111111111111";
const call = {
  to: "0x2222222222222222222222222222222222222222",
  data: "0x",
};

test("custom --calls parses a JSON array before sending the proposal", async () => {
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/public/v1/proposals/custom");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end('{"data":{"id":"test"}}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const run = (calls: string) =>
      execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          cliPath,
          "transactions",
          "create",
          "custom",
          "--account",
          account,
          "--chain-id",
          "1",
          "--calls",
          calls,
        ],
        {
          env: {
            ...process.env,
            SPLITS_API_KEY: "sk_test",
            SPLITS_API_URL: apiUrl,
          },
        },
      );

    await run(JSON.stringify([call]));
    assert.deepEqual(requests, [
      { account, chainId: 1, calls: [{ ...call, value: "0" }] },
    ]);

    await assert.rejects(run("not JSON"), (error: Error & { stdout: string }) => {
      assert.match(error.stdout, /--calls must be valid JSON/);
      return true;
    });
    await assert.rejects(
      run(JSON.stringify(call)),
      (error: Error & { stdout: string }) => {
        assert.match(error.stdout, /expected array, received object/);
        return true;
      },
    );
    assert.equal(requests.length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("accounts deploy proposes a zero-value call to the account itself", async () => {
  let request: unknown;
  const server = createServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/public/v1/proposals/custom");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end('{"data":{"id":"test"}}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        cliPath,
        "accounts",
        "deploy",
        account,
        "--chain-id",
        "8453",
      ],
      {
        env: {
          ...process.env,
          SPLITS_API_KEY: "sk_test",
          SPLITS_API_URL: apiUrl,
        },
      },
    );
    assert.deepEqual(request, {
      account,
      chainId: 8453,
      calls: [{ to: account, data: "0x", value: "0" }],
      name: "Smart account deployment",
      memo: "Deploy account on chain 8453",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
