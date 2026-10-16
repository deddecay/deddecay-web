import { formatBytes, sanitizeSegment } from "./policy.ts";
import { jstParts, liveDateLabel, type Manifest, type ManifestFile } from "./service.ts";
import type { R2Client } from "./r2";
import type { DriveClient } from "./drive";
import type { NotifyMail } from "../mail";

// R2 → Google Drive の転送と、転送済み投稿の R2 クリーン。
//
//   R2 が受付・一時保管・転送バッファ、Google Drive が最終保存先。
//   投稿ごとの状態は fan-moments/.../{uploadId}/drive.json に持つ（アップロード側の manifest.json には触れない）。
//
//   転送: complete 直後に after() で 1 回、以降は日次 Cron が再試行する。R2 から範囲読みして
//         Drive の resumable セッションへチャンクで送る。進捗（セッション URL とオフセット）は
//         チャンクごとに drive.json へ保存し、時間切れでも次回その続きから送る。
//   排他: drive.json の更新は R2 の条件付き書き込み（ETag）で行い、同時に動いた処理は一方が退く。
//   重複: 作成前に appProperties.ddKey（{uploadId}:{index}）で Drive を検索する。
//   削除: 全ファイルが Drive で確認できた投稿に限り、確認から保持期間が過ぎたら R2 から消す。
//         消す直前に Drive の実ファイルを再確認する。転送できていない投稿は決して消さない。

export const DRIVE_STATE_NAME = "drive.json";
const MANIFEST_NAME = "manifest.json";
const ROOT_PREFIX = "fan-moments/";

// Drive の resumable アップロードのチャンクは 256 KiB の倍数が必須（最後のチャンクを除く）
export const CHUNK_BYTES = 32 * 1024 * 1024;
const LEASE_MS = 90_000;
const SESSION_RESET_LIMIT = 3;
const ALERT_AFTER_MS = 24 * 60 * 60 * 1000;
const ALERT_AFTER_ATTEMPTS = 3;
export const DEFAULT_RETENTION_DAYS = 7;

export type DriveFileState = {
  index: number;
  driveFileId: string | null;
  sessionUrl: string | null;
  offset: number;
  size: number;
  md5: string;
  done: boolean;
};

export type DriveState = {
  version: 1;
  uploadId: string;
  state: "pending" | "done" | "failed";
  attempts: number;
  lastError: string | null;
  alertedAt: string | null;
  leaseUntil: number;
  folderId: string | null;
  startedAt: string;
  doneAt: string | null;
  files: DriveFileState[];
};

export type TransferDeps = {
  store: Pick<R2Client, "getObject" | "putObjectIf" | "readRange" | "listKeys" | "delete">;
  drive: Pick<
    DriveClient,
    | "ensureLiveFolder"
    | "ensureOtherFolder"
    | "ensureMediaFolder"
    | "findByKey"
    | "getFileInfo"
    | "createTransferSession"
    | "putChunk"
    | "queryOffset"
  >;
  sendMail: (mail: NotifyMail) => Promise<{ ok: boolean }>;
  now: () => number;
  retentionMs: number;
  chunkBytes?: number;
};

export type TransferOutcome = "done" | "partial" | "failed" | "skipped";

const isStatus = (err: unknown, status: number[]) =>
  typeof (err as { status?: number })?.status === "number" && status.includes((err as { status: number }).status);

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300);

// ── 状態の読み書き ─────────────────────────────────────

const loadState = async (deps: TransferDeps, prefix: string) => {
  const stored = await deps.store.getObject(`${prefix}/${DRIVE_STATE_NAME}`);
  if (!stored) return { state: null as DriveState | null, etag: null as string | null };
  return { state: JSON.parse(stored.text) as DriveState, etag: stored.etag };
};

// 条件が合わない（他の処理が先に更新した）ときは R2Error(412) が投げられる
const saveState = (deps: TransferDeps, prefix: string, state: DriveState, etag: string | null): Promise<string> =>
  deps.store.putObjectIf(
    `${prefix}/${DRIVE_STATE_NAME}`,
    JSON.stringify(state, null, 2),
    "application/json",
    etag ? { ifMatch: etag } : { ifNoneMatch: true }
  );

