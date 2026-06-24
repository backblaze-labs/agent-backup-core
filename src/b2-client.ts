import crypto from "node:crypto";

/** Default attribution token; per-tool callers override with `b2ai-<tool>`. */
const DEFAULT_USER_AGENT = "b2ai-agent-backup-core";

export type B2Client = {
  putObject(bucket: string, key: string, body: Uint8Array, contentType: string): Promise<void>;
  getObject(bucket: string, key: string): Promise<Buffer>;
  /** Server-side copy within a bucket (S3 PUT Copy) — no client-side bytes. */
  copyObject(bucket: string, srcKey: string, destKey: string): Promise<void>;
  listObjects(bucket: string, prefix: string): Promise<B2ObjectEntry[]>;
  deleteObject(bucket: string, key: string): Promise<void>;
  headBucket(bucket: string): Promise<void>;
};

export type B2ObjectEntry = {
  key: string;
  size: number;
  lastModified: string;
};

type S3SignParams = {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers: Record<string, string>;
  body: Uint8Array | "";
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  service?: string;
};

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: Uint8Array | ""): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * RFC 3986 percent-encoding for a single path segment. `encodeURIComponent`
 * leaves `!'()*` unescaped, which AWS SigV4 requires encoded.
 */
function encodeSegment(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Encode an absolute object path for both the SigV4 canonical request and the
 * request URL, preserving `/` separators. Without this, a key containing a
 * space (common in agent state) is signed literally but sent percent-encoded by
 * `fetch`, yielding SignatureDoesNotMatch.
 */
export function encodePath(path: string): string {
  return path.split("/").map(encodeSegment).join("/");
}

function getSignatureKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmacSha256(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

function signRequest(params: S3SignParams): Record<string, string> {
  const { method, path, query, headers, body, region, accessKeyId, secretAccessKey } = params;
  const service = params.service ?? "s3";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const signedHeaders = { ...headers };
  signedHeaders["x-amz-date"] = amzDate;
  signedHeaders["x-amz-content-sha256"] = payloadHash;

  const sortedHeaderKeys = Object.keys(signedHeaders).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k.toLowerCase()}:${signedHeaders[k]!.trim()}`)
    .join("\n");
  const signedHeadersList = sortedHeaderKeys.map((k) => k.toLowerCase()).join(";");

  const queryStr = query
    ? Object.keys(query)
        .sort()
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`)
        .join("&")
    : "";

  // `path` is expected to already be RFC-3986 encoded by the caller (encodePath).
  const canonicalRequest = [
    method,
    path,
    queryStr,
    `${canonicalHeaders}\n`,
    signedHeadersList,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(Buffer.from(canonicalRequest, "utf8")),
  ].join("\n");

  const signingKey = getSignatureKey(secretAccessKey, dateStamp, region, service);
  const signature = crypto
    .createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersList}, Signature=${signature}`;

  return {
    ...signedHeaders,
    authorization,
  };
}

export {
  signRequest as _signRequest,
  parseListObjectsResponse as _parseListObjectsResponse,
  encodePath as _encodePath,
};

// ─── Transient-failure handling ───────────────────────────────────────────────
// A scheduled backup daemon must survive blips: bound each request with a timeout
// and retry 429/5xx and network errors with exponential backoff + jitter.

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 4;

function backoffMs(attempt: number): number {
  const base = Math.min(500 * 2 ** (attempt - 1), 8_000);
  return base + Math.floor(Math.random() * 250); // jitter to avoid thundering herd
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function b2Fetch(url: string, init: RequestInit, label: string): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { ...init, signal: ac.signal });
      if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_ATTEMPTS) {
        await delay(backoffMs(attempt));
        continue;
      }
      return resp;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        await delay(backoffMs(attempt));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`b2 ${label}: request failed after ${MAX_ATTEMPTS} attempts: ${String(lastErr)}`);
}

export async function createB2Client(
  keyId: string,
  applicationKey: string,
  region?: string,
  userAgent: string = DEFAULT_USER_AGENT,
): Promise<B2Client> {
  // Authorize with B2 to discover the region if not provided.
  const resolvedRegion = region ?? (await discoverRegion(keyId, applicationKey, userAgent));
  const endpoint = `https://s3.${resolvedRegion}.backblazeb2.com`;
  const host = new URL(endpoint).host;

  const sign = (
    method: string,
    path: string,
    headers: Record<string, string>,
    body: Uint8Array | "" = "",
    query?: Record<string, string>,
  ) =>
    signRequest({
      method,
      path,
      query,
      headers: { ...headers, "user-agent": userAgent },
      body,
      region: resolvedRegion,
      accessKeyId: keyId,
      secretAccessKey: applicationKey,
    });

  return {
    async putObject(bucket, key, body, contentType) {
      const path = encodePath(`/${bucket}/${key}`);
      const headers = sign("PUT", path, { host, "content-type": contentType }, body);
      const resp = await b2Fetch(
        `${endpoint}${path}`,
        { method: "PUT", headers, body: new Uint8Array(body) },
        "putObject",
      );
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`b2 putObject failed (${resp.status}): ${text}`);
      }
    },

    async getObject(bucket, key) {
      const path = encodePath(`/${bucket}/${key}`);
      const headers = sign("GET", path, { host });
      const resp = await b2Fetch(`${endpoint}${path}`, { method: "GET", headers }, "getObject");
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`b2 getObject failed (${resp.status}): ${text}`);
      }
      return Buffer.from(await resp.arrayBuffer());
    },

    async copyObject(bucket, srcKey, destKey) {
      const path = encodePath(`/${bucket}/${destKey}`);
      // x-amz-copy-source is the (encoded) /bucket/key of the source; copies the
      // stored bytes server-side, so an already-encrypted blob stays valid.
      const copySource = encodePath(`/${bucket}/${srcKey}`);
      const headers = sign("PUT", path, { host, "x-amz-copy-source": copySource });
      const resp = await b2Fetch(`${endpoint}${path}`, { method: "PUT", headers }, "copyObject");
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`b2 copyObject failed (${resp.status}): ${text}`);
      }
    },

    async listObjects(bucket, prefix) {
      const all: B2ObjectEntry[] = [];
      let continuationToken: string | undefined;

      do {
        const query: Record<string, string> = {
          "list-type": "2",
          prefix,
          "max-keys": "1000",
        };
        if (continuationToken) {
          query["continuation-token"] = continuationToken;
        }
        const reqPath = encodePath(`/${bucket}`);
        const headers = sign("GET", reqPath, { host }, "", query);
        const qs = Object.entries(query)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&");
        const resp = await b2Fetch(
          `${endpoint}${reqPath}?${qs}`,
          { method: "GET", headers },
          "listObjects",
        );
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          throw new Error(`b2 listObjects failed (${resp.status}): ${text}`);
        }
        const xml = await resp.text();
        const page = parseListObjectsResponse(xml);
        all.push(...page.entries);
        continuationToken = page.nextToken;
      } while (continuationToken);

      return all;
    },

    async deleteObject(bucket, key) {
      const path = encodePath(`/${bucket}/${key}`);
      const headers = sign("DELETE", path, { host });
      const resp = await b2Fetch(`${endpoint}${path}`, { method: "DELETE", headers }, "deleteObject");
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`b2 deleteObject failed (${resp.status}): ${text}`);
      }
    },

    async headBucket(bucket) {
      // List a single key rather than HEAD the bucket: it exercises the exact
      // permission a backup needs (object read on this prefix) and works with
      // single-bucket-scoped keys, which HeadBucket can reject.
      const path = encodePath(`/${bucket}`);
      const query = { "list-type": "2", "max-keys": "1" };
      const headers = sign("GET", path, { host }, "", query);
      const qs = Object.entries(query)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
      const resp = await b2Fetch(`${endpoint}${path}?${qs}`, { method: "GET", headers }, "headBucket");
      if (!resp.ok) {
        const hint =
          resp.status === 403
            ? " — check the application key has access to this bucket"
            : resp.status === 404
              ? " — bucket not found (wrong name or region?)"
              : "";
        throw new Error(`b2 bucket access check failed (${resp.status})${hint}`);
      }
    },
  };
}

