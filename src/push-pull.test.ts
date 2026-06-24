import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { B2Client, B2ObjectEntry } from "./b2-client.js";
import { isEncrypted } from "./encryption.js";
import { pullLatest } from "./pull.js";
import { push } from "./push.js";
import type { BackupContext } from "./types.js";

/** Minimal in-memory B2 implementation for round-trip testing. */
function memoryB2(): B2Client & { store: Map<string, Buffer> } {
  const store = new Map<string, Buffer>();
  return {
    store,
    async putObject(_bucket, key, body) {
      store.set(key, Buffer.from(body));
    },
    async getObject(_bucket, key) {
      const v = store.get(key);
      if (!v) throw new Error(`no such key: ${key}`);
      return v;
    },
    async copyObject(_bucket, srcKey, destKey) {
      const v = store.get(srcKey);
      if (!v) throw new Error(`no such key: ${srcKey}`);
      store.set(destKey, Buffer.from(v));
    },
    async listObjects(_bucket, prefix) {
      const out: B2ObjectEntry[] = [];
      for (const [key, body] of store) {
        if (key.startsWith(prefix)) out.push({ key, size: body.length, lastModified: "" });
      }
      return out;
    },
    async deleteObject(_bucket, key) {
      store.delete(key);
    },
    async headBucket() {},
  };
}

const logger = { info: () => {}, warn: () => {}, error: () => {} };

describe("push → pull round-trip (multi-root, encrypted)", () => {
  let base: string;
  let dataDir: string;
  let configDir: string;
  let cacheDir: string;
  let ctx: BackupContext;

  beforeEach(async () => {
    base = await fs.promises.mkdtemp(path.join(os.tmpdir(), "roundtrip-"));
    dataDir = path.join(base, "share");
    configDir = path.join(base, "config");
    cacheDir = path.join(base, "cache");
    await fs.promises.mkdir(path.join(dataDir, "sessions"), { recursive: true });
    await fs.promises.mkdir(configDir, { recursive: true });
    // A real (WAL) SQLite DB so the snapshot path is genuinely exercised.
    const db = new DatabaseSync(path.join(dataDir, "sessions", "sessions.db"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE m (id INTEGER PRIMARY KEY, v TEXT)");
    db.prepare("INSERT INTO m (v) VALUES (?)").run("hello");
    db.close();
    await fs.promises.writeFile(path.join(configDir, "config.yaml"), "provider: openai");
    ctx = {
      roots: [
        { label: "data", dir: dataDir },
        { label: "config", dir: configDir },
      ],
      bucket: "b",
      prefix: "test-backup",
      cacheDir,
      passphrase: "a-real-separate-passphrase",
      encrypt: true,
      keepSnapshots: 10,
      sqlite: [/\.db$/],
      include: [/^data\//, /^config\//],
      // Exclude SQLite sidecars, exactly as every real adapter does — the .db is
      // snapshotted, and the transient -wal/-shm must not be backed up or they
      // churn the incremental diff.
      exclude: [/-wal$/, /-shm$/],
    };
  });

  afterEach(async () => {
    await fs.promises.rm(base, { recursive: true, force: true });
  });

  it("uploads encrypted files + an encrypted manifest, then restores byte-identical content", async () => {
    const b2 = memoryB2();
    await push(ctx, b2, logger);

    // Manifest is encrypted at rest (no plaintext path leakage).
    const manifestKey = [...b2.store.keys()].find((k) => k.endsWith("/manifest.json"));
    expect(manifestKey).toBeDefined();
    expect(isEncrypted(b2.store.get(manifestKey!)!)).toBe(true);

    // File bodies are encrypted.
    const dbKey = [...b2.store.keys()].find((k) => k.endsWith("data/sessions/sessions.db"));
    expect(dbKey).toBeDefined();
    expect(isEncrypted(b2.store.get(dbKey!)!)).toBe(true);

    // Wipe local state, then restore.
    await fs.promises.rm(dataDir, { recursive: true, force: true });
    await fs.promises.rm(configDir, { recursive: true, force: true });
    await pullLatest(ctx, b2, logger, { skipSafety: true });

    // The restored DB must be a valid SQLite file with the original row.
    const restored = new DatabaseSync(path.join(dataDir, "sessions", "sessions.db"), { readOnly: true });
    const row = restored.prepare("SELECT v FROM m WHERE id = 1").get() as { v: string };
    restored.close();
    expect(row.v).toBe("hello");
    const cfg = await fs.promises.readFile(path.join(configDir, "config.yaml"), "utf-8");
    expect(cfg).toBe("provider: openai");
  });

  it("is incremental: a second push with no changes uploads nothing new", async () => {
    const b2 = memoryB2();
    await push(ctx, b2, logger);
    const countAfterFirst = b2.store.size;
    await push(ctx, b2, logger);
    expect(b2.store.size).toBe(countAfterFirst); // no new snapshot dir
  });
});

// Regression guard for the cross-snapshot restore bug: a snapshot after the
// first must be self-contained, so restoring the LATEST snapshot recovers files
// that were unchanged since an earlier snapshot (carried forward by copy).
describe("push → pull restore of a later (incremental) snapshot", () => {
  let base: string;
  let dataDir: string;
  let cacheDir: string;
  let ctx: BackupContext;

  beforeEach(async () => {
    base = await fs.promises.mkdtemp(path.join(os.tmpdir(), "multi-snap-"));
    dataDir = path.join(base, "data");
    cacheDir = path.join(base, "cache");
    await fs.promises.mkdir(dataDir, { recursive: true });
    ctx = {
      roots: [{ label: "data", dir: dataDir }],
      bucket: "b",
      prefix: "ms-backup",
      cacheDir,
      passphrase: "pp",
      encrypt: true,
      keepSnapshots: 10,
      sqlite: [],
      include: [/^data\//],
      exclude: [],
    };
  });
  afterEach(async () => {
    await fs.promises.rm(base, { recursive: true, force: true });
  });

  it("restores the latest snapshot byte-for-byte after only one file changed", async () => {
    const b2 = memoryB2();
    await fs.promises.writeFile(path.join(dataDir, "stable.txt"), "unchanged-content");
    await fs.promises.writeFile(path.join(dataDir, "volatile.txt"), "v1");
    await push(ctx, b2, logger); // snapshot 1

    // Change only volatile.txt and push a second snapshot.
    await fs.promises.writeFile(path.join(dataDir, "volatile.txt"), "v2");
    await push(ctx, b2, logger); // snapshot 2 — stable.txt is carried forward

    // Wipe and restore the LATEST snapshot. stable.txt was never uploaded under
    // snapshot 2's timestamp; it must have been copied forward.
    await fs.promises.rm(dataDir, { recursive: true, force: true });
    await pullLatest(ctx, b2, logger, { skipSafety: true });

    expect(await fs.promises.readFile(path.join(dataDir, "stable.txt"), "utf-8")).toBe("unchanged-content");
    expect(await fs.promises.readFile(path.join(dataDir, "volatile.txt"), "utf-8")).toBe("v2");
  });
});
