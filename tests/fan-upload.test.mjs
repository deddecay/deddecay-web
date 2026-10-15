import test from "node:test";
import assert from "node:assert/strict";

import {
  checkDeclaredFile,
  checkDeclaredFiles,
  matchesMagic,
  sanitizeFileName,
  sanitizeSegment,
  normalizeTextFields,
  GIB,
  PART_SIZE,
  isLivePostable,
  postableLives,
} from "../src/lib/fan-upload/policy.ts";
import { issuePostToken, verifyPostToken } from "../src/lib/fan-upload/token.ts";
import { consume, _resetMemoryForTest } from "../src/lib/fan-upload/ratelimit.ts";
// Drive 連携は R2 への置換後は使っていない（コードは残している）。クライアント単体のテストだけ維持する
import { DriveClient } from "../src/lib/fan-upload/drive.ts";
import { R2Client, R2Error, signV4 } from "../src/lib/fan-upload/r2.ts";
import { handleInit, handleComplete, readAllowedOrigins } from "../src/lib/fan-upload/service.ts";
import { sendNotification, fanMomentsFrom } from "../src/lib/mail.ts";
import { uploadFile, UploadFatalError } from "../src/lib/fan-upload/client-upload.ts";
import { fanMomentsEnabled, fanMomentsPublic } from "../src/lib/fan-upload/flags.ts";

const ORIGIN = "https://deddecay.tokyo";
const SECRET = "x".repeat(40);

// ── policy ─────────────────────────────────────────────

test("許可形式・拡張子とMIMEの整合", () => {
  assert.equal(checkDeclaredFile({ name: "a.mp4", size: 10, type: "video/mp4" }).ok, true);
  assert.equal(checkDeclaredFile({ name: "a.MOV", size: 10, type: "video/quicktime" }).ok, true);
  assert.equal(checkDeclaredFile({ name: "a.heic", size: 10, type: "" }).ok, true); // iOS は type が空のことがある
  assert.equal(checkDeclaredFile({ name: "a.exe", size: 10, type: "application/x-msdownload" }).ok, false);
  assert.equal(checkDeclaredFile({ name: "a.svg", size: 10, type: "image/svg+xml" }).ok, false);
  assert.equal(checkDeclaredFile({ name: "a.html", size: 10, type: "text/html" }).ok, false);
  assert.equal(checkDeclaredFile({ name: "a.mp4", size: 10, type: "image/png" }).ok, false);
  assert.equal(checkDeclaredFile({ name: "noext", size: 10, type: "" }).ok, false);
  assert.equal(checkDeclaredFile({ name: "a.mp4", size: 0, type: "video/mp4" }).ok, false);
  assert.equal(checkDeclaredFile({ name: "a.mp4", size: 1.5, type: "video/mp4" }).ok, false);
});

test("サイズ・件数の上限", () => {
  assert.equal(checkDeclaredFile({ name: "a.mp4", size: 4 * GIB, type: "video/mp4" }).ok, true);
  assert.equal(checkDeclaredFile({ name: "a.mp4", size: 4 * GIB + 1, type: "video/mp4" }).ok, false);
  const many = Array.from({ length: 11 }, (_, i) => ({ name: `${i}.jpg`, size: 1, type: "image/jpeg" }));
  assert.equal(checkDeclaredFiles(many).ok, false);
  const big = [
    { name: "a.mp4", size: 4 * GIB, type: "video/mp4" },
    { name: "b.mp4", size: 4 * GIB, type: "video/mp4" },
    { name: "c.mp4", size: 1, type: "video/mp4" },
  ];
  assert.equal(checkDeclaredFiles(big).ok, false); // 合計 8GB 超
  assert.equal(checkDeclaredFiles([]).ok, false);
  const ok = checkDeclaredFiles([{ name: "a.mp4", size: 5, type: "video/mp4" }]);
  assert.deepEqual(ok, { ok: true, totalBytes: 5 });
});

test("上限はサーバーが渡した値で判定される（選択時の警告・投稿ボタン制御の根拠）", () => {
  const limits = { maxFiles: 2, maxFileBytes: 1 * GIB, maxPostBytes: 1.5 * GIB };
  const f = (name, size) => ({ name, size, type: "" });
  // 範囲内
  assert.equal(checkDeclaredFiles([f("a.jpg", GIB / 2), f("b.mp4", GIB / 2)], limits).ok, true);
  // ファイル数超過 → 削除して2件に戻せば通る
  assert.equal(checkDeclaredFiles([f("a.jpg", 1), f("b.jpg", 1), f("c.jpg", 1)], limits).ok, false);
  assert.equal(checkDeclaredFiles([f("a.jpg", 1), f("b.jpg", 1)], limits).ok, true);
  // 1ファイル超過
  assert.equal(checkDeclaredFile(f("big.mp4", GIB + 1), limits).ok, false);
  assert.equal(checkDeclaredFile(f("big.mp4", GIB), limits).ok, true);
  // 合計超過（個々は範囲内）→ 1件削除して戻せば通る
  assert.equal(checkDeclaredFiles([f("a.mp4", GIB), f("b.mp4", GIB)], limits).ok, false);
  assert.equal(checkDeclaredFiles([f("a.mp4", GIB)], limits).ok, true);
});

test("公開フラグ: 未設定なら無効・非公開。ENABLED なしでは PUBLIC も効かない", () => {
  assert.equal(fanMomentsEnabled({}), false);
  assert.equal(fanMomentsPublic({}), false);
  assert.equal(fanMomentsEnabled({ FAN_MOMENTS_ENABLED: "1" }), true);
  assert.equal(fanMomentsPublic({ FAN_MOMENTS_ENABLED: "1" }), false); // 内部有効でも導線は出さない
  assert.equal(fanMomentsPublic({ FAN_MOMENTS_ENABLED: "1", FAN_MOMENTS_PUBLIC: "1" }), true);
  assert.equal(fanMomentsPublic({ FAN_MOMENTS_PUBLIC: "1" }), false);
  // "1" 以外（true / yes / 空文字 など）は有効にしない
  assert.equal(fanMomentsEnabled({ FAN_MOMENTS_ENABLED: "true" }), false);
  assert.equal(fanMomentsEnabled({ FAN_MOMENTS_ENABLED: "" }), false);
});

test("先頭バイト検証 (magic)", () => {
  const mp4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const exe = new TextEncoder().encode("MZ\x90\x00\x03");
  const html = new TextEncoder().encode("<html><script>");
  assert.equal(matchesMagic("mp4", mp4), true);
  assert.equal(matchesMagic("mov", mp4), true);
  assert.equal(matchesMagic("heic", mp4), true);
  assert.equal(matchesMagic("jpg", jpg), true);
  assert.equal(matchesMagic("png", png), true);
  assert.equal(matchesMagic("jpg", exe), false);
  assert.equal(matchesMagic("mp4", exe), false);
  assert.equal(matchesMagic("png", html), false);
  assert.equal(matchesMagic("mp4", jpg), false);
  assert.equal(matchesMagic("exe", exe), false);
  const wav = new TextEncoder().encode("RIFF\x00\x00\x00\x00WAVEfmt ");
  assert.equal(matchesMagic("wav", wav), true);
  assert.equal(matchesMagic("webp", wav), false);
});

