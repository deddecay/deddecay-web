"use client";

import { useState } from "react";
import Link from "next/link";
import { EVENT, CONTACT_TICKET_PATH, formatYen, totalPrice } from "@/src/lib/ticket/event";

// 本人によるキャンセル手続き（枚数を選ぶ → 確認 → 完了）。見た目は TicketForm に合わせる

const primaryButton =
  "text-[10px] tracking-[0.2em] border border-white/30 hover:border-white/65 active:border-white/35 text-white/65 hover:text-white active:text-white/50 disabled:opacity-40 disabled:pointer-events-none px-4 py-1.5 rounded-sm transition-colors duration-150";

export default function TicketCancelForm({ token, name, tickets }: { token: string; name: string; tickets: number }) {
  const [cancel, setCancel] = useState(tickets);
  const [confirming, setConfirming] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ cancelled: number; kept: number; mailSent: boolean } | null>(null);

  const kept = tickets - cancel;

  const handleSend = async () => {
    if (isSending) return;
    setIsSending(true);
    setError("");
    try {
      const res = await fetch(`/api/tickets/${EVENT.id}/self-cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, cancel, expected: tickets }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean; error?: string; cancelled?: number; kept?: number; mailSent?: boolean;
      };
      if (!res.ok || !data.ok) throw new Error(data.error ?? "手続きに失敗しました");
      setDone({ cancelled: data.cancelled ?? cancel, kept: data.kept ?? kept, mailSent: data.mailSent !== false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "手続きに失敗しました");
    } finally {
      setIsSending(false);
    }
  };

  if (done) {
    return (
      <div className="flex flex-col items-center gap-6 text-center border border-white/15 px-6 py-10">
        <p className="text-sm tracking-[0.15em] text-white/85">
          {done.kept > 0 ? "一部キャンセルを承りました。" : "キャンセルを承りました。"}
        </p>
        <p className="text-xs text-white/65 leading-relaxed">
          キャンセル {done.cancelled}枚
          {done.kept > 0 && (
            <>
              <br />
              変更後 {done.kept}枚（当日のお支払い {formatYen(totalPrice(done.kept))}）
            </>
          )}
          <br />
          {done.mailSent
            ? "ご予約のメールアドレスに、キャンセル受付完了のメールをお送りしました。"
            : "完了メールの送信に失敗しましたが、キャンセルは完了しています。"}
        </p>
        <Link href="/" className="text-[10px] tracking-[0.25em] text-white/55 hover:text-white/85 transition-colors duration-150">
          ← deddecay
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 border border-white/15 p-6">
      <div className="flex flex-col gap-3.5">
        {[
          { label: "お名前", value: `${name} 様` },
          { label: "現在のチケット枚数", value: `${tickets}枚` },
        ].map(({ label, value }) => (
          <div key={label} className="flex flex-col gap-0.5">
            <span className="text-[10px] tracking-widest text-white/55">{label}</span>
            <span className="text-xs text-white/80 break-all">{value}</span>
          </div>
        ))}
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-[10px] tracking-widest text-white/65">キャンセルする枚数</span>
        <select
          value={cancel}
          onChange={(e) => { setCancel(Number(e.target.value)); setConfirming(false); }}
          disabled={isSending}
          className="w-full bg-black border border-white/30 focus:border-white/50 text-white/85 text-xs px-3 py-2 rounded-sm outline-none"
        >
          {Array.from({ length: tickets }, (_, i) => tickets - i).map((n) => (
            <option key={n} value={n}>
              {n === tickets ? `すべて（${n}枚）キャンセル` : `${n}枚キャンセル（${tickets - n}枚残す）`}
            </option>
          ))}
        </select>
        {kept > 0 && (
          <span className="text-[10px] text-white/50">
            変更後 {kept}枚・当日のお支払い {formatYen(totalPrice(kept))}
          </span>
        )}
      </label>

      <div className="flex flex-col gap-2 pt-2 border-t border-white/10">
        {error && <p className="text-[10px] text-red-400/80 text-center pt-2">{error}</p>}
        {confirming && (
          <p className="text-[11px] text-white/70 text-center pt-2">
            {kept > 0 ? `${cancel}枚をキャンセルし、${kept}枚に変更します。` : "ご予約をすべてキャンセルします。"}
            よろしいですか？（取り消せません）
          </p>
        )}
        <div className="flex items-center justify-between pt-2">
          {confirming ? (
            <button
              onClick={() => setConfirming(false)}
              disabled={isSending}
              className="text-[10px] tracking-[0.2em] text-white/50 hover:text-white/80 disabled:opacity-40 transition-colors duration-150"
            >
              戻る
            </button>
          ) : (
            <span />
          )}
          <button onClick={confirming ? handleSend : () => setConfirming(true)} disabled={isSending} className={primaryButton}>
            {isSending ? "送信中..." : confirming ? "キャンセルを確定する" : "次へ"}
          </button>
        </div>
      </div>

      <p className="text-[10px] text-white/45 leading-relaxed">
        ご不明な点は CONTACTの
        <Link href={CONTACT_TICKET_PATH} className="underline hover:text-white/80">『チケット関連』</Link>
        よりご連絡ください。
      </p>
    </div>
  );
}
