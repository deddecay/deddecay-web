import {
  CONSENT_VERSION,
  DEFAULT_LIMITS,
  GIB,
  PART_SIZE,
  checkDeclaredFile,
  checkDeclaredFiles,
  extensionOf,
  formatBytes,
  isLivePostable,
  matchesMagic,
  normalizeTextFields,
  sanitizeFileName,
  type DeclaredFile,
  type UploadLimits,
} from "./policy.ts";
import { issuePostToken, newPostId, verifyPostToken } from "./token.ts";
import type { R2Client, R2Part } from "./r2";
import type { NotifyMail } from "../mail";

// init / complete の処理本体。外部依存は Deps で注入する（テストではモックする）。
//
// 保存構造（R2 が原本の正本）:
//   fan-moments/live/{liveId}/{uploadId}/{ファイル群}, manifest.json
//   fan-moments/other/{uploadId}/{ファイル群}, manifest.json
// liveId は microCMS の entry.id（表示名や日付には依存しない）、uploadId は投稿ごとの ID。
// manifest.json に投稿の情報（対象 LIVE・投稿日時・ファイル名/サイズ/種別・同一投稿のファイル群）を残す。

// eventAt: 開催日時（ISO 文字列）。投稿受付期間（開催後 30 日間）の判定に使う
export type LiveRef = { id: string; title: string; dateLabel: string; eventAt?: string };

export type Deps = {
  store: Pick<
    R2Client,
    | "bucket"
    | "hasCapacity"
    | "appUsageBytes"
    | "createMultipart"
    | "presignUploadPart"
    | "abortMultipart"
    | "listParts"
    | "completeMultipart"
    | "putObject"
    | "getText"
    | "head"
    | "readHead"
    | "delete"
  >;
  verifyTurnstile: (token: unknown, ip: string) => Promise<boolean>;
  consume: (key: string, limit: number, windowSec: number, amount?: number) => Promise<{ allowed: boolean }>;
  getLive: (id: string) => Promise<LiveRef | null>;
  sendMail: (mail: NotifyMail) => Promise<{ ok: boolean }>;
  secret: string;
  allowedOrigins: readonly string[];
  limits: UploadLimits;
  appCapBytes: number;
  dailyBytesPerIp: number;
  now: () => number;
};

export type Result = { status: number; body: Record<string, unknown> };

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Result => ({
  status,
  body: { error, ...extra },
});

const MAGIC_BYTES = 32;
// 署名付き URL の有効期間（投稿トークンと同じ 24 時間）
const PART_URL_TTL_SEC = 24 * 60 * 60;
const MANIFEST_NAME = "manifest.json";

export type ManifestTarget =
  | { kind: "live"; liveId: string; liveTitle: string; liveDate: string }
  | { kind: "other" };

export type ManifestFile = {
  index: number;
  key: string;
  storedName: string;
  originalName: string;
  declaredSize: number;
  mime: string;
  kind: string;
  parts: number;
  multipartUploadId: string;
  result: "pending" | "accepted" | "rejected";
};

export type Manifest = {
  version: 1;
  uploadId: string;
  status: "pending" | "complete";
  target: ManifestTarget;
  createdAt: string;
  completedAt: string | null;
  consent: string;
  message: string;
  notified: boolean;
  files: ManifestFile[];
};

export const uploadPrefix = (target: ManifestTarget, uploadId: string): string =>
  target.kind === "live" ? `fan-moments/live/${target.liveId}/${uploadId}` : `fan-moments/other/${uploadId}`;

export const jstParts = (ms: number) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    y: get("year"),
    mo: get("month"),
    d: get("day"),
    h: get("hour"),
    mi: get("minute"),
    s: get("second"),
  };
};

export const readLimits = (env: NodeJS.ProcessEnv = process.env): UploadLimits => {
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    maxFiles: num(env.FAN_UPLOAD_MAX_FILES, DEFAULT_LIMITS.maxFiles),
    maxFileBytes: num(env.FAN_UPLOAD_MAX_FILE_GB, DEFAULT_LIMITS.maxFileBytes / GIB) * GIB,
    maxPostBytes: num(env.FAN_UPLOAD_MAX_POST_GB, DEFAULT_LIMITS.maxPostBytes / GIB) * GIB,
  };
};

