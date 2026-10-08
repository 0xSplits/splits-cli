// Local config + keystore for splits-cli. A single file at ~/.splits/config.json
// (mode 0600) holds the saved workspaces (an API key, an optional API URL
// override and the org it belongs to), the active workspace, and the local EOA
// signing keys. Keys are not tied to a workspace: one EOA can sign for several
// orgs.

import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "incur";

import { withLock } from "./lock.js";

const CONFIG_DIR = join(homedir(), ".splits");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const GITIGNORE_PATH = join(CONFIG_DIR, ".gitignore");
const LOCK_PATH = join(CONFIG_DIR, "config.json.lock");

export const CONFIG_FILE_PATH = CONFIG_PATH;
export const DEFAULT_API_URL = "https://server.production.splits.org";

const HEX_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX_PRIVATE_KEY_RE = /^0x[0-9a-f]{64}$/i;

const WORKSPACE_ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const V1_WORKSPACE_ALIAS = "default";

const OLDER_CLI_GUARD =
  "This file is in the v2 format. Upgrade @splits/splits-cli to read it.";

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
  orgId: z.string().nullable(),
  orgName: z.string().nullable(),
  apiKey: z.string().min(1),
  apiUrl: z.string().url().nullable(),
  savedAt: z.string(),
});

const PendingLoginSchema = z.object({
  codeVerifier: z.string().min(1),
  url: z.string().url(),
  apiUrl: z.string().url().nullable(),
  expiresAt: z.string(),
  name: z.string().nullable(),
  signerAddress: z.string().regex(HEX_ADDRESS_RE),
  startedAt: z.string(),
});

