"use client";

import { Fragment, useState, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import ContactForm from "./ContactForm";
import { isNewEntry, resolveReleaseType, type Entry, type Biography, type DiscographyRelease } from "@/src/lib/microcms";
import { BIOGRAPHY } from "@/src/data/biography";

// ── Types ────────────────────────────────────────────

type Section = "news" | "live" | "biography" | "discography" | "contact";

// DISCOGRAPHY のカテゴリ切替（表示名と内部値は分離）
type DiscoTab = "albumEp" | "single";

const DISCO_TABS: { key: DiscoTab; label: string }[] = [
  { key: "albumEp", label: "ALBUM / EP" },
  { key: "single",  label: "SINGLE" },
];

// ── Styles ───────────────────────────────────────────

const labelStyle =
  "text-sm tracking-[0.15em] text-white/90 hover:text-white active:opacity-70 transition-colors duration-150";

const andMoreStyle =
  "text-[10px] tracking-[0.25em] text-white/55 hover:text-white/85 active:text-white/65 transition-colors duration-150";

// contact パネルは他より高さが必要
const panelMaxH = (section: Section) =>
  section === "contact" ? "max-h-[520px]" : "max-h-80 sm:max-h-96";

// ── Types ────────────────────────────────────────────

type Props = {
  newsItems: Entry[];
  liveItems: Entry[];
  biography: Biography | null;
  discographyItems: DiscographyRelease[];
};

// ── Helpers ───────────────────────────────────────────

const formatDate = (publishedAt: string | undefined) =>
  publishedAt
    ? new Date(publishedAt)
        .toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" })
        .replace(/\//g, ".")
    : "";

const matchesDiscoTab = (item: DiscographyRelease, tab: DiscoTab) => {
  const releaseType = resolveReleaseType(item);
  return tab === "albumEp"
    ? releaseType === "album" || releaseType === "ep"
    : releaseType === "single";
};

// ── Component ────────────────────────────────────────

export default function NavMenu({ newsItems, liveItems, biography, discographyItems }: Props) {
  const [open, setOpen] = useState<Section | null>(null);
  // ALBUM / EP が0件のうちは SINGLE から開始する
  const [discoTab, setDiscoTab] = useState<DiscoTab>(() =>
    discographyItems.some((item) => matchesDiscoTab(item, "albumEp")) ? "albumEp" : "single"
  );
  const itemRefs    = useRef<Partial<Record<Section, HTMLLIElement>>>({});
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scrollTo = (section: Section) => {
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      const el = itemRefs.current[section];
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const targetY = window.innerHeight * 0.15;
      window.scrollTo({ top: window.scrollY + rect.top - targetY, behavior: "smooth" });
    }, 380);
  };

  const toggle = (section: Section) => {
    if (open === section) {
      setOpen(null);
    } else if (open !== null) {
      setOpen(null);
      setTimeout(() => {
        setOpen(section);
        scrollTo(section);
      }, 220);
    } else {
      setOpen(section);
      scrollTo(section);
    }
  };

  const renderContent = (section: Section): ReactNode => {
    switch (section) {
      case "news":
        return (
          <ul className="mt-6 flex flex-col items-center gap-4">
            {newsItems.map((item) => (
              <li key={item.id} className="flex flex-col items-center gap-1">
                <span className="flex items-center gap-1.5">
                  {isNewEntry(item.publishedAt) && (
                    <span className="text-[9px] tracking-widest text-white/35">new</span>
                  )}
                  <span className="text-[10px] sm:text-xs tracking-widest text-white/45">
                    {formatDate(item.eventDate ?? item.publishedAt)}
                  </span>
                </span>
                <Link
                  href={`/news/${item.id}`}
                  className="text-xs sm:text-sm text-white/75 hover:text-white/95 transition-colors duration-150"
                >
                  {item.title}
                </Link>
              </li>
            ))}
            <li className="mt-1">
              <Link href="/entries?type=news" className={andMoreStyle}>and more...</Link>
            </li>
          </ul>
        );

      case "live":
        return (
          <ul className="mt-6 flex flex-col items-center gap-4">
            {liveItems.map((item) => (
              <li key={item.id} className="flex flex-col items-center gap-1">
                <span className="flex items-center gap-1.5">
                  {isNewEntry(item.publishedAt) && (
                    <span className="text-[9px] tracking-widest text-white/35">new</span>
                  )}
                  <span className="text-[10px] sm:text-xs tracking-widest text-white/45">
                    {formatDate(item.eventDate ?? item.publishedAt)}
                  </span>
                </span>
                <Link
                  href={`/live/${item.id}`}
                  className="text-xs sm:text-sm text-white/75 hover:text-white/95 transition-colors duration-150"
                >
                  {item.title}
                </Link>
              </li>
            ))}
            <li className="mt-1">
              <Link href="/entries?type=live" className={andMoreStyle}>and more...</Link>
            </li>
          </ul>
        );

      case "biography": {
        const photo = biography?.photo;
        const title = biography?.title ?? BIOGRAPHY.name;
        const body = biography?.body ?? BIOGRAPHY.description;
        return (
          <div className="mt-5 flex flex-col items-center gap-3">
            {photo ? (
              <Image
                src={photo.url}
                alt={title}
                width={photo.width}
                height={photo.height}
                className="h-32 sm:h-36 w-auto max-w-full object-contain bg-black"
              />
            ) : (
              <div className="w-32 h-32 sm:w-36 sm:h-36 bg-white/10" />
            )}
            <div className="flex flex-col items-center gap-1.5 text-center">
              <span className="text-xs sm:text-sm tracking-widest text-white/70">{title}</span>
              {biography ? (
                <div
                  className="text-[10px] sm:text-xs leading-relaxed text-white/65"
                  dangerouslySetInnerHTML={{ __html: body }}
                />
              ) : (
                <p className="text-[10px] sm:text-xs leading-relaxed text-white/65">{body}</p>
              )}
            </div>
          </div>
        );
      }

      case "discography": {
        if (discographyItems.length > 0) {
          const items = discographyItems.filter((item) => matchesDiscoTab(item, discoTab));
          return (
            <div className="mt-5 flex flex-col gap-4 w-full px-2">
              {/* カテゴリ切替 */}
              <div className="flex items-center justify-center gap-3">
                {DISCO_TABS.map(({ key, label }, i) => (
                  <Fragment key={key}>
                    {i > 0 && (
                      <span className="text-[10px] text-white/20 select-none">/</span>
                    )}
                    <button
                      onClick={() => setDiscoTab(key)}
                      aria-pressed={discoTab === key}
                      className={`text-[10px] tracking-[0.25em] transition-colors duration-150
                        ${discoTab === key ? "text-white/85" : "text-white/35 hover:text-white/65"}`}
                    >
                      {label}
                    </button>
                  </Fragment>
                ))}
              </div>

              {/* 作品一覧：パネル上限（max-h-80 / sm:max-h-96）から mt-5・切替行・gap 分を引いた高さでスクロール */}
              {items.length > 0 && (
              <div className="flex flex-col gap-4 w-full max-h-[260px] sm:max-h-[324px] overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {items.map((item) => (
                <div key={item.id} className="flex items-start gap-3 w-full">
                  <Link href={`/discography/${item.id}`} className="flex-shrink-0">
                    {item.cover ? (
                      <Image
                        src={item.cover.url}
                        alt={item.title}
                        width={item.cover.width}
                        height={item.cover.height}
                        className="w-14 h-14 sm:w-16 sm:h-16 object-cover"
                      />
                    ) : (
                      <div className="w-14 h-14 sm:w-16 sm:h-16 bg-white/10" />
                    )}
                  </Link>
                  <Link href={`/discography/${item.id}`} className="flex flex-col gap-0.5 flex-1 min-w-0">
                    <span className="text-xs sm:text-sm text-white/80 leading-snug">{item.title}</span>
                    {item.subtitle && (
                      <span className="text-[10px] sm:text-xs text-white/55">{item.subtitle}</span>
                    )}
                  </Link>
                  <div className="flex flex-col gap-1 items-end flex-shrink-0 pt-0.5">
                    {item.subscriptionUrl ? (
                      <a href={item.subscriptionUrl} target="_blank" rel="noopener noreferrer"
                        className="text-[10px] tracking-widest text-white/55 hover:text-white/85 transition-colors duration-150">
                        listen
                      </a>
                    ) : (
                      <span className="text-[10px] tracking-widest text-white/20">listen</span>
                    )}
                    {item.buyUrl ? (
                      <a href={item.buyUrl} target="_blank" rel="noopener noreferrer"
                        className="text-[10px] tracking-widest text-white/55 hover:text-white/85 transition-colors duration-150">
                        buy
                      </a>
                    ) : (
                      <span className="text-[10px] tracking-widest text-white/20">buy</span>
                    )}
                  </div>
                </div>
              ))}
              </div>
              )}

              {items.length === 0 && (
                <p className="text-[10px] tracking-[0.25em] text-white/30 text-center select-none">
                  COMING SOON
                </p>
              )}
            </div>
          );
        }
        return (
          <p className="mt-5 text-[10px] tracking-[0.25em] text-white/30 text-center select-none">
            COMING SOON
          </p>
        );
      }

      case "contact":
        return <ContactForm />;
    }
  };

  const renderExpandable = (section: Section) => {
    const isOpen = open === section;
    return (
      <li
        key={section}
        ref={(el) => { if (el) itemRefs.current[section] = el; }}
        className="flex flex-col items-center w-full"
      >
        <button
          onClick={() => toggle(section)}
          aria-expanded={isOpen}
          className={labelStyle}
        >
          {section.toUpperCase()}
        </button>

        {/* 下線 */}
        <div
          className={`h-px w-full bg-white/20 mt-2 origin-center
            transition-transform duration-200 ease-out
            ${isOpen ? "scale-x-100" : "scale-x-[0.075]"}`}
        />

        {/* 展開パネル */}
        <div
          className={`w-full overflow-hidden transition-all ease-out
            ${isOpen
              ? `${panelMaxH(section)} opacity-100 duration-300 delay-150`
              : "max-h-0 opacity-0 duration-150 delay-0"
            }`}
        >
          {renderContent(section)}
        </div>
      </li>
    );
  };

  return (
    <nav aria-label="Main navigation">
      <ul className="flex flex-col items-center gap-5 w-full">
        {renderExpandable("news")}
        {renderExpandable("live")}
        {renderExpandable("biography")}
        {renderExpandable("discography")}
        {renderExpandable("contact")}

        {/* STORE — 外部リンクのみ残す */}
        <li className="flex flex-col items-center">
          <a
            href="https://deddecay.base.shop/"
            target="_blank"
            rel="noopener noreferrer"
            className={labelStyle}
          >
            STORE
          </a>
          <div className="h-px w-6 bg-white/20 mt-2" />
        </li>
      </ul>
    </nav>
  );
}
