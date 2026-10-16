import test from "node:test";
import assert from "node:assert/strict";

import { transferUpload, cleanupUpload, sweep, liveFolderName, driveDescription, mediaFolderOf } from "../src/lib/fan-upload/transfer.ts";
import { DriveClient } from "../src/lib/fan-upload/drive.ts";
import { R2Client } from "../src/lib/fan-upload/r2.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-12T07:00:00Z");

// ── 簡易な R2 / Drive のフェイク ─────────────────────────

class MemStore {
  objects = new Map();
  n = 0;
  deleted = [];
  put(key, body) {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    this.objects.set(key, { bytes, etag: `"e${++this.n}"` });
  }
  async getObject(key) {
    const o = this.objects.get(key);
    return o ? { text: new TextDecoder().decode(o.bytes), etag: o.etag } : null;
  }
  async putObjectIf(key, body, _ct, cond) {
    const cur = this.objects.get(key);
    const lost = (cond.ifNoneMatch && cur) || (cond.ifMatch && (!cur || cur.etag !== cond.ifMatch));
    if (lost) throw Object.assign(new Error("precondition failed"), { status: 412 });
    this.put(key, body);
    return this.objects.get(key).etag;
  }
  async readRange(key, start, end) {
    return this.objects.get(key).bytes.slice(start, end + 1);
  }
  async listKeys(prefix) {
    return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.bytes.length }));
  }
  async delete(key) {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

const makeDrive = (clock) => {
  const s = { files: new Map(), sessions: new Map(), folders: [], created: 0, failNext: null };
  const finish = (sess) => {
    const id = `file-${++s.created}`;
    const bytes = Buffer.concat(sess.chunks);
    s.files.set(id, {
      id,
      size: bytes.length,
      bytes,
      trashed: false,
      md5: `md5-${id}`,
      ddKey: sess.params.appProperties.ddKey,
      params: sess.params,
    });
    sess.fileId = id;
    return { done: true, id, size: bytes.length, md5: `md5-${id}` };
  };
  return {
    state: s,
    ensureLiveFolder: async (liveId, name) => {
      s.folders.push(["live", liveId, name]);
      return `folder-live-${liveId}`;
    },
    ensureOtherFolder: async () => {
      s.folders.push(["other"]);
      return "folder-other";
    },
    ensureMediaFolder: async (parentId, media) => {
      s.folders.push(["media", parentId, media]);
      return `${parentId}/${media}`;
    },
    findByKey: async (ddKey) =>
      [...s.files.values()].filter((f) => f.ddKey === ddKey && !f.trashed).map((f) => ({ id: f.id, size: f.size, md5: f.md5 })),
    getFileInfo: async (id) => {
      const f = s.files.get(id);
      return f ? { id, size: f.size, trashed: f.trashed, md5: f.md5, ddKey: f.ddKey } : null;
    },
    createTransferSession: async (params) => {
      const url = `https://www.googleapis.com/upload/session-${s.sessions.size + 1}`;
      s.sessions.set(url, { params, chunks: [], received: 0, total: params.size, fileId: null });
      return url;
    },
    putChunk: async (url, bytes, start, total) => {
      clock.t += 10;
      if (s.failNext) {
        const err = s.failNext;
        s.failNext = null;
        throw err;
      }
      const sess = s.sessions.get(url);
      assert.equal(start, sess.received, "チャンクのオフセットが連続している");
      sess.chunks.push(Buffer.from(bytes));
      sess.received += bytes.length;
      return sess.received === total ? finish(sess) : { done: false, next: sess.received };
    },
    queryOffset: async (url, total) => {
      const sess = s.sessions.get(url);
      if (!sess) throw Object.assign(new Error("gone"), { status: 404 });
      if (sess.fileId) return { done: true, id: sess.fileId, size: total, md5: `md5-${sess.fileId}` };
      return { done: false, next: sess.received };
    },
  };
};

const PREFIX = "fan-moments/live/L1/UP1";
const NAME = "20261012-152405_1_IMG_1355.jpeg";
const content = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) % 251);

