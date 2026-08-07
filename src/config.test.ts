import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("legacy config, profiles, and environment precedence remain isolated", async () => {
  const home = await mkdtemp(join(tmpdir(), "splits-cli-config-"));
  const previousHome = process.env.HOME;
  const previousProfile = process.env.SPLITS_PROFILE;
  process.env.HOME = home;
  delete process.env.SPLITS_PROFILE;

  try {
    const configDir = join(home, ".splits");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(configDir, { recursive: true }));
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({
        apiKey: { value: "legacy-key", savedAt: "2026-01-01T00:00:00.000Z" },
        apiUrl: "https://legacy.example",
        key: { name: "legacy", address: "0x0000000000000000000000000000000000000001", privateKey: `0x${"01".repeat(32)}` },
      }),
    );

    // Import only after HOME is set: config resolves its path at module load.
    const config = await import("./config.js");
    assert.deepEqual(await config.resolveApiKey({}), { value: "legacy-key", source: "keystore" });
    assert.equal(await config.loadLocalPrivateKey(), `0x${"01".repeat(32)}`);
    assert.equal((await config.getActiveProfile()).source, "legacy");

    await config.createProfile("alpha");
    await config.saveApiKey("alpha-key", { apiUrl: "https://alpha.example" });
    await config.saveKey({ name: "alpha", address: "0x0000000000000000000000000000000000000002", privateKey: `0x${"02".repeat(32)}` });
    await config.createProfile("beta");
    await config.saveApiKey("beta-key");
    await config.saveKey({ name: "beta", address: "0x0000000000000000000000000000000000000003", privateKey: `0x${"03".repeat(32)}` });

    process.env.SPLITS_PROFILE = "alpha";
    assert.deepEqual(await config.resolveApiKey({}), { value: "alpha-key", source: "keystore" });
    assert.equal(await config.loadLocalPrivateKey(), `0x${"02".repeat(32)}`);
    // API environment credentials still override the selected profile.
    assert.deepEqual(await config.resolveApiKey({ SPLITS_API_KEY: "env-key" }), { value: "env-key", source: "env" });

    process.env.SPLITS_PROFILE = "beta";
    assert.equal(await config.loadLocalPrivateKey(), `0x${"03".repeat(32)}`);
    // The alpha key must never be available for a beta signing operation.
    assert.notEqual(await config.loadLocalPrivateKey(), `0x${"02".repeat(32)}`);

    const persisted = JSON.parse(await readFile(join(configDir, "config.json"), "utf8"));
    assert.equal(persisted.apiKey.value, "legacy-key");
    assert.equal(persisted.profiles.alpha.key.name, "alpha");
    assert.equal(persisted.profiles.beta.key.name, "beta");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.SPLITS_PROFILE;
    else process.env.SPLITS_PROFILE = previousProfile;
    await rm(home, { recursive: true, force: true });
  }
});