test("ファイル名・フォルダ名のサニタイズ", () => {
  assert.equal(sanitizeFileName("../../etc/passwd.mp4"), "etc_passwd.mp4");
  assert.equal(sanitizeFileName("LIVE 動画 #1?.MOV"), "LIVE 動画 _1.mov"); // 末尾の記号は除去される
  assert.equal(sanitizeSegment("a/b\\c"), "a_b_c");
  assert.equal(sanitizeSegment("   "), "untitled");
  assert.ok(sanitizeSegment("あ".repeat(200), 80).length <= 80);
});

test("テキスト入力の検証", () => {
  // メッセージは任意。空でもよい
  assert.deepEqual(normalizeTextFields({}), { ok: true, value: { message: "" } });
  assert.deepEqual(normalizeTextFields({ message: "  hi  " }), { ok: true, value: { message: "hi" } });
  assert.equal(normalizeTextFields({ message: "x".repeat(1001) }).ok, false);
  // 名前・メール等が送られてきても読み捨てる（値に含めない）
  assert.deepEqual(normalizeTextFields({ name: "a", email: "a@b.co", message: "hi" }), {
    ok: true,
    value: { message: "hi" },
  });
});

// ── token ──────────────────────────────────────────────

test("投稿トークン: 署名・改ざん・期限", () => {
  const now = 1_000_000;
  const token = issuePostToken(SECRET, { pid: "abcdefghijkl", n: 2, total: 100 }, now);
  assert.equal(verifyPostToken(SECRET, token, now + 1000)?.n, 2);
  assert.equal(verifyPostToken("y".repeat(40), token, now), null); // 別の鍵
  const [body, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ pid: "abcdefghijkl", n: 99, total: 100, exp: now + 99999 })).toString("base64url");
  assert.equal(verifyPostToken(SECRET, `${forged}.${sig}`, now), null);
  assert.equal(verifyPostToken(SECRET, `${body}.AAAA`, now), null);
  assert.equal(verifyPostToken(SECRET, token, now + 25 * 3600 * 1000), null); // 期限切れ
  assert.equal(verifyPostToken(SECRET, undefined, now), null);
  assert.equal(verifyPostToken(SECRET, "a.b.c", now), null);
});

test("投稿トークン: 保存先プレフィックス(k)は決まった形式のものだけ受理する", () => {
  const now = 1_000_000;
  const issue = (k) => issuePostToken(SECRET, { pid: "abcdefghijkl", n: 1, total: 1, k }, now);
  assert.equal(verifyPostToken(SECRET, issue("fan-moments/live/L-1/abcdefghijkl"), now)?.k, "fan-moments/live/L-1/abcdefghijkl");
  assert.equal(verifyPostToken(SECRET, issue("fan-moments/other/abcdefghijkl"), now)?.k, "fan-moments/other/abcdefghijkl");
  for (const bad of [
    "other/abcdefghijkl",
    "fan-moments/../x/abcdefghijkl",
    "fan-moments/live//abcdefghijkl",
    "fan-moments/live/L/a/b",
  ]) {
    assert.equal(verifyPostToken(SECRET, issue(bad), now), null, bad);
  }
});

// ── rate limit ─────────────────────────────────────────

test("rate limit: 上限超過と加算量", async () => {
  _resetMemoryForTest();
  delete process.env.UPSTASH_REDIS_REST_URL;
  assert.equal((await consume("k", 2, 60)).allowed, true);
  assert.equal((await consume("k", 2, 60)).allowed, true);
  assert.equal((await consume("k", 2, 60)).allowed, false);
  assert.equal((await consume("bytes", 10, 60, 6)).allowed, true);
  assert.equal((await consume("bytes", 10, 60, 6)).allowed, false);
});

// ── DriveClient（fetch モック）──────────────────────────
// R2 への置換後は保存先として使っていない。コードを残している間はクライアント単体の動作だけ確認する

const jsonRes = (data, init = {}) =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" }, ...init });

const makeDrive = (handler) => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.startsWith("https://oauth2.googleapis.com/token")) {
      return jsonRes({ access_token: "tok", expires_in: 3600 });
    }
    return handler(u, init, calls);
  };
  const drive = new DriveClient({ clientId: "id", clientSecret: "sec", refreshToken: "rt" }, fetchImpl);
  return { drive, calls };
};

test("Drive: ルート/フォルダ作成は非公開・権限APIを呼ばない", async () => {
  const created = [];
  const { drive, calls } = makeDrive(async (url, init) => {
    if (url.includes("/drive/v3/files?") && (!init.method || init.method === "GET")) return jsonRes({ files: [] });
    if (url.includes("/drive/v3/files?fields=id") && init.method === "POST") {
      const body = JSON.parse(init.body);
      created.push(body);
      return jsonRes({ id: `id-${created.length}` });
    }
    throw new Error(`unexpected ${url}`);
  });
  const id = await drive.ensureFolderPath(["LIVE", "2025", "O'Brien"]);
  assert.equal(id, "id-4");
  assert.equal(created[0].appProperties.role, "fanroot");
  assert.equal(created[0].parents, undefined);
  assert.deepEqual(created[1].parents, ["id-1"]);
  assert.ok(calls.some((c) => decodeURIComponent(c.url).includes("name='O\\'Brien'")));
  assert.ok(calls.every((c) => !c.url.includes("/permissions")));
  // キャッシュされ 2 回目は API を呼ばない
  const before = calls.length;
  await drive.ensureFolderPath(["LIVE", "2025", "O'Brien"]);
  assert.equal(calls.length, before);
});

test("Drive: resumable セッションは Origin とサイズ固定付きで作成される", async () => {
  const { drive, calls } = makeDrive(async () =>
    new Response(null, { status: 200, headers: { location: "https://www.googleapis.com/upload/drive/v3/files?upload_id=abc" } })
  );
  const url = await drive.createResumableSession({
    name: "n.mp4",
    parentId: "p",
    size: 123,
    mimeType: "video/mp4",
    description: "d",
    appProperties: { postId: "x" },
    origin: ORIGIN,
  });
  assert.ok(url.includes("upload_id=abc"));
  const call = calls.find((c) => c.url.includes("uploadType=resumable"));
  assert.equal(call.init.headers.Origin, ORIGIN);
  assert.equal(call.init.headers["X-Upload-Content-Length"], "123");
  assert.equal(call.init.headers.Authorization, "Bearer tok");
});

test("Drive: Location が Google 以外なら拒否", async () => {
  const { drive } = makeDrive(async () => new Response(null, { status: 200, headers: { location: "https://evil.example/x" } }));
  await assert.rejects(
    drive.createResumableSession({ name: "n", parentId: "p", size: 1, mimeType: "video/mp4", description: "", appProperties: {}, origin: ORIGIN })
  );
});

test("Drive: 容量判定 (アプリ上限 / アカウント空き)", async () => {
  const { drive } = makeDrive(async (url) => {
    if (url.includes("/about")) return jsonRes({ storageQuota: { limit: String(15 * GIB), usage: String(14 * GIB) } });
    return jsonRes({ files: [{ size: String(2 * GIB) }] });
  });
  const opts = { appCapBytes: 50 * GIB, reserveBytes: 0.5 * GIB };
  assert.equal(await drive.hasCapacity(0.4 * GIB, opts), true);
  assert.equal(await drive.hasCapacity(2 * GIB, opts), false); // アカウント空き不足
  assert.equal(await drive.hasCapacity(1, { appCapBytes: 2 * GIB, reserveBytes: 0 }), false); // アプリ上限
});

