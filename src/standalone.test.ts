import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupAdapter } from "./adapter.js";
import type { B2Client, B2ObjectEntry } from "./b2-client.js";
import {
  acquireLock,
  buildContext,
  generateServiceUnit,
  resolvePassphrase,
  runCli,
  runOnce,
} from "./standalone.js";
import type { StandaloneConfig } from "./load-config.js";
import type { ClientFactory, Logger } from "./standalone.js";

const adapter: BackupAdapter = {
  id: "testagent",
  resolveRoots: () => [{ label: "data", dir: "/tmp/does-not-matter" }],
  include: [/^data\//],
  exclude: [/\.tmp$/],
  sqlite: [/\.db$/],
  secretExclude: [/secrets\.yaml$/],
};

const baseConfig: StandaloneConfig = {
  keyId: "k",
  applicationKey: "appkey",
  bucket: "bucket",
};

function silentLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    info: () => {},
    warn: (m) => warnings.push(m),
    error: () => {},
  };
}

describe("resolvePassphrase", () => {
  it("uses encryptionKey when provided, with no warning", () => {
    const logger = silentLogger();
    const pass = resolvePassphrase({ ...baseConfig, encryptionKey: "secret" }, logger);
    expect(pass).toBe("secret");
    expect(logger.warnings).toHaveLength(0);
  });

  it("falls back to the application key with a loud warning", () => {
    const logger = silentLogger();
    const pass = resolvePassphrase(baseConfig, logger);
    expect(pass).toBe("appkey");
    expect(logger.warnings.join(" ")).toMatch(/encryptionKey/);
  });
});

describe("buildContext", () => {
  it("applies defaults and merges secretExclude into exclude", () => {
    const ctx = buildContext(adapter, { ...baseConfig, encryptionKey: "s" }, silentLogger());
    expect(ctx.prefix).toBe("testagent-backup");
    expect(ctx.encrypt).toBe(true);
    expect(ctx.keepSnapshots).toBe(10);
    expect(ctx.cacheDir).toMatch(/\.agent-backup[/\\]testagent$/);
    // secretExclude folded into exclude so the engine enforces it everywhere.
    expect(ctx.exclude.some((r) => r.source.includes("secrets"))).toBe(true);
  });

  it("honors explicit overrides", () => {
    const ctx = buildContext(
      adapter,
      { ...baseConfig, encryptionKey: "s", prefix: "p", encrypt: false, keepSnapshots: 3 },
      silentLogger(),
    );
    expect(ctx.prefix).toBe("p");
    expect(ctx.encrypt).toBe(false);
    expect(ctx.keepSnapshots).toBe(3);
  });
});

describe("acquireLock", () => {
  it("rejects a second concurrent holder, then re-acquires after release", () => {
    const uniq: BackupAdapter = { ...adapter, id: `lock-${process.pid}-${Date.now()}` };
    const ctx = buildContext(uniq, { ...baseConfig, encryptionKey: "s" }, silentLogger());
    const release = acquireLock(uniq, ctx);
    expect(() => acquireLock(uniq, ctx)).toThrow(/already running/);
    release();
    const release2 = acquireLock(uniq, ctx);
    release2();
  });
});

describe("generateServiceUnit", () => {
  it("produces a launchd plist on darwin", () => {
    const unit = generateServiceUnit(adapter, "testagent-b2-backup", "darwin");
    expect(unit.path).toMatch(/LaunchAgents.*\.plist$/);
    expect(unit.content).toContain("com.backblaze.agent-backup.testagent");
    expect(unit.activate).toContain("launchctl load");
  });

  it("produces a systemd user unit on linux", () => {
    const unit = generateServiceUnit(adapter, "testagent-b2-backup", "linux");
    expect(unit.path).toMatch(/systemd\/user\/.*\.service$/);
    expect(unit.content).toContain("ExecStart=testagent-b2-backup");
    expect(unit.activate).toContain("systemctl --user enable");
  });

  it("produces Task Scheduler instructions on win32", () => {
    const unit = generateServiceUnit(adapter, "testagent-b2-backup", "win32");
    expect(unit.content).toContain("schtasks");
  });
});

// ─── Runtime: runOnce + runCli dispatch (in-memory B2, no network) ───────────

function memoryB2(): B2Client & { store: Map<string, Buffer> } {
  const store = new Map<string, Buffer>();
  return {
    store,
    async putObject(_b, k, body) {
      store.set(k, Buffer.from(body));
    },
    async getObject(_b, k) {
      const v = store.get(k);
      if (!v) throw new Error(`no such key: ${k}`);
      return v;
    },
    async copyObject(_b, src, dest) {
      const v = store.get(src);
      if (!v) throw new Error(`no such key: ${src}`);
      store.set(dest, Buffer.from(v));
    },
    async listObjects(_b, prefix) {
      const out: B2ObjectEntry[] = [];
      for (const [k, v] of store) if (k.startsWith(prefix)) out.push({ key: k, size: v.length, lastModified: "" });
      return out;
    },
    async deleteObject(_b, k) {
      store.delete(k);
    },
    async headBucket() {},
  } as B2Client & { store: Map<string, Buffer> };
}

describe("runOnce (injected client)", () => {
  let dir: string;
  let cfg: StandaloneConfig;
  let fileAdapter: BackupAdapter;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "runonce-"));
    await fs.promises.writeFile(path.join(dir, "note.txt"), "hello");
    cfg = { keyId: "k", applicationKey: "ak", bucket: "b", encryptionKey: "pp", cacheDir: path.join(dir, ".cache") };
    fileAdapter = {
      id: `once-${process.pid}-${Date.now()}`,
      resolveRoots: () => [{ label: "data", dir }],
      include: [/^data\//],
      exclude: [],
      sqlite: [],
    };
  });
  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("pushes to the bucket and releases the lock", async () => {
    const b2 = memoryB2();
    const factory: ClientFactory = async () => b2;
    await runOnce(fileAdapter, cfg, silentLogger(), factory);
    const keys = [...b2.store.keys()];
    expect(keys.some((k) => k.endsWith("data/note.txt"))).toBe(true);
    expect(keys.some((k) => k.endsWith("manifest.json"))).toBe(true);
    await expect(runOnce(fileAdapter, cfg, silentLogger(), factory)).resolves.toBeUndefined();
  });
});

describe("runCli dispatch", () => {
  const adapter: BackupAdapter = {
    id: "cli",
    resolveRoots: () => [],
    include: [],
    exclude: [],
    sqlite: [],
  };

  it("prints usage on --help without loading config or a client", async () => {
    const loadConfig = vi.fn();
    const factory = vi.fn();
    await runCli(adapter, loadConfig as never, ["--help"], silentLogger(), factory as never);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects unknown flags before doing anything", async () => {
    const loadConfig = vi.fn();
    await expect(runCli(adapter, loadConfig as never, ["--bogus"], silentLogger())).rejects.toThrow(/unknown option/);
    expect(loadConfig).not.toHaveBeenCalled();
  });
});
