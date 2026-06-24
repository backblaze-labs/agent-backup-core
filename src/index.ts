// Engine
export { createB2Client } from "./b2-client.js";
export type { B2Client, B2ObjectEntry } from "./b2-client.js";
export { decrypt, deriveKey, encrypt, isEncrypted } from "./encryption.js";
export { gatherFiles, resolveRelativePath, shouldInclude } from "./gatherer.js";
export type { GatherPatterns } from "./gatherer.js";
export { readJsonFileWithFallback, writeJsonFileAtomically } from "./json-io.js";
export { computeManifest, deserializeManifest, diffManifests, serializeManifest } from "./manifest.js";
export type { ManifestDiff } from "./manifest.js";
export { pullLatest, pullSnapshot } from "./pull.js";
export type { PullOptions } from "./pull.js";
export { push } from "./push.js";
export type { PushOptions } from "./push.js";
export { getLatestSnapshot, listSnapshots, pruneSnapshots } from "./snapshots.js";
export { snapshotSqlite } from "./sqlite-snapshot.js";
export { createDebounceGate } from "./debounce.js";
export type { DebounceGate } from "./debounce.js";

// Adapter contract
export type { BackupAdapter } from "./adapter.js";

// Standalone runner
export {
  acquireLock,
  buildContext,
  generateServiceUnit,
  installService,
  resolvePassphrase,
  runCli,
  runDaemon,
  runOnce,
} from "./standalone.js";
export type { Logger, StandaloneConfig } from "./standalone.js";

// Shared types
export type {
  B2Credentials,
  BackupContext,
  BackupManifest,
  BackupRoot,
  GatheredFile,
} from "./types.js";
export { SAFETY_PREFIX } from "./types.js";
