// Local config + keystore for splits-cli. Legacy installs use the top-level
// fields. Named profiles add independent copies of those fields while leaving
// the legacy values intact, so an unconfigured install behaves exactly as v1.

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

const PROFILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const ContextSchema = z.object({
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

type Context = z.infer<typeof ContextSchema>;

const ConfigSchema = ContextSchema.extend({
  activeProfile: z.string().regex(PROFILE_NAME_RE).optional(),
  profiles: z.record(z.string().regex(PROFILE_NAME_RE), ContextSchema).optional(),
});

type Config = z.infer<typeof ConfigSchema>;

const selectedProfile = (): string | null => {
  const value = process.env.SPLITS_PROFILE;
  if (value === undefined || value.length === 0) return null;
  if (!PROFILE_NAME_RE.test(value)) {
    throw new Error(
      "SPLITS_PROFILE must be 1-64 characters using letters, numbers, underscores, or hyphens.",
    );
  }
  return value;
};

const activeContext = (config: Config): { name: string | null; context: Context } => {
  const name = selectedProfile() ?? config.activeProfile ?? null;
  if (!name) return { name: null, context: config };
  const context = config.profiles?.[name];
  if (!context) {
    throw new Error(`Profile \"${name}\" does not exist. Create it with 'splits auth profiles create ${name}'.`);
  }
  return { name, context };
};

const writeContext = async (
  current: Config,
  update: (context: Context) => Context,
): Promise<void> => {
  const { name, context } = activeContext(current);
  if (!name) {
    await writeRaw({ ...current, ...update(context) });
    return;
  }
  await writeRaw({
    ...current,
    profiles: { ...current.profiles, [name]: update(context) },
  });
};

const readRaw = async (): Promise<Config> => {
  let raw: string;
  try {
    raw = await fs.readFile(CONFIG_PATH, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
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

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    // Same logic as above: strip Zod's `received` values; only the field
    // paths are safe to surface.
    const paths = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(
      `Config at ${CONFIG_PATH} has invalid shape (fields: ${paths}). Fix or delete to continue.`,
    );
  }
  return result.data;
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
// user's private key, so a crashed or preempted write must not truncate it,
// and an attacker-planted symlink must not redirect it.
//
// - Refuse if CONFIG_PATH exists and is a symlink (belt-and-suspenders against
//   O_NOFOLLOW's create-time race window).
// - Write to a sibling temp file with O_NOFOLLOW + mode 0600 + explicit fchmod
//   (Node only applies the mode arg on create; an existing file keeps its
//   current perms).
// - fs.rename is atomic on the same filesystem, so readers either see the old
//   file or the complete new one.
const writeRaw = async (config: Config): Promise<void> => {
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

// ----- API key / URL -----

export const saveApiKey = async (
  value: string,
  opts?: { apiUrl?: string },
): Promise<void> => {
  const current = await readRaw();
  await writeContext(current, (context) => ({
    ...context,
    apiKey: { value, savedAt: new Date().toISOString() },
    ...(opts?.apiUrl !== undefined ? { apiUrl: opts.apiUrl } : {}),
  }));
};

export const removeApiKey = async (): Promise<{
  hadApiKey: boolean;
  hadApiUrl: boolean;
}> => {
  const current = await readRaw();
  const { context } = activeContext(current);
  const hadApiKey = context.apiKey !== undefined;
  const hadApiUrl = context.apiUrl !== undefined;
  if (!hadApiKey && !hadApiUrl) return { hadApiKey, hadApiUrl };
  await writeContext(current, (active) => ({
    ...active,
    apiKey: undefined,
    apiUrl: undefined,
  }));
  return { hadApiKey, hadApiUrl };
};

export type ResolvedApiKey = {
  value: string;
  source: "env" | "keystore";
};

export const resolveApiKey = async (env: {
  SPLITS_API_KEY?: string;
}): Promise<ResolvedApiKey | null> => {
  if (env.SPLITS_API_KEY !== undefined && env.SPLITS_API_KEY.length > 0) {
    return { value: env.SPLITS_API_KEY, source: "env" };
  }
  const { context } = activeContext(await readRaw());
  if (context.apiKey) {
    return { value: context.apiKey.value, source: "keystore" };
  }
  return null;
};

export const resolveApiUrl = async (env: {
  SPLITS_API_URL?: string;
}): Promise<string> => {
  if (env.SPLITS_API_URL !== undefined && env.SPLITS_API_URL.length > 0) {
    return env.SPLITS_API_URL;
  }
  const { context } = activeContext(await readRaw());
  return context.apiUrl ?? DEFAULT_API_URL;
};

// ----- Local EOA key -----

export type SavedKey = {
  name: string;
  address: `0x${string}`;
  privateKey: `0x${string}`;
};

export type PublicKeyInfo = {
  name: string;
  address: `0x${string}`;
};

export const saveKey = async (
  key: SavedKey,
  opts?: { overwrite?: boolean },
): Promise<void> => {
  const current = await readRaw();
  const { context } = activeContext(current);
  if (context.key && !opts?.overwrite) {
    throw new Error(
      `A local key already exists (${context.key.address}, "${context.key.name}"). ` +
        `Run 'splits auth delete-key' first if you want to replace it.`,
    );
  }
  await writeContext(current, (active) => ({ ...active, key }));
};

export const removeKey = async (): Promise<{
  previousAddress: `0x${string}` | null;
}> => {
  const current = await readRaw();
  const { context } = activeContext(current);
  const previousAddress =
    (context.key?.address as `0x${string}` | undefined) ?? null;
  if (!context.key) return { previousAddress };
  await writeContext(current, (active) => ({ ...active, key: undefined }));
  return { previousAddress };
};

export const loadLocalKeyPublic = async (): Promise<PublicKeyInfo | null> => {
  const { context } = activeContext(await readRaw());
  if (!context.key) return null;
  return {
    name: context.key.name,
    address: context.key.address as `0x${string}`,
  };
};

export const loadLocalPrivateKey = async (): Promise<`0x${string}` | null> => {
  const { context } = activeContext(await readRaw());
  if (!context.key) return null;
  return context.key.privateKey as `0x${string}`;
};

export type ProfileInfo = { name: string; active: boolean; source: "env" | "saved" | "legacy" };

export const getActiveProfile = async (): Promise<ProfileInfo> => {
  const config = await readRaw();
  const envProfile = selectedProfile();
  const { name } = activeContext(config);
  return { name: name ?? "legacy", active: true, source: envProfile ? "env" : config.activeProfile ? "saved" : "legacy" };
};

export const listProfiles = async (): Promise<ProfileInfo[]> => {
  const config = await readRaw();
  const current = await getActiveProfile();
  return Object.keys(config.profiles ?? {}).sort().map((name) => ({
    name,
    active: current.name === name,
    source: current.name === name ? current.source : "saved",
  }));
};

export const createProfile = async (name: string): Promise<void> => {
  if (!PROFILE_NAME_RE.test(name)) throw new Error("Profile names must be 1-64 characters using letters, numbers, underscores, or hyphens.");
  const current = await readRaw();
  if (current.profiles?.[name]) throw new Error(`Profile \"${name}\" already exists.`);
  await writeRaw({ ...current, profiles: { ...current.profiles, [name]: {} }, activeProfile: name });
};

export const selectProfile = async (name: string): Promise<void> => {
  if (!PROFILE_NAME_RE.test(name)) throw new Error("Profile names must be 1-64 characters using letters, numbers, underscores, or hyphens.");
  const current = await readRaw();
  if (!current.profiles?.[name]) throw new Error(`Profile \"${name}\" does not exist.`);
  await writeRaw({ ...current, activeProfile: name });
};

// Default name used by create-key / import-key when --name is omitted.
// Short-form address is self-documenting and collision-free for v1 single-key.
export const defaultKeyName = (address: string): string =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;
