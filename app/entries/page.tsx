export const revalidate = 60;

import Link from "next/link";
import { getEntriesByType, formatEntryDate, isNewEntry } from "@/src/lib/microcms";

type Props = {
  searchParams: Promise<{ type?: string; page?: string }>;
};

const PER_PAGE = 10;

export default async function EntriesPage({ searchParams }: Props) {
  const { type: rawType, page: rawPage } = await searchParams;
  const type = rawType === "live" ? "live" : "news";
  const page = Math.max(1, parseInt(rawPage ?? "1", 10) || 1);

  const { contents, totalCount } = await getEntriesByType(type, page, PER_PAGE);
  const totalPages = Math.max(1, Math.ceil(totalCount / PER_PAGE));

  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center px-8 pt-12 pb-16">
      <div className="w-full max-w-xs sm:max-w-sm flex flex-col gap-8">

        <Link
          href="/"
          className="text-[10px] tracking-widest text-white/45 hover:text-white/75 transition-colors duration-150"
        >
          ← deddecay
        </Link>

        {/* type switcher */}
        <div className="flex gap-6">
          {(["news", "live"] as const).map((t) => (
            <Link
              key={t}
              href={`/entries?type=${t}`}
              className={`text-xs tracking-widest transition-colors duration-150 ${
                type === t ? "text-white/90" : "text-white/35 hover:text-white/65"
              }`}
            >
              {t.toUpperCase()}
            </Link>
          ))}
        </div>

        {/* entry list */}
        {contents.length === 0 ? (
          <p className="text-[10px] tracking-widest text-white/20">no entries</p>
        ) : (
          <ul className="flex flex-col gap-6">
            {contents.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1">
                <span className="flex items-center gap-1.5">
                  {isNewEntry(entry.publishedAt) && (
                    <span className="text-[9px] tracking-widest text-white/35">new</span>
                  )}
                  <span className="text-[10px] tracking-widest text-white/45">
                    {formatEntryDate(entry.eventDate ?? entry.publishedAt)}
                  </span>
                </span>
                <Link
                  href={`/${type}/${entry.id}`}
                  className="text-xs sm:text-sm text-white/75 hover:text-white/95 transition-colors duration-150"
                >
                  {entry.title}
                </Link>
              </li>
            ))}
          </ul>
        )}

        {/* pagination */}
        <nav className="flex justify-between items-center pt-4 border-t border-white/10">
          {page > 1 ? (
            <Link
              href={`/entries?type=${type}&page=${page - 1}`}
              className="text-[10px] tracking-widest text-white/55 hover:text-white/85 transition-colors duration-150"
            >
              ← prev
            </Link>
          ) : (
            <span className="text-[10px] tracking-widest text-white/20">← prev</span>
          )}
          <span className="text-[10px] tracking-widest text-white/35">
            {page} / {totalPages}
          </span>
          {page < totalPages ? (
            <Link
              href={`/entries?type=${type}&page=${page + 1}`}
              className="text-[10px] tracking-widest text-white/55 hover:text-white/85 transition-colors duration-150"
            >
              next →
            </Link>
          ) : (
            <span className="text-[10px] tracking-widest text-white/20">next →</span>
          )}
        </nav>

      </div>
    </main>
  );
}
