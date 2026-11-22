import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import TicketForm from "@/app/_components/TicketForm";
import { ticketEnabled } from "@/src/lib/ticket/flags";
import { EVENT } from "@/src/lib/ticket/event";
import { summarize } from "@/src/lib/ticket/ledger";
import { getLedgerStore } from "@/src/lib/ticket/runtime";

export const metadata: Metadata = {
  title: `${EVENT.shortLabel} チケット申し込み | deddecay`,
  robots: { index: false, follow: false },
};

// 残席の取得。失敗したら null（フォームは出さず、準備中と表示する）
const readRemaining = async (): Promise<number | null> => {
  const store = getLedgerStore();
  if (!store) return null;
  try {
    const { ledger } = await store.read();
    return summarize(ledger, EVENT.capacity).remaining;
  } catch (err) {
    console.error("[ticket] ledger read error:", err);
    return null;
  }
};

// 12/6 フロアライブ チケット申し込みフォーム。
// 公開前は 404（TICKET_1206_ENABLED=1 の環境でだけ表示する）。残席は毎回サーバーで数える（キャッシュしない）。
// 会場の正確な住所・行き方はこの画面には出さない（自動返信メールにだけ載せる）
export default async function TicketPage() {
  await connection();
  if (!ticketEnabled()) notFound();
  const remaining = await readRemaining();

  const rows: { label: string; value: string; note?: string }[] = [
    { label: "公演タイトル", value: EVENT.title },
    { label: "開催日", value: EVENT.dateLabel },
    { label: "OPEN / START", value: `${EVENT.open} / ${EVENT.start}` },
    {
      label: "会場",
      value: EVENT.publicArea,
      note: "※会場の詳細およびアクセス方法は、お申し込み完了後の自動返信メールにてご案内いたします。",
    },
    { label: "チケット料金", value: EVENT.pagePriceLabel },
    {
      label: "お支払い",
      value: EVENT.payment,
      note: "※現金でのお支払いを基本とし、クレジットカード・PayPayもご利用いただけます。ご協力をお願いいたします。",
    },
  ];

  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center px-8 pt-12 pb-16">
      <div className="w-full max-w-xs sm:max-w-sm flex flex-col gap-8">
        <Link
          href="/"
          className="text-[10px] tracking-widest text-white/45 hover:text-white/75 transition-colors duration-150"
        >
          ← deddecay
        </Link>

        <header className="flex flex-col gap-4">
          <h1 className="text-sm tracking-[0.15em] text-white/90">{EVENT.shortLabel} チケット申し込み</h1>
          <dl className="flex flex-col gap-2.5">
            {rows.map(({ label, value, note }) => (
              <div key={label} className="flex flex-col gap-0.5">
                <dt className="text-[10px] tracking-widest text-white/50">{label}</dt>
                <dd className="text-xs text-white/80">{value}</dd>
                {note && <dd className="text-[10px] leading-relaxed text-white/50">{note}</dd>}
              </div>
            ))}
          </dl>
        </header>

        {remaining === null ? (
          <p className="text-xs text-white/65 leading-relaxed">
            現在、受付を準備中です。時間をおいて再度アクセスしてください。
          </p>
        ) : (
          <TicketForm maxTickets={Math.min(EVENT.maxPerOrder, remaining)} />
        )}
      </div>
    </main>
  );
}
