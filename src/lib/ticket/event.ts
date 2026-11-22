// 2026-12-06 フロアライブの公演情報（公開してよい情報だけを置く）。
// 正確な会場住所・アクセス動画 URL はここに書かない（サーバー専用の環境変数。mail.ts / runtime.ts を参照）。
//
// 後日設定：title / open / start が決まったらここを書き換える。

export const EVENT = {
  id: "2026-12-06",
  dateLabel: "2026年12月6日（日）",
  shortLabel: "12月6日 フロアライブ",
  title: "後日設定",
  open: "後日設定",
  start: "後日設定",
  publicArea: "東京都世田谷区・梅ヶ丘駅周辺",
  pricePerTicket: 2000,
  priceLabel: "2,000円／名（ドリンク込み）",
  payment: "当日現地払い",
  capacity: 50,
  maxPerOrder: 5,
} as const;

export const formatYen = (n: number): string => `${n.toLocaleString("ja-JP")}円`;

export const totalPrice = (tickets: number): number => tickets * EVENT.pricePerTicket;

// 申し込みフォームのパス（リンク元はすべてこれを使う）
export const TICKET_PATH = `/tickets/${EVENT.id}`;

// 「チケット関連」を選択済みにして CONTACT を開く TOP の URL
export const CONTACT_TICKET_PATH = "/?contact=ticket";
