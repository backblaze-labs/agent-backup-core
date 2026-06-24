import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { B2Client } from "./b2-client.js";
import { encrypt } from "./encryption.js";
import { gatherFiles } from "./gatherer.js";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "./json-io.js";
import { computeManifest, diffManifests, serializeManifest } from "./manifest.js";
import { pruneSnapshots } from "./snapshots.js";
import { snapshotSqlite } from "./sqlite-snapshot.js";
import type { BackupContext, BackupManifest } from "./types.js";

type PushLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  debug?: (msg: string) => void;
};

export type PushOptions = {
  /** Override the prefix (used for safety snapshots). */
  prefixOverride?: string;
  /** Skip pruning (safety snapshots are never auto-pruned). */
  skipPrune?: boolean;
};

/**
 * Snapshot the agent's state and push an incremental, optionally-encrypted diff
 * to B2. Only files whose hash changed since the cached manifest are uploaded.
 * SQLite databases are snapshotted WAL-safely before hashing/upload.
 */
export async function push(
  ctx: BackupContext,
  b2: B2Client,
  logger: PushLogger,
  options?: PushOptions,
): Promise<void> {
  const prefix = options?.prefixOverride ?? ctx.prefix;
  const isSafetySnapshot = options?.prefixOverride !== undefined;
  const manifestCachePath = path.join(ctx.cacheDir, "manifest.json");

  // 1. Gather files across all roots (virtual label-prefixed paths).
  const files = await gatherFiles(ctx.roots, {
    include: ctx.include,
    exclude: ctx.exclude,
  });
  if (files.length === 0) {
    logger.info("backup: no files to sync");
    return;
  }

  // 2. Snapshot SQLite databases (adapter-declared) to a temp dir so we hash and
  //    upload a consistent copy rather than a live, possibly-WAL-dirty file.
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-backup-"));
  try {
    const sqliteFiles = files.filter((f) => ctx.sqlite.some((p) => p.test(f.relativePath)));
    for (const sqliteFile of sqliteFiles) {
      const dest = path.join(tmpDir, sqliteFile.relativePath);
      await snapshotSqlite(sqliteFile.absolutePath, dest);
      sqliteFile.absolutePath = dest;
    }

    // 3. Compute manifest (over the snapshotted, plaintext files).
    const manifest = await computeManifest(files);
    const timestamp = manifest.timestamp.replace(/:/g, "-").replace(/\.\d+Z$/, "Z");

    // 4. Load previous manifest for diffing (skip for one-off safety snapshots).
    let prevManifest: BackupManifest | null = null;
    if (!isSafetySnapshot) {
      const result = await readJsonFileWithFallback<BackupManifest | null>(manifestCachePath, null);
      prevManifest = result.value;
    }

    // 5. Diff.
    const diff = diffManifests(prevManifest, manifest);
    const toUpload = [...diff.added, ...diff.changed];
    if (toUpload.length === 0 && diff.deleted.length === 0) {
      logger.info("backup: no changes since last push");
      return;
    }
    logger.info(
      `backup: pushing ${toUpload.length} files (${diff.added.length} added, ${diff.changed.length} changed, ${diff.deleted.length} deleted)`,
    );

    // 6. Upload changed files (bounded concurrency). Index by path once — the
    //    per-file linear scan was O(files × uploads).
    const byPath = new Map(files.map((f) => [f.relativePath, f]));
    const CONCURRENCY = 8;
    for (let i = 0; i < toUpload.length; i += CONCURRENCY) {
      const batch = toUpload.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (relativePath) => {
          const file = byPath.get(relativePath);
          if (!file) return;
          let body: Uint8Array = await fs.promises.readFile(file.absolutePath);
          if (ctx.encrypt) body = encrypt(Buffer.from(body), ctx.passphrase);
          const key = `${prefix}/${timestamp}/${relativePath}`;
          await b2.putObject(ctx.bucket, key, body, "application/octet-stream");
          logger.debug?.(`backup: uploaded ${relativePath}`);
        }),
      );
    }

    // 7. Upload the manifest. Encrypted when encryption is on, since the file
    //    inventory itself can leak repo names and conversation topics.
    const manifestKey = `${prefix}/${timestamp}/manifest.json`;
    let manifestBody: Uint8Array = Buffer.from(serializeManifest(manifest), "utf-8");
    let manifestType = "application/json";
    if (ctx.encrypt) {
      manifestBody = encrypt(Buffer.from(manifestBody), ctx.passphrase);
      manifestType = "application/octet-stream";
    }
    await b2.putObject(ctx.bucket, manifestKey, manifestBody, manifestType);

    // 8. Persist the manifest cache locally (tool-owned dir, never an agent root).
    if (!isSafetySnapshot) {
      await writeJsonFileAtomically(manifestCachePath, manifest);
    }

    // 9. Prune old snapshots.
    if (!options?.skipPrune) {
      const pruned = await pruneSnapshots(b2, ctx.bucket, prefix, ctx.keepSnapshots);
      if (pruned.length > 0) logger.info(`backup: pruned ${pruned.length} old snapshots`);
    }

    logger.info(`backup: push complete (snapshot ${timestamp})`);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
