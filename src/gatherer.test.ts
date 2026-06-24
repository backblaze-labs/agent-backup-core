import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gatherFiles, resolveRelativePath, shouldInclude } from "./gatherer.js";
import type { BackupRoot } from "./types.js";

describe("shouldInclude", () => {
  const patterns = {
    include: [/^data\/.*\.db$/, /^config\/config\.yaml$/],
    exclude: [/\.tmp$/],
    secretExclude: [/^config\/secrets\.yaml$/],
  };

  it("includes matching paths", () => {
    expect(shouldInclude("data/sessions/sessions.db", patterns)).toBe(true);
    expect(shouldInclude("config/config.yaml", patterns)).toBe(true);
  });

  it("rejects non-matching paths", () => {
    expect(shouldInclude("data/notes.txt", patterns)).toBe(false);
  });

  it("lets exclude win over include", () => {
    expect(shouldInclude("data/foo.db.tmp", patterns)).toBe(false);
  });

  it("lets secretExclude win over include", () => {
    // secrets.yaml is not in include anyway, but prove precedence with an overlap.
    const p = { include: [/^config\//], exclude: [], secretExclude: [/^config\/secrets\.yaml$/] };
    expect(shouldInclude("config/config.yaml", p)).toBe(true);
    expect(shouldInclude("config/secrets.yaml", p)).toBe(false);
  });
});

describe("gatherFiles (multi-root)", () => {
  let dataDir: string;
  let configDir: string;
  let roots: BackupRoot[];

  beforeEach(async () => {
    const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gather-test-"));
    dataDir = path.join(base, "share", "goose");
    configDir = path.join(base, "config", "goose");
    await fs.promises.mkdir(path.join(dataDir, "sessions"), { recursive: true });
    await fs.promises.mkdir(configDir, { recursive: true });
    await fs.promises.mkdir(path.join(dataDir, "models"), { recursive: true });
    await fs.promises.writeFile(path.join(dataDir, "sessions", "sessions.db"), "DB");
    await fs.promises.writeFile(path.join(dataDir, "models", "ignore.bin"), "BIG");
    await fs.promises.writeFile(path.join(configDir, "config.yaml"), "cfg");
    await fs.promises.writeFile(path.join(configDir, "secrets.yaml"), "SECRET");
    roots = [
      { label: "data", dir: dataDir },
      { label: "config", dir: configDir },
    ];
  });

  afterEach(async () => {
    await fs.promises.rm(path.dirname(path.dirname(dataDir)), { recursive: true, force: true });
  });

  it("collects files from all roots with label-prefixed virtual paths", async () => {
    const files = await gatherFiles(roots, {
      include: [/^data\/sessions\//, /^config\/config\.yaml$/],
      exclude: [],
      secretExclude: [/^config\/secrets\.yaml$/],
    });
    const rels = files.map((f) => f.relativePath);
    expect(rels).toContain("data/sessions/sessions.db");
    expect(rels).toContain("config/config.yaml");
    expect(rels).not.toContain("config/secrets.yaml"); // secret excluded
    expect(rels.some((r) => r.includes("models"))).toBe(false); // not in include
  });

  it("maps virtual paths back to absolute paths", () => {
    expect(resolveRelativePath("data/sessions/sessions.db", roots)).toBe(
      path.join(dataDir, "sessions", "sessions.db"),
    );
    expect(resolveRelativePath("config/config.yaml", roots)).toBe(path.join(configDir, "config.yaml"));
    expect(resolveRelativePath("unknown/x", roots)).toBeNull();
  });
});
