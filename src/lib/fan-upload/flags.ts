// Fan moments の「内部実装」と「公開状態」を分けるフラグ（サーバー側で評価する）。
//
//   FAN_MOMENTS_ENABLED=1  /fan-moments・/upload とその API を有効にする。TOP ナビの「Fan moments」もこれで表示する。
//                          未設定なら 404（URL を知っていても使えず、ナビにも出ない）
//   FAN_MOMENTS_PUBLIC=1   LIVE 詳細ページの投稿リンクを表示する（ENABLED も必要）
//
// TOP ナビを ENABLED で出すのは、リンク先 /fan-moments が有効な環境でだけリンクを出すため。
// Preview の検証では ENABLED だけを設定すると、ナビも含めて確認できる。

type Env = Record<string, string | undefined>;

export const fanMomentsEnabled = (env: Env = process.env): boolean => env.FAN_MOMENTS_ENABLED === "1";

export const fanMomentsPublic = (env: Env = process.env): boolean =>
  fanMomentsEnabled(env) && env.FAN_MOMENTS_PUBLIC === "1";
