import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

import { z } from "incur";

// config.ts reads the home directory when it loads, so HOME points at a
// scratch directory before the import.
const home = await fs.mkdtemp(join(tmpdir(), "splits-cli-config-"));
process.env.HOME = home;
const config = await import("./config.js");

const CONFIG_PATH = join(home, ".splits", "config.json");
const LOCK_PATH = join(home, ".splits", "config.json.lock");

describe("config v1 files", () => {
  beforeEach(resetConfig);

  it("reads a v1 file as one workspace named default and one key", async () => {
    await writeFile(V1_FILE);

    assert.deepEqual(await config.listWorkspaces(), [
      {
        alias: "default",
        orgId: null,
        orgName: null,
        apiUrl: "https://staging.example.com",
        savedAt: "2026-01-01T00:00:00.000Z",
        active: true,
      },
    ]);
    assert.deepEqual(await config.listKeys(), [
      { name: "ops", address: KEY_A.address },
    ]);
    assert.deepEqual(await config.resolveCredentials({}), {
      apiKey: { value: "sk_v1", source: "keystore" },
      apiUrl: "https://staging.example.com",
      workspace: "default",
    });
  });

  it("never rewrites a v1 file on read", async () => {
    await writeFile(V1_FILE);
    const before = await fs.readFile(CONFIG_PATH, "utf-8");

    await config.listWorkspaces();
    await config.resolveCredentials({});
    await config.loadLocalKey();

    assert.equal(await fs.readFile(CONFIG_PATH, "utf-8"), before);
  });

  it("rewrites a v1 file as v2 on the first write, keeping its contents", async () => {
    await writeFile(V1_FILE);

    await config.saveKey(KEY_B);

    assert.deepEqual(await readFile(), {
      version: 2,
      key: OLDER_CLI_GUARD,
      activeWorkspace: "default",
      workspaces: {
        default: {
          orgId: null,
          orgName: null,
          apiKey: "sk_v1",
          apiUrl: "https://staging.example.com",
          savedAt: "2026-01-01T00:00:00.000Z",
        },
      },
      keys: {
        [KEY_A.address]: { name: "ops", privateKey: KEY_A.privateKey },
        [KEY_B.address]: { name: KEY_B.name, privateKey: KEY_B.privateKey },
      },
    });
  });

  it("writes a v2 file that a CLI from before v2 refuses to read", async () => {
    await config.saveKey(KEY_A);

    const result = PUBLISHED_V1_SCHEMA.safeParse(await readFile());

    assert.equal(result.success, false);
  });

  it("refuses a file from a newer config version", async () => {
    await writeFile({ version: 3 });

    await assert.rejects(config.listWorkspaces(), /version 3/);
  });
});

describe("credential precedence", () => {
  beforeEach(async () => {
    await resetConfig();
    await login({ orgId: "org-1", orgName: "Acme", apiKey: "sk_acme" });
    await login({
      orgId: "org-2",
      orgName: "Pett",
      apiKey: "sk_pett",
      apiUrl: "https://staging.example.com",
    });
  });

  it("uses the active workspace by default", async () => {
    assert.deepEqual(await config.resolveCredentials({}), {
      apiKey: { value: "sk_pett", source: "keystore" },
      apiUrl: "https://staging.example.com",
      workspace: "pett",
    });
  });

  it("lets SPLITS_WORKSPACE override the active workspace", async () => {
    const resolved = await config.resolveCredentials({
      SPLITS_WORKSPACE: "acme",
    });

    assert.equal(resolved.workspace, "acme");
    assert.equal(resolved.apiKey?.value, "sk_acme");
    assert.equal(resolved.apiUrl, config.DEFAULT_API_URL);
  });

  it("lets --workspace override SPLITS_WORKSPACE", async () => {
    const resolved = await config.resolveCredentials({
      SPLITS_WORKSPACE: "pett",
      workspace: "acme",
    });

    assert.equal(resolved.apiKey?.value, "sk_acme");
  });

  it("lets SPLITS_API_KEY win over every workspace", async () => {
    const resolved = await config.resolveCredentials({
      SPLITS_API_KEY: "sk_env",
      workspace: "acme",
    });

    assert.deepEqual(resolved.apiKey, { value: "sk_env", source: "env" });
  });

  it("lets SPLITS_API_URL win over the workspace URL", async () => {
    const resolved = await config.resolveCredentials({
      SPLITS_API_URL: "https://local.example.com",
    });

    assert.equal(resolved.apiUrl, "https://local.example.com");
  });

  it("names the saved workspaces when the requested one is unknown", async () => {
    await assert.rejects(
      config.resolveCredentials({ workspace: "nope" }),
      /No workspace named "nope"\. Saved workspaces: acme, pett\./,
    );
  });
});