const ConfigV2Schema = z.object({
  version: z.literal(2),
  activeWorkspace: z.string().nullable(),
  workspaces: z.record(z.string().regex(WORKSPACE_ALIAS_RE), WorkspaceSchema),
  keys: z.record(
    z.string().regex(HEX_ADDRESS_RE),
    z.object({
      name: z.string().min(1),
      privateKey: z.string().regex(HEX_PRIVATE_KEY_RE),
    }),
  ),
  pendingLogins: z.record(z.string(), PendingLoginSchema).optional(),
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

  const tmp = `${CONFIG_PATH}.tmp.${process.pid}.${randomUUID()}`;
  const handle = await fs.open(
    tmp,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_TRUNC |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(
      JSON.stringify({ ...config, key: OLDER_CLI_GUARD }, null, 2) + "\n",
    );
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, CONFIG_PATH);
};

const updateConfig = async <T>(
  change: (config: Config) => T,
): Promise<T> => {
  await ensureDir();
  return withLock(LOCK_PATH, async () => {
    const config = await readConfig();
    const before = JSON.stringify(config);
    const result = change(config);
    if (JSON.stringify(config) !== before) await writeConfig(config);
    return result;
  });
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

const deriveAlias = (
  config: Config,
  login: {
    orgId: string;
    orgName: string | null;
    apiKey: string;
    apiUrl?: string;
  },
): string => {
  const apiUrl = login.apiUrl ?? null;
  const existing = Object.entries(config.workspaces).find(
    ([, w]) =>
      (w.orgId === login.orgId && w.apiUrl === apiUrl) ||
      w.apiKey === login.apiKey,
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
  return updateConfig((config) => {
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
    return { alias, replaced };
  });
};

export const listWorkspaces = async (): Promise<WorkspaceInfo[]> => {
  const config = await readConfig();
  return Object.entries(config.workspaces).map(([alias, w]) =>
    toWorkspaceInfo(config, alias, w),
  );
};

export const useWorkspace = (alias: string): Promise<WorkspaceInfo> =>
  updateConfig((config) => {
    const workspace = config.workspaces[alias];
    if (!workspace) throw unknownWorkspace(config, alias);
    config.activeWorkspace = alias;
    return toWorkspaceInfo(config, alias, workspace);
  });

export const refreshWorkspaceOrg = (
  alias: string,
  apiKey: string,
  org: { orgId: string; orgName: string | null },
): Promise<void> =>
  updateConfig((config) => {
    const workspace = config.workspaces[alias];
    if (workspace?.apiKey !== apiKey) return;
    workspace.orgId = org.orgId;
    workspace.orgName = org.orgName;
  });

export const removeWorkspace = (
  alias?: string,
): Promise<{ removed: string | null; activeWorkspace: string | null }> =>
  updateConfig((config) => {
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
    return { removed: target, activeWorkspace: config.activeWorkspace };
  });

export type CredentialSource = {
  SPLITS_API_KEY?: string;
  SPLITS_API_URL?: string;
  SPLITS_WORKSPACE?: string;
  workspace?: string;
};

export type ResolvedCredentials = {
  apiKey: string | null;
  apiKeySource: "env" | "keystore" | null;
  apiUrl: string;
  workspace: string | null;
};

const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined;

export const resolveCredentials = async (
  source: CredentialSource,
): Promise<ResolvedCredentials> => {
  const requested =
    nonEmpty(source.workspace) ?? nonEmpty(source.SPLITS_WORKSPACE);
  const envKey = nonEmpty(source.SPLITS_API_KEY);
  if (envKey !== undefined) {
    if (requested !== undefined) {
      throw new Error(
        `SPLITS_API_KEY is set, so workspace "${requested}" cannot be used. ` +
          `Unset SPLITS_API_KEY to use a saved workspace, or drop --workspace and SPLITS_WORKSPACE.`,
      );
    }
    return {
      apiKey: envKey,
      apiKeySource: "env",
      apiUrl: nonEmpty(source.SPLITS_API_URL) ?? DEFAULT_API_URL,
      workspace: null,
    };
  }

  const config = await readConfig();
  if (requested !== undefined && !(requested in config.workspaces)) {
    throw unknownWorkspace(config, requested);
  }
  const alias = requested ?? config.activeWorkspace;
  const workspace = alias !== null ? config.workspaces[alias] : undefined;

  return {
    apiKey: workspace?.apiKey ?? null,
    apiKeySource: workspace ? "keystore" : null,
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

export const saveKey = (key: SavedKey): Promise<{ added: boolean }> =>
  updateConfig((config) => {
    if (findKeyAddress(config, key.address) !== undefined) {
      return { added: false };
    }
    config.keys[key.address] = { name: key.name, privateKey: key.privateKey };
    return { added: true };
  });

export const listKeys = async (): Promise<PublicKeyInfo[]> => {
  const config = await readConfig();
  return Object.entries(config.keys).map(([address, k]) => ({
    name: k.name,
    address: address as `0x${string}`,
  }));
};

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

export const removeKey = (
  address?: string,
): Promise<{ previousAddress: `0x${string}` | null }> =>
  updateConfig((config) => {
    const match = selectKeyAddress(config, address, "<address>");
    if (match === null) return { previousAddress: null };
    delete config.keys[match];
    return { previousAddress: match as `0x${string}` };
  });

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


export type PendingLogin = z.infer<typeof PendingLoginSchema> & {
  requestId: string;
};

const isExpired = (login: { expiresAt: string }, now: number): boolean =>
  Date.parse(login.expiresAt) <= now;

const setPendingLogins = (
  config: Config,
  logins: Record<string, z.infer<typeof PendingLoginSchema>>,
): void => {
  const now = Date.now();
  const live = Object.fromEntries(
    Object.entries(logins).filter(([, login]) => !isExpired(login, now)),
  );
  if (Object.keys(live).length === 0) delete config.pendingLogins;
  else config.pendingLogins = live;
};

export const savePendingLogin = ({
  requestId,
  ...login
}: PendingLogin): Promise<void> =>
  updateConfig((config) => {
    setPendingLogins(config, { ...config.pendingLogins, [requestId]: login });
  });

export const loadPendingLogin = async (
  requestId?: string,
): Promise<PendingLogin | null> => {
  const config = await readConfig();
  const now = Date.now();
  const live = Object.entries(config.pendingLogins ?? {})
    .filter(([, login]) => !isExpired(login, now))
    .map(([id, login]) => ({ requestId: id, ...login }));
  if (requestId !== undefined) {
    return live.find((login) => login.requestId === requestId) ?? null;
  }
  const [latest] = live.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return latest ?? null;
};

export const removePendingLogin = (requestId: string): Promise<void> =>
  updateConfig((config) => {
    const { [requestId]: _removed, ...rest } = config.pendingLogins ?? {};
    setPendingLogins(config, rest);
  });
