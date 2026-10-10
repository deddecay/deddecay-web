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
} from "../src/lib/fan-upload/policy.ts";
import { issuePostToken, verifyPostToken } from "../src/lib/fan-upload/token.ts";
import { consume, _resetMemoryForTest } from "../src/lib/fan-upload/ratelimit.ts";
import { DriveClient } from "../src/lib/fan-upload/drive.ts";
import { handleInit, handleComplete, readAllowedOrigins } from "../src/lib/fan-upload/service.ts";
import { parseRangeHeader, uploadFile, CHUNK_SIZE } from "../src/lib/fan-upload/client-upload.ts";
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

// ── service（init / complete）───────────────────────────

const makeDeps = (over = {}) => {
  const state = { mails: [], trashed: [], notified: [], sessions: [], folders: [], files: [] };
  const deps = {
    drive: {
      hasCapacity: async () => true,
      ensureFolderPath: async (segments) => {
        state.folders.push(segments);
        return "folder-1";
      },
      createResumableSession: async (p) => {
        state.sessions.push(p);
        return `https://www.googleapis.com/upload/drive/v3/files?upload_id=${state.sessions.length}`;
      },
      listPostFiles: async () => state.files,
      readHead: async (id) => state.heads?.[id] ?? new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]),
      trash: async (id) => {
        state.trashed.push(id);
      },
      markNotified: async (id) => {
        state.notified.push(id);
        const f = state.files.find((x) => x.id === id);
        if (f) f.appProperties.notified = "1";
      },
    },
    verifyTurnstile: async (t) => t === "good",
    consume: async () => ({ allowed: true }),
    getLive: async (id) => (id === "live-1" ? { id, title: "渋谷 WWW X", dateLabel: "2025.04.12" } : null),
    sendMail: async (m) => {
      state.mails.push(m);
      return { ok: true };
    },
    secret: SECRET,
    allowedOrigins: [ORIGIN],
    limits: { maxFiles: 10, maxFileBytes: 4 * GIB, maxPostBytes: 8 * GIB },
    appCapBytes: 50 * GIB,
    reserveBytes: GIB,
    dailyBytesPerIp: 20 * GIB,
    now: () => Date.parse("2026-10-10T06:00:00Z"),
    ...over,
  };
  return { deps, state };
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

test("init: LIVE 投稿は公演情報(正本)から自動フォルダ分類される", async () => {
  const { deps, state } = makeDeps();
  const res = await handleInit(validBody(), ctx, deps);
  assert.equal(res.status, 200);
  assert.deepEqual(state.folders[0], ["LIVE", "2025", "2025.04.12_渋谷 WWW X__live-1"]);
  assert.equal(res.body.uploads.length, 2);
  assert.ok(res.body.token && res.body.postId);
  assert.equal(state.sessions[0].origin, ORIGIN);
  assert.equal(state.sessions[0].mimeType, "video/quicktime");
  assert.equal(state.sessions[0].appProperties.postId, res.body.postId);
  assert.equal(state.sessions[0].appProperties.target, "live-1");
  assert.match(state.sessions[0].name, /^20261010-150000_1_movie\.mov$/); // JST。投稿者名は含まない
  // クライアントへ返すのはセッションURLのみ（Drive のフォルダ ID・認証情報を含まない）
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes("folder-1"));
  assert.ok(!serialized.includes(SECRET));
});

test("init: 投稿者の個人情報は要求も保存もしない（送られても読み捨てる）", async () => {
  const { deps, state } = makeDeps();
  // 名前・メール・クレジット可否が不要になったので、無くても通る
  const res = await handleInit(validBody(), ctx, deps);
  assert.equal(res.status, 200);
  // 古いクライアントが名前・メールを送ってきても、ファイル名・説明欄・メタデータに残さない
  const legacy = makeDeps();
  const res2 = await handleInit(
    validBody({ name: "ファン太郎", email: "fan@example.com", creditOk: true }),
    ctx,
    legacy.deps
  );
  assert.equal(res2.status, 200);
  for (const s of [...state.sessions, ...legacy.state.sessions]) {
    const dump = JSON.stringify(s);
    assert.ok(!dump.includes("ファン太郎"));
    assert.ok(!dump.includes("fan@example.com"));
    assert.ok(!dump.includes("投稿者"));
    assert.ok(!dump.includes("メール:"));
    assert.ok(!dump.includes("クレジット"));
  }
  // メッセージは任意で、あれば説明欄に残る
  assert.ok(state.sessions[0].description.includes("最高でした"));
  const noMessage = makeDeps();
  assert.equal((await handleInit(validBody({ message: "" }), ctx, noMessage.deps)).status, 200);
  assert.ok(!noMessage.state.sessions[0].description.includes("メッセージ:"));
});

