# 12/6 フロアライブ チケット申し込み（2026-12-06）

> 実装：2026-11-22。2026-11-22 にユーザーの指示で **本番の受付を開始（URL 直接のみ・サイト上のリンクなし）**。
> `TICKET_1206_ENABLED=1` は設定済み、`TICKET_1206_PUBLIC` は未設定。サイト上のリンク公開はユーザーの明示的な指示があるまで行わない。

## 概要

| 項目 | 内容 |
|---|---|
| フォーム | `/tickets/2026-12-06`（noindex・sitemap 対象外） |
| API | `POST /api/tickets/2026-12-06` |
| 入力 | お名前・メールアドレス・チケット希望枚数（1〜5、残席に応じて自動で制限） |
| 料金 | 1 枚 2,000 円（ドリンク込み）・当日現地払い。合計は画面で自動計算 |
| 定員 | 50 枚。合計が 50 に達したら自動で締め切り（`定員に達したため、チケットのお申し込み受付は終了しました。`） |
| 流れ | 入力 → 確認 → 送信 → 完了 → 申込者へ自動返信・運営へ通知（`CONTACT_TO_EMAIL`） |
| 公開する場所 | 東京都世田谷区・梅ヶ丘駅周辺（ここまで） |

公演情報（タイトル・OPEN・START など公開してよい情報）は `src/lib/ticket/event.ts` に置く。

## 公開・非公開（環境変数・サーバー側で評価）

| 環境変数 | 効果 | 本番の現状 |
|---|---|---|
| `TICKET_1206_ENABLED=1` | フォームと API を有効にする。未設定なら両方 404 | **設定済み**（2026-11-22〜。URL 直接で受付中） |
| `TICKET_1206_PUBLIC=1` | TOP の CONTACT 展開内・LIVE 詳細に申し込みリンクを出す（ENABLED も必要） | **未設定** |
| `TICKET_1206_LIVE_ID` | リンクを出す LIVE 詳細の microCMS contentId | 未設定（記事作成後に設定） |

- Preview で確認するときは、Preview 環境にだけ `TICKET_1206_ENABLED=1` を設定する（リンクは出さず URL 直打ちで確認）
- 公開時は本番に `TICKET_1206_ENABLED=1` と `TICKET_1206_PUBLIC=1`（と `TICKET_1206_LIVE_ID`）を設定して再デプロイ
- `1` 以外（`true` など）は無効

## 会場情報（非公開）

正確な住所と行き方の動画は **自動返信メールにだけ** 載せる。画面・API の応答・クライアントのコードには含めない。

| 環境変数（サーバー専用。`NEXT_PUBLIC_` を付けない） | 内容 |
|---|---|
| `TICKET_1206_VENUE_ADDRESS` | 正確な会場住所（未設定ならメールでは「後日、改めてご案内いたします」） |
| `TICKET_1206_ACCESS_URL` | 会場までの行き方（Dropbox 共有動画の URL）。HTML メールでは「会場までの行き方」のリンクテキストで表示 |
| `TICKET_FROM_EMAIL` | 送信元。**公開前に必ず `deddecay <ticket@deddecay.tokyo>` を設定する**。未設定なら `CONTACT_FROM_EMAIL` のアドレスに表示名 `deddecay` |

### 送信ドメイン（Resend）

- `CONTACT_FROM_EMAIL` は Resend のテスト用アドレス（resend.dev）で、アカウント所有者（deddecay@gmail.com）宛てにしか送れない。申込者宛ての自動返信には使えない
- 2026-11-22 に Resend へ `deddecay.tokyo`（Tokyo リージョン・クリック/開封計測オフ）を追加し、Vercel DNS に次を登録：
  `resend._domainkey` TXT（DKIM）／`rsend` CNAME `rsend-apne1.forge.rmta.net`／`send` CNAME `send.forge.rmta.net`／`_dmarc` TXT `v=DMARC1; p=none;`
- deddecay.tokyo の DNS は **Vercel DNS**（ネームサーバー `ns1/ns2.vercel-dns.com`）。`vercel dns ls deddecay.tokyo --scope deddecay-5043s-projects` で確認できる
- deddecay.tokyo はメールを受信しないため、自動返信の Reply-To は `CONTACT_TO_EMAIL`（運営の受信先）にしている

Dropbox の共有設定（2026-11-22 確認）：ログインなしで再生できる（リンクを知っている全員が閲覧可）。
ダウンロードボタンが表示されており、共有者名（_info deddecay）も表示される。
メールが転送されれば第三者も見られる点は仕組み上避けられない。必要なら公演後にリンクを無効化する。

## 定員管理と二重送信の防止