export const readAllowedOrigins = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const origins = new Set<string>(["https://deddecay.tokyo", "https://www.deddecay.tokyo"]);
  if (env.VERCEL_URL) origins.add(`https://${env.VERCEL_URL}`);
  if (env.VERCEL_BRANCH_URL) origins.add(`https://${env.VERCEL_BRANCH_URL}`);
  if (env.NODE_ENV !== "production") {
    origins.add("http://localhost:3000");
    origins.add("http://127.0.0.1:3000");
  }
  for (const extra of (env.FAN_UPLOAD_ALLOWED_ORIGINS ?? "").split(",")) {
    const trimmed = extra.trim();
    if (trimmed) origins.add(trimmed);
  }
  return [...origins];
};

const ipSlug = (ip: string) => ip.replace(/[^0-9a-fA-F:.]/g, "").slice(0, 45) || "unknown";

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

// ── init ──────────────────────────────────────────────

export type InitContext = { ip: string; origin: string | null };

export const handleInit = async (rawBody: unknown, ctx: InitContext, deps: Deps): Promise<Result> => {
  if (!ctx.origin || !deps.allowedOrigins.includes(ctx.origin)) return fail(403, "許可されていないリクエストです");

  const ip = ipSlug(ctx.ip);
  const burst = await deps.consume(`init:burst:${ip}`, 6, 600);
  const daily = await deps.consume(`init:day:${ip}`, 30, 86_400);
  if (!burst.allowed || !daily.allowed) {
    return fail(429, "短時間に送信が集中しています。しばらくしてからお試しください");
  }

  if (!rawBody || typeof rawBody !== "object") return fail(400, "不正なリクエストです");
  const body = rawBody as Record<string, unknown>;

  if (body.consent !== true) return fail(400, "利用許諾への同意が必要です");

  const text = normalizeTextFields(body);
  if (!text.ok) return fail(400, text.reason);

  const files = body.files as DeclaredFile[];
  const declared = checkDeclaredFiles(files, deps.limits);
  if (!declared.ok) return fail(400, declared.reason);

  const kind = body.kind;
  let live: LiveRef | null = null;
  if (kind === "live") {
    if (typeof body.liveId !== "string" || !SAFE_ID.test(body.liveId)) {
      return fail(400, "公演を選択してください");
    }
  } else if (kind !== "other") {
    return fail(400, "投稿の種類を選択してください");
  }

  if (!(await deps.verifyTurnstile(body.turnstileToken, ctx.ip))) {
    return fail(403, "ボット対策の確認に失敗しました。ページを再読み込みしてお試しください");
  }

  if (kind === "live") {
    live = await deps.getLive(body.liveId as string);
    if (!live || !SAFE_ID.test(live.id)) return fail(400, "選択した公演が見つかりません");
    if (!isLivePostable(live.eventAt, deps.now())) {
      return fail(400, "この公演は現在、アップロードを受け付けていません（ライブ開催後30日間のみ受付）");
    }
  }

  const bytes = await deps.consume(`init:bytes:${ip}`, deps.dailyBytesPerIp, 86_400, declared.totalBytes);
  if (!bytes.allowed) return fail(429, "本日の送信容量の上限に達しました。明日以降にお試しください");

  const started: { key: string; uploadId: string }[] = [];
  try {
    if (!(await deps.store.hasCapacity(declared.totalBytes, { appCapBytes: deps.appCapBytes }))) {
      return fail(503, "現在、投稿の受付容量がいっぱいです。時間をおいてお試しください");
    }

    const now = deps.now();
    const t = jstParts(now);
    const postId = newPostId();
    const stamp = `${t.y}${t.mo}${t.d}-${t.h}${t.mi}${t.s}`;
    const target: ManifestTarget = live
      ? { kind: "live", liveId: live.id, liveTitle: live.title, liveDate: live.dateLabel }
      : { kind: "other" };
    const prefix = uploadPrefix(target, postId);

    const uploads: { name: string; partSize: number; parts: string[] }[] = [];
    const manifestFiles: ManifestFile[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const check = checkDeclaredFile(file, deps.limits);
      if (!check.ok) throw new Error(check.reason);
      const storedName = `${stamp}_${i + 1}_${sanitizeFileName(file.name)}`;
      const key = `${prefix}/${storedName}`;
      const multipartUploadId = await deps.store.createMultipart(key, check.mime);
      started.push({ key, uploadId: multipartUploadId });

      const partCount = Math.max(1, Math.ceil(file.size / PART_SIZE));
      const parts: string[] = [];
      for (let n = 1; n <= partCount; n++) {
        parts.push(deps.store.presignUploadPart(key, multipartUploadId, n, PART_URL_TTL_SEC));
      }
      uploads.push({ name: file.name, partSize: PART_SIZE, parts });
      manifestFiles.push({
        index: i,
        key,
        storedName,
        originalName: file.name,
        declaredSize: file.size,
        mime: check.mime,
        kind: check.kind,
        parts: partCount,
        multipartUploadId,
        result: "pending",
      });
    }

    const manifest: Manifest = {
      version: 1,
      uploadId: postId,
      status: "pending",
      target,
      createdAt: new Date(now).toISOString(),
      completedAt: null,
      consent: CONSENT_VERSION,
      message: text.value.message,
      notified: false,
      files: manifestFiles,
    };
    await deps.store.putObject(`${prefix}/${MANIFEST_NAME}`, JSON.stringify(manifest, null, 2), "application/json");

    const token = issuePostToken(
      deps.secret,
      { pid: postId, n: files.length, total: declared.totalBytes, k: prefix },
      now
    );
    return { status: 200, body: { postId, token, uploads } };
  } catch (err) {
    console.error("[fan-upload] init error:", err);
    // 作りかけのマルチパートアップロードを片付ける（残ると未使用のパート分が課金対象になるため）
    await Promise.allSettled(started.map((s) => deps.store.abortMultipart(s.key, s.uploadId)));
    return fail(502, "保存先の準備に失敗しました。時間をおいてお試しください");
  }
};

