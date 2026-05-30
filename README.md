# deddecay official website

deddecay のオフィシャルサイト。

**本番 URL**: https://deddecay.tokyo

## 技術構成

- Next.js 16 (App Router)
- TypeScript
- Tailwind CSS v4
- microCMS（CMS）
- Resend（メール送信）
- Vercel（ホスティング）

## ローカル起動

```bash
npm install
cp .env.local.example .env.local
# .env.local を編集して各値を設定
npm run dev
```

→ http://localhost:3000

## 環境変数

`.env.local.example` を参照。本番値は `.env.local` に設定する（git 管理外）。

| 変数名 | 用途 |
|---|---|
| `MICROCMS_SERVICE_DOMAIN` | microCMS サービスドメイン |
| `MICROCMS_API_KEY` | microCMS API キー |
| `RESEND_API_KEY` | Resend の API キー |
| `CONTACT_TO_EMAIL` | CONTACT フォームの受信先アドレス |
| `CONTACT_FROM_EMAIL` | CONTACT フォームの送信元（Resend 検証済みドメイン必須） |

## Deploy

Vercel にデプロイ済み。カスタムドメイン接続済み（Cloudflare 経由・SSL 有効）。

```bash
vercel --prod --yes
```

Vercel 環境変数は Settings → Environment Variables で設定する。

## ドキュメント

- [docs/site_spec.md](docs/site_spec.md) — サイト仕様（ページ構成・CMS設計・各機能）
- [docs/operation_guide.md](docs/operation_guide.md) — 投稿・運用ガイド