const manifestOf = (over = {}, files) => ({
  version: 1,
  uploadId: "UP1",
  status: "complete",
  target: { kind: "live", liveId: "L1", liveTitle: "Spotify O-Crest『CASCADE』", liveDate: "2026.09.20" },
  createdAt: "2026-10-12T06:24:05.000Z",
  completedAt: "2026-10-12T06:24:30.000Z",
  consent: "2026-10-v2",
  message: "応援してます！",
  notified: true,
  files: files ?? [
    {
      index: 0,
      key: `${PREFIX}/${NAME}`,
      storedName: NAME,
      originalName: "IMG_1355.jpeg",
      declaredSize: 100,
      mime: "image/jpeg",
      kind: "image",
      parts: 1,
      multipartUploadId: "mp",
      result: "accepted",
    },
  ],
  ...over,
});

const setup = (opts = {}) => {
  const clock = { t: T0 };
  const store = new MemStore();
  const drive = makeDrive(clock);
  const mails = [];
  const bytes = content(100);
  store.put(`${PREFIX}/${NAME}`, bytes);
  store.put(`${PREFIX}/manifest.json`, JSON.stringify(manifestOf(opts.manifest)));
  const deps = {
    store,
    drive,
    sendMail: async (m) => {
      mails.push(m);
      return { ok: true };
    },
    now: () => clock.t,
    retentionMs: 7 * DAY,
    chunkBytes: opts.chunkBytes ?? 40,
  };
  return { clock, store, drive, mails, deps, bytes };
};

const readState = async (store) => JSON.parse((await store.getObject(`${PREFIX}/drive.json`)).text);

// ── 転送 ────────────────────────────────────────────────

test("LIVE 投稿: LIVE フォルダへ元の並びの名前で保存し、メッセージ等を説明に残す。R2 は消さない", async () => {
  const { store, drive, deps, bytes, clock } = setup();
  assert.equal(await transferUpload(deps, PREFIX, clock.t + 60_000), "done");

  assert.deepEqual(drive.state.folders, [
    ["live", "L1", "2026.09.20 Spotify O-Crest『CASCADE』"],
    ["media", "folder-live-L1", "photo"],
  ]);
  const [file] = [...drive.state.files.values()];
  assert.equal(file.params.name, NAME);
  assert.equal(file.params.parentId, "folder-live-L1/photo"); // 日付（LIVE）フォルダの下の photo
  assert.equal(file.params.mimeType, "image/jpeg");
  assert.equal(file.params.appProperties.ddKey, "UP1:0");
  assert.equal(file.params.appProperties.liveId, "L1");
  assert.match(file.params.description, /メッセージ: 応援してます！/);
  assert.match(file.params.description, /元のファイル名: IMG_1355\.jpeg/);
  assert.match(file.params.description, /投稿日時\(JST\): 2026-10-12 15:24:05/);
  assert.deepEqual(new Uint8Array(file.bytes), bytes, "Drive の中身が R2 と一致する");

  const state = await readState(store);
  assert.equal(state.state, "done");
  assert.equal(state.files[0].driveFileId, file.id);
  assert.equal(state.files[0].md5, `md5-${file.id}`);
  assert.ok(state.doneAt);
  assert.deepEqual(store.deleted, [], "転送直後に R2 原本を消さない");
  assert.ok(store.objects.has(`${PREFIX}/${NAME}`));
});

// 複数ファイルの投稿を組み立てる（画像・動画・音声の種別を指定）
const setupMulti = (specs, manifestOver = {}) => {
  const ctx = setup({ manifest: manifestOver });
  const files = specs.map((s, i) => {
    const storedName = `20261012-152405_${i + 1}_${s.name}`;
    const key = `${PREFIX}/${storedName}`;
    ctx.store.put(key, content(100, i + 1));
    return {
      index: i,
      key,
      storedName,
      originalName: s.name,
      declaredSize: 100,
      mime: s.mime,
      kind: s.kind,
      parts: 1,
      multipartUploadId: "mp",
      result: "accepted",
    };
  });
  ctx.store.put(`${PREFIX}/manifest.json`, JSON.stringify(manifestOf(manifestOver, files)));
  return ctx;
};
const parentsByName = (drive) =>
  Object.fromEntries([...drive.state.files.values()].map((f) => [f.params.name.split("_").slice(2).join("_"), f.params.parentId]));

const IMG = { name: "IMG_1355.jpeg", mime: "image/jpeg", kind: "image" };
const MOV = { name: "IMG_1289.mov", mime: "video/quicktime", kind: "video" };

