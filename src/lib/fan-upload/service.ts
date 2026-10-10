import {
  CONSENT_VERSION,
  DEFAULT_LIMITS,
  GIB,
  checkDeclaredFile,
  checkDeclaredFiles,
  extensionOf,
  formatBytes,
  matchesMagic,
  normalizeTextFields,
  sanitizeFileName,
  sanitizeSegment,
  type DeclaredFile,
  type UploadLimits,
} from "./policy.ts";
import { issuePostToken, newPostId, verifyPostToken } from "./token.ts";
import type { DriveClient, DriveFile } from "./drive";
import type { NotifyMail } from "../mail";

// init / complete の処理本体。外部依存は Deps で注入する（テストではモックする）。

export type LiveRef = { id: string; title: string; dateLabel: string };

export type Deps = {
  drive: Pick<
    DriveClient,
    | "ensureFolderPath"
    | "createResumableSession"
    | "listPostFiles"
    | "readHead"
    | "trash"
    | "markNotified"
    | "hasCapacity"
  >;
  verifyTurnstile: (token: unknown, ip: string) => Promise<boolean>;
  consume: (key: string, limit: number, windowSec: number, amount?: number) => Promise<{ allowed: boolean }>;
  getLive: (id: string) => Promise<LiveRef | null>;
  sendMail: (mail: NotifyMail) => Promise<{ ok: boolean }>;
  secret: string;
  allowedOrigins: readonly string[];
  limits: UploadLimits;
  appCapBytes: number;
  reserveBytes: number;
  dailyBytesPerIp: number;
  now: () => number;
};

export type Result = { status: number; body: Record<string, unknown> };

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Result => ({
  status,
  body: { error, ...extra },
});

const MAGIC_BYTES = 32;

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
    if (typeof body.liveId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.liveId)) {
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
    if (!live) return fail(400, "選択した公演が見つかりません");
  }

  const bytes = await deps.consume(`init:bytes:${ip}`, deps.dailyBytesPerIp, 86_400, declared.totalBytes);
  if (!bytes.allowed) return fail(429, "本日の送信容量の上限に達しました。明日以降にお試しください");

  try {
    if (!(await deps.drive.hasCapacity(declared.totalBytes, { appCapBytes: deps.appCapBytes, reserveBytes: deps.reserveBytes }))) {
      return fail(503, "現在、投稿の受付容量がいっぱいです。時間をおいてお試しください");
    }

    const now = deps.now();
    const t = jstParts(now);
    const segments = live
      ? ["LIVE", live.dateLabel.slice(0, 4) || t.y, `${live.dateLabel}_${sanitizeSegment(live.title, 60)}__${live.id}`]
      : ["OTHER", `${t.y}-${t.mo}`];
    const parentId = await deps.drive.ensureFolderPath(segments);

    const postId = newPostId();
    const stamp = `${t.y}${t.mo}${t.d}-${t.h}${t.mi}${t.s}`;
    const description = [
      text.value.message ? `メッセージ: ${text.value.message}` : null,
      live ? `公演: ${live.dateLabel} ${live.title} (${live.id})` : "公演: なし(その他)",
      `利用許諾: ${CONSENT_VERSION}`,
      `投稿ID: ${postId}`,
    ]
      .filter(Boolean)
      .join("\n");

    const uploads: { name: string; sessionUrl: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const check = checkDeclaredFile(file, deps.limits);
      if (!check.ok) return fail(400, check.reason);
      const name = `${stamp}_${i + 1}_${sanitizeFileName(file.name)}`;
      const sessionUrl = await deps.drive.createResumableSession({
        name,
        parentId,
        size: file.size,
        mimeType: check.mime,
        description,
        appProperties: {
          app: "fanupload",
          postId,
          idx: String(i),
          declSize: String(file.size),
          target: live ? live.id : "other",
          consent: CONSENT_VERSION,
        },
        origin: ctx.origin,
      });
      uploads.push({ name: file.name, sessionUrl });
    }

    const token = issuePostToken(deps.secret, { pid: postId, n: files.length, total: declared.totalBytes }, now);
    return { status: 200, body: { postId, token, uploads } };
  } catch (err) {
    console.error("[fan-upload] init error:", err);
    return fail(502, "保存先の準備に失敗しました。時間をおいてお試しください");
  }
};

// ── complete ──────────────────────────────────────────

const toIdx = (file: DriveFile) => Number(file.appProperties.idx ?? 0);

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
  if (!payload) return fail(401, "投稿の確認情報が無効です。最初からやり直してください");

  try {
    const files = (await deps.drive.listPostFiles(payload.pid)).sort((a, b) => toIdx(a) - toIdx(b));
    if (files.length < payload.n) {
      return fail(409, "アップロードが完了していないファイルがあります", {
        uploaded: files.length,
        expected: payload.n,
      });
    }

    const accepted: DriveFile[] = [];
    const rejected: string[] = [];
    let acceptedBytes = 0;
    for (const file of files) {
      const declSize = Number(file.appProperties.declSize);
      let valid = file.size > 0 && file.size === declSize && acceptedBytes + file.size <= payload.total;
      if (valid) {
        const head = await deps.drive.readHead(file.id, MAGIC_BYTES);
        valid = matchesMagic(extensionOf(file.name), head);
      }
      if (valid) {
        accepted.push(file);
        acceptedBytes += file.size;
      } else {
        rejected.push(file.name);
        await deps.drive.trash(file.id);
      }
    }

    if (accepted.length === 0) {
      return fail(422, "ファイルの内容を確認できませんでした。形式をご確認ください", { rejected: rejected.length });
    }

    const alreadyNotified = accepted.every((f) => f.appProperties.notified === "1");
    let mailed = alreadyNotified;
    if (!alreadyNotified) {
      const first = accepted[0];
      const description = first.appProperties;
      const liveTarget = description.target && description.target !== "other" ? description.target : null;
      const folderLink = first.parents[0] ? `https://drive.google.com/drive/folders/${first.parents[0]}` : "(不明)";
      const lines = [
        `DD UPLOAD に投稿が届きました。`,
        "",
        `投稿ID: ${payload.pid}`,
        `区分: ${liveTarget ? `LIVE (${liveTarget})` : "その他"}`,
        `保存先フォルダ(オーナーのみ閲覧可): ${folderLink}`,
        `ファイル数: ${accepted.length}件 / 合計 ${formatBytes(acceptedBytes)}`,
        ...(rejected.length > 0 ? [`検証で除外: ${rejected.length}件`] : []),
        "",
        "── 投稿内容 ──",
        first.description || "(記録なし)",
        "",
        "ファイル:",
        ...accepted.map((f) => `- ${f.name} (${formatBytes(f.size)})`),
      ];
      const mail = await deps.sendMail({
        subject: `[DD UPLOAD]${liveTarget ? "LIVE" : "その他"} ${accepted.length}件`,
        text: lines.join("\n"),
      });
      mailed = mail.ok;
      if (mail.ok) {
        for (const f of accepted) await deps.drive.markNotified(f.id);
      } else {
        console.error(`[fan-upload] notify failed post=${payload.pid} (files are saved)`);
      }
    }

    return { status: 200, body: { ok: true, accepted: accepted.length, rejected: rejected.length, mailed } };
  } catch (err) {
    console.error("[fan-upload] complete error:", err);
    return fail(502, "保存結果の確認に失敗しました。時間をおいて再度お試しください");
  }
};
