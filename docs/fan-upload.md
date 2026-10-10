# DD UPLOAD

deddecay へ動画・写真・ファンアート等を送る公式アップロード窓口（URL: `/upload`）。保存先は Google Drive（非公開）。

> 名称: ユーザー向けの表示名は「Fan moments」（トップのナビ、ページの見出し・タブ名、案内文、完了画面）。URL は `/upload`。
> 内部識別子（`src/lib/fan-upload/`、`/api/fan-upload/*`、`FAN_UPLOAD_*` 環境変数、R2 バケット名、本ファイル名）は表示名と分離しており、
> `fan-upload` のまま。運営側（管理者向け）の「通知メールの件名 `[DD UPLOAD]`」と「Drive のルートフォルダ名 `DD UPLOAD`」は、
> 運用の識別用としてそのまま残している。

## 公開状態（フラグ）

実装は本番コードに入っているが、**公開前は一般ユーザーから到達できない**。内部実装と公開状態は環境変数で分離している。

| 環境変数 | 効果 | 本番の現状 |
|---|---|---|
| `FAN_MOMENTS_ENABLED=1` | `/upload` とその API を有効にする。未設定なら `404`（URL を知っていても使えない） | **未設定**（無効） |
| `FAN_MOMENTS_PUBLIC=1` | トップのナビと LIVE 詳細のリンクを表示する（`ENABLED` も必要） | **未設定**（非表示） |

- Preview で検証するときは、Preview 環境にだけ `FAN_MOMENTS_ENABLED=1` を設定する（リンクは出さない）
- どちらも `1` 以外（`true` など）は無効として扱う
- フラグを変えたら再デプロイが必要（ビルドで確定する箇所があるため）

### 公開前に確定してから公開すること

公開（`FAN_MOMENTS_PUBLIC=1`）の前に、次を別工程で整理・確定し、実運用テストで検証する。

1. アップロードされたデータの保存・管理方法
2. R2 / Drive それぞれの役割とデータのライフサイクル（現状の実装は Drive のみ。R2 は環境変数だけ用意済みで未使用）
3. 削除・保管期間などの運用（削除依頼は、投稿日時・ファイル名・公演で特定する）
4. 1 ファイル・1 投稿・ファイル数などアップロード制限の最終仕様（現状: 10 ファイル / 4GB / 合計 8GB。環境変数で変更可）
5. 必要に応じた不正利用・大量アップロード対策（rate limit の共有ストア、日次容量、Drive 容量の監視 など）
6. 実運用テスト（PC / iPhone、大容量、通信断からの再開、通知メール、Drive への保存）

## 仕組み

1. ブラウザ: Turnstile を通過 → `POST /api/fan-upload/init`
2. サーバー: Origin / rate limit / Turnstile / 形式・サイズ / 公演（microCMS）/ 容量を検証し、Drive の resumable セッション URL をファイルごとに発行
3. ブラウザ: セッション URL へ 16MiB ずつ直接 PUT（中断時は受信済み位置から再開）。ファイル本体は Vercel を通らない
4. ブラウザ: `POST /api/fan-upload/complete`
5. サーバー: Drive 上のファイル数・宣言サイズ・先頭バイト（拡張子との整合）を検証。不正なファイルはゴミ箱へ。通知メールを **1 投稿 = 1 通** 送る

## 保存先フォルダ（Drive 上、アプリが作成する `DD UPLOAD` フォルダ配下）

- LIVE: `LIVE/{年}/{YYYY.MM.DD}_{公演タイトル}__{microCMS の entry id}/`
- その他: `OTHER/{YYYY-MM}/`
- ファイル名: `{投稿日時JST}_{連番}_{元のファイル名}`（投稿者名は含まない）
- 各ファイルの「説明」欄に記録するのは、メッセージ（任意）・公演・同意版・投稿ID だけ

## 個人情報の方針

- 投稿者の個人情報（名前・メールアドレス等）は、**フォームで求めず、サーバーでも保存しない**。入力欄は、メッセージ（任意）と利用許諾の同意だけ
- 古いクライアントが名前・メール等を送ってきても、サーバーは読み捨てる（ファイル名・説明欄・メタデータ・通知メールに入らない）
- IP アドレスは rate limit のカウンタにだけ使い、投稿データには保存しない

