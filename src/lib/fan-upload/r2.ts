// Cloudflare R2（S3 互換 API）クライアント（依存ライブラリなし）。
// 認証: R2 の S3 API トークン（AWS Signature V4）。バケットは非公開のまま使い、公開 URL は一切発行しない。
// ブラウザへ渡すのは「パートごとの署名付き PUT URL」だけ（期限つき・1 パート 1 URL）。

import { createHash, createHmac } from "node:crypto";

const REGION = "auto";
const SERVICE = "s3";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export const R2_ROOT_PREFIX = "fan-moments/";

export type R2Config = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export const loadR2Config = (env: NodeJS.ProcessEnv = process.env): R2Config | null => {
  const accountId = env.R2_ACCOUNT_ID;
  const bucket = env.R2_BUCKET;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { accountId, bucket, accessKeyId, secretAccessKey };
};

export class R2Error extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type R2Part = { number: number; size: number; etag: string };

// ── AWS Signature V4 ───────────────────────────────────

const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

// RFC 3986 の予約外文字以外をすべてパーセントエンコードする
export const rfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export const encodeKey = (key: string): string => key.split("/").map(rfc3986).join("/");

export const amzDateOf = (ms: number): string => new Date(ms).toISOString().replace(/[:-]|\.\d{3}/g, "");

export type SignInput = {
  method: string;
  host: string;
  path: string; // エンコード済みのパス（先頭 "/"）
  query: Record<string, string>;
  headers: Record<string, string>; // host 以外の署名対象ヘッダ
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  amzDate: string;
  presignExpires?: number; // 指定すると署名付き URL 用（クエリ認証）
};

