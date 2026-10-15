# deddecay official website — サイト仕様書

> 最終更新：2026-05-28（new 表示実装・公開制御 microCMS 標準移行・public/ 整理・OGP実装・ambient layer 構想記録）
> 本ドキュメントは現行の公開済み実装を記録したものです。

---

## 技術構成

| 項目 | 内容 |
|---|---|
| フレームワーク | Next.js 16.2.6（App Router） |
| React | 19.2.4 |
| 言語 | TypeScript |
| CSSフレームワーク | Tailwind CSS v4 |
| CMS | microCMS |
| メール送信 | Resend |
| アイコン | `simple-icons` npm パッケージ |
| フォント | Geist Sans / Geist Mono |
| ホスティング | Vercel |
| 本番 URL | https://deddecay.tokyo |
| ドメイン管理 | Cloudflare（DNS のみ、SSL は Vercel） |

### キャッシュ戦略

全ページに `export const revalidate = 60` を設定（ISR 60秒）。

---

## ファイル構成

```
app/
  page.tsx                          # TOP
  layout.tsx                        # ルートレイアウト
  globals.css                       # グローバルCSS
  _components/
    NavMenu.tsx                     # 展開メニュー（Client Component）
    ContactForm.tsx                 # CONTACTフォーム（Client Component）
  news/
    [slug]/page.tsx                 # NEWS詳細（param は contentId として扱う）
  live/
    [contentId]/page.tsx            # LIVE詳細
  discography/
    [contentId]/page.tsx            # DISCOGRAPHY詳細
  entries/
    page.tsx                        # NEWS / LIVE 共通過去ログ
  api/
    contact/route.ts                # CONTACTフォーム送信 API
src/
  lib/
    microcms.ts                     # CMSクライアント・型・fetch関数
  data/
    biography.ts                    # BIOGRAPHY フォールバック用静的データ
    discography.ts                  # DISCOGRAPHY フォールバック用静的データ
public/
  logo-white.png                    # ロゴ画像
  og/
    og-default.jpg                  # デフォルト OGP 画像
  ambient/
    .gitkeep                        # ambient 素材置き場（将来用・現在空）
docs/
  site_spec.md                      # 本ファイル（現行仕様）
  operation_guide.md                # 投稿・運用ガイド
  top_spec.md                       # 旧仕様書（CMS連携前、参考用）
```

---

## デザイン方針

- 背景：黒（`#000`）
- テキスト：白（opacity で濃淡調整）
- 基調：ミニマル・静的・無機質
- フォント：Geist Sans（英字）、システムフォント（日本語）
- アニメーション：transition のみ（scale / opacity / max-height）＋CSS animation は次の 2 つだけ（後述）：TOPロゴ初回表示（1 回）／TOP の「Fan moments」文字の不規則なちらつき（永続）
- hover：少し白くなる程度（`text-white`）
- ボタン：`rounded-sm`、細い border、glow・shadow なし
- モバイルファースト：`sm:` ブレイクポイントで PC 向けに微調整
- コンテンツ幅：`max-w-xs`（モバイル）/ `max-w-sm`（sm 以上）
- YouTube 埋め込み：**廃止済み**（SNS アイコンの YouTube リンクは残す）

---

## ページ構成

| パス | 概要 |
|---|---|
| `/` | TOP（ロゴ・SNSアイコン・展開メニュー） |
| `/news/{contentId}` | NEWS詳細 |
| `/live/{contentId}` | LIVE詳細 |
| `/discography/{contentId}` | DISCOGRAPHY詳細 |
| `/entries?type=news` | NEWS 過去ログ（ページネーション付き） |
| `/entries?type=live` | LIVE 過去ログ（ページネーション付き） |
| `/api/contact` | CONTACTフォーム送信エンドポイント（POST） |
| `/fan-moments` | Fan moments のメインページ（説明＋「投稿する」で `/upload` へ）。`FAN_MOMENTS_ENABLED=1` でのみ表示、未設定は 404。noindex |
| `/upload` | Fan moments の投稿フォーム（既存。TOP からは直接リンクしない） |

