# deddecay official website — 投稿・運用ガイド

> 最終更新：2026-06-02（プレビュー機能追加）

---

## CMS へのアクセス

microCMS の管理画面から各コンテンツを管理する。

---

## 投稿種別と使い分け

| 種別 | API | 用途 |
|---|---|---|
| NEWS | entries（type=news） | お知らせ・リリース情報・告知全般 |
| LIVE | entries（type=live） | ライブ告知 |
| BIOGRAPHY | biography | プロフィール（1件のみ） |
| DISCOGRAPHY | discography | 音源情報 |

---

## NEWS の投稿

### フィールド

| フィールド | 必須 | 内容 |
|---|---|---|
| `title` | ✅ | タイトル |
| `type` | ✅ | `news` を選択 |
| `body` | — | 本文（リッチテキスト） |
| `thumbnail` | — | サムネイル画像。設定するとそのページの OGP 画像にも使われる |
| `eventDate` | — | 表示日時を publishedAt 以外にしたい場合に設定 |

### 手順

1. entries API で新規作成
2. `type` に `news` を選択
3. `title` / `body` / `thumbnail` を入力
4. 公開する → microCMS 標準の「公開」ボタンで公開

---

## LIVE の投稿

### フィールド

| フィールド | 必須 | 内容 |
|---|---|---|
| `title` | ✅ | 公演タイトル（例：「渋谷 WWW ライブ」） |
| `type` | ✅ | `live` を選択 |
| `eventDate` | ✅ | web画面表示日時（LIVEでは入力必須） |
| `body` | — | 本文（下記テンプレートを使用） |

### 本文テンプレート

```
2026.06.15(mon)

渋谷WWW
ライブtitle

OPEN 18:00
START 18:30

ADV ¥3000
DOOR ¥3500

ACT
○○
○○

TICKET
https://~
```

### 手順

1. entries API で新規作成
2. `type` に `live` を選択
3. `eventDate` に開催日時を設定
4. `title` を入力
5. `body` にテンプレートをコピーして内容を埋める
6. 公開する → microCMS 標準の「公開」ボタンで公開

---

## BIOGRAPHY の更新

biography API は 1 件のみ管理する（新規作成しない、既存の 1 件を編集する）。

| フィールド | 内容 |
|---|---|
| `title` | アーティスト名 |
| `photo` | プロフィール写真 |
| `body` | プロフィール本文（リッチテキスト） |

---

## DISCOGRAPHY の投稿

| フィールド | 必須 | 内容 |
|---|---|---|
| `title` | ✅ | 作品タイトル |
| `cover` | — | ジャケット画像 |
| `subtitle` | — | サブタイトル（例：「1st Single」） |
| `releaseType` | — | 作品種別（`album` / `ep` / `single`）。TOP のカテゴリ切替に使用 |
| `releaseDate` | — | リリース日（表示順のソートに使用） |
| `subscriptionUrl` | — | 配信リンク（Apple Music / Spotify 等） |
| `buyUrl` | — | 購入リンク（BASE / bandcamp 等） |
| `body` | — | 歌詞・クレジット・補足情報 |

- `subscriptionUrl` / `buyUrl` は未入力の場合、TOP 表示では disabled になる（消えない）
- 詳細ページの `body` が空の場合は `—` が表示される

### 作品種別（releaseType）

TOP の DISCOGRAPHY は `ALBUM / EP` と `SINGLE` の2タブに分かれる。

| 選択値 | 表示されるタブ |
|---|---|
| `album` | ALBUM / EP |
| `ep` | ALBUM / EP |
| `single` | SINGLE |
| 未設定 | SINGLE |

- 未設定でも作品が消えることはない（SINGLE 扱い）。Album / EP は明示的に選択する
- 初期表示は `ALBUM / EP`。該当作品が1件もない間は `SINGLE` が最初に開く

---

## 新着表示（new）

NEWS / LIVE 一覧（TOP・過去ログ）で、公開から7日以内の記事に日時の左へ小文字の `new` が自動表示される。

