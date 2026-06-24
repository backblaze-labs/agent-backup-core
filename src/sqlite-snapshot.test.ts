import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { snapshotSqlite } from "./sqlite-snapshot.js";

describe("snapshotSqlite", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sqlite-snap-"));
  });
  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("snapshots a live WAL-mode database into a consistent, readable copy", async () => {
    const dbPath = path.join(dir, "state.db");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
    for (let i = 0; i < 100; i++) insert.run(`row-${i}`);
    // Leave the source OPEN (mid-WAL) to prove the online backup is consistent
    // even while another handle holds the DB — the real-world agent scenario.

    const dest = path.join(dir, "snap", "state.db");
    await snapshotSqlite(dbPath, dest);
    db.close();

    // The snapshot must be a valid SQLite DB containing all committed rows.
    const snap = new DatabaseSync(dest, { readOnly: true });
    const count = snap.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number };
    snap.close();
    expect(count.n).toBe(100);
  });

  it("does not silently produce an empty/torn file on a real DB", async () => {
    const dbPath = path.join(dir, "x.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE a (id INTEGER)");
    db.prepare("INSERT INTO a (id) VALUES (?)").run(42);
    db.close();

    const dest = path.join(dir, "x-snap.db");
    await snapshotSqlite(dbPath, dest);
    const snap = new DatabaseSync(dest, { readOnly: true });
    const row = snap.prepare("SELECT id FROM a").get() as { id: number };
    snap.close();
    expect(row.id).toBe(42);
  });
});