// ── R2Client（SigV4 / fetch モック）─────────────────────

test("SigV4: AWS 公式ドキュメントの署名例（ヘッダ認証）と一致する", () => {
  const out = signV4({
    method: "GET",
    host: "examplebucket.s3.amazonaws.com",
    path: "/test.txt",
    query: {},
    headers: {
      range: "bytes=0-9",
      "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "x-amz-date": "20130524T000000Z",
    },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "s3",
    amzDate: "20130524T000000Z",
  });
  assert.equal(out.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assert.equal(out.signedHeaders, "host;range;x-amz-content-sha256;x-amz-date");
});

test("SigV4: AWS 公式ドキュメントの署名例（署名付き URL）と一致する", () => {
  const out = signV4({
    method: "GET",
    host: "examplebucket.s3.amazonaws.com",
    path: "/test.txt",
    query: {},
    headers: {},
    payloadHash: "UNSIGNED-PAYLOAD",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "s3",
    amzDate: "20130524T000000Z",
    presignExpires: 86400,
  });
  assert.equal(out.signature, "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
});

const R2_CONFIG = { accountId: "acct", bucket: "bkt", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "SECRETKEYEXAMPLE" };
const NOW = Date.parse("2026-10-10T06:00:00Z");

const makeR2 = (handler) => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls);
  };
  return { r2: new R2Client(R2_CONFIG, fetchImpl, () => NOW), calls };
};

const xml = (body, init = {}) => new Response(body, { status: 200, headers: { "content-type": "application/xml" }, ...init });

test("R2: 署名付きパート URL（認証情報を含まず、期限・パス・日本語キーが正しい）", () => {
  const { r2 } = makeR2(async () => xml(""));
  const url = r2.presignUploadPart("fan-moments/live/L1/abcdefghijkl/20261010-150000_1_ライブ 動画.mov", "UP-1", 2, 86400);
  assert.ok(url.startsWith("https://acct.r2.cloudflarestorage.com/bkt/fan-moments/live/L1/abcdefghijkl/"));
  assert.ok(url.includes("partNumber=2"));
  assert.ok(url.includes("uploadId=UP-1"));
  assert.ok(url.includes("X-Amz-Expires=86400"));
  assert.match(url, /X-Amz-Signature=[0-9a-f]{64}$/);
  assert.ok(url.includes("%E3%83%A9%E3%82%A4%E3%83%96%20%E5%8B%95%E7%94%BB.mov")); // 日本語・空白はエンコード
  assert.ok(!url.includes("SECRETKEYEXAMPLE"));
  assert.ok(url.includes("X-Amz-Credential=AKIDEXAMPLE%2F20261010%2Fauto%2Fs3%2Faws4_request")); // アクセスキー ID は URL に載る（秘密ではない）
});

test("R2: リクエストは署名付きで、秘密鍵そのものは送られない", async () => {
  const { r2, calls } = makeR2(async () => xml("<InitiateMultipartUploadResult><UploadId>UP-9</UploadId></InitiateMultipartUploadResult>"));
  const id = await r2.createMultipart("fan-moments/other/abcdefghijkl/a.mp4", "video/mp4");
  assert.equal(id, "UP-9");
  const call = calls[0];
  assert.equal(call.init.method, "POST");
  assert.equal(call.url, "https://acct.r2.cloudflarestorage.com/bkt/fan-moments/other/abcdefghijkl/a.mp4?uploads=");
  assert.match(
    call.init.headers.Authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261010\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/
  );
  assert.equal(call.init.headers["Content-Type"], "video/mp4");
  assert.ok(!JSON.stringify(call).includes("SECRETKEYEXAMPLE"));
});

test("R2: listParts はページングして番号順に返す", async () => {
  const page1 =
    "<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>2</NextPartNumberMarker>" +
    "<Part><PartNumber>2</PartNumber><ETag>&quot;b&quot;</ETag><Size>5</Size></Part>" +
    "<Part><PartNumber>1</PartNumber><ETag>&quot;a&quot;</ETag><Size>16</Size></Part></ListPartsResult>";
  const page2 =
    "<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>3</PartNumber><ETag>&quot;c&quot;</ETag><Size>7</Size></Part></ListPartsResult>";
  const { r2, calls } = makeR2(async (url) => xml(url.includes("part-number-marker=2") ? page2 : page1));
  const parts = await r2.listParts("k", "UP");
  assert.deepEqual(
    parts.map((p) => [p.number, p.size, p.etag]),
    [
      [1, 16, "&quot;a&quot;"],
      [2, 5, "&quot;b&quot;"],
      [3, 7, "&quot;c&quot;"],
    ]
  );
  assert.equal(calls.length, 2);
});

test("R2: completeMultipart は本文にパート一覧を送り、200 でも本文のエラーは失敗扱い", async () => {
  const parts = [
    { number: 1, size: 16, etag: "&quot;a&quot;" },
    { number: 2, size: 5, etag: "&quot;b&quot;" },
  ];
  const ok = makeR2(async () => xml("<CompleteMultipartUploadResult><Key>k</Key></CompleteMultipartUploadResult>"));
  await ok.r2.completeMultipart("k", "UP", parts);
  assert.equal(
    ok.calls[0].init.body,
    "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;a&quot;</ETag></Part><Part><PartNumber>2</PartNumber><ETag>&quot;b&quot;</ETag></Part></CompleteMultipartUpload>"
  );
  const bad = makeR2(async () => xml("<Error><Code>InvalidPart</Code></Error>"));
  await assert.rejects(bad.r2.completeMultipart("k", "UP", parts), (err) => err.code === "InvalidPart");
});

test("R2: 404 の扱い（head / getText / delete は許容、listParts はエラーコードを返す）", async () => {
  const notFound = makeR2(async () => new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }));
  assert.equal(await notFound.r2.head("k"), null);
  assert.equal(await notFound.r2.getText("k"), null);
  await notFound.r2.delete("k");
  const noUpload = makeR2(async () => new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: 404 }));
  await assert.rejects(
    noUpload.r2.listParts("k", "UP"),
    (err) => err instanceof R2Error && err.status === 404 && err.code === "NoSuchUpload"
  );
  const found = makeR2(async () => new Response(null, { status: 200, headers: { "content-length": "1234" } }));
  assert.deepEqual(await found.r2.head("k"), { size: 1234 });
});

test("R2: 使用量は一覧から合算しキャッシュされる / 受付上限の判定", async () => {
  const { r2, calls } = makeR2(async () =>
    xml(
      "<ListBucketResult><IsTruncated>false</IsTruncated>" +
        `<Contents><Key>a</Key><Size>${2 * GIB}</Size></Contents><Contents><Key>b</Key><Size>${GIB}</Size></Contents></ListBucketResult>`
    )
  );
  assert.equal(await r2.appUsageBytes(), 3 * GIB);
  assert.equal(await r2.appUsageBytes(), 3 * GIB);
  assert.equal(calls.length, 1); // 2 回目はキャッシュ
  assert.ok(calls[0].url.includes("list-type=2") && calls[0].url.includes("prefix=fan-moments%2F"));
  assert.equal(await r2.hasCapacity(GIB, { appCapBytes: 4 * GIB }), true);
  assert.equal(await r2.hasCapacity(GIB + 1, { appCapBytes: 4 * GIB }), false);
});

