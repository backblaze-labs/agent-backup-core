# @backblaze-labs/agent-backup-core

Reusable engine for backing up an AI agent's local state to [Backblaze B2](https://www.backblaze.com/cloud-storage). It powers a family of small, independent per-agent backup tools (e.g. [`@backblaze-labs/goose-b2-backup`](https://github.com/backblaze-b2-samples/goose-b2-backup)).

You normally don't install this directly — you install a per-agent package that depends on it. Install this only to build a backup tool for a **new** agent.

## What it does

- **Incremental sync** — SHA-256 manifest diffing; only changed files are uploaded.
- **Encryption at rest** — AES-256-GCM, per-file random salt/IV, scrypt-derived key.
- **WAL-safe SQLite snapshots** — uses SQLite's `.backup()` API (Node `node:sqlite`), with a copy + WAL/SHM fallback, so live databases snapshot consistently.
- **Multi-root** — mirrors agents whose state is split across several directories (e.g. separate config / data / state dirs) into one namespace, and restores it correctly.
- **Snapshot retention** — keeps the N most recent snapshots; safety snapshots before a restore are never auto-pruned.
- **Standalone runner** — a daemon (`runCli`/`runDaemon`/`runOnce`) with single-instance locking, scheduling, auto-restore, and OS-service install. No agent runtime or plugin host required.
- **Zero heavy deps** — hand-rolled S3 SigV4 client; only `croner` at runtime.

## Building an adapter for a new agent

An adapter is pure data — where the agent's state lives and what to include:

```ts
import { runCli, type BackupAdapter } from "@backblaze-labs/agent-backup-core";

const myAdapter: BackupAdapter = {
  id: "myagent",
  resolveRoots: (env) => [{ label: "data", dir: `${env.HOME}/.myagent` }], // existing dirs only
  include: [/^data\/.*\.db$/, /^data\/config\.json$/],
  exclude: [/-wal$/, /-shm$/],
  sqlite: [/\.db$/],          // files needing a WAL-safe snapshot
  secretExclude: [/secrets/], // never uploaded
};

runCli(myAdapter, () => loadYourConfig());
```

That's the whole per-agent package: an adapter + a config loader + a one-line bin.

## Security model

Read this before deploying — it differs deliberately from the original OpenClaw plugin.

- **The encryption key is separate from your B2 credentials.** Set `encryptionKey` in config. A leaked B2 application key then cannot decrypt your backups, and vice-versa. If `encryptionKey` is omitted, the engine falls back to deriving the key from the B2 application key (legacy behavior) and logs a **warning** — usable, but it couples backup confidentiality to your bucket credential, so set a real `encryptionKey`.
- **The manifest is encrypted** when encryption is on. The file inventory itself can leak repo names and conversation topics, so it is not uploaded in the clear.
- **`secretExclude` keeps designated secret files out of the backup entirely.** This is path-level only: secrets embedded as fields *inside* an otherwise-backed-up file are **not** redacted. Agents that store credentials inside larger state files need a redaction step before they're safe to mirror.
- **The local manifest cache lives in a tool-owned directory** (`~/.agent-backup/<id>/` by default), never inside the agent's own directories.

## API surface

`createB2Client`, `push`, `pullLatest`, `pullSnapshot`, `listSnapshots`/`getLatestSnapshot`/`pruneSnapshots`, `gatherFiles`/`resolveRelativePath`/`shouldInclude`, `encrypt`/`decrypt`/`isEncrypted`, `snapshotSqlite`, `computeManifest`/`diffManifests`, `runCli`/`runDaemon`/`runOnce`/`buildContext`/`resolvePassphrase`/`acquireLock`/`generateServiceUnit`/`installService`. Types: `BackupAdapter`, `StandaloneConfig`, `BackupContext`, `BackupRoot`, `BackupManifest`, `Logger`.

## Requirements

Node ≥ 22.5.0 (for the built-in `node:sqlite` backup API).

## License

MIT
