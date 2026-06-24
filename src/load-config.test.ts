import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadStandaloneConfig } from "./load-config.js";

const baseEnv = {
  B2_KEY_ID: "k",
  B2_APPLICATION_KEY: "ak",
  B2_BUCKET: "b",
} as NodeJS.ProcessEnv;

describe("loadStandaloneConfig", () => {
  it("loads required fields from env", () => {
    const c = loadStandaloneConfig("nonexistent-tool-xyz", baseEnv);
    expect(c).toMatchObject({ keyId: "k", applicationKey: "ak", bucket: "b" });
  });

  it("throws listing the missing required fields", () => {
    expect(() => loadStandaloneConfig("nonexistent-tool-xyz", { B2_KEY_ID: "k" } as NodeJS.ProcessEnv)).toThrow(
      /missing required config: applicationKey, bucket/,
    );
  });

  it("parses the usual falsy spellings of B2_ENCRYPT", () => {
    for (const v of ["false", "0", "no", "off", "FALSE"]) {
      expect(loadStandaloneConfig("x", { ...baseEnv, B2_ENCRYPT: v }).encrypt).toBe(false);
    }
    expect(loadStandaloneConfig("x", { ...baseEnv, B2_ENCRYPT: "true" }).encrypt).toBe(true);
    expect(loadStandaloneConfig("x", baseEnv).encrypt).toBeUndefined();
  });

  it("rejects a non-integer B2_KEEP_SNAPSHOTS", () => {
    expect(() => loadStandaloneConfig("x", { ...baseEnv, B2_KEEP_SNAPSHOTS: "abc" })).toThrow(/integer/);
    expect(() => loadStandaloneConfig("x", { ...baseEnv, B2_KEEP_SNAPSHOTS: "0" })).toThrow(/>= 1/);
  });
});

describe("loadStandaloneConfig with a config file", () => {
  let home: string;
  let restore: string | undefined;
  beforeEach(async () => {
    home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cfg-home-"));
    restore = process.env.HOME;
    vi.spyOn(os, "homedir").mockReturnValue(home);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (restore !== undefined) process.env.HOME = restore;
    await fs.promises.rm(home, { recursive: true, force: true });
  });

  it("fails loudly on a malformed config file instead of reporting 'missing config'", async () => {
    const dir = path.join(home, ".config", "app-b2-backup");
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, "config.json"), "{ not json");
    expect(() => loadStandaloneConfig("app-b2-backup", {} as NodeJS.ProcessEnv)).toThrow(/invalid JSON/);
  });

  it("merges file config with env taking precedence", async () => {
    const dir = path.join(home, ".config", "app-b2-backup");
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({ keyId: "file-k", applicationKey: "file-ak", bucket: "file-b", prefix: "p" }),
    );
    const c = loadStandaloneConfig("app-b2-backup", { B2_BUCKET: "env-b" } as NodeJS.ProcessEnv);
    expect(c.bucket).toBe("env-b"); // env wins
    expect(c.keyId).toBe("file-k"); // file fills the rest
    expect(c.prefix).toBe("p");
  });
});
