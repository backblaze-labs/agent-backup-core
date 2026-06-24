import fs from "node:fs";
import path from "node:path";
import type { BackupRoot, GatheredFile } from "./types.js";

export type GatherPatterns = {
  include: RegExp[];
  exclude: RegExp[];
  /** Secret files to never collect; takes precedence over include. */
  secretExclude?: RegExp[];
};

function matchesAny(relativePath: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(relativePath));
}

/** Whether a directory (trailing-slash path) is wholly excluded, so the walk can skip it. */
function isExcludedDir(dirPath: string, patterns: GatherPatterns): boolean {
  if (matchesAny(dirPath, patterns.exclude)) return true;
  if (patterns.secretExclude && matchesAny(dirPath, patterns.secretExclude)) return true;
  return false;
}

/**
 * Decide whether a virtual relative path (label-prefixed) belongs in the backup.
 * Exclusions — including secret exclusions — always win over inclusions.
 */
export function shouldInclude(relativePath: string, patterns: GatherPatterns): boolean {
  if (patterns.secretExclude && matchesAny(relativePath, patterns.secretExclude)) return false;
  if (matchesAny(relativePath, patterns.exclude)) return false;
  return matchesAny(relativePath, patterns.include);
}

/**
 * Walk every root and collect files matching the patterns. Each file's
 * `relativePath` is virtual — `${root.label}/${pathWithinRoot}` — so multiple
 * source directories merge into one namespace and restore unambiguously.
 */
export async function gatherFiles(
  roots: BackupRoot[],
  patterns: GatherPatterns,
): Promise<GatheredFile[]> {
  const results: GatheredFile[] = [];
  for (const root of roots) {
    await walkDir(root, root.dir, patterns, results);
  }
  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function walkDir(
  root: BackupRoot,
  dir: string,
  patterns: GatherPatterns,
  results: GatheredFile[],
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Prune excluded subtrees instead of walking them — avoids statting every
      // file under huge, always-excluded dirs (node_modules, .venv, Cline's
      // multi-GB git checkpoints). Test the dir path with a trailing slash so
      // prefix-style exclude patterns (e.g. /checkpoints\//) match.
      const within = path.relative(root.dir, fullPath).split(path.sep).join("/");
      const dirPath = `${root.label}/${within}/`;
      if (isExcludedDir(dirPath, patterns)) continue;
      await walkDir(root, fullPath, patterns, results);
    } else if (entry.isFile()) {
      const within = path.relative(root.dir, fullPath).split(path.sep).join("/");
      const relativePath = `${root.label}/${within}`;
      if (shouldInclude(relativePath, patterns)) {
        const stat = await fs.promises.stat(fullPath);
        results.push({ relativePath, absolutePath: fullPath, size: stat.size });
      }
    }
  }
}

/** Map a virtual relative path back to an absolute path using the root labels. */
export function resolveRelativePath(relativePath: string, roots: BackupRoot[]): string | null {
  const slash = relativePath.indexOf("/");
  if (slash < 0) return null;
  const label = relativePath.slice(0, slash);
  const within = relativePath.slice(slash + 1);
  const root = roots.find((r) => r.label === label);
  if (!root) return null;
  return path.join(root.dir, within);
}
