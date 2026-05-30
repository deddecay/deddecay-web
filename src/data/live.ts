export type LiveItem = {
  id: string;
  date: string;            // "YYYY.MM.DD"
  venue: string;           // 会場名（一覧・ナビ表示用）
  title: string;           // 公演タイトル（詳細ページ用）
  open?: string;           // 開場時刻 "HH:MM"
  start?: string;          // 開演時刻 "HH:MM"
  ticket?: string;         // チケット情報または購入URL
  link?: string;           // 公演詳細URL
  isPlaceholder?: boolean; // true = 仮データ（本データ確定後に false へ）
};

export const LIVES: LiveItem[] = [
  {
    id: "live-001",
    date: "2025.04.12",
    venue: "渋谷 WWW X",
    title: "",
    open: "",
    start: "",
    ticket: "",
    link: "",
    isPlaceholder: true,
  },
  {
    id: "live-002",
    date: "2025.05.03",
    venue: "梅田 Shangri-La",
    title: "",
    open: "",
    start: "",
    ticket: "",
    link: "",
    isPlaceholder: true,
  },
  {
    id: "live-003",
    date: "2025.06.21",
    venue: "名古屋 ell.FITS ALL",
    title: "",
    open: "",
    start: "",
    ticket: "",
    link: "",
    isPlaceholder: true,
  },
];
