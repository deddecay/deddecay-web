export type NewsItem = {
  id: string;
  date: string;            // "YYYY.MM.DD"
  title: string;           // ナビ表示・一覧用見出し
  body: string;            // 本文（詳細ページ用、現時点は空）
  isPlaceholder?: boolean; // true = 仮データ（本データ確定後に false へ）
};

export const NEWS: NewsItem[] = [
  {
    id: "news-005",
    date: "2025.03.15",
    title: "New Single「---」配信リリース",
    body: "",
    isPlaceholder: true,
  },
  {
    id: "news-004",
    date: "2025.02.10",
    title: "ワンマンライブ開催決定",
    body: "",
    isPlaceholder: true,
  },
  {
    id: "news-003",
    date: "2025.01.20",
    title: "オフィシャルサイトオープン",
    body: "",
    isPlaceholder: true,
  },
  {
    id: "news-002",
    date: "2025.01.05",
    title: "SNS アカウント開設",
    body: "",
    isPlaceholder: true,
  },
  {
    id: "news-001",
    date: "2024.12.25",
    title: "1st Single「---」リリース",
    body: "",
    isPlaceholder: true,
  },
];
