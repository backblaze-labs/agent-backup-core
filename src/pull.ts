import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { B2Client } from "./b2-client.js";
import { decrypt, isEncrypted } from "./encryption.js";
import { resolveRelativePath } from "./gatherer.js";
import { writeJsonFileAtomically } from "./json-io.js";
import { deserializeManifest } from "./manifest.js";
import { push } from "./push.js";
import { getLatestSnapshot } from "./snapshots.js";
import { SAFETY_PREFIX } from "./types.js";
import type { BackupContext } from "./types.js";

type PullLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  debug?: (msg: string) => void;
};

export type PullOptions = {
  /** Skip creating a safety snapshot before restoring. */
  skipSafety?: boolean;
};

export async function pullLatest(
  ctx: BackupContext,
  b2: B2Client,
  logger: PullLogger,
  options?: PullOptions,
): Promise<void> {
  const latest = await getLatestSnapshot(b2, ctx.bucket, ctx.prefix);
  if (!latest) {
    logger.info("backup: no snapshots found in bucket");
    return;
  }
  await pullSnapshot(ctx, b2, logger, latest, options);
}

export async function pullSnapshot(
  ctx: BackupContext,
  b2: B2Client,
  logger: PullLogger,
  timestamp: string,
  options?: PullOptions,
): Promise<void> {
  // Create a safety snapshot before overwriting local state (unless skipped).
  if (!options?.skipSafety) {
    const safetyTs = new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
    const safetyPrefix = `${ctx.prefix}/${SAFETY_PREFIX}-${safetyTs}`;
    logger.info(`backup: creating safety snapshot at ${safetyPrefix}`);
    try {
      await push(ctx, b2, logger, { prefixOverride: safetyPrefix, skipPrune: true });
    } catch (err) {
      logger.warn(`backup: safety snapshot failed: ${String(err)}, continuing with pull`);
    }
  }

  const manifestKey = `${ctx.prefix}/${timestamp}/manifest.json`;
  logger.info(`backup: pulling snapshot ${timestamp}`);

  // Download + decrypt the manifest (it may be encrypted to avoid leaking paths).
  let manifestData = await b2.getObject(ctx.bucket, manifestKey);
  if (isEncrypted(manifestData)) manifestData = decrypt(manifestData, ctx.passphrase);
  const manifest = deserializeManifest(manifestData.toString("utf-8"));

  let restored = 0;
  let skipped = 0;

  for (const [relativePath, entry] of Object.entries(manifest.files)) {
    const destPath = resolveRelativePath(relativePath, ctx.roots);
    if (!destPath) {
      logger.warn(`backup: cannot map ${relativePath} to a known root, skipping`);
      continue;
    }

    // Skip files whose local copy already matches the snapshot.
    try {
      const existing = await fs.promises.readFile(destPath);
      const existingHash = crypto.createHash("sha256").update(existing).digest("hex");
      if (existingHash === entry.hash) {
        skipped++;
        continue;
      }
    } catch {
      // File doesn't exist locally — fall through to download.
    }

    const key = `${ctx.prefix}/${timestamp}/${relativePath}`;
    let data = await b2.getObject(ctx.bucket, key);
    if (isEncrypted(data)) data = decrypt(data, ctx.passphrase);

    // Verify integrity against the manifest's plaintext hash.
    const downloadHash = crypto.createHash("sha256").update(data).digest("hex");
    if (downloadHash !== entry.hash) {
      logger.warn(`backup: hash mismatch for ${relativePath}, skipping`);
      continue;
    }

    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await fs.promises.writeFile(destPath, data);
    restored++;
    logger.debug?.(`backup: restored ${relativePath}`);
  }

  // Refresh the local manifest cache so the next push diffs correctly.
  await writeJsonFileAtomically(path.join(ctx.cacheDir, "manifest.json"), manifest);

  logger.info(`backup: pull complete (${restored} restored, ${skipped} unchanged)`);
}
