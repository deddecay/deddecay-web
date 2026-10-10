// Fan Upload の受付ポリシー（許可形式・上限・入力検証）。
// サーバーとブラウザの両方から使うため、Node 固有 API や他モジュールへの依存を持たない。

export type FileKind = "video" | "image" | "audio";

type FormatRule = {
  kind: FileKind;
  mimes: readonly string[];
  // ファイル先頭バイトの検査。bytes は先頭 32 バイト程度
  magic: (bytes: Uint8Array) => boolean;
};

const ascii = (bytes: Uint8Array, start: number, text: string): boolean => {
  if (bytes.length < start + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[start + i] !== text.charCodeAt(i)) return false;
  }
  return true;
};

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b);

// ISO BMFF（mp4 / mov / m4a / heic）。先頭 4〜8 バイト目が box 名
const isIsoBmff = (bytes: Uint8Array): boolean =>
  ascii(bytes, 4, "ftyp") ||
  ascii(bytes, 4, "moov") ||
  ascii(bytes, 4, "mdat") ||
  ascii(bytes, 4, "wide") ||
  ascii(bytes, 4, "free") ||
  ascii(bytes, 4, "skip");

const isMp3 = (bytes: Uint8Array): boolean =>
  ascii(bytes, 0, "ID3") || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);

// 拡張子（小文字・ドットなし）→ ルール
export const FORMATS: Readonly<Record<string, FormatRule>> = {
  mp4:  { kind: "video", mimes: ["video/mp4"], magic: isIsoBmff },
  m4v:  { kind: "video", mimes: ["video/x-m4v", "video/mp4"], magic: isIsoBmff },
  mov:  { kind: "video", mimes: ["video/quicktime"], magic: isIsoBmff },
  webm: { kind: "video", mimes: ["video/webm"], magic: (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]) },
  jpg:  { kind: "image", mimes: ["image/jpeg"], magic: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  jpeg: { kind: "image", mimes: ["image/jpeg"], magic: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  png:  { kind: "image", mimes: ["image/png"], magic: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]) },
  gif:  { kind: "image", mimes: ["image/gif"], magic: (b) => ascii(b, 0, "GIF8") },
  webp: { kind: "image", mimes: ["image/webp"], magic: (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP") },
  heic: { kind: "image", mimes: ["image/heic", "image/heif"], magic: isIsoBmff },
  heif: { kind: "image", mimes: ["image/heif", "image/heic"], magic: isIsoBmff },
  mp3:  { kind: "audio", mimes: ["audio/mpeg", "audio/mp3"], magic: isMp3 },
  wav:  { kind: "audio", mimes: ["audio/wav", "audio/x-wav", "audio/wave"], magic: (b) => ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE") },
  m4a:  { kind: "audio", mimes: ["audio/mp4", "audio/x-m4a", "audio/m4a"], magic: isIsoBmff },
};

// <input accept> 用
export const ACCEPT_ATTRIBUTE = Object.keys(FORMATS)
  .map((ext) => `.${ext}`)
  .join(",");

export const GIB = 1024 * 1024 * 1024;

export type UploadLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxPostBytes: number;
};

export const DEFAULT_LIMITS: UploadLimits = {
  maxFiles: 10,
  maxFileBytes: 4 * GIB,
  maxPostBytes: 8 * GIB,
};

export const FIELD_LIMITS = {
  message: 1000,
  fileName: 200,
} as const;

// 同意文の版。文面を変えたら更新する（Drive 上のファイルに記録される）
export const CONSENT_VERSION = "2026-10-v1";

export type DeclaredFile = { name: string; size: number; type: string };

export type FileCheck =
  | { ok: true; ext: string; kind: FileKind; mime: string }
  | { ok: false; reason: string };

export const extensionOf = (fileName: string): string => {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? "" : fileName.slice(dot + 1).toLowerCase();
};

// 申告された名前・サイズ・MIME の検証（アップロード前）
export const checkDeclaredFile = (file: DeclaredFile, limits: UploadLimits = DEFAULT_LIMITS): FileCheck => {
  if (typeof file.name !== "string" || file.name.length === 0 || file.name.length > FIELD_LIMITS.fileName) {
    return { ok: false, reason: "ファイル名が不正です" };
  }
  const ext = extensionOf(file.name);
  const rule = FORMATS[ext];
  if (!rule) return { ok: false, reason: `対応していない形式です (.${ext || "?"})` };
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    return { ok: false, reason: "ファイルが空です" };
  }
  if (file.size > limits.maxFileBytes) {
    return { ok: false, reason: `1ファイルの上限(${Math.floor(limits.maxFileBytes / GIB)}GB)を超えています` };
  }
  // iOS では type が空・汎用になることがある。値がある場合のみ拡張子との整合を見る
  const type = typeof file.type === "string" ? file.type.toLowerCase() : "";
  const generic = type === "" || type === "application/octet-stream";
  if (!generic && !rule.mimes.includes(type)) {
    return { ok: false, reason: "ファイル形式と拡張子が一致しません" };
  }
  return { ok: true, ext, kind: rule.kind, mime: rule.mimes[0] };
};

