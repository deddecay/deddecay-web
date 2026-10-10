// Fan moments の「内部実装」と「公開状態」を分けるフラグ（サーバー側で評価する）。
//
//   FAN_MOMENTS_ENABLED=1  /upload とその API を有効にする。未設定なら 404（URL を知っていても使えない）
//   FAN_MOMENTS_PUBLIC=1   ナビ・LIVE 詳細のリンクを表示する（ENABLED も必要）
//
// 本番は両方とも未設定のまま。データ管理・アップロード制限の最終仕様と運用テストが済むまで公開しない。
// Preview の検証では ENABLED だけを設定する。

type Env = Record<string, string | undefined>;

export const fanMomentsEnabled = (env: Env = process.env): boolean => env.FAN_MOMENTS_ENABLED === "1";

export const fanMomentsPublic = (env: Env = process.env): boolean =>
  fanMomentsEnabled(env) && env.FAN_MOMENTS_PUBLIC === "1";
