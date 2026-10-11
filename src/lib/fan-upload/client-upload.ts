// ブラウザ → Cloudflare R2 のマルチパートアップロード（パートごとに署名付き URL へ PUT）。
// iPhone の画面ロック・回線切替で中断しやすいため、失敗したパートだけを再試行する。
// 完了済みパートの数は upload.donePart に残るので、「再開する」では続きのパートから送る。

const MAX_ATTEMPTS = 8;

export type ProgressFn = (uploadedBytes: number) => void;

// init が返すファイルごとの情報（parts は 1 パートずつの署名付き PUT URL）
export type PartUpload = {
  name: string;
  partSize: number;
  parts: string[];
  donePart?: number;
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    });
  });

export class UploadFatalError extends Error {}

export const uploadFile = async (
  file: File,
  upload: PartUpload,
  onProgress: ProgressFn,
  signal?: AbortSignal
): Promise<void> => {
  const size = file.size;
  let index = upload.donePart ?? 0;
  let attempt = 0;
  onProgress(Math.min(index * upload.partSize, size));

  while (index < upload.parts.length) {
    signal?.throwIfAborted();
    const start = index * upload.partSize;
    const end = Math.min(start + upload.partSize, size);
    try {
      const res = await fetch(upload.parts[index], {
        method: "PUT",
        body: file.slice(start, end),
        signal,
      });
      if (res.ok) {
        index++;
        upload.donePart = index;
        attempt = 0;
        onProgress(end);
        continue;
      }
      // 署名の期限切れ・アップロードの取り消し・不正な要求は、再試行しても直らない
      if (res.status === 400 || res.status === 403 || res.status === 404) {
        throw new UploadFatalError("アップロードの有効期限が切れました。最初からやり直してください");
      }
      throw new Error(`status ${res.status}`);
    } catch (err) {
      if (err instanceof UploadFatalError) throw err;
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      attempt++;
      if (attempt >= MAX_ATTEMPTS) throw new Error("通信が不安定なため中断しました。もう一度お試しください");
      await sleep(Math.min(1000 * 2 ** attempt, 20_000), signal);
    }
  }
};
