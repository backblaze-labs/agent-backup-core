import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Cron } from "croner";
import { createB2Client } from "./b2-client.js";
import { gatherFiles } from "./gatherer.js";
import { pullLatest } from "./pull.js";
import { push } from "./push.js";
import { getLatestSnapshot } from "./snapshots.js";
import type { BackupAdapter } from "./adapter.js";
import type { BackupContext } from "./types.js";

/** User-facing config for a standalone per-agent backup tool. */
export type StandaloneConfig = {
  keyId: string;
  applicationKey: string;
  bucket: string;
  region?: string;
  /** Object-key prefix; defaults to `${adapter.id}-backup`. */
  prefix?: string;
  /**
   * Encryption passphrase, separate from B2 credentials. Strongly recommended.
   * If omitted, falls back to the B2 application key (legacy behavior) with a
   * warning — see resolvePassphrase.
   */
  encryptionKey?: string;
  /** Encrypt at rest (default true). */
  encrypt?: boolean;
  /** Snapshots to retain (default 10). */
  keepSnapshots?: number;
  /** "daily" | "weekly" | cron expression (default "daily"). */
  schedule?: string;
  /** Tool-owned dir for the local manifest cache (default ~/.agent-backup/<id>). */
  cacheDir?: string;
};

export type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};

const consoleLogger: Logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
  debug: (m) => process.env.DEBUG && console.debug(m),
};

function resolveSchedule(schedule: string | undefined): string {
  switch (schedule) {
    case "daily":
    case undefined:
      return "0 0 * * *"; // midnight
    case "weekly":
      return "0 0 * * 0"; // Sunday midnight
    default:
      return schedule; // raw cron expression
  }
}

/**
 * Resolve the encryption passphrase. Prefer a dedicated key so a leaked B2
 * credential cannot also decrypt backups. Fall back to the application key only
 * for backward compatibility, and make the weaker posture loud, not silent.
 */
export function resolvePassphrase(config: StandaloneConfig, logger: Logger): string {
  if (config.encryptionKey && config.encryptionKey.length > 0) return config.encryptionKey;
  logger.warn(
    "backup: no encryptionKey set — falling back to the B2 application key for encryption. " +
      "This couples backup confidentiality to your bucket credential; set encryptionKey for proper at-rest security.",
  );
  return config.applicationKey;
}

/** Build the fully-resolved runtime context from user config + adapter. */
export function buildContext(adapter: BackupAdapter, config: StandaloneConfig, logger: Logger): BackupContext {
  const roots = adapter.resolveRoots(process.env);
  return {
    roots,
    bucket: config.bucket,
    prefix: config.prefix ?? `${adapter.id}-backup`,
    cacheDir: config.cacheDir ?? path.join(os.homedir(), ".agent-backup", adapter.id),
    passphrase: resolvePassphrase(config, logger),
    encrypt: config.encrypt !== false,
    keepSnapshots: config.keepSnapshots ?? 10,
    sqlite: adapter.sqlite,
    include: adapter.include,
    exclude: [...adapter.exclude, ...(adapter.secretExclude ?? [])],
  };
}

// ─── Single-instance lock ───────────────────────────────────────────────────
// Prevents two daemons racing the same bucket prefix. Keyed by adapter+prefix so
// distinct agents (or distinct buckets) can run concurrently.

