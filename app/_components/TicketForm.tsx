"use client";

import { useState } from "react";
import Link from "next/link";
import { EVENT, CONTACT_TICKET_PATH, formatYen, totalPrice } from "@/src/lib/ticket/event";

// 12/6 フロアライブのチケット申し込みフォーム（入力 → 確認 → 送信 → 完了）。
// 見た目は ContactForm に合わせる。会場の詳細はこの画面には出さない（自動返信メールでのみ案内）

type Step = "input" | "confirm" | "complete";

const SOLD_OUT = "定員に達したため、チケットのお申し込み受付は終了しました。";

const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

const inputBase =
  "w-full bg-transparent border border-white/30 focus:border-white/50 text-white/85 text-xs placeholder:text-white/40 px-3 py-2 rounded-sm outline-none transition-colors duration-150";
const labelBase = "text-[10px] tracking-widest text-white/65";
const primaryButton =
  "text-[10px] tracking-[0.25em] border border-white/35 hover:border-white/65 active:border-white/40 text-white/60 hover:text-white/95 active:text-white/50 disabled:border-white/15 disabled:text-white/25 disabled:pointer-events-none px-5 py-2 rounded-sm transition-colors duration-150";

const newRequestId = () => crypto.randomUUID();

export default function TicketForm({ maxTickets: initialMax }: { maxTickets: number }) {
  const [maxTickets, setMaxTickets] = useState(initialMax);
  const [step, setStep] = useState<Step>("input");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [tickets, setTickets] = useState(0);
  const [website, setWebsite] = useState(""); // honeypot
  // 確認画面を開くたびに作る申し込み ID。二重送信・再送はサーバーで同じ申し込みとして扱われる
  const [requestId, setRequestId] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [mailSent, setMailSent] = useState(true);
  const [doneTickets, setDoneTickets] = useState(0);

  if (maxTickets <= 0 && step !== "complete") {
    return <p className="text-xs text-white/75 leading-relaxed">{SOLD_OUT}</p>;
  }

  const isReady = name.trim() !== "" && isValidEmail(email.trim()) && tickets >= 1 && tickets <= maxTickets;

  const openConfirm = () => {
    setRequestId(newRequestId());
    setSendError("");
    setStep("confirm");
  };

  const handleSend = async () => {
    if (isSending) return;
    setIsSending(true);
    setSendError("");
    try {
      const res = await fetch(`/api/tickets/${EVENT.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, name, email, tickets, website }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean; error?: string; remaining?: number; soldOut?: boolean; mailSent?: boolean; tickets?: number;
      };
      if (!res.ok || !data.ok) {
        if (typeof data.remaining === "number") {
          const next = Math.min(EVENT.maxPerOrder, data.remaining);
          setMaxTickets(next);
          if (tickets > next) setTickets(0);
          if (next <= 0 || data.soldOut) {
            setStep("input");
            return;
          }
          setStep("input");
        }
        throw new Error(data.error ?? "送信に失敗しました");
      }
      setMailSent(data.mailSent !== false);
      setDoneTickets(data.tickets ?? tickets);
      setStep("complete");
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "送信に失敗しました");
    } finally {
      setIsSending(false);
    }
  };

  if (step === "complete") {
    return (
      <div className="flex flex-col items-center gap-6 text-center border border-white/15 px-6 py-10">
        <p className="text-sm tracking-[0.15em] text-white/85">お申し込みを受け付けました。</p>
        <p className="text-xs text-white/65 leading-relaxed">
          チケット {doneTickets}枚（合計 {formatYen(totalPrice(doneTickets))}）
          <br />
          {mailSent ? (
            <>ご入力のメールアドレスに、会場のご案内を含む確認メールをお送りしました。</>
          ) : (
            <>
              確認メールの送信に失敗しました。お手数ですが、CONTACTの
              <Link href={CONTACT_TICKET_PATH} className="underline hover:text-white/90">『チケット関連』</Link>
              よりご連絡ください。
            </>
          )}
        </p>
        <p className="text-[10px] text-white/45 leading-relaxed">
          メールが届かない場合は、迷惑メールフォルダもご確認ください。
        </p>
        <Link href="/" className="text-[10px] tracking-[0.25em] text-white/55 hover:text-white/85 transition-colors duration-150">
          ← deddecay
        </Link>
      </div>
    );
  }

  if (step === "confirm") {
    return (
      <div className="flex flex-col gap-6 border border-white/15 p-6">
        <div className="flex flex-col gap-3.5">
          {[
            { label: "お名前", value: name.trim() },
            { label: "メールアドレス", value: email.trim() },
            { label: "チケット枚数", value: `${tickets}枚` },
            { label: "合計金額", value: formatYen(totalPrice(tickets)) },
          ].map(({ label, value }) => (
            <div key={label} className="flex flex-col gap-0.5">
              <span className="text-[10px] tracking-widest text-white/55">{label}</span>
              <span className="text-xs text-white/80 break-all">{value}</span>
            </div>
          ))}
        </div>

        <ul className="flex flex-col gap-1.5 list-disc pl-4 text-[11px] leading-relaxed text-white/60">
          <li>会場の詳細および行き方は、お申し込み完了後の自動返信メールにてご案内いたします。</li>
          <li>チケット料金は当日、会場にてお支払いください。</li>
          <li>
            本公演に関するご質問・お問い合わせは、CONTACT内の
            <Link href={CONTACT_TICKET_PATH} className="underline hover:text-white/90">『チケット関連』</Link>
            よりご連絡ください。
          </li>
        </ul>

        <div className="flex flex-col gap-2 pt-2 border-t border-white/10">
          {sendError && <p className="text-[10px] text-red-400/80 text-center pt-2">{sendError}</p>}
          <div className="flex items-center justify-between pt-2">
            <button
              onClick={() => { setStep("input"); setSendError(""); }}
              disabled={isSending}
              className="text-[10px] tracking-[0.2em] text-white/50 hover:text-white/80 active:text-white/40 disabled:opacity-40 transition-colors duration-150"
            >
              戻る
            </button>
            <button
              onClick={handleSend}
              disabled={isSending}
              className="text-[10px] tracking-[0.2em] border border-white/30 hover:border-white/65 active:border-white/35 text-white/65 hover:text-white active:text-white/50 disabled:opacity-40 disabled:pointer-events-none px-4 py-1.5 rounded-sm transition-colors duration-150"
            >
              {isSending ? "送信中..." : "申し込む"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 w-full">
      {sendError && <p className="text-[10px] text-red-400/80">{sendError}</p>}

      <label className="flex flex-col gap-1.5">
        <span className={labelBase}>お名前</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="お名前"
          maxLength={100}
          autoComplete="name"
          className={inputBase}
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className={labelBase}>メールアドレス</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          maxLength={254}
          autoComplete="email"
          className={inputBase}
        />
        {email !== "" && !isValidEmail(email.trim()) && (
          <span className="text-[10px] text-red-400/80">valid email required</span>
        )}
      </label>

      <label className="flex flex-col gap-1.5">
        <span className={labelBase}>チケット希望枚数</span>
        <select
          value={tickets === 0 ? "" : String(tickets)}
          onChange={(e) => setTickets(Number(e.target.value))}
          className={`${inputBase} appearance-none`}
        >
          <option value="" disabled hidden>選択してください</option>
          {Array.from({ length: maxTickets }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n} style={{ background: "#000", color: "#fff" }}>{n}枚</option>
          ))}
        </select>
      </label>

      <p className="text-[11px] text-white/65">
        合計金額：{tickets > 0 ? formatYen(totalPrice(tickets)) : "—"}
        <span className="text-white/40">（{formatYen(EVENT.pricePerTicket)} × 枚数・{EVENT.payment}）</span>
      </p>

      {/* honeypot: hidden from users, filled by bots */}
      <div style={{ position: "absolute", left: "-9999px", width: 0, height: 0, overflow: "hidden" }} aria-hidden="true">
        <input type="text" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} tabIndex={-1} autoComplete="off" />
      </div>

      <button onClick={openConfirm} disabled={!isReady} className={`mt-1 self-center ${primaryButton}`}>
        確認する
      </button>
    </div>
  );
}
