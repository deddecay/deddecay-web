# DD UPLOAD

deddecay へ動画・写真・ファンアート等を送る公式アップロード窓口（URL: `/upload`）。
保存先（原本の正本）は Cloudflare R2 の非公開バケット。Google Drive には保存しない（二重保存しない）。

> 名称: ユーザー向けの表示名は「Fan moments」（トップのナビ、ページの見出し・タブ名、案内文、完了画面）。URL は `/upload`。
> 内部識別子（`src/lib/fan-upload/`、`/api/fan-upload/*`、`FAN_UPLOAD_*` 環境変数、R2 バケット名、本ファイル名）は表示名と分離しており、
> `fan-upload` のまま。通知メールの件名は `[Fan moments] LIVE / 2件`（または `その他`）、送信元の表示名は `deddecay Fan moments`。
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

## LIVE の投稿受付期間（開催後 6 か月間）

- LIVE への投稿は、**開催日時から 6 か月間（暦月。UTC 基準で同じ日時の 6 か月後まで。その月に同じ日が無ければ月末日）**だけ受け付ける。
  判定は LIVE の ID と開催日時（`eventDate`、無ければ表示と同じく `publishedAt`）で行い、表示名には依存しない
  （旧仕様は 30 日間。2026-10-13 に 6 か月へ変更）
- 開催前の LIVE と、開催から 6 か月を過ぎた LIVE は、公演の選択肢に出さない（一覧は「いま投稿できる LIVE」だけになり、件数が増えても伸びない）
- サーバー（`init`）でも同じ判定をするため、一覧に出ない LIVE の ID を直接指定した投稿も拒否する。期間は開始の瞬間を含み、終了の瞬間を含まない
- 開催日時が無い・不正な LIVE は受け付けない
- 画面には「ライブ開催後6か月間アップロードできます」と補足を表示する。期間内の LIVE が無いときはその旨を表示する
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
| `FAN_MOMENTS_FROM_EMAIL` | 任意。通知メールの送信元。例: `deddecay Fan moments <fanmoments@deddecay.tokyo>`（Resend で認証済みのドメインが必要）。未設定なら `CONTACT_FROM_EMAIL` を使う。CONTACT フォームの送信元は変わらない |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | 任意。rate limit をインスタンス間で共有する（未設定時はメモリ内のみ） |
| `FAN_UPLOAD_MAX_FILES` / `_MAX_FILE_GB` / `_MAX_POST_GB` | 任意。既定 10 件 / 4GB / 8GB |
| `FAN_UPLOAD_APP_CAP_GB` / `_DAILY_GB_PER_IP` | 任意。既定 50GB / 20GB。`APP_CAP` は R2 の保存量がこの値を超えたら新規投稿を断る安全弁（R2 自体に容量上限は無い）。自動削除はしない |
| `FAN_UPLOAD_ALLOWED_ORIGINS` | 任意。追加で許可するオリジン（カンマ区切り） |
| `GOOGLE_OAUTH_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` | Drive 転送用。未設定の間は転送しない（アップロードは動く） |
| `CRON_SECRET` | 16 文字以上のランダム文字列。Vercel Cron が `/api/fan-upload/transfer` を呼ぶときの認証（未設定なら 404） |
| `FAN_MOMENTS_R2_RETENTION_DAYS` / `FAN_MOMENTS_TRANSFER_BUDGET_SEC` | 任意。Drive 確認後の R2 保持日数（既定 7）/ 1 回の実行で転送に使う秒数（既定 40。関数の上限は 60 秒） |

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

## Google Drive への転送（最終保存先）

R2 は受付・一時保管・転送バッファ、**Google Drive が最終保存先**。アップロード〜通知〜完了画面の流れは変えず、
その後ろに「R2 → Drive」の転送を足している（`src/lib/fan-upload/transfer.ts`）。

```
マイドライブ / 03_media / Fan moments /
  {開催日} {LIVE名} /          例: 2026.09.20 Spotify O-Crest『CASCADE』
    20261012-152405_1_IMG_1355.jpeg   ← R2 と同じ名前（投稿日時_連番_元のファイル名）
  その他 /
    ...
```

