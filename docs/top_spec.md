# deddecay トップページ仕様書（旧）

> ⚠️ このドキュメントは CMS 連携前の旧仕様です。現行仕様は [site_spec.md](site_spec.md) を参照してください。

> 最終更新：2026-05-25（旧）  
> 対象ブランチ：main（開発中）

---

## 技術構成

| 項目 | 内容 |
|---|---|
| フレームワーク | Next.js 16.2.6（App Router） |
| React | 19.2.4 |
| 言語 | TypeScript |
| CSSフレームワーク | Tailwind CSS v4（`@import "tailwindcss"`） |
| アイコン | `simple-icons` npm パッケージ |
| フォント | Geist Sans / Geist Mono（Google Fonts, CSS変数経由） |
| ホスティング | 未定（Vercel 想定） |

---

## ファイル構成

```
app/
  page.tsx                   # トップページ
  layout.tsx                 # ルートレイアウト
  globals.css                # グローバルCSS（スクロール設定含む）
  _components/
    NavMenu.tsx              # 開閉メニュー（Client Component）
    ContactForm.tsx          # CONTACTフォーム + モーダル（Client Component）
docs/
  top_spec.md                # 本ファイル
```

---

## トップページ構成

縦に1カラム、中央配置。コンテンツ順序は以下の通り。

```
deddecay（ロゴ h1）
↓
YouTube 動画埋め込み
↓
SNS / サブスクアイコン（6個横並び）
↓
NavMenu（展開メニュー群）
↓
Copyright
```

### レイアウト

- `<main>`: `min-h-screen flex flex-col items-center`
- 上下パディング: `pt-10 sm:pt-12 / pb-10 sm:pb-12`
- 横パディング: `px-8`
- コンテンツ幅: `max-w-xs sm:max-w-sm`（`max-w-xs` = 320px, `sm:max-w-sm` = 384px）
- コンテンツ間 gap: `gap-10`
- Copyright: `mt-auto pt-10`（コンテンツが短い時は画面下端、長い時はコンテンツ末尾）

### ロゴ

- `<h1>` 内に `next/image` で `public/logo-white.png` を表示
- 表示幅: `w-4/5`（コンテナ幅の80%）、`h-auto object-contain block mx-auto`
- `priority` 付き（LCP 対象のため先読み）
- `alt="deddecay"`

### YouTube 動画埋め込み（暫定）

- 公式チャンネル: `https://www.youtube.com/@deddecay`（定数 `YOUTUBE_CHANNEL`）
- 埋め込みURL: `https://www.youtube.com/embed/d8sFhiJZyOA`（暫定動画ID）
- コンテナ: `w-full aspect-video overflow-hidden rounded-sm`
- `allow`: `accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share`
- `allowFullScreen`: あり
- iframe 下に `→ YouTube` リンク（`YOUTUBE_CHANNEL` へ、`target="_blank"`）
- **暫定実装**：MVや告知動画が確定したら埋め込み動画IDを差し替え

### Copyright

```
Copyright© deddecay, 2026 All Rights Reserved.
```

- `text-[10px] tracking-[0.2em] text-white/45 select-none`

---

## SNS / 外部リンクアイコン

`simple-icons` のパスを使った SVG ラッパー方式。

| アイコン | href | 外部リンク |
|---|---|---|
| Apple Music | `#`（未設定） | — |
| Spotify | `#`（未設定） | — |
| YouTube | `https://www.youtube.com/@deddecay` | ✓ |
| Instagram | `https://www.instagram.com/deddecay` | ✓ |
| X | `https://x.com/deddecay` | ✓ |
| TikTok | `https://www.tiktok.com/@deddecay` | ✓ |

- 外部リンクは `target="_blank" rel="noopener noreferrer"`
- アイコンサイズ: `w-4 h-4`
- ボタンサイズ: `w-10 h-10 rounded-full border border-white/30`
- hover: `text-white border-white/70`