// ── service（init / complete）───────────────────────────

const MP4_HEAD = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]);

// R2 のインメモリ代役。マルチパートの状態と保存済みオブジェクトを持つ
const makeStore = () => {
  const objects = new Map(); // key -> string | { size, head }
  const uploads = new Map(); // uploadId -> { key, mime, parts: Map(number -> size) }
  const state = { created: [], aborted: [], completed: [], deleted: [], heads: {}, seq: 0 };
  const store = {
    bucket: "test-bucket",
    hasCapacity: async () => true,
    appUsageBytes: async () => 3 * GIB,
    createMultipart: async (key, mime) => {
      const id = `up${++state.seq}`;
      uploads.set(id, { key, mime, parts: new Map() });
      state.created.push({ key, mime, id });
      return id;
    },
    presignUploadPart: (key, uploadId, n) =>
      `https://acct.r2.cloudflarestorage.com/test-bucket/${key}?partNumber=${n}&uploadId=${uploadId}&X-Amz-Signature=sig`,
    abortMultipart: async (key, id) => {
      uploads.delete(id);
      state.aborted.push(key);
    },
    putObject: async (key, body) => {
      objects.set(key, body);
    },
    getText: async (key) => (typeof objects.get(key) === "string" ? objects.get(key) : null),
    listParts: async (_key, id) => {
      const u = uploads.get(id);
      if (!u) throw new R2Error("no upload", 404, "NoSuchUpload");
      return [...u.parts].map(([number, size]) => ({ number, size, etag: `e${number}` })).sort((a, b) => a.number - b.number);
    },
    completeMultipart: async (key, id, parts) => {
      objects.set(key, { size: parts.reduce((s, p) => s + p.size, 0), head: state.heads[key] ?? MP4_HEAD });
      uploads.delete(id);
      state.completed.push(key);
    },
    head: async (key) => {
      const o = objects.get(key);
      return o && typeof o !== "string" ? { size: o.size } : null;
    },
    readHead: async (key) => objects.get(key).head,
    delete: async (key) => {
      objects.delete(key);
      state.deleted.push(key);
    },
  };
  // ブラウザが署名付き URL へパートを PUT した状態を再現する（sizesByFile[i] = 各パートのサイズ）
  const putParts = (initBody, sizesByFile) => {
    initBody.uploads.forEach((upload, i) => {
      upload.parts.forEach((url, p) => {
        const u = new URL(url);
        uploads.get(u.searchParams.get("uploadId")).parts.set(Number(u.searchParams.get("partNumber")), sizesByFile[i][p]);
      });
    });
  };
  const manifestOf = (prefix) => JSON.parse(objects.get(`${prefix}/manifest.json`));
  return { store, state, objects, putParts, manifestOf };
};

const makeDeps = (over = {}) => {
  const s = makeStore();
  const state = { mails: [], ...s.state };
  const deps = {
    store: s.store,
    verifyTurnstile: async (t) => t === "good",
    consume: async () => ({ allowed: true }),
    // 開催日時は「いま」(2026-10-10) の 20 日前 → 受付期間内
    getLive: async (id) =>
      id === "live-1" ? { id, title: "渋谷 WWW X", dateLabel: "2025.04.12", eventAt: "2026-09-20T10:00:00.000Z" } : null,
    sendMail: async (m) => {
      state.mails.push(m);
      return { ok: true };
    },
    secret: SECRET,
    allowedOrigins: [ORIGIN],
    limits: { maxFiles: 10, maxFileBytes: 4 * GIB, maxPostBytes: 8 * GIB },
    appCapBytes: 50 * GIB,
    dailyBytesPerIp: 20 * GIB,
    now: () => Date.parse("2026-10-10T06:00:00Z"),
    ...over,
  };
  return { ...s, deps, state };
};

const validBody = (over = {}) => ({
  kind: "live",
  liveId: "live-1",
  message: "最高でした",
  consent: true,
  turnstileToken: "good",
  files: [
    { name: "movie.mov", size: 1000, type: "video/quicktime" },
    { name: "photo.heic", size: 500, type: "" },
  ],
  ...over,
});
const ctx = { ip: "203.0.113.5", origin: ORIGIN };

test("init: LIVE 投稿は live/{liveId}/{uploadId}/ に分離され、manifest に投稿情報が残る", async () => {
  const { deps, state, manifestOf } = makeDeps();
  const res = await handleInit(validBody(), ctx, deps);
  assert.equal(res.status, 200);
  const prefix = `fan-moments/live/live-1/${res.body.postId}`;
  assert.deepEqual(
    state.created.map((c) => c.key),
    [`${prefix}/20261010-150000_1_movie.mov`, `${prefix}/20261010-150000_2_photo.heic`] // JST。投稿者名は含まない
  );
  assert.equal(state.created[0].mime, "video/quicktime");
  assert.equal(res.body.uploads.length, 2);
  assert.equal(res.body.uploads[0].partSize, PART_SIZE);
  assert.equal(res.body.uploads[0].parts.length, 1);
  assert.ok(res.body.token && res.body.postId);

  const manifest = manifestOf(prefix);
  assert.equal(manifest.uploadId, res.body.postId);
  assert.equal(manifest.status, "pending");
  assert.deepEqual(manifest.target, { kind: "live", liveId: "live-1", liveTitle: "渋谷 WWW X", liveDate: "2025.04.12" });
  assert.equal(manifest.createdAt, "2026-10-10T06:00:00.000Z");
  assert.equal(manifest.message, "最高でした");
  assert.deepEqual(
    manifest.files.map((f) => [f.originalName, f.declaredSize, f.mime, f.kind]),
    [
      ["movie.mov", 1000, "video/quicktime", "video"],
      ["photo.heic", 500, "image/heic", "image"],
    ]
  );

  // クライアントへ返すのは署名付きパート URL・投稿ID・トークンだけ（認証情報・内部キー構造の一覧を含まない）
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes(SECRET));
  assert.ok(!serialized.includes("manifest.json"));
});

test("init: LIVE 表示名が変わっても保存先は liveId のまま（表示名・日付を識別子にしない）", async () => {
  const a = makeDeps();
  const b = makeDeps({
    getLive: async (id) => ({ id, title: "改名後のタイトル", dateLabel: "2099.01.01", eventAt: "2026-09-20T10:00:00.000Z" }),
  });
  const ra = await handleInit(validBody(), ctx, a.deps);
  const rb = await handleInit(validBody(), ctx, b.deps);
  const dirOf = (state) => state.created[0].key.split("/").slice(0, 3).join("/");
  assert.equal(dirOf(a.state), "fan-moments/live/live-1");
  assert.equal(dirOf(b.state), "fan-moments/live/live-1");
  for (const key of [...a.state.created, ...b.state.created].map((c) => c.key)) {
    assert.ok(!key.includes("渋谷") && !key.includes("改名後") && !key.includes("2025.04.12"));
  }
  assert.notEqual(ra.body.postId, rb.body.postId);
});

