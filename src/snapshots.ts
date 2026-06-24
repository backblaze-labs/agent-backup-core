import { SAFETY_PREFIX } from "./types.js";
import type { B2Client } from "./b2-client.js";

/**
 * List complete snapshot timestamps under `prefix`, oldest→newest.
 *
 * Only timestamp dirs that contain a `manifest.json` are returned, so a snapshot
 * whose upload crashed mid-way (files but no manifest) can never be selected by
 * restore. Out-of-band `safety-*` snapshots are excluded — they're recovery
 * points, not regular snapshots, and must not be picked as "latest" or pruned.
 */
export async function listSnapshots(
  b2: B2Client,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const objects = await b2.listObjects(bucket, `${prefix}/`);
  const complete = new Set<string>();
  for (const obj of objects) {
    // Keys look like: prefix/2026-02-09T00-00-00Z/<relativePath...>
    const afterPrefix = obj.key.slice(prefix.length + 1);
    const parts = afterPrefix.split("/");
    const tsDir = parts[0];
    if (!tsDir || tsDir.startsWith(`${SAFETY_PREFIX}-`)) continue;
    if (parts.length === 2 && parts[1] === "manifest.json") complete.add(tsDir);
  }
  return [...complete].sort();
}

export async function getLatestSnapshot(
  b2: B2Client,
  bucket: string,
  prefix: string,
): Promise<string | null> {
  const snapshots = await listSnapshots(b2, bucket, prefix);
  return snapshots.length > 0 ? snapshots[snapshots.length - 1]! : null;
}

export async function pruneSnapshots(
  b2: B2Client,
  bucket: string,
  prefix: string,
  keep: number,
): Promise<string[]> {
  const snapshots = await listSnapshots(b2, bucket, prefix);
  if (snapshots.length <= keep) return [];

  const toDelete = snapshots.slice(0, snapshots.length - keep);
  for (const ts of toDelete) {
    const objects = await b2.listObjects(bucket, `${prefix}/${ts}/`);
    for (const obj of objects) {
      await b2.deleteObject(bucket, obj.key);
    }
  }
  return toDelete;
}
