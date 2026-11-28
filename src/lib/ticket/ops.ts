// 運用 API（集計表の書き直しなど）の合言葉チェック。
//
//   TICKET_OPS_SECRET  運用 API の合言葉（32 文字以上のランダムな文字列）。Vercel の本番環境変数と、
//                      手元の運用ファイル（tickets-ops.env）の両方に同じ値を置く。未設定なら運用 API は常に拒否
//
// 呼び出し側は `Authorization: Bearer <合言葉>` を付ける。比較は所要時間で中身が推測されない方法で行う。

import { timingSafeEqual } from "node:crypto";

const MIN_LENGTH = 32;

export const opsAuthorized = (
  authorization: string | null,
  env: Record<string, string | undefined> = process.env
): boolean => {
  const secret = env.TICKET_OPS_SECRET ?? "";
  if (secret.length < MIN_LENGTH || !authorization) return false;
  const a = Buffer.from(authorization);
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
};