test("init: 同じ LIVE への別投稿は uploadId で分離され、ファイルが混在しない", async () => {
  const { deps, state } = makeDeps();
  const r1 = await handleInit(validBody(), ctx, deps);
  const r2 = await handleInit(validBody(), ctx, deps);
  assert.notEqual(r1.body.postId, r2.body.postId);
  const prefixes = state.created.map((c) => c.key.split("/").slice(0, 4).join("/"));
  assert.deepEqual(
    new Set(prefixes),
    new Set([`fan-moments/live/live-1/${r1.body.postId}`, `fan-moments/live/live-1/${r2.body.postId}`])
  );
});

test("init: LIVE は開催後 6 か月間だけ受け付ける（開催前・6 か月超は拒否、「その他」は対象外）", async () => {
  const NOW_MS = Date.parse("2026-10-10T06:00:00Z");
  const withEvent = (eventAt) =>
    makeDeps({ getLive: async (id) => ({ id, title: "t", dateLabel: "d", eventAt }) });
  const status = async (eventAt) => {
    const { deps, state } = withEvent(eventAt);
    const res = await handleInit(validBody(), ctx, deps);
    return { status: res.status, created: state.created.length, error: res.body.error };
  };
  // 期間内: ちょうど開始 / 30 日前（旧仕様では期間外）/ 6 か月弱前（2026-04-10T06:00:01Z）
  assert.equal((await status(new Date(NOW_MS).toISOString())).status, 200);
  assert.equal((await status(new Date(NOW_MS - 30 * 86_400_000).toISOString())).status, 200);
  assert.equal((await status("2026-04-10T06:00:01Z")).status, 200);
  // 期間外: 開催前（1 ミリ秒先）/ ちょうど 6 か月前 / 7 か月前 / 日時なし・不正
  for (const eventAt of [
    new Date(NOW_MS + 1).toISOString(),
    "2026-04-10T06:00:00Z",
    "2026-03-10T06:00:00Z",
    undefined,
    "not-a-date",
  ]) {
    const r = await status(eventAt);
    assert.equal(r.status, 400, String(eventAt));
    assert.equal(r.created, 0, String(eventAt)); // R2 に何も作らない
    assert.ok(r.error.includes("6か月"));
  }
  // 「その他」は LIVE の期間に関係なく常に受け付ける
  const other = makeDeps({ getLive: async () => null });
  assert.equal((await handleInit(validBody({ kind: "other", liveId: undefined }), ctx, other.deps)).status, 200);
});

test("LIVE の受付期間: 開催日時からの 6 か月（暦月）で判定し、一覧は受付中のものだけ残す", () => {
  const start = Date.parse("2026-01-31T10:00:00Z"); // 6 か月後の 7/31 に同じ日がある
  assert.equal(isLivePostable("2026-01-31T10:00:00Z", start - 1), false); // 開催前
  assert.equal(isLivePostable("2026-01-31T10:00:00Z", start), true);
  assert.equal(isLivePostable("2026-01-31T10:00:00Z", Date.parse("2026-07-31T09:59:59Z")), true);
  assert.equal(isLivePostable("2026-01-31T10:00:00Z", Date.parse("2026-07-31T10:00:00Z")), false);
  // 月末開催: 6 か月後の月に同じ日が無ければ月末日（8/31 → 2/28、うるう年は 2/29）
  assert.equal(isLivePostable("2026-08-31T10:00:00Z", Date.parse("2027-02-28T09:59:59Z")), true);
  assert.equal(isLivePostable("2026-08-31T10:00:00Z", Date.parse("2027-02-28T10:00:00Z")), false);
  assert.equal(isLivePostable("2027-08-31T10:00:00Z", Date.parse("2028-02-28T10:00:00Z")), true);
  assert.equal(isLivePostable("2027-08-31T10:00:00Z", Date.parse("2028-02-29T10:00:00Z")), false);
  assert.equal(isLivePostable(undefined, start), false);

  const now = Date.parse("2026-10-10T06:00:00Z");
  const entries = [
    { id: "future", eventDate: "2026-10-20T10:00:00Z" },
    { id: "recent", eventDate: "2026-10-01T10:00:00Z" },
    { id: "three-months", eventDate: "2026-07-10T10:00:00Z" },
    { id: "expired", eventDate: "2026-03-01T10:00:00Z" },
    { id: "no-event-date", publishedAt: "2026-10-05T00:00:00Z" }, // eventDate が無ければ表示と同じく publishedAt
    { id: "nothing" },
  ];
  assert.deepEqual(postableLives(entries, now).map((e) => e.id), ["recent", "three-months", "no-event-date"]);
  assert.deepEqual(postableLives(entries, now), postableLives(entries, now)); // 副作用なし
  assert.equal(entries.length, 6);
});

test("init: その他投稿は other/{uploadId}/ に保存（LIVE とは別の枝）", async () => {
  const { deps, state, manifestOf } = makeDeps();
  const res = await handleInit(validBody({ kind: "other", liveId: undefined }), ctx, deps);
  assert.equal(res.status, 200);
  const prefix = `fan-moments/other/${res.body.postId}`;
  assert.ok(state.created.every((c) => c.key.startsWith(`${prefix}/`)));
  assert.deepEqual(manifestOf(prefix).target, { kind: "other" });
});

test("init: 投稿者の個人情報は要求も保存もしない（送られても読み捨てる）", async () => {
  const { deps, state, objects } = makeDeps();
  const res = await handleInit(validBody({ name: "ファン太郎", email: "fan@example.com", creditOk: true }), ctx, deps);
  assert.equal(res.status, 200);
  const dump = JSON.stringify([...objects.entries()]) + JSON.stringify(state.created);
  for (const word of ["ファン太郎", "fan@example.com", "投稿者", "クレジット", "203.0.113.5"]) {
    assert.ok(!dump.includes(word), word);
  }
  // メッセージは任意
  const noMessage = makeDeps();
  const r = await handleInit(validBody({ message: "" }), ctx, noMessage.deps);
  assert.equal(r.status, 200);
  assert.equal(noMessage.manifestOf(`fan-moments/live/live-1/${r.body.postId}`).message, "");
});

test("init: 大きなファイルは 16MiB ごとのパートに分かれ、パートごとの署名付き URL を返す", async () => {
  const { deps, state } = makeDeps();
  const size = PART_SIZE * 2 + 10;
  const res = await handleInit(validBody({ files: [{ name: "big.mov", size, type: "video/quicktime" }] }), ctx, deps);
  assert.equal(res.status, 200);
  assert.equal(res.body.uploads[0].parts.length, 3);
  const numbers = res.body.uploads[0].parts.map((u) => new URL(u).searchParams.get("partNumber"));
  assert.deepEqual(numbers, ["1", "2", "3"]);
  assert.equal(state.created.length, 1); // 1 ファイル = 1 マルチパートアップロード
});

