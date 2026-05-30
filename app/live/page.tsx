export const revalidate = 60;

import Link from "next/link";
import { getLiveList, formatLiveDate } from "@/src/lib/microcms";

export default async function LivePage() {
  const liveItems = await getLiveList();

  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center px-8 pt-12 pb-16">
      <div className="w-full max-w-xs sm:max-w-sm flex flex-col gap-8">

        <Link
          href="/"
          className="text-[10px] tracking-widest text-white/45 hover:text-white/75 transition-colors duration-150"
        >
          ← deddecay
        </Link>

        <ul className="flex flex-col gap-6">
          {liveItems.map((item) => (
            <li key={item.id} className="flex flex-col gap-1">
              <span className="text-[10px] tracking-widest text-white/45">
                {formatLiveDate(item)}
              </span>
              <Link
                href={`/live/${item.id}`}
                className="text-xs sm:text-sm text-white/75 hover:text-white/95 transition-colors duration-150"
              >
                {item.title}
              </Link>
            </li>
          ))}
        </ul>

      </div>
    </main>
  );
}