const initialState = (manifest: Manifest, accepted: ManifestFile[], now: number): DriveState => ({
  version: 1,
  uploadId: manifest.uploadId,
  state: "pending",
  attempts: 0,
  lastError: null,
  alertedAt: null,
  leaseUntil: 0,
  folderId: null,
  startedAt: new Date(now).toISOString(),
  doneAt: null,
  files: accepted.map((f) => ({
    index: f.index,
    driveFileId: null,
    sessionUrl: null,
    offset: 0,
    size: f.declaredSize,
    md5: "",
    done: false,
  })),
});

// ── Drive 側の見え方 ───────────────────────────────────

// 日付単位のフォルダの下を、ファイル種別で分ける: 画像 → photo / 動画 → movie。
// 種別は投稿時に拡張子で確定して manifest に残っている kind を使い、無ければ MIME で判定する。
// 画像でも動画でもない（音声など）ものは、日付単位のフォルダ直下に置く（従来どおり）。
export const mediaFolderOf = (file: Pick<ManifestFile, "kind" | "mime">): "photo" | "movie" | null => {
  if (file.kind === "image") return "photo";
  if (file.kind === "video") return "movie";
  if (file.mime?.startsWith("image/")) return "photo";
  if (file.mime?.startsWith("video/")) return "movie";
  return null;
};

export const liveFolderName = (liveDate: string, liveTitle: string): string =>
  sanitizeSegment(`${liveDate} ${liveTitle}`, 100);

export const driveDescription = (manifest: Manifest, file: ManifestFile): string => {
  const t = jstParts(Date.parse(manifest.createdAt));
  const place =
    manifest.target.kind === "live" ? `LIVE: ${liveDateLabel(manifest.target)} ${manifest.target.liveTitle}` : "その他";
  return [
    "Fan moments の投稿",
    `区分: ${place}`,
    `投稿日時(JST): ${t.y}-${t.mo}-${t.d} ${t.h}:${t.mi}:${t.s}`,
    `メッセージ: ${manifest.message || "(なし)"}`,
    `元のファイル名: ${file.originalName}`,
    `投稿ID: ${manifest.uploadId}`,
  ].join("\n");
};

const ddKeyOf = (uploadId: string, index: number) => `${uploadId}:${index}`;

// ── 1 投稿の転送 ───────────────────────────────────────

