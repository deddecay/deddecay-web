// CONTACT の「チケット関連」の問い合わせを受けたときの自動処理（サーバー専用）。
// キャンセルの連絡らしく、送信者のアドレスが予約と一致したら、予約のアドレスへキャンセル手続きのリンクを送る。
// 戻り値は運営宛ての問い合わせメールの先頭に入れる報告（何もしなかったときは空）。
// ここで失敗しても問い合わせ自体の送信は止めない（呼び出し側で例外を握りつぶす）

import "server-only";
import { EVENT, TICKET_PATH } from "./event";
import { findByEmail } from "./ledger";
import { buildCancelLinkMail } from "./mail";
import { cancelLinkEnabled, createCancelToken, looksLikeCancel } from "./cancel-link";
import { ticketEnabled } from "./flags";
import { getLedgerStore, sendMail } from "./runtime";

export const handleTicketContact = async (input: {
  email: string;
  subject: string;
  message: string;
  origin: string;
}): Promise<string[]> => {
  if (!ticketEnabled()) return [];
  const store = getLedgerStore();
  if (!store) return [];
  const { ledger } = await store.read();
  const r = findByEmail(ledger, input.email);
  const isCancel = looksLikeCancel(input.subject, input.message);

  if (!r) {
    return isCancel
      ? ["【自動処理】キャンセルの連絡のようですが、このメールアドレスの予約は見つかりませんでした。手動で確認してください。", ""]
      : [];
  }
  const info = `${r.name} 様 ${r.tickets}枚（受付ID ${r.id}）`;
  if (!isCancel) return [`【参考】このメールアドレスの予約: ${info}`, ""];

  const token = cancelLinkEnabled() ? createCancelToken(EVENT.id, r.id) : null;
  if (!token) {
    return [`【自動処理】キャンセルの連絡です（予約: ${info}）。手続きリンクの設定が無いため、手動で対応してください。`, ""];
  }
  const url = `${input.origin}${TICKET_PATH}/cancel?t=${encodeURIComponent(token)}`;
  // ローカル開発のときだけ、確認用にリンクをログへ出す（本番・Preview のログには出さない）
  if (!process.env.VERCEL_ENV) console.info(`[ticket] cancel link (local only): ${url}`);
  const to = process.env.CONTACT_TO_EMAIL;
  const ok = await sendMail(r.email, { ...buildCancelLinkMail(r, url), ...(to ? { replyTo: to } : {}) });
  return ok
    ? [
        `【自動処理】キャンセルの連絡と判断し、予約（${info}）のアドレス ${r.email} へキャンセル手続きのリンクを送信しました。`,
        "本人が手続きを終えると、台帳・集計表が自動で更新され、完了通知が届きます。対応は不要です。",
        "（キャンセル以外のご用件だった場合は、この問い合わせに通常どおり返信してください）",
        "",
      ]
    : [`⚠【自動処理】予約（${info}）へのキャンセル手続きリンクの送信に失敗しました。手動で対応してください。`, ""];
};