export const checkDeclaredFiles = (
  files: readonly DeclaredFile[],
  limits: UploadLimits = DEFAULT_LIMITS
): { ok: true; totalBytes: number } | { ok: false; reason: string } => {
  if (!Array.isArray(files) || files.length === 0) return { ok: false, reason: "ファイルを選択してください" };
  if (files.length > limits.maxFiles) {
    return { ok: false, reason: `1回の投稿は${limits.maxFiles}ファイルまでです` };
  }
  let total = 0;
  for (const file of files) {
    if (!file || typeof file !== "object") return { ok: false, reason: "ファイル情報が不正です" };
    const result = checkDeclaredFile(file, limits);
    if (!result.ok) return { ok: false, reason: `${file.name}: ${result.reason}` };
    total += file.size;
  }
  if (total > limits.maxPostBytes) {
    return { ok: false, reason: `1回の投稿の合計上限(${Math.floor(limits.maxPostBytes / GIB)}GB)を超えています` };
  }
  return { ok: true, totalBytes: total };
};

// アップロード後に Drive から取得した先頭バイトの検査
export const matchesMagic = (ext: string, head: Uint8Array): boolean => {
  const rule = FORMATS[ext.toLowerCase()];
  return rule ? rule.magic(head) : false;
};

// ファイル名・フォルダ名に使える形へ。パス区切りや制御文字を除き、拡張子は保つ
export const sanitizeSegment = (value: string, maxLength = 80): string => {
  const cleaned = value
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|#%&{}$!'`@=+^~[\];,]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s_]+|[\s_]+$/g, "");
  return Array.from(cleaned).slice(0, maxLength).join("") || "untitled";
};

export const sanitizeFileName = (fileName: string, maxLength = 100): string => {
  const ext = extensionOf(fileName);
  const base = ext ? fileName.slice(0, fileName.length - ext.length - 1) : fileName;
  const safeBase = sanitizeSegment(base, maxLength);
  return ext ? `${safeBase}.${ext}` : safeBase;
};

export type FormTarget =
  | { kind: "live"; liveId: string }
  | { kind: "other" };

// 投稿者の個人情報（名前・メール等）は要求も保存もしない。受け取るのは任意のメッセージだけ。
// クライアントが他の項目を送ってきても読み捨てる。
export type FormTextFields = {
  message: string;
};

// フォームの文字入力の正規化と検証
export const normalizeTextFields = (
  input: Record<string, unknown>
): { ok: true; value: FormTextFields } | { ok: false; reason: string } => {
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (message.length > FIELD_LIMITS.message) return { ok: false, reason: "メッセージが長すぎます" };
  return { ok: true, value: { message } };
};

export const formatBytes = (bytes: number): string => {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
};
