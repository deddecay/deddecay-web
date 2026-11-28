// チケット申し込みの台帳（受付データ）と、定員を守る受付処理。
//
// 台帳は JSON 1 ファイル（本番は R2）。書き込みは「読んだ版（ETag）のときだけ書く」条件付き書き込みで行い、
// 競合（他の申し込みが先に書いた）なら読み直してやり直す。これで同時申し込みでも定員を超えない。
// 二重送信は requestId（確認画面ごとにクライアントが作る ID）で判定し、同じ ID の再送は同じ結果を返す。
// 外部依存は LedgerStore で注入する（テストではメモリ実装を使う）。

export type Reservation = {
  id: string;
  requestId: string;
  name: string;
  email: string;
  tickets: number;
  createdAt: string;
};

export type Ledger = {
  version: 1;
  reservations: Reservation[];
};

export type LedgerStore = {
  read(): Promise<{ ledger: Ledger; etag: string | null }>;
  // etag=null は「まだ存在しないときだけ作る」。競合したら false
  write(ledger: Ledger, etag: string | null): Promise<boolean>;
};

export type Application = { requestId: string; name: string; email: string; tickets: number };

export type ReserveOptions = {
  capacity: number;
  maxPerOrder: number;
  now?: () => Date;
  maxAttempts?: number;
};

export type ReserveResult =
  | { status: "accepted"; reservation: Reservation; reserved: number; remaining: number }
  | { status: "replayed"; reservation: Reservation; reserved: number; remaining: number }
  | { status: "duplicate_email" }
  | { status: "sold_out" }
  | { status: "insufficient"; remaining: number }
  | { status: "conflict" };

export const emptyLedger = (): Ledger => ({ version: 1, reservations: [] });

export const summarize = (ledger: Ledger, capacity: number) => {
  const reserved = ledger.reservations.reduce((sum, r) => sum + r.tickets, 0);
  return { reserved, remaining: Math.max(0, capacity - reserved), capacity };
};

const normalizeEmail = (v: string) => v.trim().toLowerCase();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUEST_ID_RE = /^[A-Za-z0-9-]{16,64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export type ParseResult = { ok: true; value: Application } | { ok: false; error: string };

export const parseApplication = (body: unknown, maxPerOrder = 5): ParseResult => {
  if (!body || typeof body !== "object") return { ok: false, error: "不正なリクエストです" };
  const b = body as Record<string, unknown>;
  const requestId = typeof b.requestId === "string" ? b.requestId : "";
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const email = typeof b.email === "string" ? b.email.trim() : "";
  const tickets = typeof b.tickets === "number" ? b.tickets : typeof b.tickets === "string" ? Number(b.tickets) : NaN;

  if (!REQUEST_ID_RE.test(requestId)) return { ok: false, error: "不正なリクエストです" };
  if (!name || name.length > 100 || CONTROL_RE.test(name)) return { ok: false, error: "お名前を確認してください" };
  if (!EMAIL_RE.test(email) || email.length > 254 || CONTROL_RE.test(email)) {
    return { ok: false, error: "メールアドレスを確認してください" };
  }
  if (!Number.isInteger(tickets) || tickets < 1 || tickets > maxPerOrder) {
    return { ok: false, error: "チケット枚数を確認してください" };
  }
  return { ok: true, value: { requestId, name, email, tickets } };
};

const newId = () => globalThis.crypto.randomUUID();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const reserve = async (
  store: LedgerStore,
  app: Application,
  opts: ReserveOptions
): Promise<ReserveResult> => {
  const maxAttempts = opts.maxAttempts ?? 8;
  const now = opts.now ?? (() => new Date());
  const email = normalizeEmail(app.email);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { ledger, etag } = await store.read();
    const { reserved, remaining } = summarize(ledger, opts.capacity);

    const same = ledger.reservations.find((r) => r.requestId === app.requestId);
    if (same) return { status: "replayed", reservation: same, reserved, remaining };
    if (ledger.reservations.some((r) => normalizeEmail(r.email) === email)) return { status: "duplicate_email" };
    if (remaining <= 0) return { status: "sold_out" };
    if (app.tickets > remaining || app.tickets > opts.maxPerOrder) return { status: "insufficient", remaining };

    const reservation: Reservation = {
      id: newId(),
      requestId: app.requestId,
      name: app.name,
      email: app.email,
      tickets: app.tickets,
      createdAt: now().toISOString(),
    };
    const next: Ledger = { ...ledger, reservations: [...ledger.reservations, reservation] };
    if (await store.write(next, etag)) {
      return { status: "accepted", reservation, reserved: reserved + app.tickets, remaining: remaining - app.tickets };
    }
    // 競合。少し待って読み直す（同時に来た申し込みが散らばるようにゆらぎを入れる）
    await sleep(Math.floor(Math.random() * 40) + 10 * attempt);
  }
  return { status: "conflict" };
};