describe("auth login", () => {
  beforeEach(resetConfig);

  it("names the workspace after the org and makes it active", async () => {
    const result = await login({
      orgId: "org-1",
      orgName: "Acme Corp!",
      apiKey: "sk_1",
    });

    assert.deepEqual(result, { alias: "acme-corp", replaced: false });
    assert.equal((await readFile()).activeWorkspace, "acme-corp");
  });

  it("refreshes the workspace of the same org instead of adding another", async () => {
    await login({ orgId: "org-1", orgName: "Acme", apiKey: "sk_old" });

    const result = await login({
      orgId: "org-1",
      orgName: "Acme",
      apiKey: "sk_new",
    });

    assert.deepEqual(result, { alias: "acme", replaced: true });
    assert.equal((await config.listWorkspaces()).length, 1);
  });

  it("refreshes a workspace migrated from v1 when the key matches", async () => {
    await writeFile(V1_FILE);

    const result = await login({
      orgId: "org-1",
      orgName: "Acme",
      apiKey: "sk_v1",
    });

    assert.deepEqual(result, { alias: "default", replaced: true });
    assert.deepEqual(
      (await config.listWorkspaces()).map((w) => [w.alias, w.orgId]),
      [["default", "org-1"]],
    );
  });

  it("numbers the alias of another org with the same name", async () => {
    await login({ orgId: "org-1", orgName: "Acme", apiKey: "sk_1" });

    const result = await login({
      orgId: "org-2",
      orgName: "Acme",
      apiKey: "sk_2",
    });

    assert.deepEqual(result, { alias: "acme-2", replaced: false });
  });

  it("adds a workspace for the same org on another API URL", async () => {
    await login({ orgId: "org-1", orgName: "Acme", apiKey: "sk_prod" });

    const result = await login({
      orgId: "org-1",
      orgName: "Acme",
      apiKey: "sk_local",
      apiUrl: "http://localhost:8080",
    });

    assert.deepEqual(result, { alias: "acme-2", replaced: false });
    assert.equal(
      (await config.resolveCredentials({ workspace: "acme" })).apiKey?.value,
      "sk_prod",
    );
  });

  it("keeps every other workspace and key", async () => {
    await config.saveKey(KEY_A);
    await login({ orgId: "org-1", orgName: "Acme", apiKey: "sk_1" });

    await login({ orgId: "org-2", orgName: "Pett", apiKey: "sk_2" });

    assert.deepEqual(
      (await config.listWorkspaces()).map((w) => w.alias),
      ["acme", "pett"],
    );
    assert.equal((await config.listKeys()).length, 1);
  });

  it("rejects an alias a shell would need quoted", async () => {
    await assert.rejects(
      login({ name: "my org", orgId: "org-1", orgName: null, apiKey: "sk" }),
      /Invalid workspace name/,
    );
  });
});

describe("auth use and logout", () => {
  beforeEach(async () => {
    await resetConfig();
    await login({ orgId: "org-1", orgName: "Acme", apiKey: "sk_1" });
    await login({ orgId: "org-2", orgName: "Pett", apiKey: "sk_2" });
  });

  it("switches the active workspace", async () => {
    await config.useWorkspace("acme");

    assert.equal((await readFile()).activeWorkspace, "acme");
  });

  it("removes the active workspace and hands active to the only one left", async () => {
    const result = await config.removeWorkspace();

    assert.deepEqual(result, { removed: "pett", activeWorkspace: "acme" });
  });

  it("leaves no active workspace when several remain", async () => {
    await login({ orgId: "org-3", orgName: "Third", apiKey: "sk_3" });

    const result = await config.removeWorkspace();

    assert.deepEqual(result, { removed: "third", activeWorkspace: null });
  });

  it("removes a named workspace without changing the active one", async () => {
    const result = await config.removeWorkspace("acme");

    assert.deepEqual(result, { removed: "acme", activeWorkspace: "pett" });
  });
});

describe("auth whoami", () => {
  beforeEach(resetConfig);

  it("fills in the org of a workspace migrated from v1", async () => {
    await writeFile(V1_FILE);

    await config.refreshWorkspaceOrg("default", {
      orgId: "org-1",
      orgName: "Acme",
    });

    const [workspace] = await config.listWorkspaces();
    assert.equal(workspace.orgId, "org-1");
    assert.equal(workspace.orgName, "Acme");
  });

  it("keeps the alias when the org is renamed", async () => {
    await login({ orgId: "org-1", orgName: "Acme", apiKey: "sk_1" });

    await config.refreshWorkspaceOrg("acme", {
      orgId: "org-1",
      orgName: "Acme Labs",
    });

    assert.deepEqual(
      (await config.listWorkspaces()).map((w) => [w.alias, w.orgName]),
      [["acme", "Acme Labs"]],
    );
  });

  it("writes nothing when the org has not changed", async () => {
    await writeFile(V1_FILE);
    await config.refreshWorkspaceOrg("default", {
      orgId: "org-1",
      orgName: "Acme",
    });
    const before = await fs.stat(CONFIG_PATH);

    await config.refreshWorkspaceOrg("default", {
      orgId: "org-1",
      orgName: "Acme",
    });

    assert.equal((await fs.stat(CONFIG_PATH)).mtimeMs, before.mtimeMs);
  });
});

