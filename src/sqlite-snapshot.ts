import fs from "node:fs";
import path from "node:path";

/**
 * Snapshot a (possibly live, WAL-mode) SQLite database to `destPath` consistently.
 *
 * Uses `node:sqlite`'s module-level `backup()` (the online backup API), which
 * produces a consistent copy even while the source is being written — the right
 * tool for agents that hold their DB open (Goose, Hermes). NOTE: `backup` is a
 * module function, not a `DatabaseSync` instance method.
 *
 * Only if the online backup is genuinely unavailable do we fall back to a plain
 * file copy (best-effort, including WAL/SHM sidecars). A real backup failure
 * rethrows rather than silently degrading to that torn-copy path.
 */
export async function snapshotSqlite(dbPath: string, destPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

  let sqlite: { backup?: unknown; DatabaseSync?: unknown };
  try {
    sqlite = (await import("node:sqlite")) as typeof sqlite;
  } catch {
    // node:sqlite unavailable (shouldn't happen on Node >=22.5) — best-effort copy.
    await copyWithSidecars(dbPath, destPath);
    return;
  }

  if (typeof sqlite.backup === "function") {
    const backup = sqlite.backup as (
      source: unknown,
      destFile: string,
      options?: unknown,
    ) => Promise<unknown>;
    const DatabaseSync = sqlite.DatabaseSync as new (p: string, o?: unknown) => { close(): void };
    const src = new DatabaseSync(dbPath, { readOnly: true });
    try {
      await backup(src, destPath);
    } finally {
      src.close();
    }
    return;
  }

  // Older runtime without the online backup API: copy file + WAL/SHM sidecars.
  await copyWithSidecars(dbPath, destPath);
}

async function copyWithSidecars(dbPath: string, destPath: string): Promise<void> {
  await fs.promises.copyFile(dbPath, destPath);
  for (const suffix of ["-wal", "-shm"]) {
    try {
      await fs.promises.copyFile(`${dbPath}${suffix}`, `${destPath}${suffix}`);
    } catch {
      // sidecars may not exist
    }
  }
}
