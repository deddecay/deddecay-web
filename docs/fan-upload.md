# DD UPLOAD

deddecay へ動画・写真・ファンアート等を送る公式アップロード窓口（URL: `/upload`）。
保存先（原本の正本）は Cloudflare R2 の非公開バケット。Google Drive には保存しない（二重保存しない）。

> 名称: ユーザー向けの表示名は「Fan moments」（トップのナビ、ページの見出し・タブ名、案内文、完了画面）。URL は `/upload`。
> 内部識別子（`src/lib/fan-upload/`、`/api/fan-upload/*`、`FAN_UPLOAD_*` 環境変数、R2 バケット名、本ファイル名）は表示名と分離しており、
> `fan-upload` のまま。運営側（管理者向け）の通知メールの件名 `[DD UPLOAD]` は、運用の識別用としてそのまま残している。
> `drive.ts` と `scripts/dd-upload-oauth.mjs`（Drive 保存の旧実装）はコードとして残してあるが、現在の経路では使っていない。

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
2. R2 のデータのライフサイクル（R2 = 最終保存先に確定。Drive は使わない。自動削除・保管期間は未設定で、容量の増え方を観測してから決める）
3. 削除・保管期間などの運用（削除依頼は、投稿日時・ファイル名・公演で特定する）
4. 1 ファイル・1 投稿・ファイル数などアップロード制限の最終仕様（現状: 10 ファイル / 4GB / 合計 8GB。環境変数で変更可）
5. 必要に応じた不正利用・大量アップロード対策（rate limit の共有ストア、日次容量、R2 使用量の監視 など）
6. 実運用テスト（PC / iPhone、大容量、通信断からの再開、通知メール、R2 への保存）

## 仕組み

1. ブラウザ: Turnstile を通過 → `POST /api/fan-upload/init`
2. サーバー: Origin / rate limit / Turnstile / 形式・サイズ / 公演（microCMS）/ 容量を検証し、
   ファイルごとに R2 のマルチパートアップロードを開始。**パートごとの署名付き PUT URL**（期限 24 時間）と、投稿情報 `manifest.json` を作る
3. ブラウザ: 署名付き URL へ 16MiB ずつ直接 PUT（中断時は失敗したパートだけ再送、「再開する」で続きから）。ファイル本体は Vercel を通らない
4. ブラウザ: `POST /api/fan-upload/complete`（署名トークンだけを送る。ETag 等はクライアントから受け取らない）
5. サーバー: R2 に届いたパート一覧（ListParts）から、ファイルごとに欠け・サイズを確認して結合（CompleteMultipartUpload）→
   宣言サイズ・先頭バイト（拡張子との整合）を検証。不正なファイルは削除。通知メールを **1 投稿 = 1 通** 送る

## 保存先の構造（R2 バケット、非公開）

```
fan-moments/
  live/{liveId}/{uploadId}/
    {投稿日時JST}_{連番}_{元のファイル名}   ← 原本
    manifest.json                          ← 投稿情報
  other/{uploadId}/
    ...                                    （同上）
```

- `liveId` は microCMS の entry id（安定 ID）。LIVE の表示名・日付は保存パスに使わない（改名しても既存の投稿との関連は壊れない）
- `uploadId` は投稿ごとの ID（= `postId`）。同じ LIVE への別投稿でも、フォルダが分かれるのでファイルが混在しない
- 「その他」は `other/` 配下で LIVE と完全に分離している
- ファイル名に投稿者名は含まない
- DB は使わない。投稿情報は `manifest.json` に残す:

| 項目 | 内容 |
|---|---|
| `uploadId` / `status` | 投稿 ID / `pending`（受付中）・`complete`（確定済み） |
| `target` | `live`（`liveId` と、投稿時点の LIVE タイトル・日付のスナップショット）または `other` |
| `createdAt` / `completedAt` | 投稿日時 / 確定日時（ISO 8601） |
| `message` / `consent` | メッセージ（任意）/ 同意文の版 |
| `notified` | 通知メール送信済みか |
| `files[]` | 保存名・元のファイル名・宣言サイズ・MIME・種別（video/image/audio）・結果（`accepted`/`rejected`） |

## 個人情報の方針

- 投稿者の個人情報（名前・メールアドレス等）は、**フォームで求めず、サーバーでも保存しない**。入力欄は、メッセージ（任意）と利用許諾の同意だけ
- 古いクライアントが名前・メール等を送ってきても、サーバーは読み捨てる（ファイル名・manifest・通知メールに入らない）
- IP アドレスは rate limit のカウンタにだけ使い、投稿データには保存しない

LIVE の選択肢は microCMS の `entries`（type=live）が唯一の正本。

## LIVE の投稿受付期間（開催後 30 日間）

- LIVE への投稿は、**開催日時から 30 日間（30 × 24 時間。暦月ではない）**だけ受け付ける。判定は LIVE の ID と開催日時
  （`eventDate`、無ければ表示と同じく `publishedAt`）で行い、表示名には依存しない
- 開催前の LIVE と、開催から 30 日を超えた LIVE は、公演の選択肢に出さない（一覧は「いま投稿できる LIVE」だけになり、件数が増えても伸びない）
- サーバー（`init`）でも同じ判定をするため、一覧に出ない LIVE の ID を直接指定した投稿も拒否する。期間は開始の瞬間を含み、終了の瞬間を含まない
- 開催日時が無い・不正な LIVE は受け付けない
- 画面には「ライブ開催後30日間アップロードできます」と補足を表示する。期間内の LIVE が無いときはその旨を表示する
- 「その他」は期間の制限なく、常に選べる
- 一覧はページの再生成（最大 60 秒）で更新される。microCMS の LIVE 取得処理は変更していない
- 日付だけが入っている LIVE（時刻が 0 時）の場合は、開催日の 0 時（microCMS の保存値の時刻）から数える

