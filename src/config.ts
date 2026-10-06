// Local config + keystore for splits-cli. A single file at ~/.splits/config.json
// (mode 0600) holds the saved workspaces (an API key, an optional API URL
// override and the org it belongs to), the active workspace, and the local EOA
// signing keys. Keys are not tied to a workspace: one EOA can sign for several
// orgs.

import { constants as fsConstants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "incur";

const CONFIG_DIR = join(homedir(), ".splits");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const GITIGNORE_PATH = join(CONFIG_DIR, ".gitignore");

export const CONFIG_FILE_PATH = CONFIG_PATH;
export const DEFAULT_API_URL = "https://server.production.splits.org";

const HEX_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX_PRIVATE_KEY_RE = /^0x[0-9a-f]{64}$/i;

// Aliases are typed on the command line and in env vars, so they stay to
// characters no shell needs quoted.
const WORKSPACE_ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// A v1 file has one API key and no org, so its workspace gets this alias.
const V1_WORKSPACE_ALIAS = "default";

const ConfigV1Schema = z.object({
  apiKey: z
    .object({
      value: z.string().min(1),
      savedAt: z.string(),
    })
    .optional(),
  apiUrl: z.string().url().optional(),
  key: z
    .object({
      name: z.string().min(1),
      address: z.string().regex(HEX_ADDRESS_RE),
      privateKey: z.string().regex(HEX_PRIVATE_KEY_RE),
    })
    .optional(),
});

type ConfigV1 = z.infer<typeof ConfigV1Schema>;

const WorkspaceSchema = z.object({
  // Null only for a workspace migrated from a v1 file, which never stored the
  // org. The next `auth login` into that alias fills them in.
  orgId: z.string().nullable(),
  orgName: z.string().nullable(),
  apiKey: z.string().min(1),
  // Null means the production API, or SPLITS_API_URL when that is set.
  apiUrl: z.string().url().nullable(),
  savedAt: z.string(),
});

const ConfigV2Schema = z.object({
  version: z.literal(2),
  // Null when no workspace is saved, or after the active one is logged out
  // while several others remain.
  activeWorkspace: z.string().nullable(),
  workspaces: z.record(z.string().regex(WORKSPACE_ALIAS_RE), WorkspaceSchema),
  keys: z.record(
    z.string().regex(HEX_ADDRESS_RE),
    z.object({
      name: z.string().min(1),
      privateKey: z.string().regex(HEX_PRIVATE_KEY_RE),
    }),
  ),
});

type Config = z.infer<typeof ConfigV2Schema>;
type Workspace = z.infer<typeof WorkspaceSchema>;

const emptyConfig = (): Config => ({
  version: 2,
  activeWorkspace: null,
  workspaces: {},
  keys: {},
});

const fromV1 = (v1: ConfigV1): Config => {
  const config = emptyConfig();
  if (v1.apiKey) {
    config.workspaces[V1_WORKSPACE_ALIAS] = {
      orgId: null,
      orgName: null,
      apiKey: v1.apiKey.value,
      apiUrl: v1.apiUrl ?? null,
      savedAt: v1.apiKey.savedAt,
    };
    config.activeWorkspace = V1_WORKSPACE_ALIAS;
  }
  if (v1.key) {
    config.keys[v1.key.address] = {
      name: v1.key.name,
      privateKey: v1.key.privateKey,
    };
  }
  return config;
};

const invalidShape = (issues: { path: PropertyKey[] }[]): Error => {
  // Strip Zod's `received` values: the file may contain a private key or API
  // key and any error path is visible in stderr / MCP. Only the field paths
  // are safe to surface.
  const paths = issues.map((i) => i.path.join(".")).join(", ");
  return new Error(
    `Config at ${CONFIG_PATH} has invalid shape (fields: ${paths}). Fix or delete to continue.`,
  );
};

// Reads never rewrite the file. A v1 file is returned as v2 in memory and only
// reaches disk as v2 on the next write.
const readConfig = async (): Promise<Config> => {
  let raw: string;
  try {
    raw = await fs.readFile(CONFIG_PATH, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyConfig();
    if ((err as NodeJS.ErrnoException).code === "EACCES") {
      throw new Error(
        `Config at ${CONFIG_PATH} is unreadable (permission denied). Check file permissions.`,
      );
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Do NOT echo the file contents in the error — the file may contain a
    // private key or API key and any error path is visible in stderr / MCP.
    throw new Error(
      `Config at ${CONFIG_PATH} is not valid JSON. Fix or delete to continue.`,
    );
  }

  const version =
    typeof parsed === "object" && parsed !== null && "version" in parsed
      ? parsed.version
      : undefined;

  if (version === undefined) {
    const v1 = ConfigV1Schema.safeParse(parsed);
    if (!v1.success) throw invalidShape(v1.error.issues);
    return fromV1(v1.data);
  }

  if (version !== 2) {
    throw new Error(
      `Config at ${CONFIG_PATH} has version ${JSON.stringify(version)}, which this CLI does not know. ` +
        `Upgrade @splits/splits-cli to continue.`,
    );
  }

  const v2 = ConfigV2Schema.safeParse(parsed);
  if (!v2.success) throw invalidShape(v2.error.issues);
  return v2.data;
};

let gitignoreEnsured = false;
const ensureDir = async (): Promise<void> => {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  if (gitignoreEnsured) return;
  try {
    await fs.writeFile(GITIGNORE_PATH, "*\n", { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  gitignoreEnsured = true;
};

// Atomic, symlink-safe keystore write. The file is the only copy of the
// user's private keys, so a crashed or preempted write must not truncate it,
// and an attacker-planted symlink must not redirect it.
//
// - Refuse if CONFIG_PATH exists and is a symlink (belt-and-suspenders against
//   O_NOFOLLOW's create-time race window).
// - Write to a sibling temp file with O_NOFOLLOW + mode 0600 + explicit fchmod
//   (Node only applies the mode arg on create; an existing file keeps its
//   current perms).
// - fs.rename is atomic on the same filesystem, so readers either see the old
//   file or the complete new one.
const writeConfig = async (config: Config): Promise<void> => {
  await ensureDir();
  try {
    const st = await fs.lstat(CONFIG_PATH);
    if (st.isSymbolicLink()) {
      throw new Error(
        `Config at ${CONFIG_PATH} is a symlink. Refusing to write through it; ` +
          `delete it first.`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const tmp = `${CONFIG_PATH}.tmp.${process.pid}`;
  const handle = await fs.open(
    tmp,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_TRUNC |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(JSON.stringify(config, null, 2) + "\n");
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, CONFIG_PATH);
};

// ----- Workspaces -----

export type WorkspaceInfo = {
  alias: string;
  orgId: string | null;
  orgName: string | null;
  apiUrl: string | null;
  savedAt: string;
  active: boolean;
};

const toWorkspaceInfo = (
  config: Config,
  alias: string,
  workspace: Workspace,
): WorkspaceInfo => ({
  alias,
  orgId: workspace.orgId,
  orgName: workspace.orgName,
  apiUrl: workspace.apiUrl,
  savedAt: workspace.savedAt,
  active: config.activeWorkspace === alias,
});

const unknownWorkspace = (config: Config, alias: string): Error => {
  const aliases = Object.keys(config.workspaces);
  return new Error(
    aliases.length === 0
      ? `No workspace named "${alias}". No workspaces are saved; run \`splits auth login\`.`
      : `No workspace named "${alias}". Saved workspaces: ${aliases.join(", ")}.`,
  );
};

export const assertWorkspaceAlias = (alias: string): void => {
  if (!WORKSPACE_ALIAS_RE.test(alias)) {
    throw new Error(
      `Invalid workspace name "${alias}". Use up to 64 lowercase letters, digits, "-" or "_", starting with a letter or digit.`,
    );
  }
};

const slugify = (orgName: string | null): string => {
  const slug = (orgName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : V1_WORKSPACE_ALIAS;
};

// A login without --name reuses the alias already saved for the same org (or
// the same key, for a workspace migrated from v1 without an org), so logging
// in again refreshes it instead of adding a duplicate. Another org with the
// same name gets a numbered alias so it never replaces a workspace the user
// did not name.
const deriveAlias = (
  config: Config,
  login: { orgId: string; orgName: string | null; apiKey: string },
): string => {
  const existing = Object.entries(config.workspaces).find(
    ([, w]) => w.orgId === login.orgId || w.apiKey === login.apiKey,
  );
  if (existing) return existing[0];

  const base = slugify(login.orgName);
  if (!(base in config.workspaces)) return base;
  let n = 2;
  while (`${base}-${n}` in config.workspaces) n += 1;
  return `${base}-${n}`;
};

export const saveWorkspace = async (input: {
  name?: string;
  orgId: string;
  orgName: string | null;
  apiKey: string;
  apiUrl?: string;
}): Promise<{ alias: string; replaced: boolean }> => {
  if (input.name !== undefined) assertWorkspaceAlias(input.name);
  const config = await readConfig();
  const alias = input.name ?? deriveAlias(config, input);
  const replaced = alias in config.workspaces;
  config.workspaces[alias] = {
    orgId: input.orgId,
    orgName: input.orgName,
    apiKey: input.apiKey,
    apiUrl: input.apiUrl ?? null,
    savedAt: new Date().toISOString(),
  };
  config.activeWorkspace = alias;
  await writeConfig(config);
  return { alias, replaced };
};

export const listWorkspaces = async (): Promise<WorkspaceInfo[]> => {
  const config = await readConfig();
  return Object.entries(config.workspaces).map(([alias, w]) =>
    toWorkspaceInfo(config, alias, w),
  );
};

export const useWorkspace = async (alias: string): Promise<WorkspaceInfo> => {
  const config = await readConfig();
  const workspace = config.workspaces[alias];
  if (!workspace) throw unknownWorkspace(config, alias);
  config.activeWorkspace = alias;
  await writeConfig(config);
  return toWorkspaceInfo(config, alias, workspace);
};

// Logging out the active workspace hands "active" to the only one left, if
// exactly one is left. With several left, the user picks with `auth use`.
export const removeWorkspace = async (
  alias?: string,
): Promise<{ removed: string | null; activeWorkspace: string | null }> => {
  const config = await readConfig();
  const target = alias ?? config.activeWorkspace;
  if (target === null) {
    return { removed: null, activeWorkspace: config.activeWorkspace };
  }
  if (!(target in config.workspaces)) throw unknownWorkspace(config, target);

  delete config.workspaces[target];
  if (config.activeWorkspace === target) {
    const remaining = Object.keys(config.workspaces);
    config.activeWorkspace = remaining.length === 1 ? remaining[0] : null;
  }
  await writeConfig(config);
  return { removed: target, activeWorkspace: config.activeWorkspace };
};

// Where a command's credentials come from. `workspace` is the --workspace
// flag; it beats SPLITS_WORKSPACE, which beats the active workspace.
export type CredentialSource = {
  SPLITS_API_KEY?: string;
  SPLITS_API_URL?: string;
  SPLITS_WORKSPACE?: string;
  workspace?: string;
};

export type ResolvedCredentials = {
  apiKey: { value: string; source: "env" | "keystore" } | null;
  apiUrl: string;
  workspace: string | null;
};

const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

// SPLITS_API_KEY wins over every workspace, as it did over the single saved
// key in v1. The URL still falls back to the selected workspace's override,
// which is also what v1 did with its one saved URL.
export const resolveCredentials = async (
  source: CredentialSource,
): Promise<ResolvedCredentials> => {
  const config = await readConfig();
  const requested =
    nonEmpty(source.workspace) ?? nonEmpty(source.SPLITS_WORKSPACE);
  if (requested !== undefined && !(requested in config.workspaces)) {
    throw unknownWorkspace(config, requested);
  }
  const alias = requested ?? config.activeWorkspace;
  const workspace = alias !== null ? config.workspaces[alias] : undefined;

  const envKey = nonEmpty(source.SPLITS_API_KEY);
  const apiKey = envKey
    ? { value: envKey, source: "env" as const }
    : workspace
      ? { value: workspace.apiKey, source: "keystore" as const }
      : null;

  return {
    apiKey,
    apiUrl:
      nonEmpty(source.SPLITS_API_URL) ?? workspace?.apiUrl ?? DEFAULT_API_URL,
    workspace: workspace ? alias : null,
  };
};

// ----- Local EOA keys -----

export type SavedKey = {
  name: string;
  address: `0x${string}`;
  privateKey: `0x${string}`;
};

export type PublicKeyInfo = {
  name: string;
  address: `0x${string}`;
};

const findKeyAddress = (config: Config, address: string): string | undefined =>
  Object.keys(config.keys).find(
    (a) => a.toLowerCase() === address.toLowerCase(),
  );

// Returns false when the address is already saved. The saved entry is kept
// as it is, because the same address always means the same private key.
export const saveKey = async (key: SavedKey): Promise<{ added: boolean }> => {
  const config = await readConfig();
  if (findKeyAddress(config, key.address) !== undefined) {
    return { added: false };
  }
  config.keys[key.address] = { name: key.name, privateKey: key.privateKey };
  await writeConfig(config);
  return { added: true };
};

export const listKeys = async (): Promise<PublicKeyInfo[]> => {
  const config = await readConfig();
  return Object.entries(config.keys).map(([address, k]) => ({
    name: k.name,
    address: address as `0x${string}`,
  }));
};

// With no address, picks the only saved key. Several keys need an address so
// the CLI never signs or deletes with a key the caller did not mean.
const selectKeyAddress = (
  config: Config,
  address: string | undefined,
  flag: string,
): string | null => {
  const addresses = Object.keys(config.keys);
  if (address !== undefined) {
    const match = findKeyAddress(config, address);
    if (match === undefined) {
      throw new Error(
        `No local key with address ${address}. Saved keys: ${addresses.join(", ") || "none"}.`,
      );
    }
    return match;
  }
  if (addresses.length === 0) return null;
  if (addresses.length > 1) {
    throw new Error(
      `Several local keys are saved. Pass ${flag} with one of: ${addresses.join(", ")}.`,
    );
  }
  return addresses[0];
};

export const removeKey = async (
  address?: string,
): Promise<{ previousAddress: `0x${string}` | null }> => {
  const config = await readConfig();
  const match = selectKeyAddress(config, address, "<address>");
  if (match === null) return { previousAddress: null };
  delete config.keys[match];
  await writeConfig(config);
  return { previousAddress: match as `0x${string}` };
};

export const loadLocalKey = async (address?: string): Promise<SavedKey | null> => {
  const config = await readConfig();
  const match = selectKeyAddress(config, address, "--key");
  if (match === null) return null;
  return {
    name: config.keys[match].name,
    address: match as `0x${string}`,
    privateKey: config.keys[match].privateKey as `0x${string}`,
  };
};

// Default name used by create-key / import-key when --name is omitted.
// Short-form address is self-documenting and collision-free.
export const defaultKeyName = (address: string): string =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;
