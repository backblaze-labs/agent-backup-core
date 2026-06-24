import { describe, expect, it, vi } from "vitest";
import type { B2Client, B2ObjectEntry } from "./b2-client.js";
import { getLatestSnapshot, listSnapshots, pruneSnapshots } from "./snapshots.js";

function createMockB2(objects: B2ObjectEntry[]): B2Client {
  const deleted: string[] = [];
  return {
    putObject: vi.fn(),
    getObject: vi.fn(),
    copyObject: vi.fn(),
    listObjects: vi.fn(async (_bucket: string, prefix: string) =>
      objects.filter((o) => o.key.startsWith(prefix)),
    ),
    deleteObject: vi.fn(async (_bucket: string, key: string) => {
      deleted.push(key);
    }),
    headBucket: vi.fn(),
    _deleted: deleted,
  } as unknown as B2Client & { _deleted: string[] };
}

/** A complete snapshot = a data file + a manifest.json under the timestamp dir. */
function snapshot(prefix: string, ts: string): B2ObjectEntry[] {
  return [
    { key: `${prefix}/${ts}/data/file.txt`, size: 10, lastModified: "" },
    { key: `${prefix}/${ts}/manifest.json`, size: 20, lastModified: "" },
  ];
}

describe("snapshots", () => {
  const prefix = "agent-backup";
  const bucket = "test-bucket";

  describe("listSnapshots", () => {
    it("lists only complete (manifest-bearing) snapshots, sorted", async () => {
      const b2 = createMockB2([
        ...snapshot(prefix, "2026-01-03T00-00-00Z"),
        ...snapshot(prefix, "2026-01-01T00-00-00Z"),
        ...snapshot(prefix, "2026-01-02T00-00-00Z"),
      ]);
      expect(await listSnapshots(b2, bucket, prefix)).toEqual([
        "2026-01-01T00-00-00Z",
        "2026-01-02T00-00-00Z",
        "2026-01-03T00-00-00Z",
      ]);
    });

    it("excludes a torn snapshot (files but no manifest)", async () => {
      const b2 = createMockB2([
        ...snapshot(prefix, "2026-01-01T00-00-00Z"),
        { key: `${prefix}/2026-01-02T00-00-00Z/data/file.txt`, size: 10, lastModified: "" }, // no manifest
      ]);
      expect(await listSnapshots(b2, bucket, prefix)).toEqual(["2026-01-01T00-00-00Z"]);
    });

    it("excludes out-of-band safety snapshots", async () => {
      const b2 = createMockB2([
        ...snapshot(prefix, "2026-01-01T00-00-00Z"),
        { key: `${prefix}/safety-2026-01-09T00-00-00Z/manifest.json`, size: 20, lastModified: "" },
      ]);
      expect(await listSnapshots(b2, bucket, prefix)).toEqual(["2026-01-01T00-00-00Z"]);
    });

    it("returns empty array when no objects", async () => {
      expect(await listSnapshots(createMockB2([]), bucket, prefix)).toEqual([]);
    });
  });

  describe("getLatestSnapshot", () => {
    it("returns the latest complete timestamp, ignoring a later safety snapshot", async () => {
      const b2 = createMockB2([
        ...snapshot(prefix, "2026-01-01T00-00-00Z"),
        ...snapshot(prefix, "2026-01-03T00-00-00Z"),
        { key: `${prefix}/safety-2026-02-01T00-00-00Z/manifest.json`, size: 20, lastModified: "" },
      ]);
      expect(await getLatestSnapshot(b2, bucket, prefix)).toBe("2026-01-03T00-00-00Z");
    });

    it("returns null when no snapshots", async () => {
      expect(await getLatestSnapshot(createMockB2([]), bucket, prefix)).toBeNull();
    });
  });

  describe("pruneSnapshots", () => {
    it("deletes oldest snapshots beyond keep count", async () => {
      const b2 = createMockB2([
        ...snapshot(prefix, "2026-01-01T00-00-00Z"),
        ...snapshot(prefix, "2026-01-02T00-00-00Z"),
        ...snapshot(prefix, "2026-01-03T00-00-00Z"),
      ]);
      const pruned = await pruneSnapshots(b2, bucket, prefix, 2);
      expect(pruned).toEqual(["2026-01-01T00-00-00Z"]);
      expect(b2.deleteObject).toHaveBeenCalled();
    });

    it("does nothing when within keep count", async () => {
      const b2 = createMockB2([
        ...snapshot(prefix, "2026-01-01T00-00-00Z"),
        ...snapshot(prefix, "2026-01-02T00-00-00Z"),
      ]);
      const pruned = await pruneSnapshots(b2, bucket, prefix, 5);
      expect(pruned).toEqual([]);
      expect(b2.deleteObject).not.toHaveBeenCalled();
    });
  });
});