export const transferUpload = async (
  deps: TransferDeps,
  prefix: string,
  deadline: number
): Promise<TransferOutcome> => {
  const manifestObj = await deps.store.getObject(`${prefix}/${MANIFEST_NAME}`);
  if (!manifestObj) return "skipped";
  const manifest = JSON.parse(manifestObj.text) as Manifest;
  if (manifest.status !== "complete") return "skipped";
  const accepted = manifest.files.filter((f) => f.result === "accepted");
  if (accepted.length === 0) return "skipped";

  const loaded = await loadState(deps, prefix);
  const state = loaded.state ?? initialState(manifest, accepted, deps.now());
  let etag = loaded.etag;
  if (state.state === "done") return "skipped"; // 転送済み（クリーンは別処理）
  if (state.leaseUntil > deps.now()) return "skipped"; // 他の処理が実行中

  // リース（実行権）を取る。ここで 412 になれば他の処理が先に取った
  try {
    state.leaseUntil = deps.now() + LEASE_MS;
    etag = await saveState(deps, prefix, state, etag);
  } catch (err) {
    if (isStatus(err, [412])) return "skipped";
    throw err;
  }

  const persist = async () => {
    state.leaseUntil = deps.now() + LEASE_MS;
    etag = await saveState(deps, prefix, state, etag);
  };

  try {
    const folderId =
      manifest.target.kind === "live"
        ? await deps.drive.ensureLiveFolder(
            manifest.target.liveId,
            liveFolderName(liveDateLabel(manifest.target), manifest.target.liveTitle)
          )
        : await deps.drive.ensureOtherFolder();
    state.folderId = folderId;

    const chunkBytes = deps.chunkBytes ?? CHUNK_BYTES;
    for (const file of accepted) {
      const fs = state.files.find((f) => f.index === file.index);
      if (!fs || fs.done) continue;
      const ddKey = ddKeyOf(manifest.uploadId, file.index);
      let resets = 0;

      const markDone = (id: string, size: number, md5: string) => {
        if (size !== file.declaredSize) {
          throw new Error(`Drive 上のサイズが一致しません (${size} / ${file.declaredSize})`);
        }
        fs.driveFileId = id;
        fs.size = size;
        fs.md5 = md5;
        fs.sessionUrl = null;
        fs.offset = size;
        fs.done = true;
      };

      // 既に Drive にある（前回、完了の記録だけ失敗した）なら再送しない
      if (!fs.driveFileId && !fs.sessionUrl) {
        const existing = (await deps.drive.findByKey(ddKey)).find((f) => f.size === file.declaredSize);
        if (existing) {
          markDone(existing.id, existing.size, existing.md5);
          await persist();
          continue;
        }
      }

      while (!fs.done) {
        if (deps.now() >= deadline) {
          // 時間切れ。続きは次回の実行（リースは手放す）
          state.leaseUntil = 0;
          await saveState(deps, prefix, state, etag);
          return "partial";
        }
        if (!fs.sessionUrl) {
          const media = mediaFolderOf(file);
          const parentId = media ? await deps.drive.ensureMediaFolder(folderId, media) : folderId;
          fs.sessionUrl = await deps.drive.createTransferSession({
            name: file.storedName,
            parentId,
            size: file.declaredSize,
            mimeType: file.mime,
            description: driveDescription(manifest, file),
            appProperties: {
              ddKey,
              uploadId: manifest.uploadId,
              ...(manifest.target.kind === "live" ? { liveId: manifest.target.liveId } : {}),
            },
          });
          fs.offset = 0;
          await persist();
        } else {
          // 保存済みセッションは、Drive が受け取り済みのオフセットに合わせ直してから続ける
          try {
            const status = await deps.drive.queryOffset(fs.sessionUrl, file.declaredSize);
            if (status.done) {
              markDone(status.id, status.size, status.md5);
              await persist();
              break;
            }
            fs.offset = status.next;
          } catch (err) {
            if (isStatus(err, [404, 410]) && resets < SESSION_RESET_LIMIT) {
              resets++;
              fs.sessionUrl = null;
              fs.offset = 0;
              continue;
            }
            throw err;
          }
        }

        const start = fs.offset;
        const end = Math.min(start + chunkBytes, file.declaredSize) - 1;
        const bytes = await deps.store.readRange(file.key, start, end);
        if (bytes.byteLength !== end - start + 1) throw new Error("R2 から読み出したサイズが想定と違います");
        try {
          const res = await deps.drive.putChunk(fs.sessionUrl, bytes, start, file.declaredSize);
          if (res.done) markDone(res.id, res.size, res.md5);
          else fs.offset = res.next;
        } catch (err) {
          if (isStatus(err, [404, 410]) && resets < SESSION_RESET_LIMIT) {
            resets++;
            fs.sessionUrl = null;
            fs.offset = 0;
            continue;
          }
          throw err;
        }
        await persist();
      }
    }

    state.state = "done";
    state.doneAt = new Date(deps.now()).toISOString();
    state.lastError = null;
    state.leaseUntil = 0;
    await saveState(deps, prefix, state, etag);
    return "done";
  } catch (err) {
    if (isStatus(err, [412])) return "skipped"; // 実行権を失った。後始末は勝った側に任せる
    console.error(`[fan-upload] drive transfer failed post=${manifest.uploadId}:`, messageOf(err));
    state.state = "failed";
    state.attempts += 1;
    state.lastError = messageOf(err);
    state.leaseUntil = 0;
    try {
      await maybeAlert(deps, manifest, state);
      await saveState(deps, prefix, state, etag);
    } catch (saveErr) {
      console.error("[fan-upload] drive state save failed:", messageOf(saveErr));
    }
    return "failed";
  }
};

