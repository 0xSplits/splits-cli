// Local config + keystore for splits-cli. A single file at ~/.splits/config.json
// (mode 0600) holds an optional saved API key, an optional API URL override,
// and at most one local EOA signing key. The same file serves as both
// "credentials store" and "identity store" — keep the shape minimal; expand
// only when a customer actually needs more than one key / API key.

import { promises as fs } from "node:fs";
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

const ConfigSchema = z.object({
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

type Config = z.infer<typeof ConfigSchema>;

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

const writeRaw = async (config: Config): Promise<void> => {
  await ensureDir();
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
};

// ----- API key / URL -----

export const saveApiKey = async (
  value: string,
  opts?: { apiUrl?: string },
): Promise<void> => {
  const current = await readRaw();
  await writeRaw({
    ...current,
    apiKey: { value, savedAt: new Date().toISOString() },
    ...(opts?.apiUrl !== undefined ? { apiUrl: opts.apiUrl } : {}),
  });
};

export const removeApiKey = async (): Promise<{
  hadApiKey: boolean;
  hadApiUrl: boolean;
}> => {
  const current = await readRaw();
  const hadApiKey = current.apiKey !== undefined;
  const hadApiUrl = current.apiUrl !== undefined;
  if (!hadApiKey && !hadApiUrl) return { hadApiKey, hadApiUrl };
  await writeRaw({ ...current, apiKey: undefined, apiUrl: undefined });
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
  const config = await readRaw();
  if (config.apiKey) {
    return { value: config.apiKey.value, source: "keystore" };
  }
  return null;
};

export const resolveApiUrl = async (env: {
  SPLITS_API_URL?: string;
}): Promise<string> => {
  if (env.SPLITS_API_URL !== undefined && env.SPLITS_API_URL.length > 0) {
    return env.SPLITS_API_URL;
  }
  const config = await readRaw();
  return config.apiUrl ?? DEFAULT_API_URL;
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
  if (current.key && !opts?.overwrite) {
    throw new Error(
      `A local key already exists (${current.key.address}, "${current.key.name}"). ` +
        `Run 'splits auth delete-key' first if you want to replace it.`,
    );
  }
  await writeRaw({ ...current, key });
};

export const removeKey = async (): Promise<{
  previousAddress: `0x${string}` | null;
}> => {
  const current = await readRaw();
  const previousAddress =
    (current.key?.address as `0x${string}` | undefined) ?? null;
  if (!current.key) return { previousAddress };
  await writeRaw({ ...current, key: undefined });
  return { previousAddress };
};

export const loadLocalKeyPublic = async (): Promise<PublicKeyInfo | null> => {
  const config = await readRaw();
  if (!config.key) return null;
  return {
    name: config.key.name,
    address: config.key.address as `0x${string}`,
  };
};

export const loadLocalPrivateKey = async (): Promise<`0x${string}` | null> => {
  const config = await readRaw();
  if (!config.key) return null;
  return config.key.privateKey as `0x${string}`;
};

// Default name used by create-key / import-key when --name is omitted.
// Short-form address is self-documenting and collision-free for v1 single-key.
export const defaultKeyName = (address: string): string =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;
