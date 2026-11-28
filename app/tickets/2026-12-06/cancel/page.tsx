import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import TicketCancelForm from "@/app/_components/TicketCancelForm";
import { ticketEnabled } from "@/src/lib/ticket/flags";
import { EVENT, CONTACT_TICKET_PATH } from "@/src/lib/ticket/event";
import { verifyCancelToken } from "@/src/lib/ticket/cancel-link";
import { getLedgerStore } from "@/src/lib/ticket/runtime";

export const metadata: Metadata = {
  title: `${EVENT.shortLabel} キャンセル手続き | deddecay`,
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

// 本人によるキャンセル手続きページ。CONTACT からキャンセルの連絡があったとき、予約のアドレスへ送るリンクで開く。
// 署名付きトークン（?t=）が正しいときだけ予約（お名前・枚数）を表示する。メールアドレス・会場は出さない
export default async function TicketCancelPage({ searchParams }: { searchParams: Promise<{ t?: string | string[] }> }) {
  await connection();
  if (!ticketEnabled()) notFound();
  const raw = (await searchParams).t;
  const token = typeof raw === "string" ? raw : "";
  const id = verifyCancelToken(EVENT.id, token);

  let body: React.ReactNode;
  if (!id) {
    body = <Message>リンクが無効か、有効期限が切れています。</Message>;
  } else {
    const store = getLedgerStore();
    const reservation = store ? (await store.read()).ledger.reservations.find((r) => r.id === id) : undefined;
    body = !store ? (
      <Message>現在、手続きを受け付けられません。時間をおいて再度アクセスしてください。</Message>
    ) : !reservation ? (
      <Message>このご予約はすでにキャンセルされています。</Message>
    ) : (
      <TicketCancelForm token={token} name={reservation.name} tickets={reservation.tickets} />
    );
  }

  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center px-8 pt-12 pb-16">
      <div className="w-full max-w-xs sm:max-w-sm flex flex-col gap-8">
        <Link href="/" className="text-[10px] tracking-widest text-white/45 hover:text-white/75 transition-colors duration-150">
          ← deddecay
        </Link>
        <header className="flex flex-col gap-2">
          <h1 className="text-sm tracking-[0.15em] text-white/90">{EVENT.shortLabel} キャンセル手続き</h1>
          <p className="text-xs text-white/70">
            {EVENT.title}　{EVENT.dateLabel}
          </p>
        </header>
        {body}
      </div>
    </main>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-white/75 leading-relaxed">{children}</p>
      <p className="text-[10px] text-white/50 leading-relaxed">
        ご不明な点は CONTACTの
        <Link href={CONTACT_TICKET_PATH} className="underline hover:text-white/80">『チケット関連』</Link>
        よりご連絡ください。
      </p>
    </div>
  );
}
