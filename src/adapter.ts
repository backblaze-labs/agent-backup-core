import type { BackupRoot } from "./types.js";

/**
 * Per-agent backup profile. Everything agent-specific lives here; the engine
 * (gather → snapshot → encrypt → push/pull) is driven entirely by these fields.
 * A per-agent package supplies one `BackupAdapter` and wires it to `runStandalone`.
 */
export type BackupAdapter = {
  /** Stable id, e.g. "goose". Used for prefixes, lock files, and the cache dir. */
  id: string;

  /**
   * Resolve the agent's state directories from the environment, honoring the
   * agent's own env-var overrides (XDG_*, app-specific vars). Return only roots
   * that actually exist on disk; an empty array means "nothing to back up here".
   */
  resolveRoots(env: NodeJS.ProcessEnv): BackupRoot[];

  /** Relative-path patterns to include (matched against the virtual label-prefixed path). */
  include: RegExp[];

  /** Relative-path patterns to exclude. Takes precedence over `include`. */
  exclude: RegExp[];

  /** Patterns identifying SQLite databases that need a WAL-safe snapshot. */
  sqlite: RegExp[];

  /**
   * Patterns for files that hold secrets/credentials and must never leave the
   * machine. Takes precedence over `include`. Note: this is path-level only —
   * secrets embedded as fields inside an otherwise-included file are not handled.
   */
  secretExclude?: RegExp[];

  /**
   * Optional guidance appended to the "no state directories found" error, for
   * adapters where the user must point the tool somewhere (e.g. Aider has no
   * central dir and needs AIDER_PROJECTS).
   */
  noRootsHint?: string;
};
