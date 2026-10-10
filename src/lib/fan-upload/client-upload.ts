// ブラウザ → Google Drive の resumable upload（チャンク PUT）。
// iPhone の画面ロック・回線切替で中断しやすいため、失敗時は受信済み位置を問い合わせて再開する。

// Drive の要件: 256 KiB の倍数
export const CHUNK_SIZE = 16 * 1024 * 1024;
const MAX_ATTEMPTS = 8;

export type ProgressFn = (uploadedBytes: number) => void;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    });
  });

// "bytes=0-12345" → 受信済みの次の位置 (12346)
export const parseRangeHeader = (value: string | null): number | null => {
  if (!value) return null;
  const match = /^bytes=0-(\d+)$/.exec(value.trim());
  return match ? Number(match[1]) + 1 : null;
};

const isDone = (status: number) => status === 200 || status === 201;

// セッションの受信済み位置を問い合わせる。完了済みなら "done"、不明なら null
const queryOffset = async (sessionUrl: string, size: number): Promise<number | "done" | null> => {
  try {
    const res = await fetch(sessionUrl, {
      method: "PUT",
      headers: { "Content-Range": `bytes */${size}` },
    });
    if (isDone(res.status)) return "done";
    if (res.status === 308) return parseRangeHeader(res.headers.get("Range")) ?? 0;
  } catch {
    // 通信不可。呼び出し側で待って再試行する
  }
  return null;
};

export class UploadFatalError extends Error {}

export const uploadFile = async (
  file: File,
  sessionUrl: string,
  onProgress: ProgressFn,
  signal?: AbortSignal
): Promise<void> => {
  const size = file.size;
  let offset = 0;
  let attempt = 0;

  while (offset < size) {
    signal?.throwIfAborted();
    const end = Math.min(offset + CHUNK_SIZE, size);
    try {
      const res = await fetch(sessionUrl, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${offset}-${end - 1}/${size}` },
        body: file.slice(offset, end),
        signal,
      });
      if (isDone(res.status)) {
        onProgress(size);
        return;
      }
      if (res.status === 308) {
        // Range ヘッダが読めない場合は送信したチャンクまで届いたものとして進める
        offset = parseRangeHeader(res.headers.get("Range")) ?? end;
        attempt = 0;
        onProgress(offset);
        continue;
      }
      if (res.status === 404 || res.status === 410) {
        throw new UploadFatalError("アップロードの有効期限が切れました。最初からやり直してください");
      }
      throw new Error(`status ${res.status}`);
    } catch (err) {
      if (err instanceof UploadFatalError) throw err;
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      attempt++;
      if (attempt >= MAX_ATTEMPTS) throw new Error("通信が不安定なため中断しました。もう一度お試しください");
      await sleep(Math.min(1000 * 2 ** attempt, 20_000), signal);
      // 受信済み位置を確認して、その続きから再開する
      const resumed = await queryOffset(sessionUrl, size);
      if (resumed === "done") {
        onProgress(size);
        return;
      }
      if (resumed !== null) {
        offset = resumed;
        onProgress(offset);
      }
    }
  }
};