---

## メニュー開閉仕様

### 対象セクション

`news` / `live` / `biography` / `discography` / `contact`

- 常に**1セクションのみ**展開
- 展開中に別セクションをクリック → 既存を閉じてから（220ms後）新しいセクションを開く
- 同じセクションをクリック → 閉じる

### アニメーション

| 状態 | 挙動 |
|---|---|
| 下線（閉） | `scale-x-[0.075]`（幅の約7%のみ表示） |
| 下線（開） | `scale-x-100`（全幅）、`duration-200` |
| パネル（開） | `max-h → 内容高さ`、`opacity 0→1`、`duration-300 delay-150` |
| パネル（閉） | `max-h 0`、`opacity 0`、`duration-150` |

- `contact` のパネル max-h: `max-h-[520px]`（フォーム5項目分）
- 他セクションのパネル max-h: `max-h-80 sm:max-h-96`

### スクロール補助

- 開いた時のみ実行（閉じる時はスクロールしない）
- 全セクション共通の `window.scrollTo` 方式
- delay: **380ms**（展開アニメーション完了後）
- 基準位置: `window.innerHeight * 0.15`（画面上端から15%の位置に選択メニューが来る）

```ts
const rect = el.getBoundingClientRect();
const targetY = window.innerHeight * 0.15;
window.scrollTo({ top: window.scrollY + rect.top - targetY, behavior: "smooth" });
```

### その他リンク

- **STORE**: `https://deddecay.base.shop/` 外部リンク（展開なし）
- **CONTACT**: 展開式フォーム（外部リンクではない）

---

## NEWS 仕様

- 表示件数: **5件**（ダミーデータ）
- データソース: `src/data/news.ts`（静的配列、CMS未導入）
- 末尾に `and more...`（`/news` へのリンク）
- `/news` ページは未実装

### NewsItem 型

```ts
type NewsItem = {
  id: string;              // 一意ID（例: "news-001"）
  date: string;            // 表示日付 "YYYY.MM.DD"
  title: string;           // 一覧・ナビ表示用見出し
  body: string;            // 本文（詳細ページ用、現時点は空文字）
  isPlaceholder?: boolean; // true = 仮データ
};
```

---

## LIVE 仕様

- 表示件数: **3件**（ダミーデータ）
- データソース: `src/data/live.ts`（静的配列、CMS未導入）
- 末尾に `and more...`（`/live` へのリンク）
- `/live` ページは未実装

### LiveItem 型

```ts
type LiveItem = {
  id: string;              // 一意ID（例: "live-001"）
  date: string;            // 表示日付 "YYYY.MM.DD"
  venue: string;           // 会場名（一覧・ナビ表示用）
  title: string;           // 公演タイトル（詳細ページ用）
  open?: string;           // 開場時刻 "HH:MM"
  start?: string;          // 開演時刻 "HH:MM"
  ticket?: string;         // チケット情報または購入URL
  link?: string;           // 公演詳細URL
  isPlaceholder?: boolean; // true = 仮データ
};
```

---

## BIOGRAPHY 仕様

- **トップ内完結**（詳細ページなし）
- データソース: `src/data/biography.ts`
- 現時点は全て仮素材（`isPlaceholder: true`）
- アーティスト画像は `bg-white/10` グレー表示（本素材・レンダリング差し替えは CMS フェーズで対応予定）

### BiographyData 型

```ts
type BiographyData = {
  name: string;
  description: string;
  image?: string;          // 画像パス（CMS フェーズで使用）
  isPlaceholder?: boolean; // true = 仮素材
};
```

---

## DISCOGRAPHY 仕様