LIVE の選択肢は microCMS の `entries`（type=live）が唯一の正本。過去公演も含めて全件を選べる。

## 環境変数（Vercel の Production / Preview）

| 名前 | 用途 |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth クライアント |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | 保存先 Google アカウントのリフレッシュトークン（スコープ `drive.file` のみ） |
| `FAN_UPLOAD_SECRET` | 投稿トークン署名用。32 文字以上のランダム文字列 |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile のシークレット |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Turnstile のサイトキー（公開値。**変更後は再デプロイが必要**） |
| `RESEND_API_KEY` / `CONTACT_TO_EMAIL` / `CONTACT_FROM_EMAIL` | 通知メール（CONTACT と共通） |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | 任意。rate limit をインスタンス間で共有する（未設定時はメモリ内のみ） |
| `FAN_UPLOAD_MAX_FILES` / `_MAX_FILE_GB` / `_MAX_POST_GB` | 任意。既定 10 件 / 4GB / 8GB |
| `FAN_UPLOAD_APP_CAP_GB` / `_RESERVE_GB` / `_DAILY_GB_PER_IP` | 任意。既定 50GB / 1GB / 20GB |
| `FAN_UPLOAD_ALLOWED_ORIGINS` | 任意。追加で許可するオリジン（カンマ区切り） |

必須が欠けている場合、API は 503（「準備中」）を返す。

## Google OAuth トークンの発行・更新

保存先アカウントのリフレッシュトークンは `scripts/dd-upload-oauth.mjs` で発行する（ローカルで手動実行）。

```
node scripts/dd-upload-oauth.mjs --login-hint <保存先Googleアカウント> [--targets production,preview] [--no-deliver]
```

- OAuth クライアント JSON は **repository の外**に置く（既定: `/Users/hayato/site/secrets/deddecay/dd-upload/google-oauth-client.json`、
  環境変数 `DD_UPLOAD_OAUTH_CLIENT_JSON` で変更可）。ファイル権限が 600 でなければ中断する。JSON・トークンは Git に入れない
- ブラウザで Google の認証画面が開く。保存先アカウントで `drive.file` に同意する（5 分以内）
- 取得したリフレッシュトークンは画面・ログ・ファイルに出さず、Vercel CLI の標準入力へ直接渡す（`--no-deliver` なら保存しない）
- 現在の OAuth アプリは「テスト」状態（内部運用のため本番公開しない方針）。**テスト状態のリフレッシュトークンは約 7 日で失効する可能性がある**
  ため、DD UPLOAD の保存が失敗する（502）ようになったら、このスクリプトを再実行して更新する
- Production と Preview はそれぞれ別のトークンになる（どちらも有効）

## セキュリティ境界

- Drive のフォルダ・ファイルは共有設定を一切変更しない（オーナーのみ）。投稿者に渡るのは単一ファイル用のアップロード URL のみ
- 認証情報はサーバーの環境変数のみ。クライアントへ返すのはセッション URL と署名トークン（フォルダ ID 等は返さない）
- `drive.file` スコープにより、アプリはこのアプリが作成したファイルしか操作できない
- Origin 許可リスト、Turnstile（init で 1 回）、rate limit（IP 単位の回数・日次容量）、形式許可リスト、サイズ・件数上限、完了時の先頭バイト検証、Drive 容量・アプリ上限による受付停止
- 通知メールにはオーナー向けの Drive フォルダリンクを含む（オーナーのみ閲覧可）

## 運用

- 投稿が届くと CONTACT 宛先に `[DD UPLOAD] ...` の件名でメールが届く。Drive の `DD UPLOAD` フォルダを確認する
- 容量が足りなくなると新規投稿を自動で断る（`FAN_UPLOAD_APP_CAP_GB` またはアカウント空き容量）
- 不適切な投稿は Drive 上で削除する（サイト側の操作は不要）
- 同意文を変更したら `src/lib/fan-upload/policy.ts` の `CONSENT_VERSION` を更新する

## テスト

`npm test`（Drive / Turnstile / メールはモック）。実機確認は Preview デプロイで、PC とスマートフォンから大容量動画を送り、
Drive への保存・メール 1 通・中断後の再開を確認する。