- 投稿ごとのサブフォルダは作らず、LIVE フォルダに素材を直接置く。ファイル名の先頭の投稿日時で時系列に並び、他の人の `IMG_1355` とも衝突しない
- LIVE フォルダは名前ではなく `appProperties.liveId` で探す（LIVE 名が後から変わっても別フォルダが増えない）。ファイルの「説明」に、区分・投稿日時・メッセージ・元のファイル名・投稿 ID を入れる
  （Drive アプリの詳細で読める）。同じ内容のうち機械が使う `ddKey`（`{uploadId}:{連番}`）などは `appProperties` に入る
- 共有設定は一切変更しない（フォルダの共有範囲は `03_media` を引き継ぐ）

### 流れ

1. `complete` が R2 の保存を確定して通知メールを送る（従来どおり）。その応答を返した**あと**に、同じ投稿の転送を 1 回始める（`after()`）
2. 転送は R2 から 32MiB ずつ範囲読みして Drive の resumable セッションへ送る。進捗（セッション URL とオフセット）はチャンクごとに
   その投稿の `drive.json` へ保存するので、時間切れ・通信断のあとは続きから送る。`manifest.json` には触れない
3. **日次 Cron**（`vercel.json`、03:00 JST）が `GET /api/fan-upload/transfer` を呼び、未転送・失敗した投稿の再試行と R2 の掃除を行う（Hobby は Cron が 1 日 1 回まで）
4. Drive 設定（`GOOGLE_OAUTH_*`）が無い間は、転送は何もしない（アップロードには影響しない）

- **成功の判定**: ファイルごとに、Drive の最終応答の `size` が R2 のサイズと一致すること。`fileId` と `md5Checksum` を `drive.json` に記録する。全ファイルが揃うと `state: "done"`
- **重複の防止**: 作成前に `ddKey` で Drive を検索 / `drive.json` の更新は R2 の条件付き書き込み（ETag）とリース（90 秒）で排他 / 保存済みセッションの続きから送る
- **失敗**: R2 の原本には触れない。試行回数とエラーを記録し、次の実行で再試行する。3 回失敗または 24 時間続くと `[Fan moments] Drive転送に失敗` のメールを 1 回送る
  （トークン失効の再認証が必要な場合もここで気づける）

### R2 のクリーン（アプリが行う。R2 のライフサイクルルールでは消さない）

- 対象は、全ファイルが Drive で確認できた投稿で、**確認（`doneAt`）から 7 日**（`FAN_MOMENTS_R2_RETENTION_DAYS` で変更可）経過したものだけ
- 消す直前に、Drive の実ファイルを 1 件ずつ再確認する（存在する・ゴミ箱でない・サイズが一致・同じ投稿の `ddKey`）。1 つでも満たさなければ消さない
- 転送に失敗している・未転送の投稿は、何日経っても消さない。削除は原本 → `drive.json` → `manifest.json` の順
- 完了しなかったマルチパートは、従来どおり R2 側の「Default Multipart Abort Rule（7 日）」が担当する（別の仕組み）

### 初回の準備（人間操作）

1. Google Cloud Console の OAuth を「本番環境」に公開済みであること（スコープは `drive.file` のみ）
2. 公開**後**に、下記のスクリプトでリフレッシュトークンを発行し直し、Vercel（Production）の `GOOGLE_OAUTH_*` と `CRON_SECRET` を設定する
3. 初回の転送でアプリがマイドライブ直下に `Fan moments` フォルダを作る。**そのフォルダを `03_media` へ 1 回だけ移動**する
   （`drive.file` は既存フォルダの中身を見られないため。移動後もアプリは同じフォルダを `appProperties` で見つけて使い続ける）
4. 実機（iPhone）で `Fan moments → R2 → Drive` を確認してから、公開の判断をする

## Google OAuth トークンの発行・更新

`GOOGLE_OAUTH_*`（Drive 転送で使う）のリフレッシュトークンは `scripts/dd-upload-oauth.mjs` で発行する（ローカルで手動実行）。

```
node scripts/dd-upload-oauth.mjs --login-hint <保存先Googleアカウント> [--targets production,preview] [--no-deliver]
```

- OAuth クライアント JSON は **repository の外**に置く（既定: `/Users/hayato/site/secrets/deddecay/dd-upload/google-oauth-client.json`、
  環境変数 `DD_UPLOAD_OAUTH_CLIENT_JSON` で変更可）。ファイル権限が 600 でなければ中断する。JSON・トークンは Git に入れない
