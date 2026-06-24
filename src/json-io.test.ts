import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "./json-io.js";

describe("json-io", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "jsonio-test-"));
  });
  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("round-trips a value through atomic write + read", async () => {
    const file = path.join(dir, "nested", "data.json");
    await writeJsonFileAtomically(file, { a: 1, b: ["x"] });
    const { value } = await readJsonFileWithFallback(file, null);
    expect(value).toEqual({ a: 1, b: ["x"] });
  });

  it("returns the fallback when the file is missing", async () => {
    const { value } = await readJsonFileWithFallback(path.join(dir, "nope.json"), { fallback: true });
    expect(value).toEqual({ fallback: true });
  });

  it("returns the fallback when the file is invalid JSON", async () => {
    const file = path.join(dir, "bad.json");
    await fs.promises.writeFile(file, "{not json");
    const { value } = await readJsonFileWithFallback(file, null);
    expect(value).toBeNull();
  });

  it("leaves no temp files behind", async () => {
    const file = path.join(dir, "data.json");
    await writeJsonFileAtomically(file, { ok: true });
    const entries = await fs.promises.readdir(dir);
    expect(entries).toEqual(["data.json"]);
  });
});
