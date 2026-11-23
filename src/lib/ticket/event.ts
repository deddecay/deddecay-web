// 2026-12-06 フロアライブの公演情報（公開してよい情報だけを置く）。
// 正確な会場住所・アクセス動画 URL はここに書かない（サーバー専用の環境変数。mail.ts / runtime.ts を参照）。
//
// title は公演タイトル（申し込みページと自動返信メールの「公演タイトル」）。publicArea は公開してよい会場表記で、正確な住所は書かない。

export const EVENT = {
  id: "2026-12-06",
  dateLabel: "2026年12月6日（日）",
  shortLabel: "12月6日 フロアライブ",
  title: "deddecay 手創りフロアライブ",
  open: "18:00",
  start: "18:30",
  publicArea: "東京都世田谷区某所（小田急線沿線）",
  pricePerTicket: 2000,
  // 自動返信メール用（「／名」付き）と申し込みページ用
  priceLabel: "2,000円／名（ドリンク込み）",
  pagePriceLabel: "2,000円（ドリンク込み）",
  payment: "当日会場払い",
  capacity: 55,
  maxPerOrder: 5,
} as const;

export const formatYen = (n: number): string => `${n.toLocaleString("ja-JP")}円`;

export const totalPrice = (tickets: number): number => tickets * EVENT.pricePerTicket;

// 申し込みフォームのパス（リンク元はすべてこれを使う）
export const TICKET_PATH = `/tickets/${EVENT.id}`;

// 「チケット関連」を選択済みにして CONTACT を開く TOP の URL
export const CONTACT_TICKET_PATH = "/?contact=ticket";