test("init: 拒否条件 (origin / consent / turnstile / live / 形式 / 容量 / rate limit)", async () => {
  const run = async (body, c = ctx, over = {}) => handleInit(body, c, makeDeps(over).deps);
  assert.equal((await run(validBody(), { ip: "1.1.1.1", origin: "https://evil.example" })).status, 403);
  assert.equal((await run(validBody(), { ip: "1.1.1.1", origin: null })).status, 403);
  assert.equal((await run(validBody({ consent: false }))).status, 400);
  assert.equal((await run(validBody({ turnstileToken: "bad" }))).status, 403);
  assert.equal((await run(validBody({ liveId: "nope" }))).status, 400);
  assert.equal((await run(validBody({ liveId: "../etc" }))).status, 400);
  assert.equal((await run(validBody({ kind: "x" }))).status, 400);
  assert.equal((await run(validBody({ files: [{ name: "a.exe", size: 1, type: "" }] }))).status, 400);
  assert.equal((await run(validBody({ message: "x".repeat(1001) }))).status, 400);
  assert.equal((await run(validBody(), ctx, { consume: async () => ({ allowed: false }) })).status, 429);
  const full = makeDeps();
  full.deps.store.hasCapacity = async () => false;
  assert.equal((await handleInit(validBody(), ctx, full.deps)).status, 503);
  assert.equal(full.state.created.length, 0);
});

test("init: 上限は従来どおり（ファイル数 / 1 ファイル / 合計）", async () => {
  const run = async (files) => (await handleInit(validBody({ files }), ctx, makeDeps().deps)).status;
  const f = (name, size) => ({ name, size, type: "" });
  assert.equal(await run(Array.from({ length: 11 }, (_, i) => f(`${i}.jpg`, 1))), 400);
  assert.equal(await run([f("a.mp4", 4 * GIB + 1)]), 400);
  assert.equal(await run([f("a.mp4", 4 * GIB), f("b.mp4", 4 * GIB), f("c.mp4", 1)]), 400);
  assert.equal(await run([f("a.mp4", 4 * GIB), f("b.mp4", 4 * GIB)]), 200);
});

test("init: Turnstile 失敗時は R2 に何も作らない", async () => {
  const { deps, state, objects } = makeDeps();
  await handleInit(validBody({ turnstileToken: "bad" }), ctx, deps);
  assert.equal(state.created.length, 0);
  assert.equal(objects.size, 0);
});

test("init: 保存先の準備に失敗したら、作りかけのマルチパートアップロードを取り消す", async () => {
  const { deps, state } = makeDeps();
  deps.store.putObject = async () => {
    throw new R2Error("boom", 500);
  };
  const res = await handleInit(validBody(), ctx, deps);
  assert.equal(res.status, 502);
  assert.deepEqual(state.aborted.sort(), state.created.map((c) => c.key).sort());
});

test("complete: 全ファイル保存済みなら結合・検証し、1 投稿 = 1 通のメール（添付なし）", async () => {
  const { deps, state, putParts, manifestOf } = makeDeps();
  const init = await handleInit(validBody(), ctx, deps);
  putParts(init.body, [[1000], [500]]);
  const res = await handleComplete({ token: init.body.token }, ctx, deps);
  assert.equal(res.status, 200);
  assert.equal(res.body.accepted, 2);
  assert.equal(res.body.mailed, true);
  assert.equal(state.completed.length, 2);
  assert.equal(state.mails.length, 1); // 2 ファイルでも 1 通
  const mail = state.mails[0];
  assert.equal(mail.subject, "[Fan moments] LIVE / 2件");
  assert.ok(!("attachments" in mail)); // ファイル自体は添付しない
  for (const needle of [
    init.body.postId,
    "LIVE: 2025.04.12 渋谷 WWW X (live-1)", // どの LIVE への投稿か分かる
    "投稿日時(JST): 2026-10-10 15:00:00",
    "movie.mov",
    "photo.heic",
    "最高でした",
    "バケット: test-bucket",
    `フォルダ: fan-moments/live/live-1/${init.body.postId}/`,
    "R2 使用量(概算): 3.00 GB / 受付上限 50.00 GB",
  ]) {
    assert.ok(mail.text.includes(needle), needle);
  }
  assert.ok(!mail.text.includes("https://")); // ファイルへの URL は載せない（非公開のまま）
  assert.ok(mail.text.startsWith("Fan moments に投稿が届きました。")); // 旧称 DD UPLOAD は表示に残さない
  assert.ok(!mail.text.includes("DD UPLOAD"));
  const manifest = manifestOf(`fan-moments/live/live-1/${init.body.postId}`);
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.notified, true);
  assert.equal(manifest.completedAt, "2026-10-10T06:00:00.000Z");
  assert.deepEqual(manifest.files.map((f) => f.result), ["accepted", "accepted"]);

  // 再実行しても再送・再結合しない
  const again = await handleComplete({ token: init.body.token }, ctx, deps);
  assert.equal(again.status, 200);
  assert.equal(state.mails.length, 1);
  assert.equal(state.completed.length, 2);
});

test("complete: その他投稿のメールは「その他」と分かる", async () => {
  const { deps, state, putParts } = makeDeps();
  const init = await handleInit(validBody({ kind: "other", liveId: undefined }), ctx, deps);
  putParts(init.body, [[1000], [500]]);
  assert.equal((await handleComplete({ token: init.body.token }, ctx, deps)).status, 200);
  assert.equal(state.mails[0].subject, "[Fan moments] その他 / 2件");
  assert.ok(state.mails[0].text.includes("区分: その他"));
  assert.ok(state.mails[0].text.includes(`フォルダ: fan-moments/other/${init.body.postId}/`));
});

test("complete: 複数パートのファイルは全パートが揃った時点で結合される", async () => {
  const { deps, state, putParts } = makeDeps();
  const size = PART_SIZE * 2 + 10;
  const init = await handleInit(validBody({ files: [{ name: "big.mov", size, type: "video/quicktime" }] }), ctx, deps);
  // パート 1・2 だけ → 未完了
  putParts({ uploads: [{ parts: init.body.uploads[0].parts.slice(0, 2) }] }, [[PART_SIZE, PART_SIZE]]);
  const early = await handleComplete({ token: init.body.token }, ctx, deps);
  assert.equal(early.status, 409);
  assert.equal(state.completed.length, 0);
  assert.equal(state.mails.length, 0);
  // 残りを送って再実行（再開）
  putParts(init.body, [[PART_SIZE, PART_SIZE, 10]]);
  const done = await handleComplete({ token: init.body.token }, ctx, deps);
  assert.equal(done.status, 200);
  assert.equal(state.completed.length, 1);
  assert.equal(state.mails.length, 1);
});

test("complete: 未完了ファイルがあれば 409 で何も確定せずメールもしない", async () => {
  const { deps, state, putParts } = makeDeps();
  const init = await handleInit(validBody(), ctx, deps);
  putParts({ uploads: [init.body.uploads[0]] }, [[1000]]); // 2 つ目が届いていない
  const res = await handleComplete({ token: init.body.token }, ctx, deps);
  assert.equal(res.status, 409);
  assert.equal(res.body.uploaded, 1);
  assert.equal(res.body.expected, 2);
  assert.equal(state.completed.length, 0);
  assert.equal(state.mails.length, 0);
});

