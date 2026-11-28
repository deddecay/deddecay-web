// チケット申し込みのサーバー側の組み立て（台帳の保存先・メール送信）。サーバー専用。
//
// 保存先:
//   Vercel Production   → R2 `tickets/2026-12-06/ledger.json`
//   Vercel Preview      → R2 `tickets/2026-12-06/ledger-preview.json`（本番の台帳と混ざらない）
//   ローカル（VERCEL_ENV なし）→ メモリ（再起動で消える）。TICKET_STORE=r2 で `ledger-local.json` を使う
// 会場情報（サーバー専用の環境変数。NEXT_PUBLIC_ を付けない）:
//   TICKET_1206_VENUE_ADDRESS  正確な会場住所
//   TICKET_1206_ACCESS_URL     会場への行き方（Dropbox 共有動画の URL）
//   TICKET_1206_ACCESS_STEPS   会場までの道順（1 行 1 手順。番号は自動で振る）

import "server-only";
import { Resend } from "resend";
import { getR2Client, R2Error, type R2Client } from "../fan-upload/r2";
import { EVENT } from "./event";
import { createMemoryStore, emptyLedger, ledgerKeyFor, parseLedger, type LedgerStore } from "./ledger";
import { parseSteps, ticketFrom, type Mail, type Venue } from "./mail";
import { getDriveClient } from "../fan-upload/drive";
import { sheetKeyFor, sheetNameFor, sheetUrl, syncSheet } from "./sheet";

const ledgerKey = (): string => ledgerKeyFor(EVENT.id, process.env.VERCEL_ENV);

const r2Store = (client: R2Client, key: string): LedgerStore => ({
  async read() {
    const obj = await client.getObject(key);
    if (!obj) return { ledger: emptyLedger(), etag: null };
    return { ledger: parseLedger(obj.text), etag: obj.etag };
  },
  async write(ledger, etag) {
    try {
      await client.putObjectIf(
        key,
        JSON.stringify(ledger, null, 1),
        "application/json",
        etag ? { ifMatch: etag } : { ifNoneMatch: true }
      );
      return true;
    } catch (err) {
      if (err instanceof R2Error && err.status === 412) return false;
      throw err;
    }
  },
});

const globalMemory = globalThis as unknown as { __ticketMemoryStore?: LedgerStore };

export const getLedgerStore = (): LedgerStore | null => {
  const isLocal = !process.env.VERCEL_ENV;
  if (isLocal && process.env.TICKET_STORE !== "r2") {
    globalMemory.__ticketMemoryStore ??= createMemoryStore();
    return globalMemory.__ticketMemoryStore;
  }
  const client = getR2Client();
  return client ? r2Store(client, ledgerKey()) : null;
};

// 集計表（Google スプレッドシート）へ反映する。Google 連携（GOOGLE_OAUTH_*）が無い環境では何もしない。
// 失敗しても受付には影響させない（ログだけ残し、次の申し込みか scripts/tickets.mjs sheet で追いつく）
// 集計表を今すぐ書き直す（失敗は呼び出し側へ投げる）。Google 連携が無ければ null
export const syncSheetNow = async (store: LedgerStore): Promise<{ rows: number; url: string } | null> => {
  const drive = getDriveClient();
  if (!drive) return null;
  const stage = process.env.VERCEL_ENV;
  const r = await syncSheet(drive, store, {
    sheetKey: sheetKeyFor(EVENT.id, stage),
    sheetName: sheetNameFor(EVENT.shortLabel, stage),
    pricePerTicket: EVENT.pricePerTicket,
  });
  return { rows: r.rows, url: sheetUrl(r.id) };
};

export const syncSheetSafely = async (store: LedgerStore): Promise<void> => {
  try {
    await syncSheetNow(store);
  } catch (err) {
    console.error("[ticket] 集計表の反映に失敗しました:", err instanceof Error ? err.message : err);
  }
};

export const readVenue = (): Venue => ({
  address: process.env.TICKET_1206_VENUE_ADDRESS ?? "",
  accessUrl: process.env.TICKET_1206_ACCESS_URL ?? "",
  steps: parseSteps(process.env.TICKET_1206_ACCESS_STEPS),
});

export const sendMail = async (to: string, mail: Mail): Promise<boolean> => {
  const from = ticketFrom();
  if (!process.env.RESEND_API_KEY || !from) {
    console.error("[ticket] 環境変数が未設定: RESEND_API_KEY / CONTACT_FROM_EMAIL");
    return false;
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  // Resend は 1 秒あたりの送信数に上限がある（超えると 429）。申し込みが集中したときに自動返信を落とさないよう、
  // 429 のときだけ間隔をあけて送り直す
  for (let attempt = 0; attempt < MAIL_ATTEMPTS; attempt++) {
    try {
      const { error } = await resend.emails.send({
        to,
        from,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
      });
      if (!error) return true;
      const rateLimited = (error as { statusCode?: number }).statusCode === 429 || error.name === "rate_limit_exceeded";
      if (!rateLimited || attempt === MAIL_ATTEMPTS - 1) {
        console.error("[ticket] resend error:", error);
        return false;
      }
    } catch (err) {
      console.error("[ticket] unexpected mail error:", err);
      return false;
    }
    await new Promise((r) => setTimeout(r, 600 * (attempt + 1) + Math.floor(Math.random() * 800)));
  }
  return false;
};

const MAIL_ATTEMPTS = 5;
