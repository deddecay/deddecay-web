export type DiscographyItem = {
  id: string;
  title: string;
  type: string;            // "Single" / "Album" / "EP" など
  year: string;            // "YYYY"
  link?: string;           // 配信/購入リンク（空文字の場合はリンクなし）
  linkLabel?: string;      // リンクラベル（例: "配信で聴く"）
  image?: string;          // ジャケット画像パス（未設定または空の場合はプレースホルダー表示）
  isPlaceholder?: boolean; // true = 仮素材（本素材確定後に false へ）
};

export const DISCOGRAPHY: DiscographyItem[] = [];