- **トップ内完結**（詳細ページなし）
- データソース: `src/data/discography.ts`（静的配列、CMS未導入）
- 表示件数: **2件**（仮データ）
- 現時点は全て仮素材（`isPlaceholder: true`）
- `link` が設定されている場合のみ外部リンク（`target="_blank" rel="noopener noreferrer"`）
- `link` が空の場合はリンクなし（クリック不可の `<div>`）
- 配信リンク（Apple Music / Spotify 等）は未確定のため空
- ジャケット画像は `bg-white/10` グレー表示（本素材・レンダリング差し替えは CMS フェーズで対応予定）
- `and more...` リンクなし（トップ内完結のため）

### DiscographyItem 型

```ts
type DiscographyItem = {
  id: string;
  title: string;
  type: string;            // "Single" / "Album" / "EP" など
  year: string;            // "YYYY"
  link?: string;           // 配信/購入リンク（空文字の場合はリンクなし）
  linkLabel?: string;      // リンクラベル（例: "配信で聴く"）
  image?: string;          // ジャケット画像パス（CMS フェーズで使用）
  isPlaceholder?: boolean; // true = 仮素材
};
```

---

## CONTACT 仕様

### フォーム構成（ContactForm.tsx）

| フィールド | 種別 | 表示名 | placeholder |
|---|---|---|---|
| category | select | 種別 | 選択してください |
| name | text | お名前 | お名前 |
| email | email | メールアドレス | your@email.com |
| subject | text | 件名 | 件名 |
| message | textarea（4行） | 内容 | お問い合わせ内容 |

#### カテゴリ選択肢

| 内部値（value） | 表示名（label） |
|---|---|
| `BOOKING` | ライブのお誘い |
| `TICKET` | チケット関連 |
| `MEDIA` | 取材・メディア |
| `OTHER` | その他 |

- 内部値は将来のメール件名付与（`[BOOKING]` 等）に使用するため変更しない

#### バリデーション

- 全フィールド入力済みで「確認する」ボタンが有効化
- 未入力時はボタン `disabled`（`pointer-events-none`）

### Preview モーダル

- バックドロップ: `bg-black/75`
- コンテナ: `max-h-[85vh] flex flex-col`（長文でも画面内に収まる）
- 内容エリア: `overflow-y-auto`、スクロールバー非表示
- ボタンエリア: `flex-shrink-0`で常に下部固定、`border-t border-white/10` で分離
- 表示項目: 種別（日本語ラベルに変換）/ お名前 / メールアドレス / 件名 / 内容
- ボタン: 「戻る」（フォームへ戻る、入力内容保持）/ 「送信」（Completeモーダルへ）

### Complete モーダル

- 表示文言:
  - 見出し: `送信が完了しました。`
  - 本文: `お問い合わせありがとうございます。内容を確認後、ご連絡いたします。`
- ボタン: 「閉じる」（モーダルを閉じ、フォームをリセット）

### メール送信（Phase 1 実装済み）

- メール送信サービス: **Resend**
- API Route: `app/api/contact/route.ts`（POST `/api/contact`）
- バンド側への通知メールのみ（自動返信は未実装）

#### 送信仕様

| 項目 | 内容 |
|---|---|
| To | `CONTACT_TO_EMAIL`（環境変数） |
| From | `CONTACT_FROM_EMAIL`（環境変数、Resend検証済みドメイン） |
| Reply-To | フォーム入力の Email |
| Subject | `[CATEGORY] 件名` |
| Body | 種別 / お名前 / メールアドレス / 件名 / 内容（プレーンテキスト） |

#### 環境変数（`.env.local`）

`.env.local.example` を参照。

```
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
CONTACT_TO_EMAIL=deddecay@gmail.com
CONTACT_FROM_EMAIL=noreply@example.com
```

#### テスト用アドレス

| 用途 | アドレス |
|---|---|
| バンド側受信（`CONTACT_TO_EMAIL`） | `deddecay@gmail.com` |
| テスト送信者 | `hyt.drums@gmail.com`（フォーム入力値） |

- 本番前に正式アドレス・ドメインへ差し替え

#### フロント側の挙動