// ── complete ──────────────────────────────────────────

type Probe =
  | { file: ManifestFile; state: "settled" }
  | { file: ManifestFile; state: "stored" } // 結合済みのオブジェクトが既にある
  | { file: ManifestFile; state: "incomplete" }
  | { file: ManifestFile; state: "bad" } // パートの内訳が申告と合わない
  | { file: ManifestFile; state: "ready"; parts: R2Part[] };

const probeFile = async (deps: Deps, file: ManifestFile): Promise<Probe> => {
  if (file.result !== "pending") return { file, state: "settled" };
  if (await deps.store.head(file.key)) return { file, state: "stored" };

  let parts: R2Part[];
  try {
    parts = await deps.store.listParts(file.key, file.multipartUploadId);
  } catch (err) {
    if ((err as { status?: number }).status === 404) return { file, state: "incomplete" };
    throw err;
  }
  if (parts.length < file.parts) return { file, state: "incomplete" };
  const contiguous = parts.length === file.parts && parts.every((p, i) => p.number === i + 1);
  const total = parts.reduce((sum, p) => sum + p.size, 0);
  if (!contiguous || total !== file.declaredSize) return { file, state: "bad" };
  return { file, state: "ready", parts };
};

const buildMail = (manifest: Manifest, accepted: ManifestFile[], rejected: number, deps: Deps, usage: number | null) => {
  const { target } = manifest;
  const created = jstParts(Date.parse(manifest.createdAt));
  const prefix = uploadPrefix(target, manifest.uploadId);
  const total = accepted.reduce((sum, f) => sum + f.declaredSize, 0);
  const place =
    target.kind === "live" ? `LIVE: ${target.liveDate} ${target.liveTitle} (${target.liveId})` : "その他";
  const lines = [
    "DD UPLOAD に投稿が届きました。",
    "",
    `投稿ID: ${manifest.uploadId}`,
    `区分: ${place}`,
    `投稿日時(JST): ${created.y}-${created.mo}-${created.d} ${created.h}:${created.mi}:${created.s}`,
    `ファイル数: ${accepted.length}件 / 合計 ${formatBytes(total)}`,
    ...(rejected > 0 ? [`検証で除外: ${rejected}件`] : []),
    "",
    "── 保存先（Cloudflare R2・非公開） ──",
    `バケット: ${deps.store.bucket}`,
    `フォルダ: ${prefix}/`,
    `投稿情報: ${prefix}/${MANIFEST_NAME}`,
    "確認方法: Cloudflare ダッシュボード > R2 > 上記バケット > 上記フォルダ",
    ...(usage !== null ? [`R2 使用量(概算): ${formatBytes(usage)} / 受付上限 ${formatBytes(deps.appCapBytes)}`] : []),
    "",
    "── 投稿内容 ──",
    manifest.message ? `メッセージ: ${manifest.message}` : "(メッセージなし)",
    "",
    "ファイル:",
    ...accepted.map((f) => `- ${f.originalName} (${formatBytes(f.declaredSize)})`),
  ];
  return {
    subject: `[Fan moments] ${target.kind === "live" ? "LIVE" : "その他"} / ${accepted.length}件`,
    text: lines.join("\n"),
  };
};

