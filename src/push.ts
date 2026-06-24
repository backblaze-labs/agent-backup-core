import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { B2Client } from "./b2-client.js";
import { encrypt } from "./encryption.js";
import { gatherFiles } from "./gatherer.js";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "./json-io.js";
import { computeManifest, diffManifests, serializeManifest } from "./manifest.js";
import { getLatestSnapshot, pruneSnapshots } from "./snapshots.js";
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

    // 3. Compute manifest (over the snapshotted, plaintext files). Keep
    //    sub-second precision in the dir name so two pushes in the same second
    //    (e.g. a scheduled push immediately followed by a shutdown push) can't
    //    collide into one blended snapshot dir.
    const manifest = await computeManifest(files);
    const timestamp = manifest.timestamp.replace(/[:.]/g, "-");

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
    // Unchanged files still belong in THIS snapshot dir so it is self-contained
    // and restorable on its own. Their bytes already live in the previous
    // snapshot, so we server-side copy them forward instead of re-uploading.
    const uploadSet = new Set(toUpload);
    const toCopy = Object.keys(manifest.files).filter((p) => !uploadSet.has(p));
    logger.info(
      `backup: ${toUpload.length} uploaded (${diff.added.length} added, ${diff.changed.length} changed), ` +
        `${toCopy.length} carried forward, ${diff.deleted.length} dropped`,
    );

    const byPath = new Map(files.map((f) => [f.relativePath, f]));
    const CONCURRENCY = 8;
    const runBatched = async (items: string[], fn: (rel: string) => Promise<void>) => {
      for (let i = 0; i < items.length; i += CONCURRENCY) {
        await Promise.all(items.slice(i, i + CONCURRENCY).map(fn));
      }
    };
    const uploadFile = async (relativePath: string) => {
      const file = byPath.get(relativePath);
      if (!file) return;
      let body: Uint8Array = await fs.promises.readFile(file.absolutePath);
      if (ctx.encrypt) body = encrypt(Buffer.from(body), ctx.passphrase);
      await b2.putObject(ctx.bucket, `${prefix}/${timestamp}/${relativePath}`, body, "application/octet-stream");
    };

    // 6a. Upload changed/added files from local.
    await runBatched(toUpload, async (rel) => {
      await uploadFile(rel);
      logger.debug?.(`backup: uploaded ${rel}`);
    });

    // 6b. Carry unchanged files forward via server-side copy from the previous
    //     snapshot. Falls back to a local upload if the copy fails for any
    //     reason, so the snapshot is always complete regardless of copy support.
    const prevTimestamp =
      toCopy.length > 0 && !isSafetySnapshot
        ? await getLatestSnapshot(b2, ctx.bucket, prefix)
        : null;
    await runBatched(toCopy, async (rel) => {
      if (prevTimestamp) {
        try {
          await b2.copyObject(ctx.bucket, `${prefix}/${prevTimestamp}/${rel}`, `${prefix}/${timestamp}/${rel}`);
          logger.debug?.(`backup: carried forward ${rel}`);
          return;
        } catch (err) {
          logger.debug?.(`backup: copy-forward of ${rel} failed (${String(err)}), re-uploading`);
        }
      }
      await uploadFile(rel);
    });

    // 7. Upload the manifest LAST (the completeness marker). Encrypted when
    //    encryption is on, since the file inventory itself can leak repo names
    //    and conversation topics.
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