- 操作不要・自動判定
- 判定基準は `publishedAt`（公開日時）
- 予約投稿の場合は公開解禁日時が起点
- 7日経過後は自動で消える

---

## 公開・予約投稿

microCMS 標準の公開機能を使用する。

| 操作 | 結果 |
|---|---|
| 「公開」ボタン | 即時公開 |
| 「予約投稿」設定 | 指定日時に自動公開 |
| 「非公開」/ 下書き | サイト非表示 |

### 下書き管理

- 作成中：下書き状態のまま保存
- 即時公開：「公開」ボタンで公開
- 日時指定：microCMS の予約投稿機能で日時を設定して公開

---

## サイト更新の反映タイミング

ISR（Incremental Static Regeneration）で 60 秒ごとに自動更新される。

- CMS で保存 → 最大 60 秒後にサイトへ反映
- 即時反映が必要な場合は Vercel ダッシュボードから「Redeploy」する

---

## 本番デプロイ

```bash
vercel --prod --yes
```

または GitHub と連携している場合は `main` ブランチへの push で自動デプロイされる。

---

## Vercel 環境変数

`.env.local` は git 管理外。本番値は Vercel ダッシュボードで設定する。

> Settings → Environment Variables

| 変数名 | 用途 |
|---|---|
| `MICROCMS_SERVICE_DOMAIN` | microCMS サービスドメイン |
| `MICROCMS_API_KEY` | microCMS API キー |
| `RESEND_API_KEY` | Resend API キー |
| `CONTACT_TO_EMAIL` | CONTACT フォームの受信先アドレス |
| `CONTACT_FROM_EMAIL` | CONTACT フォームの送信元（Resend 検証済みドメイン必須） |

---

## 静的素材の管理（public/）

サイト内で使用する静的ファイルは用途別サブディレクトリで管理する。

| ディレクトリ | 用途 |
|---|---|
| `public/og/` | OGP 用画像。`og-default.jpg` はサイト全体のデフォルト OGP |
| `public/ambient/` | ambient layer 用素材置き場（将来用・現在空） |
| `public/` 直下 | ロゴ等、特定ディレクトリに属さないもの（`logo-white.png` 等） |

### OGP 画像を差し替えたい場合

1. 新しい画像を `public/og/` に配置
2. `app/layout.tsx` の `metadata.openGraph.images` パスを更新
3. デプロイ後、外部 OGP 確認ツールでキャッシュクリアして確認

### ambient 素材の命名規則（将来用）

形式：`種類-強度-番号`（例：`noise-soft-01.png`）

---

## プレビュー機能（NEWS / LIVE）

下書き・予約投稿・非公開記事を公開前に確認できる。

### 対応コンテンツ

| コンテンツ | 対象 |
|---|---|
| NEWS 詳細 | ✅ |
| LIVE 詳細 | ✅ |
| DISCOGRAPHY 詳細 | ✅ |
| BIOGRAPHY | — |

### 事前準備（初回のみ）

**1. 環境変数を設定する**

`.env.local`（ローカル）と Vercel 環境変数（本番）の両方に設定する。

```
PREVIEW_SECRET=任意の文字列（推測されにくい値を使用）
```

Vercel: Settings → Environment Variables → `PREVIEW_SECRET` を追加

**2. microCMS のプレビューURL を設定する**

プレビューURL は API ごとに個別に設定する。

**entries API（NEWS / LIVE）** → API設定 → プレビューURL：

```
https://deddecay.tokyo/api/preview?secret=PREVIEW_SECRET の実値&contentId={CONTENT_ID}&draftKey={DRAFT_KEY}
```

**discography API** → API設定 → プレビューURL：

```
https://deddecay.tokyo/api/preview?secret=PREVIEW_SECRET の実値&endpoint=discography&contentId={CONTENT_ID}&draftKey={DRAFT_KEY}
```