async function discoverRegion(
  keyId: string,
  applicationKey: string,
  userAgent: string,
): Promise<string> {
  const auth = Buffer.from(`${keyId}:${applicationKey}`).toString("base64");
  const resp = await b2Fetch(
    "https://api.backblazeb2.com/b2api/v3/b2_authorize_account",
    { headers: { authorization: `Basic ${auth}`, "user-agent": userAgent } },
    "authorize",
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`b2 authorize failed (${resp.status}): ${text}`);
  }
  const data = (await resp.json()) as {
    s3ApiUrl?: string;
    apiInfo?: { storageApi?: { s3ApiUrl?: string } };
  };
  // v3 nests s3ApiUrl under apiInfo.storageApi; v2 has it at top level
  const s3ApiUrl = data.apiInfo?.storageApi?.s3ApiUrl ?? data.s3ApiUrl;
  const match = s3ApiUrl?.match(/s3\.([^.]+)\.backblazeb2\.com/);
  if (!match?.[1]) {
    throw new Error("b2: could not determine region from authorize response");
  }
  return match[1];
}

type ListObjectsPage = {
  entries: B2ObjectEntry[];
  nextToken: string | undefined;
};

/** Decode the five predefined XML entities (order matters: &amp; last). */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseListObjectsResponse(xml: string): ListObjectsPage {
  const entries: B2ObjectEntry[] = [];
  const contentRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null;
  while ((match = contentRegex.exec(xml)) !== null) {
    const block = match[1]!;
    const key = decodeXmlEntities(block.match(/<Key>(.*?)<\/Key>/)?.[1] ?? "");
    const size = Number(block.match(/<Size>(.*?)<\/Size>/)?.[1] ?? "0");
    const lastModified = block.match(/<LastModified>(.*?)<\/LastModified>/)?.[1] ?? "";
    entries.push({ key, size, lastModified });
  }

  const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const nextToken = isTruncated
    ? decodeXmlEntities(xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/)?.[1] ?? "")
    : undefined;

  return { entries, nextToken };
}