---

## microCMS 構成

### entries API（リスト）

NEWS と LIVE を共通管理する。

| フィールド | 型 | 用途 |
|---|---|---|
| `title` | テキスト | タイトル |
| `type` | セレクトフィールド（複数可） | `news` / `live` で分岐 |
| `body` | リッチテキスト | 本文 |
| `thumbnail` | 画像 | NEWS詳細のサムネイル・OGP画像 |
| `eventDate` | 日時 | web画面表示日時（LIVEでは入力必須・NEWSでは任意） |
| `externalLinks` | 繰り返しフィールド | 外部リンク（url / label） |
| `slug` | テキスト | 現在未使用（URL は contentId） |

- URL は常に contentId ベース（slug は使用しない）
- `type[contains]news` / `type[contains]live` でフィルタリング（配列型にも対応）
- 公開・予約投稿は microCMS 標準機能で管理（後述）

### biography API（シングルコンテンツ）

| フィールド | 型 | 用途 |
|---|---|---|
| `title` | テキスト | アーティスト名 |
| `photo` | 画像 | プロフィール写真 |
| `body` | リッチテキスト | プロフィール本文 |

- 詳細ページなし（TOP の BIOGRAPHY 展開内にのみ表示）
- CMS 未取得時は `src/data/biography.ts` の固定データにフォールバック

### discography API（リスト）

| フィールド | 型 | 用途 |
|---|---|---|
| `title` | テキスト | 作品タイトル |
| `subtitle` | テキスト | サブタイトル（任意） |
| `releaseType` | セレクト | 作品種別 `album` / `ep` / `single`（任意・未設定は `single` 扱い） |
| `cover` | 画像 | ジャケット画像 |
| `releaseDate` | 日時 | リリース日（ソート用） |
| `subscriptionUrl` | テキスト | 配信リンク（任意） |
| `buyUrl` | テキスト | 購入リンク（任意） |
| `body` | リッチテキスト | 歌詞・クレジット・補足情報（任意） |

- 新しい `releaseDate` 順に表示（未設定時は `publishedAt` フォールバック）
- TOP 表示 + 詳細ページあり（`/discography/{contentId}`）
- CMS 未取得時は `src/data/discography.ts` にフォールバック

---

## 表示制御

microCMS 標準の公開・予約投稿機能で管理する。非公開または公開予定時刻前のコンテンツは API から返されないため、サイト側でのフィルタリングは不要。

| 状態 | 表示 |
|---|---|
| 公開 ON | 表示 |
| 公開 OFF | 非表示 |
| 予約投稿（公開 ON・未来日時） | 指定時刻まで非表示 |

---

## TOP ページ

### 構成

```
deddecay（ロゴ h1）
↓
SNS / 外部リンクアイコン（6個横並び）
↓
NavMenu（展開メニュー群）
↓
Copyright
```

### ロゴ初回表示アニメーション（暫定）

> ⚠️ 暫定採用。最終確認後に削除・変更の可能性あり。

| 項目 | 内容 |
|---|---|
| 対象 | TOPロゴ（`public/logo-white.png`）のみ |
| className | `logo-signal` |
| 実装場所 | `app/globals.css` |
| 演出 | opacity のみを使った高速な不規則点滅（380ms・1回のみ） |
| 着地後 | 完全静止 |
| タイミング関数 | `steps(1, end)`（滑らかなフェードではなく、デジタルな切り替わり） |
| 非対応環境 | `prefers-reduced-motion: reduce` では静止表示 |

不採用とした案（参考）：
- フラッシュ残像（blur + ::before/::after レイヤー）→ 消えかけの電球感になり不採用
- 微細な横スライス（clip-path + translateX）→ 安っぽく見えたため不採用

### SNS アイコン