## 環境変数（Vercel の Production / Preview）

| 名前 | 用途 |
|---|---|
| `R2_ACCOUNT_ID` / `R2_BUCKET` | R2 のアカウント ID とバケット名 |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 の S3 API トークン（対象バケットのみ・Object Read & Write） |
| `FAN_UPLOAD_SECRET` | 投稿トークン署名用。32 文字以上のランダム文字列 |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile のシークレット |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Turnstile のサイトキー（公開値。**変更後は再デプロイが必要**） |
| `RESEND_API_KEY` / `CONTACT_TO_EMAIL` / `CONTACT_FROM_EMAIL` | 通知メール（CONTACT と共通） |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | 任意。rate limit をインスタンス間で共有する（未設定時はメモリ内のみ） |
| `FAN_UPLOAD_MAX_FILES` / `_MAX_FILE_GB` / `_MAX_POST_GB` | 任意。既定 10 件 / 4GB / 8GB |
| `FAN_UPLOAD_APP_CAP_GB` / `_DAILY_GB_PER_IP` | 任意。既定 50GB / 20GB。`APP_CAP` は R2 の保存量がこの値を超えたら新規投稿を断る安全弁（R2 自体に容量上限は無い）。自動削除はしない |
| `FAN_UPLOAD_ALLOWED_ORIGINS` | 任意。追加で許可するオリジン（カンマ区切り） |

必須が欠けている場合、API は 503（「準備中」）を返す。

## R2 バケットの設定（人間操作・Cloudflare ダッシュボード）

- **バケットは非公開**のままにする（`r2.dev` の公開 URL とカスタムドメインの公開は有効にしない）。オブジェクトの公開 URL は一切発行しない
- **CORS**（ブラウザからの直接 PUT に必要）。本番オリジンのみ許可し、ワイルドカードは使わない:

```json
[
  {
    "AllowedOrigins": ["https://deddecay.tokyo"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3600
  }
]
```

  - 本番で `https://www.deddecay.tokyo` からもアップロードする場合に限り、実際に必要と確認してから追加する
  - Preview で試す場合は、その Preview のオリジンを一時的に追加する（不要になったら削除する）
- 完了しなかったマルチパートアップロードのパートは容量に残るため、ライフサイクルルール「未完了のマルチパートアップロードを N 日後に中断」の設定を推奨
  （完了済みのファイルを自動削除するルールは、今は設定しない）
- S3 API トークンは対象バケットのみ・Object Read & Write に絞る

## 運営側の確認方法

- 通知メールに、LIVE（日付・タイトル・`liveId`）または「その他」、投稿 ID、投稿日時、ファイル一覧、R2 の保存先フォルダが書かれている
- ファイルは Cloudflare ダッシュボード > R2 > バケット > `fan-moments/...` のフォルダで確認・取得する（専用の管理画面は無い）
- 投稿者を含め、他人が閲覧する機能は無い。メールにファイルへの URL は載せない
- R2 の使用量は Cloudflare ダッシュボードの R2 メトリクスで見られる。通知メールにもアプリの概算使用量を載せる

## Google OAuth トークンの発行・更新（旧 Drive 保存用・現在は使っていない）

Drive に保存していた旧実装用。R2 への置換後は不要。`scripts/dd-upload-oauth.mjs` は残してあるが、環境変数 `GOOGLE_OAUTH_*` は使われない。
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

- R2 バケットは非公開。投稿者に渡るのは、1 パートだけを書き込める署名付き URL（期限 24 時間）のみ。読み出し用の URL は発行しない
- 認証情報（R2 の API トークン）はサーバーの環境変数のみ。署名付き URL にはアクセスキー ID が含まれるが、秘密鍵は含まれない
- 結合・検証・削除はすべてサーバー側。クライアントから ETag や保存先のキーを受け取らない（保存先は署名済みトークンの `k` と manifest から決まる）
- Origin 許可リスト、Turnstile（init で 1 回）、rate limit（IP 単位の回数・日次容量）、形式許可リスト、サイズ・件数上限、完了時の先頭バイト検証、アプリ上限による受付停止
- 通知メールにはファイルを添付せず、ファイルへの URL も載せない

## 運用

- 投稿が届くと CONTACT 宛先に `[DD UPLOAD] ...` の件名でメールが届く。Cloudflare ダッシュボードの R2 で、メールに書かれたフォルダを確認する
- R2 の保存量が `FAN_UPLOAD_APP_CAP_GB` を超えると、新規投稿を自動で断る（安全弁。既存データは削除しない）
- 自動削除・保管期間は未設定。不適切な投稿は R2 上で削除する（サイト側の操作は不要）
- 同意文を変更したら `src/lib/fan-upload/policy.ts` の `CONSENT_VERSION` を更新する

## テスト

`npm test`（R2 / Turnstile / メールはモック。SigV4 署名は AWS 公式ドキュメントの署名例と一致することを確認している）。
実機確認は Production の直接 URL（公開導線は OFF のまま）で、PC とスマートフォンから大容量動画を送り、
R2 への保存・メール 1 通・中断後の再開を確認する。
