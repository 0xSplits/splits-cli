import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The MCP Registry entry in server.json pins the npm version, so it must match the
// version we publish. With --write (the npm `version` hook) this copies the version
// from package.json into server.json. Without it (prepublishOnly) it fails on any
// mismatch, which catches a version bumped by hand.
const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
const serverPath = fileURLToPath(new URL("../server.json", import.meta.url));

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const server = JSON.parse(readFileSync(serverPath, "utf8"));
const npmEntry = server.packages.find(
  (entry) => entry.registryType === "npm" && entry.identifier === pkg.name,
);
if (!npmEntry) {
  throw new Error(`server.json has no npm package entry for ${pkg.name}.`);
}
if (server.name !== pkg.mcpName) {
  throw new Error(
    `server.json name "${server.name}" does not match package.json mcpName "${pkg.mcpName}". The registry rejects the publish when they differ.`,
  );
}

if (process.argv.includes("--write")) {
  server.version = pkg.version;
  npmEntry.version = pkg.version;
  writeFileSync(serverPath, `${JSON.stringify(server, null, 2)}\n`);
} else if (server.version !== pkg.version || npmEntry.version !== pkg.version) {
  throw new Error(
    `server.json has version ${server.version} (npm package ${npmEntry.version}) but package.json has ${pkg.version}. ` +
      `Run \`node scripts/server-json-version.mjs --write\` and commit server.json before publishing.`,
  );
}