- ブラウザで Google の認証画面が開く。保存先アカウントで `drive.file` に同意する（5 分以内）
- 取得したリフレッシュトークンは画面・ログ・ファイルに出さず、Vercel CLI の標準入力へ直接渡す（`--no-deliver` なら保存しない）
- OAuth アプリは「本番環境」で運用する（Fan moments を公開する機能のため）。「テスト」状態のリフレッシュトークンは約 7 日で失効するので、
  **本番公開より前に発行したトークンは、公開後に発行し直す**。失効した場合は Drive 転送が失敗し、失敗通知メールが届く（R2 の原本は残る）
- Production と Preview はそれぞれ別のトークンになる（どちらも有効）

## セキュリティ境界

- R2 バケットは非公開。投稿者に渡るのは、1 パートだけを書き込める署名付き URL（期限 24 時間）のみ。読み出し用の URL は発行しない
- 認証情報（R2 の API トークン）はサーバーの環境変数のみ。署名付き URL にはアクセスキー ID が含まれるが、秘密鍵は含まれない
- 結合・検証・削除はすべてサーバー側。クライアントから ETag や保存先のキーを受け取らない（保存先は署名済みトークンの `k` と manifest から決まる）
- Origin 許可リスト、Turnstile（init で 1 回）、rate limit（IP 単位の回数・日次容量）、形式許可リスト、サイズ・件数上限、完了時の先頭バイト検証、アプリ上限による受付停止
- 通知メールにはファイルを添付せず、ファイルへの URL も載せない

## 運用

- 投稿が届くと CONTACT 宛先に `[Fan moments] LIVE / n件`（または `その他`）の件名でメールが届く。Cloudflare ダッシュボードの R2 で、メールに書かれたフォルダを確認する
- R2 の保存量が `FAN_UPLOAD_APP_CAP_GB` を超えると、新規投稿を自動で断る（安全弁。既存データは削除しない）
- 日常の閲覧・ダウンロードは Google Drive（`03_media/Fan moments`）で行う。R2 は直接見に行かなくてよい
- R2 の正常投稿は、Drive 転送の確認から 7 日後にアプリが自動削除する（転送できていない投稿は削除しない）。不適切な投稿は Drive 側で削除する
- 同意文を変更したら `src/lib/fan-upload/policy.ts` の `CONSENT_VERSION` を更新する

## テスト

`npm test`（R2 / Turnstile / メールはモック。SigV4 署名は AWS 公式ドキュメントの署名例と一致することを確認している）。
実機確認は Production の直接 URL（公開導線は OFF のまま）で、PC とスマートフォンから大容量動画を送り、
R2 への保存・メール 1 通・中断後の再開を確認する。

## 実機 E2E の記録

### 2026-10-12 iPhone Safari・Production 直接 URL（成功）

- 投稿: LIVE（`liveId = bg95k9pc7kmy`）に写真 1 件（約 242 KB）+ 動画 1 件（約 19.55 MB）。アップロード完了・通知メール受信まで確認
- R2 の保存先: `fan-moments/live/bg95k9pc7kmy/Y8f_IWuAoAE2_yqi/` に、`20261012-152405_1_IMG_1355.jpeg`・`20261012-152405_2_IMG_1289.mov`・`manifest.json`（約 1.87 KB）
- 画面上の容量表示（バイナリ単位: 236 KB / 18.6 MB）と Cloudflare の表示（10 進単位: 約 242 KB / 約 19.55 MB）は、単位の違いで一致する
- 完了処理は、宣言サイズと R2 上のサイズが一致し、先頭バイト検査に通ったファイルだけを残す。両ファイルが最終名で残っていることは、この検証を通ったことを示す

### 同日の初回失敗（原因: R2 の CORS 未設定）

- 症状: 約 120 秒後に「通信が不安定なため中断しました」。ブラウザの事前確認（プリフライト）が拒否され、パートの PUT が 8 回連続で通信エラーになった
- 対処: バケットの CORS Policy を設定（本番オリジンのみ・PUT のみ）。コードの変更はしていない。**CORS が無いとアップロードは成立しない**ため、バケットの作り直しや環境の追加では、最初に確認する
- 後始末: 失敗した投稿が作った未完了のマルチパートアップロードが残る。バケットの標準ルール「Default Multipart Abort Rule」（未完了のマルチパートを自動で中断）に任せ、手動では削除しない。失敗した投稿の `manifest.json`（状態 `pending`）は自動削除の対象ではなく、保管・削除の運用が決まるまで残す