test("振り分け: 画像のみ → 日付フォルダ配下の photo だけ", async () => {
  const { drive, deps, clock } = setupMulti([IMG, { ...IMG, name: "b.png", mime: "image/png" }]);
  assert.equal(await transferUpload(deps, PREFIX, clock.t + 60_000), "done");
  assert.deepEqual(parentsByName(drive), { "IMG_1355.jpeg": "folder-live-L1/photo", "b.png": "folder-live-L1/photo" });
  assert.deepEqual(drive.state.folders.filter((f) => f[0] === "media"), [
    ["media", "folder-live-L1", "photo"],
    ["media", "folder-live-L1", "photo"],
  ]);
  assert.ok(!drive.state.folders.some((f) => f[2] === "movie")); // movie は作らない
});

test("振り分け: 動画のみ → movie だけ", async () => {
  const { drive, deps, clock } = setupMulti([MOV, { ...MOV, name: "c.mp4", mime: "video/mp4" }]);
  assert.equal(await transferUpload(deps, PREFIX, clock.t + 60_000), "done");
  assert.deepEqual(parentsByName(drive), { "IMG_1289.mov": "folder-live-L1/movie", "c.mp4": "folder-live-L1/movie" });
  assert.ok(!drive.state.folders.some((f) => f[2] === "photo"));
});

test("振り分け: 画像と動画の混在 → それぞれ photo / movie（ファイル名・LIVEフォルダ名は従来どおり）", async () => {
  const { drive, deps, clock } = setupMulti([IMG, MOV]);
  assert.equal(await transferUpload(deps, PREFIX, clock.t + 60_000), "done");
  assert.deepEqual(parentsByName(drive), { "IMG_1355.jpeg": "folder-live-L1/photo", "IMG_1289.mov": "folder-live-L1/movie" });
  // 日付より上の階層（LIVE フォルダ）は従来どおり
  assert.deepEqual(drive.state.folders[0], ["live", "L1", "2026.09.20 Spotify O-Crest『CASCADE』"]);
  // 保存名は R2 と同じ（先頭の投稿日時_連番_元の名前）
  assert.deepEqual(
    [...drive.state.files.values()].map((f) => f.params.name).sort(),
    ["20261012-152405_1_IMG_1355.jpeg", "20261012-152405_2_IMG_1289.mov"]
  );
});

test("振り分け: 「その他」も同じ（その他/photo・その他/movie）。種別が不明でも MIME で判定する", async () => {
  const { drive, deps, clock } = setupMulti(
    [{ ...IMG, kind: "" }, { ...MOV, kind: "" }],
    { target: { kind: "other" } }
  );
  assert.equal(await transferUpload(deps, PREFIX, clock.t + 60_000), "done");
  assert.deepEqual(parentsByName(drive), { "IMG_1355.jpeg": "folder-other/photo", "IMG_1289.mov": "folder-other/movie" });
});

test("振り分け: 画像でも動画でもないもの（音声）は日付フォルダ直下のまま", async () => {
  const { drive, deps, clock } = setupMulti([{ name: "a.mp3", mime: "audio/mpeg", kind: "audio" }]);
  assert.equal(await transferUpload(deps, PREFIX, clock.t + 60_000), "done");
  assert.deepEqual(parentsByName(drive), { "a.mp3": "folder-live-L1" });
  assert.equal(mediaFolderOf({ kind: "audio", mime: "audio/mpeg" }), null);
});

test("その他の投稿は「その他」フォルダへ保存する", async () => {
  const { drive, deps, clock } = setup({ manifest: { target: { kind: "other" } } });
  assert.equal(await transferUpload(deps, PREFIX, clock.t + 60_000), "done");
  assert.deepEqual(drive.state.folders, [["other"], ["media", "folder-other", "photo"]]);
  assert.match([...drive.state.files.values()][0].params.description, /区分: その他/);
});

test("時間切れで中断しても、保存済みのセッションから続きを送る（重複作成しない）", async () => {
  const { store, drive, deps, bytes, clock } = setup();
  // 1 チャンク送ると時計が 10ms 進み、締切（+5ms）を超えて中断する
  assert.equal(await transferUpload(deps, PREFIX, clock.t + 5), "partial");
  let state = await readState(store);
  assert.equal(state.state, "pending");
  assert.equal(state.files[0].offset, 40);
  assert.equal(state.leaseUntil, 0, "中断時はリースを手放す");
  assert.equal(drive.state.files.size, 0);

  assert.equal(await transferUpload(deps, PREFIX, clock.t + 60_000), "done");
  assert.equal(drive.state.sessions.size, 1, "セッションを作り直さない");
  assert.equal(drive.state.files.size, 1);
  assert.deepEqual(new Uint8Array([...drive.state.files.values()][0].bytes), bytes);
  state = await readState(store);
  assert.equal(state.state, "done");
});