test("complete: 中身が拡張子と一致しないファイルは削除し、残りだけ通知", async () => {
  const { deps, state, putParts, manifestOf } = makeDeps();
  const init = await handleInit(validBody(), ctx, deps);
  state.heads[state.created[1].key] = new TextEncoder().encode("MZ\x90\x00 not an image");
  putParts(init.body, [[1000], [500]]);
  const res = await handleComplete({ token: init.body.token }, ctx, deps);
  assert.equal(res.status, 200);
  assert.equal(res.body.accepted, 1);
  assert.equal(res.body.rejected, 1);
  assert.deepEqual(state.deleted, [state.created[1].key]);
  assert.equal(state.mails.length, 1);
  assert.ok(state.mails[0].text.includes("検証で除外: 1件"));
  assert.ok(!state.mails[0].text.includes("photo.heic"));
  const manifest = manifestOf(`fan-moments/live/live-1/${init.body.postId}`);
  assert.deepEqual(manifest.files.map((f) => f.result), ["accepted", "rejected"]);
});

test("complete: 宣言サイズと違うファイルは取り消して除外 / 全滅なら 422 でメールなし", async () => {
  const { deps, state, putParts } = makeDeps();
  const init = await handleInit(validBody(), ctx, deps);
  putParts(init.body, [[1001], [501]]); // どちらもサイズ不一致
  const res = await handleComplete({ token: init.body.token }, ctx, deps);
  assert.equal(res.status, 422);
  assert.equal(state.mails.length, 0);
  assert.equal(state.completed.length, 0); // 結合しない
  assert.equal(state.aborted.length, 2); // マルチパートを取り消す
});

test("complete: 不正トークン・別オリジン・保存先を指さないトークン", async () => {
  const { deps } = makeDeps();
  assert.equal((await handleComplete({ token: "bogus" }, ctx, deps)).status, 401);
  assert.equal((await handleComplete({ token: "x" }, { ip: "1.1.1.1", origin: "https://evil.example" }, deps)).status, 403);
  const now = deps.now();
  // 保存先(k)を持たないトークン / postId と一致しない保存先を指すトークン
  const noPrefix = issuePostToken(SECRET, { pid: "abcdefghijkl", n: 1, total: 1 }, now);
  assert.equal((await handleComplete({ token: noPrefix }, ctx, deps)).status, 401);
  const mismatched = issuePostToken(SECRET, { pid: "abcdefghijkl", n: 1, total: 1, k: "fan-moments/other/zzzzzzzzzz" }, now);
  assert.equal((await handleComplete({ token: mismatched }, ctx, deps)).status, 401);
  // 任意のキーを指す k はトークンとして受理されない
  const arbitrary = issuePostToken(SECRET, { pid: "abcdefghijkl", n: 1, total: 1, k: "../secret/abcdefghijkl" }, now);
  assert.equal(verifyPostToken(SECRET, arbitrary, now), null);
});

test("complete: メール失敗時も保存は成功扱い。未通知のまま残り、再実行で再送できる", async () => {
  const { deps, state, putParts, manifestOf } = makeDeps();
  const init = await handleInit(validBody(), ctx, deps);
  putParts(init.body, [[1000], [500]]);
  let sendOk = false;
  deps.sendMail = async (m) => {
    if (sendOk) state.mails.push(m);
    return { ok: sendOk };
  };
  const res = await handleComplete({ token: init.body.token }, ctx, deps);
  assert.equal(res.status, 200); // 保存は成功しているのでユーザーにはエラーにしない
  assert.equal(res.body.mailed, false);
  assert.equal(manifestOf(`fan-moments/live/live-1/${init.body.postId}`).notified, false);
  sendOk = true;
  const retry = await handleComplete({ token: init.body.token }, ctx, deps);
  assert.equal(retry.body.mailed, true);
  assert.equal(state.mails.length, 1);
  assert.equal(state.completed.length, 2); // 結合は 1 回だけ
});