function lockPath(adapter: BackupAdapter, ctx: BackupContext): string {
  const safe = `${adapter.id}-${ctx.bucket}-${ctx.prefix}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(os.tmpdir(), `agent-backup-${safe}.lock`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Acquire the lock or throw. Returns a release function. */
export function acquireLock(adapter: BackupAdapter, ctx: BackupContext): () => void {
  const file = lockPath(adapter, ctx);
  try {
    fs.writeFileSync(file, String(process.pid), { flag: "wx" });
  } catch {
    // Lock exists — check whether the holder is still alive (stale after crash).
    const holder = Number(fs.readFileSync(file, "utf-8").trim());
    if (Number.isFinite(holder) && isPidAlive(holder)) {
      throw new Error(`another ${adapter.id} backup process (pid ${holder}) is already running`);
    }
    fs.writeFileSync(file, String(process.pid)); // take over the stale lock
  }
  return () => {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // best effort
    }
  };
}

/** Run a single push and return (for cron/CI use). */
export async function runOnce(
  adapter: BackupAdapter,
  config: StandaloneConfig,
  logger: Logger = consoleLogger,
): Promise<void> {
  const ctx = buildContext(adapter, config, logger);
  if (ctx.roots.length === 0) {
    throw new Error(`no ${adapter.id} state directories found — nothing to back up`);
  }
  const b2 = await createB2Client(config.keyId, config.applicationKey, config.region);
  await b2.headBucket(ctx.bucket); // fail fast on bad creds / missing bucket
  const release = acquireLock(adapter, ctx);
  try {
    await push(ctx, b2, logger);
  } finally {
    release();
  }
}

/**
 * Long-running daemon: optional auto-restore on first run, scheduled pushes, and
 * a final push on shutdown. Resolves when a shutdown signal is received.
 */
export async function runDaemon(
  adapter: BackupAdapter,
  config: StandaloneConfig,
  logger: Logger = consoleLogger,
): Promise<void> {
  const ctx = buildContext(adapter, config, logger);
  if (ctx.roots.length === 0) {
    throw new Error(`no ${adapter.id} state directories found — nothing to back up`);
  }
  const b2 = await createB2Client(config.keyId, config.applicationKey, config.region);
  await b2.headBucket(ctx.bucket);
  const release = acquireLock(adapter, ctx);

  // Auto-restore: empty local state + snapshots exist → pull latest.
  try {
    const files = await gatherFiles(ctx.roots, { include: ctx.include, exclude: ctx.exclude });
    if (files.length === 0 && (await getLatestSnapshot(b2, ctx.bucket, ctx.prefix))) {
      logger.info("backup: empty state detected, auto-restoring latest snapshot");
      await pullLatest(ctx, b2, logger, { skipSafety: true });
    }
  } catch (err) {
    logger.warn(`backup: auto-restore check failed: ${String(err)}`);
  }

  const cronExpr = resolveSchedule(config.schedule);
  logger.info(`backup: ${adapter.id} daemon started (schedule: ${config.schedule ?? "daily"})`);
  const cron = new Cron(cronExpr, async () => {
    try {
      await push(ctx, b2, logger);
    } catch (err) {
      logger.error(`backup: scheduled push failed: ${String(err)}`);
    }
  });

  // Resolve on SIGINT/SIGTERM after a final push, so the lock is released cleanly.
  await new Promise<void>((resolve) => {
    const shutdown = async (signal: string) => {
      logger.info(`backup: ${signal} received, running final push`);
      cron.stop();
      try {
        await push(ctx, b2, logger);
      } catch (err) {
        logger.warn(`backup: shutdown push failed: ${String(err)}`);
      }
      release();
      resolve();
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  });
}

// ─── OS service unit generation (for `--install`) ─────────────────────────────

/** Generate an OS-appropriate service definition that runs `binName` as a daemon. */
export function generateServiceUnit(
  adapter: BackupAdapter,
  binName: string,
  platform: NodeJS.Platform = process.platform,
): { path: string; content: string; activate: string } {
  const home = os.homedir();
  const label = `com.backblaze.agent-backup.${adapter.id}`;
  if (platform === "darwin") {
    return {
      path: path.join(home, "Library", "LaunchAgents", `${label}.plist`),
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${binName}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`,
      activate: `launchctl load ~/Library/LaunchAgents/${label}.plist`,
    };
  }
  if (platform === "win32") {
    return {
      path: path.join(home, `${label}.txt`),
      content:
        `Register a scheduled task to run at logon:\n` +
        `  schtasks /create /tn "${label}" /tr "${binName}" /sc onlogon\n`,
      activate: `schtasks /run /tn "${label}"`,
    };
  }
  // Linux / other: systemd user unit
  return {
    path: path.join(home, ".config", "systemd", "user", `${label}.service`),
    content: `[Unit]
Description=Backblaze B2 backup for ${adapter.id}

[Service]
ExecStart=${binName}
Restart=on-failure

[Install]
WantedBy=default.target
`,
    activate: `systemctl --user enable --now ${label}.service`,
  };
}

/** Write the service unit to disk and print activation instructions. */
export function installService(adapter: BackupAdapter, binName: string, logger: Logger = consoleLogger): void {
  const unit = generateServiceUnit(adapter, binName);
  fs.mkdirSync(path.dirname(unit.path), { recursive: true });
  fs.writeFileSync(unit.path, unit.content);
  logger.info(`backup: wrote service unit to ${unit.path}`);
  logger.info(`backup: activate with:\n  ${unit.activate}`);
}

/**
 * Thin CLI entry for per-agent bins. Parses `--once` / `--install` / default
 * (daemon) and dispatches. Keeps per-agent packages to a one-liner.
 */
export async function runCli(
  adapter: BackupAdapter,
  loadConfig: () => StandaloneConfig | Promise<StandaloneConfig>,
  argv: string[] = process.argv.slice(2),
  logger: Logger = consoleLogger,
): Promise<void> {
  const binName = `${adapter.id}-b2-backup`;
  if (argv.includes("--install")) {
    installService(adapter, binName, logger);
    return;
  }
  const config = await loadConfig();
  if (argv.includes("--once")) {
    await runOnce(adapter, config, logger);
    return;
  }
  await runDaemon(adapter, config, logger);
}
