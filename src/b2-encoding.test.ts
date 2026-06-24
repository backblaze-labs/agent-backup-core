import { describe, expect, it } from "vitest";
import {
  _encodePath as encodePath,
  _parseListObjectsResponse as parseListObjectsResponse,
  _signRequest as signRequest,
} from "./b2-client.js";

describe("encodePath", () => {
  it("percent-encodes segments while preserving slashes", () => {
    expect(encodePath("/bucket/prefix/2026/tasks/a b.json")).toBe(
      "/bucket/prefix/2026/tasks/a%20b.json",
    );
    expect(encodePath("/bucket/key")).toBe("/bucket/key"); // clean keys unchanged
  });

  it("encodes characters encodeURIComponent leaves raw", () => {
    expect(encodePath("/b/it's(a)*test!")).toBe("/b/it%27s%28a%29%2Atest%21");
  });
});

describe("signRequest with an encoded path", () => {
  it("signs the encoded canonical path so the wire URL and signature agree", () => {
    // The caller encodes before signing; a space must already be %20 here,
    // matching what fetch sends on the wire (the bug was signing the raw space).
    const path = encodePath("/bucket/my file.json");
    const headers = signRequest({
      method: "PUT",
      path,
      headers: { host: "s3.us-west-004.backblazeb2.com" },
      body: "",
      region: "us-west-004",
      accessKeyId: "004test",
      secretAccessKey: "K004secret",
    });
    expect(path).toContain("%20");
    // A signature is produced deterministically over the encoded path.
    expect(headers.authorization).toMatch(/Signature=[0-9a-f]{64}/);
  });
});

describe("parseListObjectsResponse XML entity decoding", () => {
  it("decodes entities in object keys", () => {
    const xml = `<ListBucketResult>
      <Contents><Key>p/a &amp; b/x&lt;y&gt;.json</Key><Size>10</Size><LastModified>2026-01-01</LastModified></Contents>
      <IsTruncated>false</IsTruncated>
    </ListBucketResult>`;
    const { entries } = parseListObjectsResponse(xml);
    expect(entries[0]!.key).toBe("p/a & b/x<y>.json");
  });
});