test("通知メールの送信元: FAN_MOMENTS_FROM_EMAIL があれば優先し、無ければ CONTACT のアドレス + 表示名「deddecay Fan moments」", async () => {
  const keys = ["RESEND_API_KEY", "CONTACT_TO_EMAIL", "CONTACT_FROM_EMAIL", "FAN_MOMENTS_FROM_EMAIL"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: "mail-1" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.CONTACT_TO_EMAIL = "owner@example.com";
    process.env.CONTACT_FROM_EMAIL = "onboarding@resend.dev";
    delete process.env.FAN_MOMENTS_FROM_EMAIL;
    assert.deepEqual(await sendNotification({ subject: "s", text: "t" }), { ok: true });
    // 未設定なら CONTACT のアドレスのまま、表示名だけ Fan moments 用にする（Resend のドメイン認証は不要）
    assert.equal(sent[0].from, "deddecay Fan moments <onboarding@resend.dev>");

    // CONTACT_FROM_EMAIL が「名前 <アドレス>」形式でも、名前だけが置き換わる
    process.env.CONTACT_FROM_EMAIL = "DD UPLOAD <onboarding@resend.dev>";
    assert.deepEqual(await sendNotification({ subject: "s", text: "t" }), { ok: true });
    assert.equal(sent[1].from, "deddecay Fan moments <onboarding@resend.dev>");
    assert.equal(fanMomentsFrom({ CONTACT_FROM_EMAIL: "DD UPLOAD <onboarding@resend.dev>" }), "deddecay Fan moments <onboarding@resend.dev>");
    assert.equal(fanMomentsFrom({}), ""); // どちらも無ければ送信しない（既存の未設定扱い）
    sent.pop();

    process.env.FAN_MOMENTS_FROM_EMAIL = "deddecay Fan moments <fanmoments@deddecay.tokyo>";
    assert.deepEqual(await sendNotification({ subject: "[Fan moments] LIVE / 2件", text: "t" }), { ok: true });
    assert.equal(sent[1].from, "deddecay Fan moments <fanmoments@deddecay.tokyo>");
    assert.equal(sent[1].subject, "[Fan moments] LIVE / 2件");
    assert.equal(sent[1].to, "owner@example.com"); // 宛先は変わらない
  } finally {
    globalThis.fetch = realFetch;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("完了画面の導線: 「TOPへ戻る」(主・枠付き, /) と「Fan momentsへ戻る」(副・テキスト, /upload)。左上の TOP リンクは完了画面で隠す", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const form = readFileSync(new URL("../app/_components/FanUploadForm.tsx", import.meta.url), "utf8");
  const screen = readFileSync(new URL("../app/_components/FanUploadScreen.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/upload/page.tsx", import.meta.url), "utf8");
  const done = form.slice(form.indexOf('if (phase === "done")'), form.indexOf("const uploaded = progress"));

  // 遷移先は実在する route（トップ /・Fan moments の /upload）
  assert.ok(existsSync(new URL("../app/page.tsx", import.meta.url)));
  assert.ok(existsSync(new URL("../app/upload/page.tsx", import.meta.url)));
  assert.match(done, /<Link href="\/" className=\{buttonBase\}>\s*TOPへ戻る\s*<\/Link>/); // 主導線（枠付きボタン）
  assert.match(done, /href="\/upload"[\s\S]*?onClick=\{reset\}[\s\S]*?Fan momentsへ戻る/); // 副導線（枠なしのテキストリンク）
  const sub = done.slice(done.indexOf('href="/upload"'), done.indexOf("Fan momentsへ戻る"));
  assert.ok(!sub.includes("buttonBase") && !sub.includes("border")); // 副導線は枠付きにしない
  assert.ok(done.indexOf("TOPへ戻る") < done.indexOf("Fan momentsへ戻る")); // TOP の下に副導線
  assert.ok(!done.includes("続けて投稿する"));
  // 既存の文言は維持
  assert.ok(done.includes("ありがとうございます！"));
  assert.ok(done.includes("アップロードいただいた動画も引き続き自由にお使いください！"));

  // 左上の「← deddecay」は完了画面でだけ隠す。ページ側には残さない（二重表示を防ぐ）
  assert.match(screen, /\{!done && \(\s*<Link\s+href="\/"/);
  assert.ok(screen.includes("onDoneChange={setDone}"));
  // 共通ヘッダー（見出し・説明）も完了画面では隠す。通常のフォーム画面では表示する（done が false の間）
  assert.match(screen, /\{!done && \(\s*<header[\s\S]*?Fan moments[\s\S]*?SNS等での使用を目的としています。[\s\S]*?<\/header>\s*\)\}/);
  assert.ok(screen.indexOf("<FanUploadForm") > screen.indexOf("</header>")); // フォームは常に表示
  assert.ok(!page.includes("← deddecay"));
  // 公開導線は追加していない（ナビ・LIVE 詳細へのリンクを足していない）
  assert.ok(!readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8").includes("/upload"));
});

test("TOP 導線: DISCOGRAPHY の直下から /fan-moments へ。/upload へは直接つながない。点滅は reduced-motion で止まる", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const nav = read("../app/_components/NavMenu.tsx");
  const main = read("../app/fan-moments/page.tsx");
  const css = read("../app/globals.css");

  assert.ok(existsSync(new URL("../app/fan-moments/page.tsx", import.meta.url)));
  assert.ok(existsSync(new URL("../app/upload/page.tsx", import.meta.url)));
  // TOP のリンクは /fan-moments。/upload は TOP（page.tsx / NavMenu）に直接出さない。表示は公開フラグ次第
  assert.match(nav, /href="\/fan-moments"/);
  assert.ok(!nav.includes('"/upload"') && !read("../app/page.tsx").includes("/upload"));
  assert.match(nav, /showFanMoments && \(/);
  // TOP の表示条件は ENABLED（リンク先 /fan-moments が有効なときだけ出す）。PUBLIC の有無には依存しない
  const top = read("../app/page.tsx");
  assert.match(top, /showFanMoments=\{fanMomentsEnabled\(\)\}/);
  assert.ok(!top.includes("fanMomentsPublic"));
  // 位置: DISCOGRAPHY の直下（CONTACT より前）
  assert.ok(nav.indexOf('renderExpandable("discography")') < nav.indexOf("showFanMoments && ("));
  assert.ok(nav.indexOf("showFanMoments && (") < nav.indexOf('renderExpandable("contact")'));
  // メインページ: 公開前は 404、投稿は既存 /upload へ
  assert.match(main, /if \(!fanMomentsEnabled\(\)\) notFound\(\)/);
  assert.match(main, /href="\/upload"[\s\S]*?投稿する/);
  // 点滅は prefers-reduced-motion: no-preference のときだけ。opacity のみ、最低 0.5 以上
  const motion = css.slice(css.indexOf("@media (prefers-reduced-motion: no-preference) {", css.indexOf("fan-moments-flicker-a")));
  assert.ok(motion.includes(".fan-moments-flicker") && motion.includes(".fan-moments-flicker-b"));
  const keyframes = css.slice(css.indexOf("@keyframes fan-moments-flicker-a"), css.indexOf("@media", css.indexOf("@keyframes fan-moments-flicker-b")));
  const values = [...keyframes.matchAll(/opacity:\s*([0-9.]+)/g)].map((m) => Number(m[1]));
  assert.ok(values.length > 0 && Math.min(...values) >= 0.5 && Math.max(...values) <= 1);
  assert.ok(!/(blur|transform|translate)/.test(keyframes));
});

test("許可オリジン: 本番ドメインを含み、任意オリジンは含まない", () => {
  const origins = readAllowedOrigins({ NODE_ENV: "production" });
  assert.ok(origins.includes("https://deddecay.tokyo"));
  assert.ok(!origins.includes("http://localhost:3000"));
  assert.ok(readAllowedOrigins({ NODE_ENV: "development" }).includes("http://localhost:3000"));
});

// ── client-upload ──────────────────────────────────────

const withFetch = async (impl, fn) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
};

test("パートアップロード: パートごとに署名付き URL へ PUT し、進捗とパート位置が進む", async () => {
  const file = new File([new Uint8Array(10)], "a.mp4");
  const upload = { name: "a.mp4", partSize: 4, parts: ["https://r2.example/p1", "https://r2.example/p2", "https://r2.example/p3"] };
  const puts = [];
  const progress = [];
  await withFetch(
    async (url, init) => {
      puts.push([String(url), init.method, init.body.size]);
      return new Response(null, { status: 200 });
    },
    async () => {
      await uploadFile(file, upload, (b) => progress.push(b));
    }
  );
  assert.deepEqual(puts, [
    ["https://r2.example/p1", "PUT", 4],
    ["https://r2.example/p2", "PUT", 4],
    ["https://r2.example/p3", "PUT", 2],
  ]);
  assert.deepEqual(progress, [0, 4, 8, 10]);
  assert.equal(upload.donePart, 3);
});

test("パートアップロード: 通信断では失敗したパートだけ再送し、完了済みパートは再送しない", async () => {
  const file = new File([new Uint8Array(8)], "a.mp4");
  const upload = { name: "a.mp4", partSize: 4, parts: ["https://r2.example/p1", "https://r2.example/p2"] };
  const log = [];
  let failedOnce = false;
  await withFetch(
    async (url) => {
      log.push(String(url));
      if (String(url).endsWith("/p2") && !failedOnce) {
        failedOnce = true;
        throw new TypeError("network down");
      }
      return new Response(null, { status: 200 });
    },
    async () => {
      await uploadFile(file, upload, () => {});
    }
  );
  assert.deepEqual(log, ["https://r2.example/p1", "https://r2.example/p2", "https://r2.example/p2"]);
});

test("パートアップロード: 「再開する」では完了済みパートの続きから送る", async () => {
  const file = new File([new Uint8Array(12)], "a.mp4");
  const upload = {
    name: "a.mp4",
    partSize: 4,
    parts: ["https://r2.example/p1", "https://r2.example/p2", "https://r2.example/p3"],
    donePart: 2,
  };
  const log = [];
  const progress = [];
  await withFetch(
    async (url) => {
      log.push(String(url));
      return new Response(null, { status: 200 });
    },
    async () => {
      await uploadFile(file, upload, (b) => progress.push(b));
    }
  );
  assert.deepEqual(log, ["https://r2.example/p3"]);
  assert.deepEqual(progress, [8, 12]);
});

test("パートアップロード: 署名の期限切れ(403)は再試行せず致命的エラー", async () => {
  const file = new File([new Uint8Array(4)], "a.mp4");
  const upload = { name: "a.mp4", partSize: 4, parts: ["https://r2.example/p1"] };
  let calls = 0;
  await withFetch(
    async () => {
      calls++;
      return new Response("expired", { status: 403 });
    },
    async () => {
      await assert.rejects(uploadFile(file, upload, () => {}), UploadFatalError);
    }
  );
  assert.equal(calls, 1);
});
