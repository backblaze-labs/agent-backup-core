/** A single source directory to back up, tagged with a stable label. */
export type BackupRoot = {
  /** Stable identifier used as the first segment of every relative path in the
   * backup (e.g. "data", "config"). Lets us mirror agents whose state is split
   * across multiple directories and reassemble it correctly on restore. */
  label: string;
  /** Absolute path to the directory. */
  dir: string;
};

/** Backblaze B2 connection + credentials. */
export type B2Credentials = {
  keyId: string;
  applicationKey: string;
  bucket: string;
  region?: string;
};

/**
 * Fully-resolved runtime context for a push/pull. The runner builds this from
 * user config + the adapter, so push/pull never see raw config defaults or the
 * legacy-fallback decision — those are settled once, up front.
 */
export type BackupContext = {
  roots: BackupRoot[];
  bucket: string;
  /** Object-key prefix for this agent's snapshots, e.g. "goose-backup". */
  prefix: string;
  /** Tool-owned dir for the local manifest cache. Never inside an agent's roots. */
  cacheDir: string;
  /**
   * Encryption passphrase, already resolved. Decoupled from B2 credentials: a
   * leaked B2 key must not also decrypt backups. The runner falls back to the
   * B2 application key only for legacy compatibility, with a warning.
   */
  passphrase: string;
  encrypt: boolean;
  keepSnapshots: number;
  /** Relative-path patterns whose files need a WAL-safe SQLite snapshot. */
  sqlite: RegExp[];
  include: RegExp[];
  exclude: RegExp[];
};

export type BackupManifest = {
  version: 1;
  timestamp: string;
  files: Record<string, { hash: string; size: number }>;
};

export type GatheredFile = {
  /** Virtual path: `${root.label}/${pathRelativeToRootDir}`. */
  relativePath: string;
  absolutePath: string;
  size: number;
};

/** Out-of-band prefix segment for pre-restore safety snapshots; never auto-pruned. */
export const SAFETY_PREFIX = "safety";
