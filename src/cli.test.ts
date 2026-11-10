import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
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

const runAgainst = async (
  respond: (res: ServerResponse) => void,
  args: string[],
) => {
  const server = createServer((_req, res) => respond(res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return await execFileAsync(
      process.execPath,
      ["--import", "tsx", cliPath, ...args],
      {
        env: {
          ...process.env,
          SPLITS_API_KEY: "sk_test",
          SPLITS_API_URL: apiUrl,
        },
      },
    ).then(
      ({ stdout }) => stdout,
      (error: Error & { stdout: string }) => error.stdout,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

test("a 429 is explained, and names the Base plan only on the Base limiter's response", async () => {
  const html = { "Content-Type": "text/html; charset=utf-8" };
  const accountsList = (respond: (res: ServerResponse) => void) =>
    runAgainst(respond, ["accounts", "list"]);
  const planTalk = /\b(Base|Pro)\b/;

  const base = await accountsList((res) => {
    res.writeHead(429, {
      ...html,
      "Retry-After": "1",
      "X-RateLimit-Limit": "1",
      "X-RateLimit-Remaining": "0",
    });
    res.end("Too many requests, please try again in a second");
  });
  assert.match(base, /Rate limited \(HTTP 429\)/);
  assert.match(base, /Base plan/);
  assert.match(base, /Wait 1 second, then retry\./);
  assert.match(base, /Optional: .*\/settings\/team\/upgrade\?plan=pro/);

  const org = await accountsList((res) => {
    res.writeHead(429, {
      ...html,
      "Retry-After": "1",
      "X-RateLimit-Limit": "20",
      "X-RateLimit-Remaining": "0",
    });
    res.end("Too many requests, please try again in a few minutes");
  });
  assert.match(
    org,
    /Rate limited \(HTTP 429\): too many requests\. Wait 1 second, then retry\./,
  );
  assert.doesNotMatch(org, planTalk);
  assert.doesNotMatch(org, /few minutes/);

  const inFlight = await accountsList((res) => {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          code: "TOO_MANY_IN_FLIGHT",
          message: "Too much work already queued for this organization",
        },
      }),
    );
  });
  assert.match(inFlight, /Too much work already queued for this organization/);
  assert.doesNotMatch(inFlight, /Rate limited/);

  const bare = await accountsList((res) => {
    res.writeHead(429);
    res.end();
  });
  assert.match(
    bare,
    /Rate limited \(HTTP 429\): too many requests\. Wait before retrying\./,
  );
  assert.doesNotMatch(bare, planTalk);
});

test("--llms-full explains the Base limit and where a person can review Pro", async () => {
  const manifest = await runAgainst(() => {}, ["--llms-full"]);
  assert.match(manifest, /1 API request per second/);
  assert.match(
    manifest,
    /https:\/\/app\.splits\.org\/settings\/team\/upgrade\?plan=pro/,
  );
});