describe("local keys", () => {
  beforeEach(resetConfig);

  it("adds keys instead of refusing when one exists", async () => {
    await config.saveKey(KEY_A);

    assert.deepEqual(await config.saveKey(KEY_B), { added: true });
    assert.equal((await config.listKeys()).length, 2);
  });

  it("keeps the saved entry when the same address is saved again", async () => {
    await config.saveKey(KEY_A);

    const result = await config.saveKey({ ...KEY_A, name: "renamed" });

    assert.deepEqual(result, { added: false });
    assert.equal((await config.listKeys())[0].name, KEY_A.name);
  });

  it("uses the only key when no address is given", async () => {
    await config.saveKey(KEY_A);

    assert.equal((await config.loadLocalKey())?.address, KEY_A.address);
  });

  it("requires an address when several keys are saved", async () => {
    await config.saveKey(KEY_A);
    await config.saveKey(KEY_B);

    await assert.rejects(config.loadLocalKey(), /Pass --key/);
    assert.equal(
      (await config.loadLocalKey(KEY_B.address.toLowerCase()))?.address,
      KEY_B.address,
    );
  });

  it("deletes one key by address", async () => {
    await config.saveKey(KEY_A);
    await config.saveKey(KEY_B);

    await config.removeKey(KEY_A.address);

    assert.deepEqual(await config.listKeys(), [
      { name: KEY_B.name, address: KEY_B.address },
    ]);
  });
});

describe("concurrent changes", () => {
  beforeEach(resetConfig);

  it("keeps every key when several are saved at once", async () => {
    await Promise.all([config.saveKey(KEY_A), config.saveKey(KEY_B)]);

    assert.equal((await config.listKeys()).length, 2);
  });

  it("waits for another process that holds the lock", async () => {
    await fs.writeFile(LOCK_PATH, "");
    setTimeout(() => void fs.rm(LOCK_PATH, { force: true }), 100);

    await config.saveKey(KEY_A);

    assert.equal((await config.listKeys()).length, 1);
  });

  it("takes over a lock left by a process that died", async () => {
    await fs.writeFile(LOCK_PATH, "");
    const longAgo = new Date(Date.now() - 60_000);
    await fs.utimes(LOCK_PATH, longAgo, longAgo);

    await config.saveKey(KEY_A);

    assert.equal((await config.listKeys()).length, 1);
    await assert.rejects(fs.stat(LOCK_PATH), { code: "ENOENT" });
  });
});

describe("file safety", () => {
  beforeEach(resetConfig);

  it("writes the file with mode 0600", async () => {
    await config.saveKey(KEY_A);

    const { mode } = await fs.stat(CONFIG_PATH);
    assert.equal(mode & 0o777, 0o600);
  });

  it("refuses to write through a symlink", async () => {
    const target = join(home, "elsewhere.json");
    await fs.writeFile(target, "{}");
    await fs.symlink(target, CONFIG_PATH);

    await assert.rejects(config.saveKey(KEY_A), /is a symlink/);
    assert.equal(await fs.readFile(target, "utf-8"), "{}");
  });
});

// ----- helpers -----

const OLDER_CLI_GUARD =
  "This file is in the v2 format. Upgrade @splits/splits-cli to read it.";

// The config schema of @splits/splits-cli 0.2.11, the last release before v2.
const PUBLISHED_V1_SCHEMA = z.object({
  apiKey: z.object({ value: z.string().min(1), savedAt: z.string() }).optional(),
  apiUrl: z.string().url().optional(),
  key: z
    .object({
      name: z.string().min(1),
      address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      privateKey: z.string().regex(/^0x[0-9a-f]{64}$/i),
    })
    .optional(),
});

const KEY_A = {
  name: "ops",
  address: "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23",
  privateKey:
    "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
} as const;

const KEY_B = {
  name: "backup",
  address: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
  privateKey:
    "0x1111111111111111111111111111111111111111111111111111111111111111",
} as const;

const V1_FILE = {
  apiKey: { value: "sk_v1", savedAt: "2026-01-01T00:00:00.000Z" },
  apiUrl: "https://staging.example.com",
  key: KEY_A,
};

async function resetConfig(): Promise<void> {
  await fs.rm(join(home, ".splits"), { recursive: true, force: true });
  await fs.rm(join(home, "elsewhere.json"), { force: true });
  await fs.mkdir(join(home, ".splits"), { recursive: true });
}

async function writeFile(contents: unknown): Promise<void> {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(contents));
}

async function readFile(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
}

function login(input: {
  name?: string;
  orgId: string;
  orgName: string | null;
  apiKey: string;
  apiUrl?: string;
}) {
  return config.saveWorkspace(input);
}