- 送信中: 「送信」ボタンが「送信中...」に変わり disabled
- 送信成功: Complete モーダルを表示
- 送信失敗: Preview モーダル内に最小エラー文言を表示、入力内容は保持

#### 未実装（次フェーズ）

- 自動返信メール（ユーザーへの受信確認）
- Gmail フィルター設定（`[BOOKING]` 等で振り分け）

---

## スクロール仕様

### スクロールバー非表示 + スクロール可能

`globals.css` で設定。

```css
html {
  overflow-y: auto;
  scrollbar-width: none;        /* Firefox */
  -ms-overflow-style: none;     /* IE/Edge */
}
html::-webkit-scrollbar {
  display: none;                /* Chrome/Safari */
}
```

- `html`・`body` に `height: 100%` や `overflow: hidden` は設定しない
- `body`: `min-height: 100%` なし（自然なフロー）
- `layout.tsx` body クラス: `min-h-full`（`h-full` ではない）
- `page.tsx` main: `min-h-screen`（`h-full` ではない）

---

## デザイン方針

- 背景: 黒（`#000`）
- テキスト: 白（opacity で濃淡調整）
- 基調: ミニマル / 静的 / 無機質
- フォント: Geist Sans（英字）、システムフォント（日本語）
- アニメーション: transition のみ（scale / opacity / max-height）、flashy な演出なし
- hover: 少し白くなる（`text-white`）のみ、translateY なし
- active: 少し透過（`opacity-70`）
- ボタン類: `rounded-sm`、細い border、controls なし（glow / shadow なし）
- モバイルファースト: `sm:` ブレイクポイントで PC 向けに少し拡大

---

## 現時点の未実装 / 後回し項目

| 項目 | 状態 |
|---|---|
| CONTACTフォーム 自動返信 | 未実装（Phase 1 はバンド側通知のみ） |
| Gmail フィルター設定 | 未実装 |
| YouTube 動画 | 暫定（MVや告知動画確定後に差し替え） |
| Apple Music / Spotify / YouTube リンク | `#`（未設定） |
| BIOGRAPHY 画像 | `bg-white/10` グレー表示、本素材差し替えは CMS フェーズで対応予定 |
| DISCOGRAPHY ジャケット画像 | `bg-white/10` グレー表示、本素材差し替えは CMS フェーズで対応予定 |
| DISCOGRAPHY 各作品リンク | `link: ""` で未設定（配信リンク確定後に追加） |
| /news ページ | 未実装 |
| /live ページ | 未実装 |
| /discography ページ | 未実装 |
| /contact ページ | 不要（トップ展開式に統合済み） |
| OGP / meta 設定 | 最低限のみ（title: "deddecay"、OGP画像は本素材確定後） |
| favicon | ✅ `app/icon.png` に設定済み |
| GA / 計測タグ | 未設定 |
| 実データへの差し替え（NEWS/LIVE等） | ダミーデータのまま |

---

## Deploy 状況

> 2026-05-25 更新

### 本番 URL

`https://deddecay.tokyo`

### 構成

- Vercel Production deploy 済み
- カスタムドメイン `deddecay.tokyo` 接続済み（Cloudflare 経由・SSL 有効）

### 確認済み項目

| 確認項目 | 状態 |
|---|---|
| `npm run build` | ✅ 通過 |
| Vercel Production deploy | ✅ 成功（2026-05-25） |
| `deddecay.tokyo` 表示確認 | ✅ 正常 |
| `/api/contact` 本番疎通 | ✅ `{"ok":true}`（Resend 実送信確認済み） |

### Vercel 環境変数（設定済み）

| 変数名 | 環境 | 状態 |
|---|---|---|
| `RESEND_API_KEY` | Production | ✅ 設定済み |
| `CONTACT_TO_EMAIL` | Production | ✅ 設定済み |
| `CONTACT_FROM_EMAIL` | Production | ✅ 設定済み（`onboarding@resend.dev`、正式ドメイン取得後に差し替え要） |
