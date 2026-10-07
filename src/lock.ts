import { constants as fsConstants, promises as fs } from "node:fs";

const STALE_LOCK_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 2 * STALE_LOCK_MS;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const acquireLock = async (lockPath: string): Promise<void> => {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await fs.open(
        lockPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      await handle.close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const age = await fs
      .lstat(lockPath)
      .then((st) => Date.now() - st.mtimeMs)
      .catch(() => 0);
    if (age > STALE_LOCK_MS) {
      await fs.rm(lockPath, { force: true });
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${lockPath} is held by another splits process. ` +
          `Try again, or delete it if no splits process is running.`,
      );
    }
    await sleep(LOCK_RETRY_MS);
  }
};

let queue: Promise<unknown> = Promise.resolve();

export const withLock = <T>(
  lockPath: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const run = async (): Promise<T> => {
    await acquireLock(lockPath);
    try {
      return await fn();
    } finally {
      await fs.rm(lockPath, { force: true });
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
};