| アイコン | リンク |
|---|---|
| Apple Music | https://music.apple.com/jp/artist/deddecay/6773657681 |
| Spotify | https://open.spotify.com/intl-ja/artist/2Odjvded4tky0XgSZtHssl?si=atkoQdhiRB-TeHzYqubfzg |
| YouTube | https://www.youtube.com/@deddecay |
| Instagram | https://www.instagram.com/deddecay |
| X | https://x.com/deddecay |
| TikTok | https://www.tiktok.com/@deddecay |

- 外部リンクは `target="_blank" rel="noopener noreferrer"`

### 展開メニュー

- NEWS / LIVE / BIOGRAPHY / DISCOGRAPHY / CONTACT の 5 セクション
- 常に 1 セクションのみ展開（別セクション選択時は閉じてから開く、220ms 後）
- STORE は展開なしの外部リンク（https://deddecay.base.shop/）
- **Fan moments**：DISCOGRAPHY の直下（CONTACT の前）に置く展開なしのリンク（STORE と同じ短い下線）。リンク先は `/fan-moments`（`/upload` へは直接つながない）。`FAN_MOMENTS_ENABLED=1` のときだけ表示する（リンク先 `/fan-moments` が有効な環境でだけ出す。`FAN_MOMENTS_PUBLIC` は LIVE 詳細のリンク用）

#### Fan moments 文字のちらつき（永続・例外）

| 項目 | 内容 |
|---|---|
| 対象 | TOP の「Fan moments」リンク文字のみ |
| className | `fan-moments-flicker`（リンク・周期 8s）／`fan-moments-flicker-b`（内側の span・周期 11s） |
| 実装場所 | `app/globals.css` |
| 演出 | opacity のみ・`steps(1, end)`。通常は opacity 1（読める状態）で、短いちらつきが不規則に入る。2 つの周期を重ねて規則的に見えないようにする |
| 可読性の上限 | 最低 opacity 0.5／1 回のちらつきは 0.5 秒未満／1 秒間の明滅は 3 回未満 |
| 非対応環境 | `prefers-reduced-motion: reduce` では静止表示（アニメーションは `no-preference` のときだけ指定） |

---

## NEWS 仕様

### TOP 表示

- microCMS `entries` API から最新 5 件（`type=news`）
- 表示日時：`eventDate ?? publishedAt`
- 末尾に `and more...` → `/entries?type=news`

### 詳細ページ（`/news/{contentId}`）

- サムネイル（`w-full object-cover`）、なければ非表示
- 表示日時（`eventDate ?? publishedAt`）
- タイトル / 本文
- 前後ナビゲーション
  - `← prev` = 新しい記事（`publishedAt` 降順で前）
  - `next →` = 古い記事（`publishedAt` 降順で次）
  - リンク先なしの場合は disabled 表示（非表示にしない）

---

## LIVE 仕様

### TOP 表示

- microCMS `entries` API から直近 5 件（`type=live`、`eventDate` 昇順）
- 表示日時：`eventDate ?? publishedAt`
- 末尾に `and more...` → `/entries?type=live`

### 詳細ページ（`/live/{contentId}`）

- 表示日時（`eventDate`、なければ `publishedAt`）
- タイトル / 本文
- 前後ナビゲーション（NEWS と同様）

---

## 新着表示（new）— NEWS / LIVE 共通

| 項目 | 内容 |
|---|---|
| 表示対象 | TOP の NEWS・LIVE 一覧、過去ログ一覧 |
| 表示文言 | 小文字 `new`（日時の左） |
| 判定基準 | `publishedAt` |
| 表示条件 | `publishedAt` が現在以前かつ7日以内 |
| 実装 | `isNewEntry()` in `src/lib/microcms.ts` |

- LIVE の表示日時は `eventDate` だが、new 判定は `publishedAt` を使う
- 予約投稿・即時公開問わず、**公開された日時を起点に7日後に自動消滅**
- 公開前（未来の `publishedAt`）では表示されない

---

## BIOGRAPHY 仕様

