import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
   * If omitted, falls back to the B2 application key (legacy) with a warning.
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

/** Path of the optional JSON config file for a given tool name. */
export function standaloneConfigPath(appName: string): string {
  return path.join(os.homedir(), ".config", appName, "config.json");
}

/** Whether the JSON config file exists (used to warn before installing a service). */
export function configFileExists(appName: string): boolean {
  try {
    return fs.statSync(standaloneConfigPath(appName)).isFile();
  } catch {
    return false;
  }
}

/**
 * Load config from an optional JSON file, then overlay environment variables
 * (env wins). Centralized so every per-agent tool gets identical, hardened
 * parsing: malformed config files fail loudly (not silently as "missing
 * config"), `keepSnapshots` is validated, and `B2_ENCRYPT` accepts the usual
 * falsy spellings.
 */
export function loadStandaloneConfig(
  appName: string,
  env: NodeJS.ProcessEnv = process.env,
): StandaloneConfig {
  const configPath = standaloneConfigPath(appName);
  const fromFile = readConfigFile(configPath);

  const merged: Partial<StandaloneConfig> = {
    ...fromFile,
    ...stripUndefined({
      keyId: env.B2_KEY_ID,
      applicationKey: env.B2_APPLICATION_KEY,
      bucket: env.B2_BUCKET,
      region: env.B2_REGION,
      prefix: env.B2_PREFIX,
      encryptionKey: env.B2_ENCRYPTION_KEY,
      schedule: env.B2_SCHEDULE,
      encrypt: parseBool(env.B2_ENCRYPT),
      keepSnapshots: parseCount(env.B2_KEEP_SNAPSHOTS, "B2_KEEP_SNAPSHOTS"),
    }),
  };

  const missing = (["keyId", "applicationKey", "bucket"] as const).filter((k) => !merged[k]);
  if (missing.length > 0) {
    throw new Error(
      `missing required config: ${missing.join(", ")}. ` +
        `Set B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET (and ideally B2_ENCRYPTION_KEY) ` +
        `in the environment or ${configPath}.`,
    );
  }
  if (
    merged.keepSnapshots !== undefined &&
    !(Number.isInteger(merged.keepSnapshots) && merged.keepSnapshots >= 1)
  ) {
    throw new Error(`keepSnapshots must be an integer >= 1, got ${String(merged.keepSnapshots)}`);
  }
  return merged as StandaloneConfig;
}

function readConfigFile(configPath: string): Partial<StandaloneConfig> {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`cannot read config ${configPath}: ${String(err)}`);
  }
  // The config holds the application key (and often the encryption key). Warn if
  // it's readable by group/other — it's the credential store for everything.
  if (process.platform !== "win32") {
    try {
      const mode = fs.statSync(configPath).mode;
      if (mode & 0o077) {
        console.warn(
          `warning: ${configPath} is group/other-readable; it holds your B2 (and encryption) keys. Run: chmod 600 ${configPath}`,
        );
      }
    } catch {
      // best effort
    }
  }
  try {
    return JSON.parse(raw) as Partial<StandaloneConfig>;
  } catch (err) {
    throw new Error(`invalid JSON in ${configPath}: ${String(err)}`);
  }
}

/** Accept the usual falsy spellings for a boolean env var; undefined if unset. */
function parseBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  return !/^(false|0|no|off)$/i.test(v.trim());
}

function parseCount(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got "${v}"`);
  return n;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