test("init: その他投稿は OTHER/年-月 に保存", async () => {
  const { deps, state } = makeDeps();
  const res = await handleInit(validBody({ kind: "other", liveId: undefined }), ctx, deps);
  assert.equal(res.status, 200);
  assert.deepEqual(state.folders[0], ["OTHER", "2026-10"]);
  assert.equal(state.sessions[0].appProperties.target, "other");
});

test("init: 拒否条件 (origin / consent / turnstile / live / 形式 / 容量 / rate limit)", async () => {
  const run = async (body, c = ctx, over = {}) => handleInit(body, c, makeDeps(over).deps);
  assert.equal((await run(validBody(), { ip: "1.1.1.1", origin: "https://evil.example" })).status, 403);
  assert.equal((await run(validBody(), { ip: "1.1.1.1", origin: null })).status, 403);
  assert.equal((await run(validBody({ consent: false }))).status, 400);
  assert.equal((await run(validBody({ turnstileToken: "bad" }))).status, 403);
  assert.equal((await run(validBody({ liveId: "nope" }))).status, 400);
  assert.equal((await run(validBody({ kind: "x" }))).status, 400);
  assert.equal((await run(validBody({ files: [{ name: "a.exe", size: 1, type: "" }] }))).status, 400);
  assert.equal((await run(validBody({ message: "x".repeat(1001) }))).status, 400);
  assert.equal((await run(validBody(), ctx, { consume: async () => ({ allowed: false }) })).status, 429);
  const full = makeDeps();
  full.deps.drive.hasCapacity = async () => false;
  assert.equal((await handleInit(validBody(), ctx, full.deps)).status, 503);
  assert.equal(full.state.sessions.length, 0);
});

test("init: Turnstile 失敗時は Drive に何も作らない", async () => {
  const { deps, state } = makeDeps();
  await handleInit(validBody({ turnstileToken: "bad" }), ctx, deps);
  assert.equal(state.folders.length, 0);
  assert.equal(state.sessions.length, 0);
});

const driveFiles = (postId, extra = {}) => [
  {
    id: "f1",
    name: "x_1_movie.mov",
    size: 1000,
    parents: ["folder-1"],
    description: "メッセージ: 最高でした",
    appProperties: { postId, idx: "0", declSize: "1000", target: "live-1" },
    ...extra,
  },
  {
    id: "f2",
    name: "x_2_photo.heic",
    size: 500,
    parents: ["folder-1"],
    description: "メッセージ: 最高でした",
    appProperties: { postId, idx: "1", declSize: "500", target: "live-1" },
  },
];

test("complete: 全ファイル保存済みなら 1 投稿 = 1 通のメール", async () => {
  const { deps, state } = makeDeps();
  const init = await handleInit(validBody(), ctx, deps);
  state.files = driveFiles(init.body.postId);
  const res = await handleComplete({ token: init.body.token }, ctx, deps);
  assert.equal(res.status, 200);
  assert.equal(res.body.accepted, 2);
  assert.equal(state.mails.length, 1); // 2 ファイルでも 1 通
  assert.ok(state.mails[0].text.includes("movie.mov") || state.mails[0].text.includes("x_1_movie.mov"));
  assert.ok(state.mails[0].text.includes("最高でした"));
  assert.ok(state.mails[0].text.includes("folder-1")); // 管理者向けメールにのみフォルダリンク
  assert.deepEqual(state.notified.sort(), ["f1", "f2"]);
  // 再実行しても再送しない
  const again = await handleComplete({ token: init.body.token }, ctx, deps);
  assert.equal(again.status, 200);
  assert.equal(state.mails.length, 1);
});

test("complete: 未完了ファイルがあれば 409 でメールしない", async () => {
  const { deps, state } = makeDeps();
  const init = await handleInit(validBody(), ctx, deps);
  state.files = driveFiles(init.body.postId).slice(0, 1);
  const res = await handleComplete({ token: init.body.token }, ctx, deps);
  assert.equal(res.status, 409);
  assert.equal(state.mails.length, 0);
});