- TOP の BIOGRAPHY 展開内にのみ表示（詳細ページなし）
- プロフィール写真（`w-32 h-32 sm:w-36 sm:h-36 object-cover`）
- タイトル / 本文（CMS のリッチテキストを `dangerouslySetInnerHTML` で描画）
- CMS 未取得時は `src/data/biography.ts` の固定文言・画像なし状態にフォールバック

---

## DISCOGRAPHY 仕様

### TOP 表示

```
DISCOGRAPHY
ALBUM / EP  /  SINGLE          ← カテゴリ切替
[ジャケット] タイトル / サブタイトル    listen / buy
```

- カテゴリ切替は `releaseType` によるクライアント側フィルタ（取得処理・並び順は変更しない）
  - `ALBUM / EP` タブ → `album` / `ep`
  - `SINGLE` タブ → `single`（`releaseType` 未設定もここに入る）
- 初期タブは `ALBUM / EP`。該当作品が0件の場合のみ `SINGLE` から開始する
- 選択中カテゴリが0件の場合は `COMING SOON` を表示

- cover・title・subtitle クリックで詳細ページへ
- `subscriptionUrl` / `buyUrl` は外部リンク（`target="_blank" rel="noopener noreferrer"`）
- URL 未設定時は disabled 表示（非表示にしない）

### 詳細ページ（`/discography/{contentId}`）

- cover（全幅）/ タイトル / サブタイトル
- listen / buy リンク（URL 未設定時は非表示）
- body（歌詞・クレジット等）、body が空の場合は `—`
- `?draftKey=` 付きのプレビュー時のみ `preview — {releaseType}` を表示（公開表示では出ない）

---

## CONTACT 仕様

### フォーム構成

| フィールド | 種別 | 表示名 |
|---|---|---|
| `category` | select | 種別 |
| `name` | text | お名前 |
| `email` | email | メールアドレス |
| `subject` | text | 件名 |
| `message` | textarea（4行） | 内容 |
| `website` | hidden | （ハニーポット、ユーザーには見えない） |

#### カテゴリ選択肢

| 内部値 | 表示名 |
|---|---|
| `BOOKING` | ライブのお誘い |
| `TICKET` | チケット関連 |
| `MEDIA` | 取材・メディア |
| `OTHER` | その他 |

### バリデーション

- 全フィールド（category / name / email / subject / message）入力済みで「確認する」ボタン有効化
- email は正規表現 `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` で検証
  - NG：`あいうえお` / `aaa` / `aaa@bbb`
  - OK：`test@example.com` / `info@deddecay.tokyo`
- 未入力・バリデーション NG 時はボタン disabled（`pointer-events-none`）

### スパム対策（ハニーポット）

- `website` フィールドを画面外に隠す（`position: absolute; left: -9999px`）
- `tabIndex={-1}` / `autoComplete="off"` / `aria-hidden="true"`
- bot がフィールドを入力した場合、サーバー側はサイレントに `{ ok: true }` を返す（bot には検知されない）

### フロー

1. フォーム入力 → 「確認する」で Preview モーダル
2. Preview モーダルで内容確認 → 「送信」
3. API `/api/contact` に POST
4. 成功 → Complete モーダル（フォームリセット）
5. 失敗 → Preview モーダル内にエラー文言表示（入力内容保持）

### メール送信仕様

| 項目 | 内容 |
|---|---|
| 送信サービス | Resend |
| To | 環境変数 `CONTACT_TO_EMAIL` |
| From | 環境変数 `CONTACT_FROM_EMAIL`（Resend 検証済みドメイン必須） |
| Reply-To | フォーム入力の email |
| Subject | `[CATEGORY] 件名` |
| Body | 種別 / お名前 / メールアドレス / 件名 / 内容（プレーンテキスト） |

---

## NEWS / LIVE 共通過去ログ（`/entries`）

- query `?type=news` または `?type=live` で切り替え（デフォルト `news`）
- 1 ページ 10 件
- 表示：表示日時（`eventDate ?? publishedAt`）+ タイトル → 各詳細へリンク
- ページネーション：`← prev` / `ページ番号 / 総ページ数` / `next →`
- 無効時は disabled 表示（非表示にしない）
- 空状態：`no entries` 表示

