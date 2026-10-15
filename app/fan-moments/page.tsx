export const revalidate = 60;

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fanMomentsEnabled } from "@/src/lib/fan-upload/flags";

const DESCRIPTION = "deddecayのライブで撮影した写真や動画をアップロードしてください！";

export const metadata: Metadata = {
  title: "Fan moments | deddecay",
  description: DESCRIPTION,
  robots: { index: false, follow: false },
  openGraph: {
    title: "Fan moments | deddecay",
    description: DESCRIPTION,
    url: "/fan-moments",
    siteName: "deddecay",
    type: "website",
    images: [{ url: "/og/og-fan-moments.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Fan moments | deddecay",
    description: DESCRIPTION,
    images: ["/og/og-fan-moments.png"],
  },
};

// Fan moments のメインページ。TOP からはここへ来て、投稿は既存の /upload で行う。
// 公開前は 404（FAN_MOMENTS_ENABLED=1 の環境でだけ表示する）
export default function FanMomentsPage() {
  if (!fanMomentsEnabled()) notFound();

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
            {DESCRIPTION}
            <br />
            SNS等での使用を目的としています。
          </p>
        </header>

        <div className="flex flex-col gap-3 border border-white/15 p-3">
          <ul className="flex flex-col gap-1.5 list-disc pl-4 text-[11px] leading-relaxed text-white/55">
            <li>投稿するのは、ご自身が撮影・制作したものに限ります。</li>
            <li>アップロードいただいたデータも、引き続きSNS等でご利用ください。</li>
          </ul>
        </div>

        <Link
          href="/upload"
          className="self-start text-[10px] tracking-[0.25em] border border-white/35 hover:border-white/65 active:border-white/40 text-white/60 hover:text-white/95 active:text-white/50 px-5 py-2 rounded-sm transition-colors duration-150"
        >
          投稿する
        </Link>
      </div>
    </main>
  );
}