test("重複防止: Drive に同じ投稿・同じサイズのファイルが既にあれば送らない", async () => {
  const { store, drive, deps, clock } = setup();
  drive.state.files.set("existing", { id: "existing", size: 100, trashed: false, md5: "m", ddKey: "UP1:0", bytes: Buffer.alloc(100) });
  assert.equal(await transferUpload(deps, PREFIX, clock.t + 60_000), "done");
  assert.equal(drive.state.sessions.size, 0);
  assert.equal((await readState(store)).files[0].driveFileId, "existing");
});

test("完了の記録だけ失敗していた場合も、セッションの完了を確認して二重に送らない", async () => {
  const { store, drive, deps, clock } = setup();
  assert.equal(await transferUpload(deps, PREFIX, clock.t + 5), "partial");
  // Drive 側は最後まで受け取り済み（記録前に落ちた状況）
  const [url, sess] = [...drive.state.sessions][0];
  sess.chunks = [Buffer.from(content(100))];
  sess.received = 100;
  sess.fileId = "done-on-drive";
  drive.state.files.set("done-on-drive", { id: "done-on-drive", size: 100, trashed: false, md5: "m", ddKey: "UP1:0", bytes: Buffer.alloc(100) });
  assert.ok(url);
  assert.equal(await transferUpload(deps, PREFIX, clock.t + 60_000), "done");
  assert.equal((await readState(store)).files[0].driveFileId, "done-on-drive");
  assert.equal(drive.state.files.size, 1);
});

test("失敗時は R2 原本を残して記録し、次回の再試行で完了する", async () => {
  const { store, drive, deps, clock } = setup();
  drive.state.failNext = Object.assign(new Error("drive chunk upload failed (503)"), { status: 503 });
  assert.equal(await transferUpload(deps, PREFIX, clock.t + 60_000), "failed");
  let state = await readState(store);
  assert.equal(state.state, "failed");
  assert.equal(state.attempts, 1);
  assert.match(state.lastError, /503/);
  assert.equal(state.leaseUntil, 0);
  assert.deepEqual(store.deleted, []);
  assert.ok(store.objects.has(`${PREFIX}/${NAME}`));

  assert.equal(await transferUpload(deps, PREFIX, clock.t + 60_000), "done");
  state = await readState(store);
  assert.equal(state.state, "done");
  assert.equal(drive.state.files.size, 1);
});

test("セッション失効(404)は新しいセッションで最初から送り直す", async () => {
  const { drive, deps, bytes, clock } = setup();
  assert.equal(await transferUpload(deps, PREFIX, clock.t + 5), "partial");
  drive.state.sessions.clear(); // 失効
  assert.equal(await transferUpload(deps, PREFIX, clock.t + 60_000), "done");
  assert.deepEqual(new Uint8Array([...drive.state.files.values()][0].bytes), bytes);
});

test("同時実行: 実行中（リース有効）の投稿は処理しない", async () => {
  const { store, deps, clock } = setup();
  assert.equal(await transferUpload(deps, PREFIX, clock.t + 5), "partial");
  // 他の処理がリースを取っている状態にする
  const st = await readState(store);
  st.leaseUntil = clock.t + 60_000;
  await store.putObjectIf(`${PREFIX}/drive.json`, JSON.stringify(st), "application/json", {
    ifMatch: (await store.getObject(`${PREFIX}/drive.json`)).etag,
  });
  assert.equal(await transferUpload(deps, PREFIX, clock.t + 60_000), "skipped");
  clock.t += 120_000; // リース切れ
  assert.equal(await transferUpload(deps, PREFIX, clock.t + 60_000), "done");
});

test("同時実行: ETag が合わなければ（先に更新された）書き込みを諦める", async () => {
  const { store, deps, clock } = setup();
  await transferUpload(deps, PREFIX, clock.t + 5); // drive.json を作る
  const stale = (await store.getObject(`${PREFIX}/drive.json`)).etag;
  await store.putObjectIf(`${PREFIX}/drive.json`, "{}", "application/json", { ifMatch: stale });
  await assert.rejects(
    store.putObjectIf(`${PREFIX}/drive.json`, "{}", "application/json", { ifMatch: stale }),
    (err) => err.status === 412
  );
  assert.ok(deps);
});

