# @backblaze-labs/agent-backup-core

**Encrypted, incremental, off-site backups for your AI coding agent — powered by [Backblaze B2 cloud storage](https://blze.ai/storage).**

Reusable engine for backing up an AI agent's local state to [Backblaze B2](https://www.backblaze.com/cloud-storage). It powers a family of small, independent per-agent backup tools (e.g. [`@backblaze-labs/goose-b2-backup`](https://github.com/backblaze-labs/goose-b2-backup)).

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

## FAQ

**Should I install this directly?**

Usually not. Install a per-agent package (e.g. `@backblaze-labs/goose-b2-backup`) that depends on this. Install the core only to build a backup tool for a **new** agent.

**How do I add support for a new agent?**

Write a `BackupAdapter` — pure data: an `id`, a `resolveRoots(env)` function, and `include`/`exclude`/`sqlite`/`secretExclude` regex arrays — then wire it with a one-line bin: `runCli(myAdapter)`. See the README example.

**How is encryption handled?**

AES-256-GCM with a per-file random salt and IV, scrypt-derived key. The passphrase (`encryptionKey`) is deliberately separate from B2 credentials so a leaked bucket key can't decrypt backups.

**How are backups kept incremental but still restorable?**

Each push uploads only changed files and server-side-copies unchanged ones into the new snapshot, so every snapshot is self-contained. The manifest is hashed (and encrypted) to drive the diff and verify restores.

**How are live SQLite databases handled?**

Via `node:sqlite`'s online `backup()` API (with a copy fallback), so a WAL-mode database snapshots consistently while the agent is using it. Adapters declare which files are SQLite via the `sqlite` patterns.

**Why Node >= 22.5?**

The WAL-safe SQLite snapshot relies on the built-in `node:sqlite` module's backup API, available from Node 22.5. This is an experimental Node API, so it may emit an experimental-feature warning.

**Does it support multiple source directories?**

Yes — an adapter can return several roots (e.g. Goose's config/data/state), each labeled; the engine mirrors them into one namespace and restores them correctly.

**How does the standalone daemon behave?**

`runDaemon` takes a single-instance lock, auto-restores on first run if local state is empty, backs up immediately, then on schedule, coalesces overlapping runs, and does a final backup on shutdown.

**Can I exclude secrets from a backup?**

Adapters can list `secretExclude` patterns for files that should never leave the machine. Note this is path-level only — secrets embedded *inside* an included file can't be isolated this way, so rely on encryption there.

**Is it tied to Backblaze only?**

The client speaks the S3-compatible API against Backblaze B2. See [blze.ai/storage](https://blze.ai/storage) for B2.

## Learn more

- [Backblaze B2 Cloud Storage](https://blze.ai/storage) — affordable, S3-compatible object storage
- [agent-backup-core](https://github.com/backblaze-labs/agent-backup-core) — the shared backup engine powering this tool

## License

MIT
