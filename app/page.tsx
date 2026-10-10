export const revalidate = 60;

import Image from "next/image";
import NavMenu from "./_components/NavMenu";
import { getTopNews, getTopLives, getBiography, getDiscography } from "@/src/lib/microcms";
import { fanMomentsPublic } from "@/src/lib/fan-upload/flags";
import {
  siApplemusic,
  siSpotify,
  siYoutube,
  siInstagram,
  siX,
  siTiktok,
} from "simple-icons";

const YOUTUBE_CHANNEL = "https://www.youtube.com/@deddecay";

const snsLinks = [
  { icon: siApplemusic, href: "https://music.apple.com/jp/artist/deddecay/6773657681",                                                           external: true },
  { icon: siSpotify,    href: "https://open.spotify.com/intl-ja/artist/2Odjvded4tky0XgSZtHssl?si=atkoQdhiRB-TeHzYqubfzg",                     external: true },
  { icon: siYoutube,    href: YOUTUBE_CHANNEL,                             external: true  },
  { icon: siInstagram,  href: "https://www.instagram.com/deddecay",        external: true  },
  { icon: siX,          href: "https://x.com/deddecay",                    external: true  },
  { icon: siTiktok,     href: "https://www.tiktok.com/@deddecay",          external: true  },
].map(({ icon, href, external }) => ({ label: icon.title, href, icon, external }));

export default async function Home() {
  const [newsItems, liveItems, biography, discographyItems] = await Promise.all([getTopNews(), getTopLives(), getBiography(), getDiscography()]);
  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center px-8 pt-10 pb-10 sm:pt-12 sm:pb-12">
      <div className="w-full max-w-xs sm:max-w-sm flex flex-col items-center gap-10">

        {/* Logo */}
        <h1>
          <Image
            src="/logo-white.png"
            alt="deddecay"
            width={14999}
            height={6101}
            className="w-full max-w-[220px] sm:max-w-[275px] h-auto object-contain block mx-auto logo-signal"
            priority
          />
        </h1>

        {/* SNS Icons */}
        <div className="flex items-center gap-4">
          {snsLinks.map(({ label, href, icon, external }) => (
            <a
              key={label}
              href={href}
              aria-label={label}
              title={label}
              {...(external && { target: "_blank", rel: "noopener noreferrer" })}
              className="w-10 h-10 rounded-full border border-white/30 flex items-center justify-center text-white/70 hover:text-white hover:border-white/70 transition-colors duration-200"
            >
              <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                className="w-4 h-4"
                aria-hidden="true"
              >
                <path d={icon.path} />
              </svg>
            </a>
          ))}
        </div>

        {/* Navigation */}
        <NavMenu
          newsItems={newsItems}
          liveItems={liveItems}
          biography={biography}
          discographyItems={discographyItems}
          showFanMoments={fanMomentsPublic()}
        />

      </div>

      {/* Copyright */}
      <p className="mt-auto pt-10 text-center text-[10px] tracking-[0.2em] text-white/45 select-none">
        Copyright© deddecay, 2026 All Rights Reserved.
      </p>
    </main>
  );
}
