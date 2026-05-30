export const revalidate = 60;

import { notFound } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { getDiscographyById } from "@/src/lib/microcms";

type Props = {
  params: Promise<{ contentId: string }>;
};

export default async function DiscographyDetailPage({ params }: Props) {
  const { contentId } = await params;
  const release = await getDiscographyById(contentId);
  if (!release) notFound();

  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center px-8 pt-12 pb-16">
      <div className="w-full max-w-xs sm:max-w-sm flex flex-col gap-8">

        <Link
          href="/"
          className="text-[10px] tracking-widest text-white/45 hover:text-white/75 transition-colors duration-150"
        >
          ← deddecay
        </Link>

        {release.cover && (
          <div className="w-full overflow-hidden">
            <Image
              src={release.cover.url}
              alt={release.title}
              width={release.cover.width}
              height={release.cover.height}
              className="w-full h-auto object-cover"
            />
          </div>
        )}

        <article className="flex flex-col gap-6">
          <header className="flex flex-col gap-1">
            <h1 className="text-sm sm:text-base tracking-wider text-white/90 leading-snug">
              {release.title}
            </h1>
            {release.subtitle && (
              <span className="text-[10px] tracking-widest text-white/45">
                {release.subtitle}
              </span>
            )}
          </header>

          <div className="flex gap-4">
            {release.subscriptionUrl ? (
              <a
                href={release.subscriptionUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] tracking-widest text-white/55 hover:text-white/85 transition-colors duration-150"
              >
                → listen
              </a>
            ) : (
              <span className="text-[10px] tracking-widest text-white/20">→ listen</span>
            )}
            {release.buyUrl ? (
              <a
                href={release.buyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] tracking-widest text-white/55 hover:text-white/85 transition-colors duration-150"
              >
                → buy
              </a>
            ) : (
              <span className="text-[10px] tracking-widest text-white/20">→ buy</span>
            )}
          </div>

          {release.body ? (
            <div
              className="text-xs sm:text-sm leading-relaxed text-white/75 [&_a]:underline [&_a:hover]:text-white/95 [&_p]:mb-3 [&_h2]:text-xs [&_h2]:tracking-widest [&_h2]:text-white/55 [&_h2]:mt-5 [&_ul]:list-disc [&_ul]:pl-4 [&_li]:mb-1"
              dangerouslySetInnerHTML={{ __html: release.body }}
            />
          ) : (
            <p className="text-[10px] tracking-widest text-white/20">—</p>
          )}
        </article>

      </div>
    </main>
  );
}
