// 12/6 フロアライブ チケット申し込みの「内部実装」と「公開状態」を分けるフラグ（サーバー側で評価する）。
//
//   TICKET_1206_ENABLED=1  /tickets/2026-12-06 とその API を有効にする。未設定なら 404（URL を知っていても申し込めない）
//   TICKET_1206_PUBLIC=1   TOP の CONTACT・LIVE 詳細に申し込みリンクを表示する（ENABLED も必要）
//   TICKET_1206_LIVE_ID    申し込みリンクを出す LIVE 詳細の microCMS contentId（未設定なら LIVE 詳細には出さない）
//
// Preview の検証では ENABLED だけを設定する（リンクは出さず、URL 直打ちで確認する）。
// 公開は本番に ENABLED と PUBLIC を設定して再デプロイするだけ。

type Env = Record<string, string | undefined>;

export const ticketEnabled = (env: Env = process.env): boolean => env.TICKET_1206_ENABLED === "1";

export const ticketPublic = (env: Env = process.env): boolean =>
  ticketEnabled(env) && env.TICKET_1206_PUBLIC === "1";

export const ticketLiveId = (env: Env = process.env): string | null =>
  env.TICKET_1206_LIVE_ID?.trim() || null;