test("manifest が complete でない投稿・受理ファイルが無い投稿は転送しない", async () => {
  const a = setup({ manifest: { status: "pending" } });
  assert.equal(await transferUpload(a.deps, PREFIX, a.clock.t + 60_000), "skipped");
  assert.equal(a.drive.state.files.size, 0);
  const files = manifestOf().files.map((f) => ({ ...f, result: "rejected" }));
  const b = setup({ manifest: { files } });
  assert.equal(await transferUpload(b.deps, PREFIX, b.clock.t + 60_000), "skipped");
});

test("失敗が続くとメールで 1 回だけ知らせる（原本は残る）", async () => {
  const { store, drive, mails, deps, clock } = setup();
  for (let i = 0; i < 4; i++) {
    drive.state.failNext = Object.assign(new Error("token refresh failed (400)"), { status: 400 });
    assert.equal(await transferUpload(deps, PREFIX, clock.t + 60_000), "failed");
  }
  assert.equal(mails.length, 1);
  assert.equal(mails[0].subject, "[Fan moments] Drive転送に失敗");
  assert.match(mails[0].text, /token refresh failed/);
  assert.deepEqual(store.deleted, []);
});

// ── R2 のクリーン ───────────────────────────────────────

const transferred = async () => {
  const ctx = setup();
  await transferUpload(ctx.deps, PREFIX, ctx.clock.t + 60_000);
  const keys = async () => (await ctx.store.listKeys(`${PREFIX}/`)).map((o) => o.key);
  return { ...ctx, keys };
};

test("クリーン: 転送確認から保持期間（7日）が過ぎるまでは消さない", async () => {
  const ctx = await transferred();
  ctx.clock.t += 7 * DAY - 1000;
  assert.equal(await cleanupUpload(ctx.deps, PREFIX, await ctx.keys()), "kept");
  assert.deepEqual(ctx.store.deleted, []);
});

test("クリーン: 保持期間後、Drive の実ファイルを再確認できたら R2 の投稿一式を消す", async () => {
  const ctx = await transferred();
  ctx.clock.t += 7 * DAY + 1000;
  assert.equal(await cleanupUpload(ctx.deps, PREFIX, await ctx.keys()), "deleted");
  assert.deepEqual(await ctx.keys(), []);
  // 記録（drive.json / manifest）は最後に消える
  assert.deepEqual(ctx.store.deleted.slice(-2), [`${PREFIX}/drive.json`, `${PREFIX}/manifest.json`]);
});

test("クリーン: Drive 側でゴミ箱・削除・サイズ不一致・別ファイルなら消さない", async () => {
  for (const mutate of [
    (d, id) => (d.state.files.get(id).trashed = true),
    (d, id) => d.state.files.delete(id),
    (d, id) => (d.state.files.get(id).size = 99),
    (d, id) => (d.state.files.get(id).ddKey = "OTHER:0"),
  ]) {
    const ctx = await transferred();
    mutate(ctx.drive, "file-1");
    ctx.clock.t += 8 * DAY;
    assert.equal(await cleanupUpload(ctx.deps, PREFIX, await ctx.keys()), "kept");
    assert.deepEqual(ctx.store.deleted, []);
    assert.ok(ctx.store.objects.has(`${PREFIX}/${NAME}`));
  }
});

test("クリーン: 転送に失敗している・未完了の投稿は、何日経っても消さない", async () => {
  const ctx = setup();
  ctx.drive.state.failNext = Object.assign(new Error("boom"), { status: 500 });
  await transferUpload(ctx.deps, PREFIX, ctx.clock.t + 60_000);
  ctx.clock.t += 400 * DAY;
  assert.equal(await cleanupUpload(ctx.deps, PREFIX, (await ctx.store.listKeys(`${PREFIX}/`)).map((o) => o.key)), "kept");
  assert.deepEqual(ctx.store.deleted, []);

  const fresh = setup(); // 転送を一度も試していない（drive.json なし）
  fresh.clock.t += 400 * DAY;
  assert.equal(await cleanupUpload(fresh.deps, PREFIX, (await fresh.store.listKeys(`${PREFIX}/`)).map((o) => o.key)), "kept");
});