---

## 環境変数

`.env.local.example` を参照。本番値は `.env.local` に設定する（git 管理外）。

| 変数名 | 用途 |
|---|---|
| `MICROCMS_SERVICE_DOMAIN` | microCMS サービスドメイン |
| `MICROCMS_API_KEY` | microCMS API キー |
| `RESEND_API_KEY` | Resend API キー |
| `CONTACT_TO_EMAIL` | CONTACTフォームの受信先アドレス |
| `CONTACT_FROM_EMAIL` | CONTACTフォームの送信元（Resend 検証済みドメイン） |

---

## OGP

### 現行仕様

| 項目 | 内容 |
|---|---|
| デフォルトOGP画像 | `public/og/og-default.jpg` |
| 実装箇所（共通） | `app/layout.tsx` の `metadata` |
| `metadataBase` | `https://deddecay.tokyo` |
| `og:type` | `website` |
| `twitter:card` | `summary_large_image` |
| 動的OGP | NEWS・LIVE 詳細ページのみ実装済み |

#### 動的OGP（NEWS / LIVE 詳細ページ）

- `thumbnail` がある場合はその URL を OGP 画像に使用
- `thumbnail` なしの場合は `/og/og-default.jpg` にフォールバック
- 実装箇所：各詳細ページの `generateMetadata()`

> ※ Basic認証有効中は外部クローラーが画像を取得できない可能性がある。Basic認証解除後に外部OGP確認ツールで動作確認すること。

### 今後の候補

- DISCOGRAPHY の `cover` を詳細ページの OGP に使用する案あり
- 複数 OGP 画像を日付・更新状態に応じて切り替える案あり（完全ランダムは SNS 側キャッシュの都合で不向き）
- 「状態変化型 OGP」として更新後 24 時間だけ別画像にする案あり

---

## ambient layer（将来構想・未実装）

### 方向性

「演出」ではなく「状態変化」。情報を追加するのではなく、サイトが静かに息をしているような、毎日訪れた時の微細な違和感・生態感を作る。

### 設計ルール

- UI 操作を邪魔しない・クリック領域を持たない・音を出さない
- 低頻度・派手なグリッチ禁止
- `prefers-reduced-motion: reduce` 対応必須
- モバイルは軽量化（アニメーション省略も可）
- まずは TOP のみ対象

### 候補

| 案 | 概要 |
|---|---|
| 微細ノイズレイヤー | ロゴ周辺や背景に極低強度のノイズを重ねる |
| 深夜変化 | 深夜時間帯のみ opacity 等が微変化 |
| 更新後 24h 変化 | CMS 投稿から 24 時間だけ微細な視覚変化 |
| ロゴ低頻度点滅 | 数分に一度・極低確率で logo-signal が再生 |
| ランダムフッター文言 | Copyright 付近の文言が低頻度でわずかに変化 |
| 状態変化型 OGP | 更新後 24h だけ別 OGP 画像を使用 |

### 素材管理

- 置き場：`public/ambient/`（現在は `.gitkeep` のみ）
- 命名規則：`種類-強度-番号`

```
noise-soft-01.png
noise-hard-01.png
grain-soft-01.png
signal-dot-01.png
```

---

## 今後の追加候補

| 項目 | 備考 |
|---|---|
| ambient layer | 状態変化型の視覚演出（上記セクション参照） |
| 動的OGP（DISCOGRAPHY） | cover を詳細ページの OGP に反映（NEWS・LIVE は実装済み） |
| favicon | 現状 `app/icon.png` 設定済み・最終確認 |
| アクセス解析 | GA / Vercel Analytics 等 |
| sitemap / robots.txt | — |
| CONTACT 強化 | reCAPTCHA / Cloudflare Turnstile / rate limiting |
| 自動返信メール | 問い合わせ者への受信確認 |
