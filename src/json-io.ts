import fs from "node:fs";
import path from "node:path";

/**
 * Local replacements for the JSON helpers the OpenClaw plugin SDK used to
 * provide, so the core has no dependency on any agent runtime.
 */

/** Read and parse JSON, returning `fallback` if the file is missing or invalid. */
export async function readJsonFileWithFallback<T>(
  filePath: string,
  fallback: T,
): Promise<{ value: T }> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    return { value: JSON.parse(raw) as T };
  } catch {
    return { value: fallback };
  }
}

/** Write JSON atomically: write to a temp file in the same dir, then rename. */
export async function writeJsonFileAtomically(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  // Same-directory temp file guarantees the rename is atomic (same filesystem).
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2), "utf-8");
  await fs.promises.rename(tmp, filePath);
}