test("complete: 中身が拡張子と一致しないファイルは破棄し、残りだけ通知", async () => {
  const { deps, state } = makeDeps();
  const init = await handleInit(validBody(), ctx, deps);
  state.files = driveFiles(init.body.postId);
  state.heads = { f2: new TextEncoder().encode("MZ\x90\x00 not an image") };
  const res = await handleComplete({ token: init.body.token }, ctx, deps);
  assert.equal(res.status, 200);
  assert.equal(res.body.accepted, 1);
  assert.equal(res.body.rejected, 1);
  assert.deepEqual(state.trashed, ["f2"]);
  assert.equal(state.mails.length, 1);
});

test("complete: 宣言サイズと違うファイルは破棄 / 全滅なら 422 でメールなし", async () => {
  const { deps, state } = makeDeps();
  const init = await handleInit(validBody(), ctx, deps);
  state.files = driveFiles(init.body.postId).map((f) => ({ ...f, size: f.size + 1 }));
  const res = await handleComplete({ token: init.body.token }, ctx, deps);
  assert.equal(res.status, 422);
  assert.equal(state.mails.length, 0);
  assert.equal(state.trashed.length, 2);
});

test("complete: 不正トークン・別オリジン・メール失敗時", async () => {
  const { deps, state } = makeDeps();
  assert.equal((await handleComplete({ token: "bogus" }, ctx, deps)).status, 401);
  assert.equal((await handleComplete({ token: "x" }, { ip: "1.1.1.1", origin: "https://evil.example" }, deps)).status, 403);

  const init = await handleInit(validBody(), ctx, deps);
  state.files = driveFiles(init.body.postId);
  deps.sendMail = async () => ({ ok: false });
  const res = await handleComplete({ token: init.body.token }, ctx, deps);
  assert.equal(res.status, 200); // 保存は成功しているのでユーザーにはエラーにしない
  assert.equal(res.body.mailed, false);
  assert.equal(state.notified.length, 0); // 未通知のまま → 再実行で再送できる
});

test("許可オリジン: 本番ドメインを含み、任意オリジンは含まない", () => {
  const origins = readAllowedOrigins({ NODE_ENV: "production" });
  assert.ok(origins.includes("https://deddecay.tokyo"));
  assert.ok(!origins.includes("http://localhost:3000"));
  assert.ok(readAllowedOrigins({ NODE_ENV: "development" }).includes("http://localhost:3000"));
});

// ── client-upload ──────────────────────────────────────

test("Range ヘッダの解釈", () => {
  assert.equal(parseRangeHeader("bytes=0-99"), 100);
  assert.equal(parseRangeHeader(null), null);
  assert.equal(parseRangeHeader("garbage"), null);
});

test("チャンクアップロード: 複数チャンクで完了し、Content-Range が正しい", async () => {
  const size = CHUNK_SIZE + 1234;
  const file = new File([new Uint8Array(size)], "a.mp4");
  const ranges = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    ranges.push(init.headers["Content-Range"]);
    const isLast = init.headers["Content-Range"].startsWith(`bytes ${CHUNK_SIZE}-`);
    return isLast
      ? new Response("{}", { status: 200 })
      : new Response(null, { status: 308, headers: { Range: `bytes=0-${CHUNK_SIZE - 1}` } });
  };
  try {
    let last = 0;
    await uploadFile(file, "https://www.googleapis.com/upload/x", (b) => (last = b));
    assert.deepEqual(ranges, [`bytes 0-${CHUNK_SIZE - 1}/${size}`, `bytes ${CHUNK_SIZE}-${size - 1}/${size}`]);
    assert.equal(last, size);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("チャンクアップロード: 通信断のあと受信済み位置から再開する", async () => {
  const size = 1000;
  const file = new File([new Uint8Array(size)], "a.mp4");
  const log = [];
  const realFetch = globalThis.fetch;
  let first = true;
  globalThis.fetch = async (_url, init) => {
    const range = init.headers["Content-Range"];
    log.push(range);
    if (first) {
      first = false;
      throw new TypeError("network down");
    }
    if (range === `bytes */${size}`) return new Response(null, { status: 308, headers: { Range: "bytes=0-499" } });
    return new Response("{}", { status: 200 });
  };
  try {
    await uploadFile(file, "https://www.googleapis.com/upload/x", () => {});
    assert.deepEqual(log, [`bytes 0-999/${size}`, `bytes */${size}`, `bytes 500-999/${size}`]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
