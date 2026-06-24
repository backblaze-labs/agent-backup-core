import { describe, expect, it, vi } from "vitest";
import type { BackupAdapter } from "./adapter.js";
import {
  acquireLock,
  buildContext,
  generateServiceUnit,
  resolvePassphrase,
} from "./standalone.js";
import type { StandaloneConfig } from "./load-config.js";
import type { Logger } from "./standalone.js";

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
