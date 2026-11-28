// 本人によるキャンセル手続きのリンク（署名付き）と、問い合わせ文がキャンセルの連絡かどうかの判定。
//
// リンクは予約のメールアドレスにだけ送るので、リンクを開けた人＝そのアドレスの持ち主とみなす。
// 署名の鍵は TICKET_OPS_SECRET から用途別に導く（新しい環境変数は不要。32 文字未満なら機能ごと無効）。
// トークン: <受付ID>.<有効期限(秒)>.<署名>

import { createHmac, timingSafeEqual } from "node:crypto";

const MIN_SECRET = 32;

// 公演の翌日 0 時（JST）まで有効
export const CANCEL_LINK_EXPIRES = Math.floor(Date.parse("2026-12-07T00:00:00+09:00") / 1000);

const keyFrom = (env: Record<string, string | undefined>): Buffer | null => {
  const secret = env.TICKET_OPS_SECRET ?? "";
  if (secret.length < MIN_SECRET) return null;
  return createHmac("sha256", secret).update("ticket-cancel-link-v1").digest();
};

const sign = (key: Buffer, eventId: string, id: string, exp: number) =>
  createHmac("sha256", key).update(`${eventId}|${id}|${exp}`).digest("base64url");

export const cancelLinkEnabled = (env: Record<string, string | undefined> = process.env) => keyFrom(env) !== null;

export const createCancelToken = (
  eventId: string,
  id: string,
  env: Record<string, string | undefined> = process.env,
  exp = CANCEL_LINK_EXPIRES
): string | null => {
  const key = keyFrom(env);
  return key ? `${id}.${exp}.${sign(key, eventId, id, exp)}` : null;
};

// 正しければ受付ID を返す。改ざん・期限切れ・鍵なしは null
export const verifyCancelToken = (
  eventId: string,
  token: unknown,
  env: Record<string, string | undefined> = process.env,
  nowSec = Math.floor(Date.now() / 1000)
): string | null => {
  const key = keyFrom(env);
  if (!key || typeof token !== "string" || token.length > 200) return null;
  const m = /^([A-Za-z0-9-]{8,64})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  const [, id, expRaw, sig] = m;
  const exp = Number(expRaw);
  if (exp < nowSec) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(key, eventId, id, exp));
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
};

// 問い合わせ（件名＋本文）がキャンセル・枚数を減らす連絡らしいか。
// 誤判定しても本人が手続きページで操作しない限り何も起きないので、広めに拾う
const CANCEL_RE =
  /キャンセル|きゃんせる|取り?消|とりけし|取りやめ|行けな|いけな|行けなく|伺えな|うかがえな|参加(でき|出来)な|参加(でき|出来)ませ|欠席|減ら|へら|cancel/i;

export const looksLikeCancel = (subject: string, message: string): boolean => CANCEL_RE.test(`${subject}\n${message}`);
