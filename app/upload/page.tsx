export const revalidate = 60;

import type { Metadata } from "next";
import Link from "next/link";
import FanUploadForm from "../_components/FanUploadForm";
import { getAllLives, formatLiveDate } from "@/src/lib/microcms";

export const metadata: Metadata = {
  title: "DD UPLOAD | deddecay",
  description: "deddecayへ動画・写真・ファンアートなどを送る公式アップロード窓口",
  robots: { index: false, follow: false },
};

type Props = {
  searchParams: Promise<{ live?: string }>;
};

export default async function FanUploadPage({ searchParams }: Props) {
  const { live } = await searchParams;
  const entries = await getAllLives();
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
          <h1 className="text-sm tracking-[0.2em] text-white/90">DD UPLOAD</h1>
          <p className="text-[11px] leading-relaxed text-white/55">
            deddecay へ、動画・写真・ファンアートなどを送ってください。LIVEで撮ったものは、過去の公演の分も受け付けています。
          </p>
        </header>

        <FanUploadForm lives={lives} initialLiveId={typeof live === "string" ? live : undefined} />
      </div>
    </main>
  );
}
