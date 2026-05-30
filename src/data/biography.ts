export type BiographyData = {
  name: string;
  description: string;
  image?: string;          // 画像パス（未設定または空の場合はプレースホルダー表示）
  isPlaceholder?: boolean; // true = 仮素材（本素材確定後に false へ）
};

export const BIOGRAPHY: BiographyData = {
  name: "deddecay",
  description: "2026年3月 山崎大樹(ex ROKI, JIGDRESS)により活動開始",
  image: "/images/placeholders/biography.png",
  isPlaceholder: true,
};
