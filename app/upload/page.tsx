export const revalidate = 60;

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import FanUploadScreen from "../_components/FanUploadScreen";
import { fanMomentsEnabled } from "@/src/lib/fan-upload/flags";
import { getAllLives, formatLiveDate } from "@/src/lib/microcms";
import { readLimits } from "@/src/lib/fan-upload/service";
import { postableLivesNow } from "@/src/lib/fan-upload/policy";

export const metadata: Metadata = {
  title: "Fan moments | deddecay",
  description: "deddecayのライブで撮影した写真や動画をアップロードしてください！",
  robots: { index: false, follow: false },
  openGraph: {
    title: "Fan moments | deddecay",
    description: "deddecayのライブで撮影した写真や動画をアップロードしてください！",
    url: "/upload",
    siteName: "deddecay",
    type: "website",
    images: [{ url: "/og/og-fan-moments.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Fan moments | deddecay",
    description: "deddecayのライブで撮影した写真や動画をアップロードしてください！",
    images: ["/og/og-fan-moments.png"],
  },
};

type Props = {
  searchParams: Promise<{ live?: string }>;
};

export default async function FanUploadPage({ searchParams }: Props) {
  // 公開前は 404（FAN_MOMENTS_ENABLED=1 の環境でだけ表示する）
  if (!fanMomentsEnabled()) notFound();
  const { live } = await searchParams;
  // 一覧に出すのは、いま投稿を受け付けている LIVE（開催後 6 か月間）だけ。取得処理は従来のまま
  const entries = postableLivesNow(await getAllLives());
  const lives = entries.map((entry) => ({
    id: entry.id,
    label: `${formatLiveDate(entry)}  ${entry.title}`,
  }));

  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center px-8 pt-12 pb-16">
      <div className="w-full max-w-xs sm:max-w-sm flex flex-col gap-8">
        <FanUploadScreen
          lives={lives}
          initialLiveId={typeof live === "string" ? live : undefined}
          limits={readLimits()}
        />
      </div>
    </main>
  );
}