- 台帳は R2 の JSON 1 ファイル。本番 `tickets/2026-12-06/ledger.json`、Preview `ledger-preview.json`（本番の定員を消費しない）。ローカルはメモリ（再起動で消える）
- 書き込みは ETag による条件付き書き込み。同時申し込みで競合したら読み直してやり直す → 定員を超えない
- 確認画面ごとに申し込み ID を発行し、同じ ID の再送（連打・通信のやり直し）は 1 件として扱う（メールも再送しない）
- 同じメールアドレスからの 2 回目の申し込みは拒否（変更は CONTACT「チケット関連」へ）
- 送信時にサーバーで残席を再確認。足りなければ残席数を返し、フォームの選択肢を減らす
- そのほか：IP ごとに 1 時間 10 回まで・honeypot・別オリジンからの送信拒否
- Resend の送信数制限（毎秒 10 件）に当たったら、間隔をあけて最大 5 回まで送り直す
- 自動返信が失敗しても受付は有効。運営通知に「自動返信の送信に失敗」と出るので、手動で案内する

## 集計表（Google スプレッドシート）

- 申し込みのたびに、応答を返したあとで（`after()`）受付一覧の全件をスプレッドシートに書き直す。キャンセル（`scripts/tickets.mjs cancel --yes`）でも書き直す
- 正本は R2 の台帳。表は写しなので、**表に直接書いたメモ・色は次の反映で消える**（メモは別シートで参照する）
- Fan moments の Google 連携（`GOOGLE_OAUTH_*`、権限 `drive.file`）を使う。表はそのアカウントの Google ドライブに
  「deddecay 12月6日 フロアライブ 申し込み一覧」（Preview・ローカルは名前に（preview）などが付く）で作られる
- 表は `appProperties.sheet = ticket:2026-12-06:{production|preview|local}` で見分ける。同時の初回反映で 2 つできたら新しい方をゴミ箱へ
- 反映に失敗しても受付・自動返信には影響しない（ログ `[ticket] 集計表の反映に失敗しました`）。`scripts/tickets.mjs sheet` で手動反映でき、URL も表示される
- Google 連携のトークンが失効すると反映が止まる（[fan-upload.md](fan-upload.md) のトークン更新手順を参照）

## 運用（一覧・スプレッドシート・キャンセル）

`scripts/tickets.mjs` を使う。R2（と集計表を更新するなら `GOOGLE_OAUTH_*`）の認証情報を環境変数で渡す。

> ⚠ `vercel env pull` では取り出せない（2026-11-22 確認）。R2・Google の値は Vercel で「Sensitive」扱いのため、空で取り出される。
> R2 の運用用 API トークン（対象バケットのみ・Object Read & Write）を Cloudflare で別に発行し、リポジトリの外のファイル（権限 600）に置いて使う。

**人数のリセット（本番の受付開始前など）**：Cloudflare ダッシュボード → R2 → 該当バケット → `tickets/2026-12-06/ledger.json` を削除すると 0 件に戻る。
集計表は次の申し込み（または `sheet`）で書き直される。

```bash
node --env-file=/tmp/dd-prod.env scripts/tickets.mjs list
node --env-file=/tmp/dd-prod.env scripts/tickets.mjs csv
node --env-file=/tmp/dd-prod.env scripts/tickets.mjs cancel <受付ID>
node --env-file=/tmp/dd-prod.env scripts/tickets.mjs cancel <受付ID> --yes
rm /tmp/dd-prod.env
```

- `csv` は UTF-8（BOM 付き）の CSV を書き出す。Excel でそのまま開ける。Google スプレッドシートは「ファイル → インポート」で読み込む
- CSV には個人情報が入る。共有範囲に注意し、リポジトリに入れない（`tickets-*.csv` は .gitignore 済み）
- `cancel` は `--yes` なしなら確認だけ。取り消すと席が戻り、同じメールアドレスで申し込み直せる。申込者への連絡は別途
- Preview の台帳は `--stage preview`

## 公開前チェックリスト

1. `event.ts` の公演タイトル・OPEN・START を設定
2. 本番に `TICKET_1206_VENUE_ADDRESS`・`TICKET_1206_ACCESS_URL`・`TICKET_FROM_EMAIL` を設定（Resend で deddecay.tokyo が Verified になっていること）
3. LIVE 記事を作成し、contentId を `TICKET_1206_LIVE_ID` に設定
4. Preview で自分宛てに申し込み、自動返信の表示（リンク・住所）を確認 → `cancel --stage preview` で片付け
5. ユーザーの指示を受けてから、本番に `TICKET_1206_ENABLED=1`・`TICKET_1206_PUBLIC=1` を設定して再デプロイ
6. 公開後に本番で 1 件テストする場合は、確認後に `cancel` で取り消す

## ファイル

| ファイル | 役割 |
|---|---|
| `src/lib/ticket/event.ts` | 公演情報（公開してよい情報だけ） |
| `src/lib/ticket/flags.ts` | 公開フラグ |
| `src/lib/ticket/ledger.ts` | 台帳・受付処理・キャンセル・CSV |
| `src/lib/ticket/mail.ts` | 自動返信・運営通知の本文 |
| `src/lib/ticket/runtime.ts` | 保存先の選択・メール送信（サーバー専用） |
| `app/tickets/2026-12-06/page.tsx` / `app/_components/TicketForm.tsx` | フォーム画面 |
| `app/api/tickets/2026-12-06/route.ts` | 受付 API |
| `scripts/tickets.mjs` | 運用ツール |
| `tests/ticket.test.mjs` | テスト |