export const handleComplete = async (
  rawBody: unknown,
  ctx: { ip: string; origin: string | null },
  deps: Deps
): Promise<Result> => {
  if (!ctx.origin || !deps.allowedOrigins.includes(ctx.origin)) return fail(403, "許可されていないリクエストです");

  const ip = ipSlug(ctx.ip);
  const rate = await deps.consume(`complete:${ip}`, 60, 600);
  if (!rate.allowed) return fail(429, "リクエストが集中しています。しばらくしてからお試しください");

  const body = (rawBody && typeof rawBody === "object" ? rawBody : {}) as Record<string, unknown>;
  const payload = verifyPostToken(deps.secret, body.token, deps.now());
  if (!payload || !payload.k || !payload.k.endsWith(`/${payload.pid}`)) {
    return fail(401, "投稿の確認情報が無効です。最初からやり直してください");
  }
  const prefix = payload.k;
  const manifestKey = `${prefix}/${MANIFEST_NAME}`;

  try {
    const stored = await deps.store.getText(manifestKey);
    if (!stored) return fail(409, "投稿情報が見つかりません。最初からやり直してください");
    const manifest = JSON.parse(stored) as Manifest;
    if (manifest.uploadId !== payload.pid || manifest.files.length !== payload.n) {
      return fail(401, "投稿の確認情報が無効です。最初からやり直してください");
    }

    // 1) 全ファイルのアップロードが揃っているか（揃っていなければ何も確定しない）
    const probes = await Promise.all(manifest.files.map((file) => probeFile(deps, file)));
    const missing = probes.filter((p) => p.state === "incomplete").length;
    if (missing > 0) {
      return fail(409, "アップロードが完了していないファイルがあります", {
        uploaded: manifest.files.length - missing,
        expected: manifest.files.length,
      });
    }

    // 2) 結合・サイズ確認・先頭バイト検証。不正なものは削除して除外する
    await Promise.all(
      probes.map(async (probe) => {
        const file = probe.file;
        if (probe.state === "settled") return;
        let valid = probe.state !== "bad";
        if (probe.state === "bad") {
          await deps.store.abortMultipart(file.key, file.multipartUploadId);
        } else if (probe.state === "ready") {
          await deps.store.completeMultipart(file.key, file.multipartUploadId, probe.parts);
        }
        if (valid) {
          const info = await deps.store.head(file.key);
          valid = info !== null && info.size === file.declaredSize && file.declaredSize > 0;
          if (valid) {
            const head = await deps.store.readHead(file.key, MAGIC_BYTES);
            valid = matchesMagic(extensionOf(file.storedName), head);
          }
          if (!valid) await deps.store.delete(file.key);
        }
        file.result = valid ? "accepted" : "rejected";
      })
    );

    const accepted = manifest.files.filter((f) => f.result === "accepted");
    const rejected = manifest.files.filter((f) => f.result === "rejected").length;

    manifest.status = "complete";
    manifest.completedAt ??= new Date(deps.now()).toISOString();
    // 先に確定結果を保存する（メール送信が失敗しても保存済みの結果は残る）
    await deps.store.putObject(manifestKey, JSON.stringify(manifest, null, 2), "application/json");

    if (accepted.length === 0) {
      return fail(422, "ファイルの内容を確認できませんでした。形式をご確認ください", { rejected });
    }

    let mailed = manifest.notified;
    if (!manifest.notified) {
      let usage: number | null = null;
      try {
        usage = await deps.store.appUsageBytes();
      } catch {
        // 使用量の取得に失敗しても通知は送る
      }
      const mail = await deps.sendMail(buildMail(manifest, accepted, rejected, deps, usage));
      mailed = mail.ok;
      if (mail.ok) {
        manifest.notified = true;
        try {
          await deps.store.putObject(manifestKey, JSON.stringify(manifest, null, 2), "application/json");
        } catch (err) {
          console.error(`[fan-upload] manifest update after notify failed post=${payload.pid}:`, err);
        }
      } else {
        console.error(`[fan-upload] notify failed post=${payload.pid} (files are saved)`);
      }
    }

    return { status: 200, body: { ok: true, accepted: accepted.length, rejected, mailed } };
  } catch (err) {
    console.error("[fan-upload] complete error:", err);
    return fail(502, "保存結果の確認に失敗しました。時間をおいて再度お試しください");
  }
};
