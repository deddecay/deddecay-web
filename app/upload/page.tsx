export const revalidate = 60;

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import FanUploadForm from "../_components/FanUploadForm";
import { fanMomentsEnabled } from "@/src/lib/fan-upload/flags";
import { getAllLives, formatLiveDate } from "@/src/lib/microcms";
import { readLimits } from "@/src/lib/fan-upload/service";
import { postableLivesNow } from "@/src/lib/fan-upload/policy";

export const metadata: Metadata = {
  title: "Fan moments | deddecay",
  description: "deddecayのライブで撮影した写真や動画をアップロードしてください！",
  robots: { index: false, follow: false },
};

type Props = {
  searchParams: Promise<{ live?: string }>;
};

export default async function FanUploadPage({ searchParams }: Props) {
  // 公開前は 404（FAN_MOMENTS_ENABLED=1 の環境でだけ表示する）
  if (!fanMomentsEnabled()) notFound();
  const { live } = await searchParams;
  // 一覧に出すのは、いま投稿を受け付けている LIVE（開催後 30 日間）だけ。取得処理は従来のまま
  const entries = postableLivesNow(await getAllLives());
  const lives = entries.map((entry) => ({
    id: entry.id,
    label: `${formatLiveDate(entry)}  ${entry.title}`,
  }));

  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center px-8 pt-12 pb-16">
      <div className="w-full max-w-xs sm:max-w-sm flex flex-col gap-8">
        <Link
          href="/"
          className="text-[10px] tracking-widest text-white/45 hover:text-white/75 transition-colors duration-150"
        >
          ← deddecay
        </Link>

        <header className="flex flex-col gap-2">
          <h1 className="text-sm tracking-[0.2em] text-white/90">Fan moments</h1>
          <p className="text-[11px] leading-relaxed text-white/55">
            deddecayのライブで撮影した写真や動画をアップロードしてください！
            <br />
            SNS等での使用を目的としています。
          </p>
        </header>

        {/* 上限はサーバーが実際に適用している値（環境変数での変更に追従）を渡す */}
        <FanUploadForm
          lives={lives}
          initialLiveId={typeof live === "string" ? live : undefined}
          limits={readLimits()}
        />
      </div>
    </main>
  );
}