// 失敗が続いている投稿を 1 回だけメールで知らせる（R2 の原本は残っている）
const maybeAlert = async (deps: TransferDeps, manifest: Manifest, state: DriveState) => {
  if (state.alertedAt) return;
  const age = deps.now() - Date.parse(manifest.completedAt ?? manifest.createdAt);
  if (age < ALERT_AFTER_MS && state.attempts < ALERT_AFTER_ATTEMPTS) return;
  const total = manifest.files.filter((f) => f.result === "accepted").reduce((s, f) => s + f.declaredSize, 0);
  const mail = await deps.sendMail({
    subject: "[Fan moments] Drive転送に失敗",
    text: [
      "Fan moments の投稿を Google Drive へ転送できていません。",
      "R2 の原本は削除されずに残っています。自動で再試行します。",
      "",
      `投稿ID: ${manifest.uploadId}`,
      `ファイル: ${manifest.files.filter((f) => f.result === "accepted").length}件 / ${formatBytes(total)}`,
      `試行回数: ${state.attempts}`,
      `直近のエラー: ${state.lastError ?? "(なし)"}`,
      "",
      "続く場合は、Google のトークン失効（再認証が必要）や Drive の容量を確認してください。",
    ].join("\n"),
  });
  if (mail.ok) state.alertedAt = new Date(deps.now()).toISOString();
};

// ── R2 のクリーン（転送確認済み＋保持期間経過のみ） ────────

export const cleanupUpload = async (
  deps: TransferDeps,
  prefix: string,
  keys: readonly string[]
): Promise<"deleted" | "kept"> => {
  const loaded = await loadState(deps, prefix);
  const state = loaded.state;
  if (!state || state.state !== "done" || !state.doneAt) return "kept";
  if (deps.now() - Date.parse(state.doneAt) < deps.retentionMs) return "kept";
  if (state.files.length === 0 || state.files.some((f) => !f.done || !f.driveFileId)) return "kept";

  // 消す直前に Drive の実ファイルを確認する（存在・ゴミ箱でない・サイズ一致・同じ投稿のファイル）
  for (const f of state.files) {
    const info = await deps.drive.getFileInfo(f.driveFileId as string);
    if (!info || info.trashed || info.size !== f.size || info.ddKey !== ddKeyOf(state.uploadId, f.index)) {
      console.error(`[fan-upload] cleanup skipped post=${state.uploadId}: Drive 側の確認に失敗 index=${f.index}`);
      return "kept";
    }
  }

  const stateKey = `${prefix}/${DRIVE_STATE_NAME}`;
  const manifestKey = `${prefix}/${MANIFEST_NAME}`;
  for (const key of keys) {
    if (key === stateKey || key === manifestKey || !key.startsWith(`${prefix}/`)) continue;
    await deps.store.delete(key);
  }
  // 記録は最後に消す（途中で止まっても次回、続きから消せる）
  await deps.store.delete(stateKey);
  await deps.store.delete(manifestKey);
  return "deleted";
};

// ── 全体（Cron から） ──────────────────────────────────

export type SweepResult = { transferred: number; partial: number; failed: number; deleted: number };

export const sweep = async (deps: TransferDeps, deadline: number): Promise<SweepResult> => {
  const result: SweepResult = { transferred: 0, partial: 0, failed: 0, deleted: 0 };
  const listed = await deps.store.listKeys(ROOT_PREFIX);
  const keysByPrefix = new Map<string, string[]>();
  for (const { key } of listed) {
    const slash = key.lastIndexOf("/");
    if (slash < 0) continue;
    const prefix = key.slice(0, slash);
    const list = keysByPrefix.get(prefix) ?? [];
    list.push(key);
    keysByPrefix.set(prefix, list);
  }

  for (const [prefix, keys] of keysByPrefix) {
    if (!keys.includes(`${prefix}/${MANIFEST_NAME}`)) continue;
    if (deps.now() >= deadline) break;
    try {
      const outcome = await transferUpload(deps, prefix, deadline);
      if (outcome === "done") result.transferred++;
      else if (outcome === "partial") result.partial++;
      else if (outcome === "failed") result.failed++;
      if ((await cleanupUpload(deps, prefix, keys)) === "deleted") result.deleted++;
    } catch (err) {
      // 1 件の異常（壊れた JSON など）で他の投稿の処理を止めない
      console.error(`[fan-upload] sweep error prefix=${prefix}:`, messageOf(err));
      result.failed++;
    }
  }
  return result;
};
