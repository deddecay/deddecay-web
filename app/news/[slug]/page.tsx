export const revalidate = 60;

import { connection } from "next/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { getEntryById, getAdjacentEntries, formatEntryDate } from "@/src/lib/microcms";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

const BASE_URL = "https://deddecay.tokyo";
const DEFAULT_OG = "/og/og-default.jpg";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug: contentId } = await params;
  const entry = await getEntryById(contentId);
  const ogImage = entry?.thumbnail?.url ?? DEFAULT_OG;
  const title = entry ? `${entry.title} | deddecay` : "deddecay";
  const url = `${BASE_URL}/news/${contentId}`;
  return {
    title,
    openGraph: { title, url, images: [{ url: ogImage }] },
    twitter: { card: "summary_large_image", title, images: [ogImage] },
  };
}

export default async function NewsPage({ params, searchParams }: Props) {
  const { slug: contentId } = await params;
  const sp = await searchParams;
  const draftKey = typeof sp.draftKey === "string" ? sp.draftKey : undefined;

  if (draftKey) await connection();

  const entry = await getEntryById(contentId, draftKey);
  if (!entry) notFound();
  const { prev, next } = entry.publishedAt
    ? await getAdjacentEntries(entry.publishedAt)
    : { prev: null, next: null };

  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center px-8 pt-12 pb-16">
      <div className="w-full max-w-xs sm:max-w-sm flex flex-col gap-8">

        <Link
          href="/"
          className="text-[10px] tracking-widest text-white/45 hover:text-white/75 transition-colors duration-150"
        >
          ← deddecay
        </Link>

        {entry.thumbnail && (
          <div className="w-full overflow-hidden">
            <Image
              src={entry.thumbnail.url}
              alt={entry.title}
              width={entry.thumbnail.width}
              height={entry.thumbnail.height}
              className="w-full h-auto object-cover"
            />
          </div>
        )}

        <article className="flex flex-col gap-6">
          <header className="flex flex-col gap-2">
            <span className="text-[10px] tracking-widest text-white/45">
              {formatEntryDate(entry.eventDate ?? entry.publishedAt)}
            </span>
            <h1 className="text-sm sm:text-base tracking-wider text-white/90 leading-snug">
              {entry.title}
            </h1>
          </header>

          {entry.body && (
            <div
              className="text-xs sm:text-sm leading-relaxed text-white/75 [&_a]:underline [&_a:hover]:text-white/95 [&_p]:mb-3 [&_h2]:text-xs [&_h2]:tracking-widest [&_h2]:text-white/55 [&_h2]:mt-5 [&_ul]:list-disc [&_ul]:pl-4 [&_li]:mb-1"
              dangerouslySetInnerHTML={{ __html: entry.body }}
            />
          )}

          {entry.externalLinks && entry.externalLinks.length > 0 && (
            <ul className="flex flex-col gap-2 pt-2">
              {entry.externalLinks.map((link) => (
                <li key={link.url}>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] tracking-widest text-white/55 hover:text-white/85 transition-colors duration-150"
                  >
                    → {link.label}
                  </a>
                </li>
              ))}
            </ul>
          )}

        </article>

        <nav className="flex justify-between items-start gap-4 pt-4 border-t border-white/10">
          <div className="min-w-0 max-w-[45%]">
            {prev ? (
              <Link
                href={`/news/${prev.id}`}
                className="flex items-center gap-2 text-[10px] tracking-widest text-white/55 hover:text-white/85 transition-colors duration-150"
              >
                <span className="flex-shrink-0">← prev</span>
                <span className="truncate">{prev.title}</span>
              </Link>
            ) : (
              <span className="text-[10px] tracking-widest text-white/20">← prev</span>
            )}
          </div>
          <div className="min-w-0 max-w-[45%] ml-auto">
            {next ? (
              <Link
                href={`/news/${next.id}`}
                className="flex items-center gap-2 text-[10px] tracking-widest text-white/55 hover:text-white/85 transition-colors duration-150"
              >
                <span className="truncate">{next.title}</span>
                <span className="flex-shrink-0">next →</span>
              </Link>
            ) : (
              <span className="text-[10px] tracking-widest text-white/20">next →</span>
            )}
          </div>
        </nav>

      </div>
    </main>
  );
}