// メモリ上の台帳（テスト・ローカル開発用。サーバーのインスタンス間では共有されないので本番では使わない）
export const createMemoryStore = (opts: { latencyMs?: number } = {}): LedgerStore => {
  let body: string | null = null;
  let version = 0;
  const wait = () => (opts.latencyMs ? sleep(opts.latencyMs) : Promise.resolve());
  return {
    async read() {
      await wait();
      return body === null
        ? { ledger: emptyLedger(), etag: null }
        : { ledger: JSON.parse(body) as Ledger, etag: `v${version}` };
    },
    async write(ledger, etag) {
      await wait();
      const current = body === null ? null : `v${version}`;
      if (current !== etag) return false;
      body = JSON.stringify(ledger);
      version += 1;
      return true;
    },
  };
};

// ── 運用（scripts/tickets.mjs から使う） ─────────────────

// 台帳の保存先キー。本番と Preview・ローカルで分ける（テストの申し込みが本番の定員を消費しないように）
export const ledgerKeyFor = (eventId: string, stage: string | undefined): string =>
  stage === "production" ? `tickets/${eventId}/ledger.json` : `tickets/${eventId}/ledger-${stage ?? "local"}.json`;

export type CancelResult =
  | { status: "cancelled"; reservation: Reservation }
  | { status: "not_found" }
  | { status: "conflict" };

// キャンセル（運営が受付 ID を指定して取り消す）。席が戻り、同じメールアドレスで申し込み直せるようになる
export const cancelReservation = async (store: LedgerStore, id: string, maxAttempts = 8): Promise<CancelResult> => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { ledger, etag } = await store.read();
    const target = ledger.reservations.find((r) => r.id === id);
    if (!target) return { status: "not_found" };
    const next: Ledger = { ...ledger, reservations: ledger.reservations.filter((r) => r.id !== id) };
    if (await store.write(next, etag)) return { status: "cancelled", reservation: target };
    await sleep(20 + 10 * attempt);
  }
  return { status: "conflict" };
};

// 本人のキャンセル手続き（一部キャンセル対応）。cancel 枚を減らし、0 枚になれば予約ごと取り消す。
// expected: 手続きページを開いたときの枚数。今の枚数と違えば（別の画面で先に手続き済みなど）何もしない
export type ReduceResult =
  | { status: "cancelled"; before: Reservation }
  | { status: "reduced"; before: Reservation; after: Reservation }
  | { status: "not_found" }
  | { status: "changed"; current: Reservation }
  | { status: "invalid" }
  | { status: "conflict" };

export const reduceReservation = async (
  store: LedgerStore,
  id: string,
  cancel: number,
  expected: number,
  maxAttempts = 8
): Promise<ReduceResult> => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { ledger, etag } = await store.read();
    const target = ledger.reservations.find((r) => r.id === id);
    if (!target) return { status: "not_found" };
    if (target.tickets !== expected) return { status: "changed", current: target };
    if (!Number.isInteger(cancel) || cancel < 1 || cancel > target.tickets) return { status: "invalid" };
    const after: Reservation | null = cancel === target.tickets ? null : { ...target, tickets: target.tickets - cancel };
    const next: Ledger = {
      ...ledger,
      reservations: after
        ? ledger.reservations.map((r) => (r.id === id ? after : r))
        : ledger.reservations.filter((r) => r.id !== id),
    };
    if (await store.write(next, etag)) {
      return after ? { status: "reduced", before: target, after } : { status: "cancelled", before: target };
    }
    await sleep(20 + 10 * attempt);
  }
  return { status: "conflict" };
};

export const findByEmail = (ledger: Ledger, email: string): Reservation | undefined =>
  ledger.reservations.find((r) => normalizeEmail(r.email) === normalizeEmail(email));

const csvCell = (v: string | number): string => {
  let s = String(v);
  // スプレッドシートで数式として実行されないように（CSV インジェクション対策）
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// CSV（UTF-8 BOM 付き。Excel・Google スプレッドシートでそのまま開ける）
export const toCsv = (ledger: Ledger, pricePerTicket = 2000): string => {
  const header = ["受付日時", "お名前", "メールアドレス", "枚数", "合計金額", "受付ID"];
  const rows = ledger.reservations.map((r) => [
    new Date(r.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
    r.name,
    r.email,
    r.tickets,
    r.tickets * pricePerTicket,
    r.id,
  ]);
  return "﻿" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
};

export const parseLedger = (text: string): Ledger => {
  const data = JSON.parse(text) as Partial<Ledger>;
  if (data.version !== 1 || !Array.isArray(data.reservations)) throw new Error("ledger: unexpected format");
  return data as Ledger;
};