export const signV4 = (input: SignInput) => {
  const date8 = input.amzDate.slice(0, 8);
  const scope = `${date8}/${input.region}/${input.service}/aws4_request`;
  const credential = `${input.accessKeyId}/${scope}`;

  const headers: Record<string, string> = { host: input.host };
  for (const [name, value] of Object.entries(input.headers)) {
    headers[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  }
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");

  const query: Record<string, string> = { ...input.query };
  if (input.presignExpires !== undefined) {
    query["X-Amz-Algorithm"] = "AWS4-HMAC-SHA256";
    query["X-Amz-Credential"] = credential;
    query["X-Amz-Date"] = input.amzDate;
    query["X-Amz-Expires"] = String(input.presignExpires);
    query["X-Amz-SignedHeaders"] = signedHeaders;
  }
  const canonicalQuery = Object.entries(query)
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [
    input.method,
    input.path,
    canonicalQuery,
    names.map((n) => `${n}:${headers[n]}\n`).join(""),
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${input.secretAccessKey}`, date8);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  return { signature, signedHeaders, credential, canonicalQuery };
};

// ── XML（R2 が返す定型レスポンスだけを読む）──────────────

const tagText = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1] : null;
};

const blocks = (xml: string, name: string): string[] =>
  [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]);

type FetchLike = typeof fetch;

export class R2Client {
  readonly bucket: string;
  private usageCache: { bytes: number; at: number } | null = null;

  private readonly config: R2Config;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(config: R2Config, fetchImpl: FetchLike = fetch, now: () => number = Date.now) {
    this.config = config;
    this.bucket = config.bucket;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  private get host() {
    return `${this.config.accountId}.r2.cloudflarestorage.com`;
  }

  private bucketPath() {
    return `/${rfc3986(this.config.bucket)}`;
  }

  private objectPath(key: string) {
    return `${this.bucketPath()}/${encodeKey(key)}`;
  }

  private async send(
    method: string,
    path: string,
    query: Record<string, string> = {},
    opts: { body?: string | Uint8Array; headers?: Record<string, string>; allow404?: boolean } = {}
  ): Promise<Response> {
    const payloadHash = opts.body !== undefined ? sha256Hex(opts.body) : EMPTY_SHA256;
    const amzDate = amzDateOf(this.now());
    const signed = signV4({
      method,
      host: this.host,
      path,
      query,
      headers: { "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate },
      payloadHash,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      region: REGION,
      service: SERVICE,
      amzDate,
    });
    const url = `https://${this.host}${path}${signed.canonicalQuery ? `?${signed.canonicalQuery}` : ""}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `AWS4-HMAC-SHA256 Credential=${signed.credential}, SignedHeaders=${signed.signedHeaders}, Signature=${signed.signature}`,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        ...(opts.headers ?? {}),
      },
      body: opts.body as BodyInit | undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok || (opts.allow404 && res.status === 404)) return res;
    const text = await res.text().catch(() => "");
    throw new R2Error(`r2 ${method} failed (${res.status})`, res.status, tagText(text, "Code") ?? "");
  }

  // ブラウザが 1 パートを直接 PUT するための署名付き URL（期限つき）。認証情報そのものは含まれない
  presignUploadPart(key: string, uploadId: string, partNumber: number, expiresSec: number): string {
    const amzDate = amzDateOf(this.now());
    const signed = signV4({
      method: "PUT",
      host: this.host,
      path: this.objectPath(key),
      query: { partNumber: String(partNumber), uploadId },
      headers: {},
      payloadHash: UNSIGNED_PAYLOAD,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      region: REGION,
      service: SERVICE,
      amzDate,
      presignExpires: expiresSec,
    });
    return `https://${this.host}${this.objectPath(key)}?${signed.canonicalQuery}&X-Amz-Signature=${signed.signature}`;
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    const res = await this.send("POST", this.objectPath(key), { uploads: "" }, {
      headers: { "Content-Type": contentType },
    });
    const uploadId = tagText(await res.text(), "UploadId");
    if (!uploadId) throw new R2Error("r2 createMultipart: no UploadId", 502);
    return uploadId;
  }

  async listParts(key: string, uploadId: string): Promise<R2Part[]> {
    const out: R2Part[] = [];
    let marker = "";
    for (;;) {
      const query: Record<string, string> = { uploadId, "max-parts": "1000" };
      if (marker) query["part-number-marker"] = marker;
      const xml = await (await this.send("GET", this.objectPath(key), query)).text();
      for (const block of blocks(xml, "Part")) {
        out.push({
          number: Number(tagText(block, "PartNumber")),
          size: Number(tagText(block, "Size")),
          etag: tagText(block, "ETag") ?? "",
        });
      }
      if (tagText(xml, "IsTruncated") !== "true") break;
      marker = tagText(xml, "NextPartNumberMarker") ?? "";
      if (!marker) break;
    }
    return out.sort((a, b) => a.number - b.number);
  }

  async completeMultipart(key: string, uploadId: string, parts: readonly R2Part[]): Promise<void> {
    const body =
      "<CompleteMultipartUpload>" +
      parts.map((p) => `<Part><PartNumber>${p.number}</PartNumber><ETag>${p.etag}</ETag></Part>`).join("") +
      "</CompleteMultipartUpload>";
    const res = await this.send("POST", this.objectPath(key), { uploadId }, {
      body,
      headers: { "Content-Type": "application/xml" },
    });
    // S3 互換 API は 200 のまま本文にエラーを返すことがある
    const text = await res.text();
    if (text.includes("<Error>")) {
      throw new R2Error("r2 completeMultipart failed", 502, tagText(text, "Code") ?? "");
    }
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.send("DELETE", this.objectPath(key), { uploadId }, { allow404: true });
  }

  async putObject(key: string, body: string | Uint8Array, contentType: string): Promise<void> {
    await this.send("PUT", this.objectPath(key), {}, { body, headers: { "Content-Type": contentType } });
  }

  async getText(key: string): Promise<string | null> {
    const res = await this.send("GET", this.objectPath(key), {}, { allow404: true });
    return res.status === 404 ? null : res.text();
  }

  // 本文と ETag を一緒に取得する（条件付き書き込みの前提）
  async getObject(key: string): Promise<{ text: string; etag: string } | null> {
    const res = await this.send("GET", this.objectPath(key), {}, { allow404: true });
    if (res.status === 404) return null;
    return { text: await res.text(), etag: res.headers.get("etag") ?? "" };
  }

  // 条件付き書き込み。ifMatch=ETag なら「その版のときだけ」、ifNoneMatch=true なら「存在しないときだけ」書く。
  // 条件が合わなければ R2Error(status 412)。同時実行の排他に使う
  async putObjectIf(
    key: string,
    body: string | Uint8Array,
    contentType: string,
    cond: { ifMatch?: string; ifNoneMatch?: boolean }
  ): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": contentType };
    if (cond.ifMatch) headers["If-Match"] = cond.ifMatch;
    if (cond.ifNoneMatch) headers["If-None-Match"] = "*";
    const res = await this.send("PUT", this.objectPath(key), {}, { body, headers });
    return res.headers.get("etag") ?? "";
  }

  // 任意範囲（両端を含む）の読み出し。Drive への転送でチャンクごとに使う
  async readRange(key: string, start: number, end: number): Promise<Uint8Array> {
    const res = await this.send("GET", this.objectPath(key), {}, { headers: { Range: `bytes=${start}-${end}` } });
    return new Uint8Array(await res.arrayBuffer());
  }

  // prefix 配下のキー一覧
  async listKeys(prefix: string): Promise<{ key: string; size: number }[]> {
    const out: { key: string; size: number }[] = [];
    let token = "";
    for (;;) {
      const query: Record<string, string> = { "list-type": "2", prefix };
      if (token) query["continuation-token"] = token;
      const xml = await (await this.send("GET", this.bucketPath(), query)).text();
      for (const block of blocks(xml, "Contents")) {
        out.push({ key: (tagText(block, "Key") ?? "").replace(/&amp;/g, "&"), size: Number(tagText(block, "Size") ?? 0) });
      }
      if (tagText(xml, "IsTruncated") !== "true") break;
      token = tagText(xml, "NextContinuationToken") ?? "";
      if (!token) break;
    }
    return out;
  }

  async head(key: string): Promise<{ size: number } | null> {
    const res = await this.send("HEAD", this.objectPath(key), {}, { allow404: true });
    if (res.status === 404) return null;
    return { size: Number(res.headers.get("content-length") ?? 0) };
  }

  async readHead(key: string, length = 32): Promise<Uint8Array> {
    const res = await this.send("GET", this.objectPath(key), {}, { headers: { Range: `bytes=0-${length - 1}` } });
    return new Uint8Array(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await this.send("DELETE", this.objectPath(key), {}, { allow404: true });
  }

  // R2_ROOT_PREFIX 配下の保存容量の合計（5 分キャッシュ）。R2 には容量照会 API が無いため一覧から数える
  async appUsageBytes(): Promise<number> {
    if (this.usageCache && this.usageCache.at > this.now() - 300_000) return this.usageCache.bytes;
    let bytes = 0;
    let token = "";
    for (;;) {
      const query: Record<string, string> = { "list-type": "2", prefix: R2_ROOT_PREFIX };
      if (token) query["continuation-token"] = token;
      const xml = await (await this.send("GET", this.bucketPath(), query)).text();
      for (const block of blocks(xml, "Contents")) bytes += Number(tagText(block, "Size") ?? 0);
      if (tagText(xml, "IsTruncated") !== "true") break;
      token = tagText(xml, "NextContinuationToken") ?? "";
      if (!token) break;
    }
    this.usageCache = { bytes, at: this.now() };
    return bytes;
  }

  // 新しい投稿を受け付けられるか（アプリ上限。R2 自体には容量の上限が無いため、安全弁として使う）
  async hasCapacity(incomingBytes: number, opts: { appCapBytes: number }): Promise<boolean> {
    return (await this.appUsageBytes()) + incomingBytes <= opts.appCapBytes;
  }
}

let shared: R2Client | null = null;

export const getR2Client = (): R2Client | null => {
  const config = loadR2Config();
  if (!config) return null;
  shared ??= new R2Client(config);
  return shared;
};