※ `{CONTENT_ID}` `{DRAFT_KEY}` は microCMS の置換変数。
※ `endpoint` は取得先 API の指定。未指定時は `entries` として扱われるため、NEWS / LIVE 側の設定は変更不要。
※ `entries` 内の news / live の振り分けは API 側で `entry.type` を取得して自動判定する。

### プレビュー手順

1. microCMS で記事を下書き保存または予約投稿設定
2. 対象記事の編集画面を開く
3. 「プレビュー」ボタンを押す
4. ブラウザで詳細ページが開き、下書き内容が表示される
5. 確認後、microCMS に戻って必要に応じて修正・公開する

### 注意事項

- プレビューURLは外部に共有しない（`draftKey` が含まれるため）
- DISCOGRAPHY のプレビューでは、タイトル下に `preview — album` のように作品種別が表示される（公開後は表示されない）
- TOP の一覧には下書きは出ない（NEWS / LIVE と同じ）。確認は詳細ページで行う
- プレビュー表示はキャッシュされない（毎回 microCMS から最新取得）
- 通常の公開ページ表示（ISR 60秒キャッシュ）には影響しない

---

## SEO / Search Console

### 実装済み（2026-06）

| ファイル | 内容 |
|---|---|
| `app/sitemap.ts` | CMS から動的生成（NEWS・LIVE・DISCOGRAPHY 詳細 + 静的ページ）、1時間 revalidate |
| `app/robots.ts` | `Allow: /`、`Sitemap:` 指定 |
| `app/layout.tsx` | `robots: { index: true, follow: true }` |

生成エンドポイント：`/sitemap.xml` `/robots.txt`

sitemap.xml に含まれる URL：
- `/`
- `/entries?type=news`
- `/entries?type=live`
- `/live`
- NEWS 詳細（全件）
- LIVE 詳細（全件）
- DISCOGRAPHY 詳細（全件）

### Search Console 登録状況

- [x] Google Search Console 登録完了
- [x] ドメイン所有権確認完了（Cloudflare DNS 認証）
- [x] sitemap.xml 送信完了
- [x] トップページ インデックス登録リクエスト完了
- [x] NEWS 詳細ページ インデックス登録リクエスト完了

現状：Googleクロール待ちフェーズ（数時間〜数日、遅い場合 1〜2 週間）

確認コマンド：`site:deddecay.tokyo`

### 新規ページ公開後の手順（Search Console）

重要なページのみ手動で登録申請する（自動クロール待ちでも可）。

対象：トップページ、重要 NEWS、LIVE 詳細

手順：Search Console → URL 検査 → 「インデックス登録をリクエスト」

**LIVE 詳細の注意：公開前の URL は登録しない。**

### 今後の検討

| 項目 | 内容 | 優先度 |
|---|---|---|
| Google Analytics | 流入元・閲覧数・デバイス比率の確認 | 中 |
| Bing Webmaster Tools | Bing 向けインデックス申請 | 低 |

---

## 確認済み項目（公開可能ライン）

- [x] 独自ドメイン（deddecay.tokyo）
- [x] 本番公開（Vercel）
- [x] microCMS 連携（NEWS / LIVE / BIOGRAPHY / DISCOGRAPHY）
- [x] NEWS 詳細・過去ログ・前後ナビ
- [x] LIVE 詳細・過去ログ・前後ナビ
- [x] BIOGRAPHY TOP 表示
- [x] DISCOGRAPHY 詳細・listen / buy リンク
- [x] CONTACT フォーム送信・受信確認
- [x] contentId URL 運用
- [x] ISR（60 秒）
- [x] 公開・予約投稿（microCMS 標準機能）
- [x] email バリデーション
- [x] ハニーポットスパム対策
- [x] 固定 OGP（サイト全体）
- [x] 動的 OGP（NEWS / LIVE 詳細ページ・thumbnail フォールバック付き）
- [x] public/ ディレクトリ整理（og/ / ambient/ 分離）
- [x] robots.txt / sitemap.xml
- [x] Google Search Console 登録・sitemap 送信
- [x] プレビュー機能（NEWS / LIVE / DISCOGRAPHY 詳細）