test("sweep: 未転送の投稿を転送し、壊れた投稿があっても他を止めない", async () => {
  const ctx = setup();
  ctx.store.put("fan-moments/live/L9/BAD/manifest.json", "{not json");
  const r = await sweep(ctx.deps, ctx.clock.t + 60_000);
  assert.equal(r.transferred, 1);
  assert.equal(r.failed, 1);
  assert.equal((await readState(ctx.store)).state, "done");
  // 2 回目は転送済みを数え直さない
  const again = await sweep(ctx.deps, ctx.clock.t + 60_000);
  assert.equal(again.transferred, 0);
});

// ── 表示名・説明 ────────────────────────────────────────

test("LIVE フォルダ名はパス区切り等を除いた「開催日 LIVE名」", () => {
  assert.equal(liveFolderName("2026.09.20", "Spotify O-Crest『CASCADE』"), "2026.09.20 Spotify O-Crest『CASCADE』");
  assert.equal(liveFolderName("2026.09.20", "A/B:C"), "2026.09.20 A_B_C");
});

test("LIVE の日付は eventAt を日本時間で読む（保存済みの誤った liveDate より優先。+1日の補正ではない）", () => {
  // 2026-09-20T15:00:00Z = 日本時間 2026-09-21 00:00。以前の版は UTC で読んで 09.20 と保存していた
  const target = { kind: "live", liveId: "L1", liveTitle: "T", liveDate: "2026.09.20", eventAt: "2026-09-20T15:00:00.000Z" };
  const m = manifestOf({ target });
  assert.match(driveDescription(m, m.files[0]), /LIVE: 2026\.09\.21 T/);
  // 日本時間の前日 23:59 は前日のまま
  const before = manifestOf({ target: { ...target, eventAt: "2026-09-20T14:59:59.000Z" } });
  assert.match(driveDescription(before, before.files[0]), /LIVE: 2026\.09\.20 T/);
  // eventAt が無い古い manifest は保存済みの liveDate のまま
  const old = manifestOf({ target: { ...target, eventAt: undefined } });
  assert.match(driveDescription(old, old.files[0]), /LIVE: 2026\.09\.20 T/);
});

test("説明にメッセージが無い場合は (なし)", () => {
  const m = manifestOf({ message: "" });
  assert.match(driveDescription(m, m.files[0]), /メッセージ: \(なし\)/);
});

// ── R2Client の追加 API ─────────────────────────────────

const r2 = (handler) =>
  new R2Client({ accountId: "acct", bucket: "bkt", accessKeyId: "AK", secretAccessKey: "SK" }, async (url, init) => handler(String(url), init), () => T0);

test("R2Client: 範囲読み・条件付き書き込み・一覧", async () => {
  const seen = [];
  const client = r2((url, init) => {
    seen.push({ url, init });
    if (init.method === "PUT") return new Response("", { status: 200, headers: { etag: '"abc"' } });
    if (url.includes("list-type=2")) {
      return new Response(
        "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>fan-moments/a/b.jpg</Key><Size>5</Size></Contents></ListBucketResult>"
      );
    }
    return new Response(new Uint8Array([1, 2, 3]), { status: 206 });
  });
  assert.deepEqual([...(await client.readRange("fan-moments/x/y.mov", 10, 12))], [1, 2, 3]);
  assert.equal(seen[0].init.headers.Range, "bytes=10-12");

  assert.equal(await client.putObjectIf("fan-moments/x/drive.json", "{}", "application/json", { ifMatch: '"v1"' }), '"abc"');
  assert.equal(seen[1].init.headers["If-Match"], '"v1"');
  await client.putObjectIf("fan-moments/x/drive.json", "{}", "application/json", { ifNoneMatch: true });
  assert.equal(seen[2].init.headers["If-None-Match"], "*");

  assert.deepEqual(await client.listKeys("fan-moments/"), [{ key: "fan-moments/a/b.jpg", size: 5 }]);
});

test("R2Client: 条件が合わない書き込みは status 412 のエラー", async () => {
  const client = r2(() => new Response("<Error><Code>PreconditionFailed</Code></Error>", { status: 412 }));
  await assert.rejects(client.putObjectIf("k", "x", "text/plain", { ifMatch: '"v"' }), (e) => e.status === 412);
});

