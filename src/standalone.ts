import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Cron } from "croner";
import { createB2Client } from "./b2-client.js";
import type { B2Client } from "./b2-client.js";
import { gatherFiles } from "./gatherer.js";
import { configFileExists, loadStandaloneConfig } from "./load-config.js";
import { pullLatest } from "./pull.js";
import { push } from "./push.js";
import { getLatestSnapshot } from "./snapshots.js";
import type { BackupAdapter } from "./adapter.js";
import type { StandaloneConfig } from "./load-config.js";
import type { BackupContext } from "./types.js";

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

/** Attribution user agent for B2 usage tracking, per-tool. */
function userAgentFor(adapter: BackupAdapter): string {
  return `b2ai-${adapter.id}-backup`;
}

/** Factory for the B2 client. Overridable in tests to avoid real network calls. */
export type ClientFactory = (config: StandaloneConfig, adapter: BackupAdapter) => Promise<B2Client>;

const defaultClientFactory: ClientFactory = (config, adapter) =>
  createB2Client(config.keyId, config.applicationKey, config.region, userAgentFor(adapter));

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
  const encrypt = config.encrypt !== false;
  if (!encrypt) {
    logger.warn(
      "backup: encryption is DISABLED (encrypt=false) — files, including any secrets, will be stored in B2 in plaintext.",
    );
  }
  return {
    roots,
    bucket: config.bucket,
    prefix: config.prefix ?? `${adapter.id}-backup`,
    cacheDir: config.cacheDir ?? path.join(os.homedir(), ".agent-backup", adapter.id),
    passphrase: resolvePassphrase(config, logger),
    encrypt,
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
    // Best-effort takeover of a stale lock. A residual TOCTOU race here is benign
    // for same-user login-time daemons; the bucket-prefix is the same target.
    fs.writeFileSync(file, String(process.pid));
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
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<void> {
  const ctx = buildContext(adapter, config, logger);
  if (ctx.roots.length === 0) {
    throw new Error(`no ${adapter.id} state directories found — nothing to back up${adapter.noRootsHint ? `. ${adapter.noRootsHint}` : ""}`);
  }
  const b2 = await clientFactory(config, adapter);
  await b2.headBucket(ctx.bucket); // fail fast on bad creds / missing bucket
  const release = acquireLock(adapter, ctx);
  try {
    await push(ctx, b2, logger);
  } finally {
    release();
  }
}

/**
 * Long-running daemon: optional auto-restore, an immediate first backup, then
 * scheduled pushes, and a final push on shutdown. Resolves when a shutdown
 * signal is received.
 */
export async function runDaemon(
  adapter: BackupAdapter,
  config: StandaloneConfig,
  logger: Logger = consoleLogger,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<void> {
  const ctx = buildContext(adapter, config, logger);
  if (ctx.roots.length === 0) {
    throw new Error(`no ${adapter.id} state directories found — nothing to back up${adapter.noRootsHint ? `. ${adapter.noRootsHint}` : ""}`);
  }
  const b2 = await clientFactory(config, adapter);
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

  // Coalesce pushes: a slow push must never overlap the next cron tick (they'd
  // race the manifest cache and bucket prefix). A tick during an in-flight push
  // is dropped; callers can await the in-flight one.
  let current: Promise<void> | null = null;
  const doPush = (reason: string): Promise<void> => {
    if (current) {
      logger.debug?.(`backup: ${reason} push skipped — one already running`);
      return current;
    }
    current = (async () => {
      try {
        await push(ctx, b2, logger);
      } catch (err) {
        logger.error(`backup: ${reason} push failed: ${String(err)}`);
      } finally {
        current = null;
      }
    })();
    return current;
  };

  // Immediate first backup, so starting the daemon actually backs up now rather
  // than waiting for the next (up to 24h away) cron boundary.
  await doPush("startup");

  const cronExpr = resolveSchedule(config.schedule);
  logger.info(`backup: ${adapter.id} daemon started (schedule: ${config.schedule ?? "daily"})`);
  const cron = new Cron(cronExpr, () => void doPush("scheduled"));

  await new Promise<void>((resolve) => {
    const shutdown = async (signal: string) => {
      logger.info(`backup: ${signal} received, finishing up`);
      cron.stop();
      if (current) await current.catch(() => undefined); // let an in-flight push finish
      await doPush("shutdown"); // capture any last-moment changes
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
  // The installed service starts in a minimal environment and will NOT see the
  // B2_* env vars you exported in your shell. Credentials must come from the
  // config file, or the service will crash-loop on "missing required config".
  if (!configFileExists(`${adapter.id}-b2-backup`)) {
    logger.warn(
      `backup: no config file at ~/.config/${adapter.id}-b2-backup/config.json. ` +
        `An installed background service cannot read shell environment variables, so it will fail to start. ` +
        `Write your B2 credentials to that file (chmod 600) before activating the service.`,
    );
  }
  fs.mkdirSync(path.dirname(unit.path), { recursive: true });
  fs.writeFileSync(unit.path, unit.content);
  logger.info(`backup: wrote service unit to ${unit.path}`);
  logger.info(`backup: activate with:\n  ${unit.activate}`);
}

/**
 * Thin CLI entry for per-agent bins. Parses `--once` / `--install` / `--help`
 * and dispatches; rejects unknown flags rather than silently running the daemon.
 * `loadConfig` defaults to the shared loader keyed by the adapter id.
 */
export async function runCli(
  adapter: BackupAdapter,
  loadConfig: () => StandaloneConfig | Promise<StandaloneConfig> = () =>
    loadStandaloneConfig(`${adapter.id}-b2-backup`),
  argv: string[] = process.argv.slice(2),
  logger: Logger = consoleLogger,
  clientFactory: ClientFactory = defaultClientFactory,
): Promise<void> {
  const binName = `${adapter.id}-b2-backup`;
  const usage =
    `Usage: ${binName} [--once | --install]\n` +
    `  (no flags)   run as a daemon: restore on first run, back up now, then on schedule\n` +
    `  --once       run a single backup and exit (for cron/CI)\n` +
    `  --install    install an OS service that runs the daemon at login\n` +
    `  --help, -h   show this help`;

  if (argv.includes("--help") || argv.includes("-h")) {
    logger.info(usage);
    return;
  }
  const known = new Set(["--once", "--install"]);
  const unknown = argv.filter((a) => a.startsWith("-") && !known.has(a));
  if (unknown.length > 0) {
    throw new Error(`unknown option(s): ${unknown.join(", ")}\n${usage}`);
  }

  if (argv.includes("--install")) {
    installService(adapter, binName, logger);
    return;
  }
  const config = await loadConfig();
  if (argv.includes("--once")) {
    await runOnce(adapter, config, logger, clientFactory);
    return;
  }
  await runDaemon(adapter, config, logger, clientFactory);
}