// ── DriveClient の転送用 API ────────────────────────────

const drive = (handler) =>
  new DriveClient({ clientId: "c", clientSecret: "s", refreshToken: "r" }, async (url, init = {}) => {
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
    }
    return handler(String(url), init);
  }, () => T0);

test("DriveClient: セッションはサーバー用（Origin なし）で、完了応答に size と md5 を含める", async () => {
  let created;
  const client = drive((url, init) => {
    created = { url, init };
    return new Response("", { status: 200, headers: { location: "https://www.googleapis.com/upload/drive/v3/files?upload_id=u" } });
  });
  const location = await client.createTransferSession({
    name: "a.jpeg",
    parentId: "P",
    size: 100,
    mimeType: "image/jpeg",
    description: "d",
    appProperties: { ddKey: "UP1:0" },
  });
  assert.match(location, /upload_id=u/);
  assert.match(created.url, /fields=id,size,md5Checksum/);
  assert.equal(created.init.headers.Origin, undefined);
  const body = JSON.parse(created.init.body);
  assert.deepEqual(body.parents, ["P"]);
  assert.equal(body.appProperties.app, "fanupload");
  assert.equal(body.appProperties.ddKey, "UP1:0");
});

test("DriveClient: チャンク送信は 308(続き)と 200(完了)を区別し、リダイレクトを追わない", async () => {
  const calls = [];
  const client = drive((url, init) => {
    calls.push(init);
    return calls.length === 1
      ? new Response("", { status: 308, headers: { range: "bytes=0-39" } })
      : new Response(JSON.stringify({ id: "F", size: "100", md5Checksum: "m" }), { status: 200 });
  });
  const url = "https://www.googleapis.com/upload/drive/v3/files?upload_id=u";
  assert.deepEqual(await client.putChunk(url, new Uint8Array(40), 0, 100), { done: false, next: 40 });
  assert.equal(calls[0].redirect, "manual");
  assert.equal(calls[0].headers["Content-Range"], "bytes 0-39/100");
  assert.deepEqual(await client.putChunk(url, new Uint8Array(60), 40, 100), { done: true, id: "F", size: 100, md5: "m" });
  assert.equal(calls[1].headers["Content-Range"], "bytes 40-99/100");
});

test("DriveClient: 受け取り前の 308 は offset 0、セッション失効(404)はエラー", async () => {
  const none = drive(() => new Response("", { status: 308 }));
  assert.deepEqual(await none.queryOffset("https://www.googleapis.com/u", 100), { done: false, next: 0 });
  const gone = drive(() => new Response("", { status: 404 }));
  await assert.rejects(gone.putChunk("https://www.googleapis.com/u", new Uint8Array(1), 0, 1), (e) => e.status === 404);
});

test("DriveClient: getFileInfo は存在・ゴミ箱・ddKey を返し、404 は null", async () => {
  const ok = drive(() => new Response(JSON.stringify({ id: "F", size: "100", trashed: false, md5Checksum: "m", appProperties: { ddKey: "UP1:0" } })));
  assert.deepEqual(await ok.getFileInfo("F"), { id: "F", size: 100, trashed: false, md5: "m", ddKey: "UP1:0" });
  const missing = drive(() => new Response("", { status: 404 }));
  assert.equal(await missing.getFileInfo("F"), null);
});

test("DriveClient: LIVE フォルダは appProperties(liveId) で探し、無ければ作る", async () => {
  const queries = [];
  let created = 0;
  const client = drive((url, init) => {
    const u = new URL(url);
    if (init.method === "POST") {
      created++;
      return new Response(JSON.stringify({ id: `new-${created}` }));
    }
    queries.push(u.searchParams.get("q"));
    const q = u.searchParams.get("q");
    if (q.includes("role' and value='fmroot")) return new Response(JSON.stringify({ files: [{ id: "ROOT" }] }));
    if (q.includes("liveId") && created === 0) return new Response(JSON.stringify({ files: [] }));
    return new Response(JSON.stringify({ files: [{ id: "new-1" }] }));
  });
  assert.equal(await client.ensureLiveFolder("L1", "2026.09.20 X"), "new-1");
  assert.ok(queries.some((q) => q.includes("'ROOT' in parents") && q.includes("key='liveId' and value='L1'")));
  assert.equal(created, 1);
});
