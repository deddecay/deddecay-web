"use client";

import { useState } from "react";

type ModalState = "none" | "preview" | "complete";

const CATEGORIES = [
  { value: "BOOKING", label: "ライブのお誘い" },
  { value: "TICKET",  label: "チケット関連"   },
  { value: "MEDIA",   label: "取材・メディア" },
  { value: "OTHER",   label: "その他"         },
] as const;

const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

const inputBase =
  "w-full bg-transparent border border-white/30 focus:border-white/50 text-white/85 text-xs placeholder:text-white/40 px-3 py-2 rounded-sm outline-none transition-colors duration-150";

const labelBase = "text-[10px] tracking-widest text-white/65";

export default function ContactForm() {
  const [category, setCategory] = useState("");
  const [name, setName]         = useState("");
  const [email, setEmail]       = useState("");
  const [subject, setSubject]   = useState("");
  const [message, setMessage]   = useState("");
  const [website, setWebsite]   = useState(""); // honeypot
  const [modal, setModal]       = useState<ModalState>("none");
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState("");

  const isReady =
    category !== "" && name !== "" && isValidEmail(email) && subject !== "" && message !== "";

  const resetForm = () => {
    setCategory(""); setName(""); setEmail(""); setSubject(""); setMessage("");
    setSendError("");
  };

  const handleSend = async () => {
    setIsSending(true);
    setSendError("");
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, name, email, subject, message, website }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? "送信に失敗しました");
      }
      setModal("complete");
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "送信に失敗しました");
    } finally {
      setIsSending(false);
    }
  };

  return (
    <>
      <div className="mt-5 flex flex-col gap-4 w-full px-1">

        {/* Category */}
        <div className="flex flex-col gap-1.5">
          <span className={labelBase}>種別</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className={`${inputBase} appearance-none`}
          >
            <option value="" disabled hidden>選択してください</option>
            {CATEGORIES.map(({ value, label }) => (
              <option key={value} value={value} style={{ background: "#000", color: "#fff" }}>{label}</option>
            ))}
          </select>
        </div>

        {/* Name */}
        <div className="flex flex-col gap-1.5">
          <span className={labelBase}>お名前</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="お名前"
            className={inputBase}
          />
        </div>

        {/* Email */}
        <div className="flex flex-col gap-1.5">
          <span className={labelBase}>メールアドレス</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="your@email.com"
            className={inputBase}
          />
          {email !== "" && !isValidEmail(email) && (
            <span className="text-[10px] text-red-400/80">valid email required</span>
          )}
        </div>

        {/* Subject */}
        <div className="flex flex-col gap-1.5">
          <span className={labelBase}>件名</span>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="件名"
            className={inputBase}
          />
        </div>

        {/* Message */}
        <div className="flex flex-col gap-1.5">
          <span className={labelBase}>内容</span>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="お問い合わせ内容"
            rows={4}
            className={`${inputBase} resize-none`}
          />
        </div>

        {/* honeypot: hidden from users, filled by bots */}
        <div style={{ position: "absolute", left: "-9999px", width: 0, height: 0, overflow: "hidden" }} aria-hidden="true">
          <input
            type="text"
            name="website"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            tabIndex={-1}
            autoComplete="off"
          />
        </div>

        {/* Preview button */}
        <button
          onClick={() => setModal("preview")}
          disabled={!isReady}
          className="mt-1 self-center text-[10px] tracking-[0.25em] border border-white/35 hover:border-white/65 active:border-white/40 text-white/60 hover:text-white/95 active:text-white/50 disabled:border-white/15 disabled:text-white/25 disabled:pointer-events-none px-5 py-2 rounded-sm transition-colors duration-150"
        >
          確認する
        </button>
      </div>

      {/* ── Preview Modal ────────────────────────────── */}
      {modal === "preview" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4">
          <div className="w-full max-w-xs sm:max-w-sm bg-black border border-white/15 flex flex-col max-h-[85vh]">

            {/* スクロール可能な内容エリア */}
            <div
              className="flex-1 overflow-y-auto px-6 pt-6 pb-4 [&::-webkit-scrollbar]:hidden"
              style={{ scrollbarWidth: "none" }}
            >
              <div className="flex flex-col gap-3.5">
                {[
                  { label: "種別",          value: CATEGORIES.find((c) => c.value === category)?.label ?? category },
                  { label: "お名前",        value: name    },
                  { label: "メールアドレス", value: email   },
                  { label: "件名",          value: subject },
                ].map(({ label, value }) => (
                  <div key={label} className="flex flex-col gap-0.5">
                    <span className="text-[10px] tracking-widest text-white/55">{label}</span>
                    <span className="text-xs text-white/80">{value}</span>
                  </div>
                ))}
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] tracking-widest text-white/55">内容</span>
                  <p className="text-xs text-white/75 leading-relaxed whitespace-pre-wrap break-words">{message}</p>
                </div>
              </div>
            </div>

            {/* 常に表示されるボタンエリア */}
            <div className="flex flex-col gap-2 px-6 py-4 border-t border-white/10 flex-shrink-0">
              {sendError && (
                <p className="text-[10px] text-red-400/80 text-center">{sendError}</p>
              )}
              <div className="flex items-center justify-between">
                <button
                  onClick={() => { setModal("none"); setSendError(""); }}
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
                  {isSending ? "送信中..." : "送信"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Complete Modal ───────────────────────────── */}
      {modal === "complete" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4">
          <div className="w-full max-w-xs sm:max-w-sm bg-black border border-white/15 p-10 flex flex-col items-center gap-7">
            <div className="flex flex-col items-center gap-2.5 text-center">
              <p className="text-sm tracking-[0.15em] text-white/85">送信が完了しました。</p>
              <p className="text-xs text-white/65 leading-relaxed">お問い合わせありがとうございます。<br />内容を確認後、ご連絡いたします。</p>
            </div>
            <button
              onClick={() => { setModal("none"); resetForm(); }}
              className="text-[10px] tracking-[0.25em] border border-white/30 hover:border-white/65 active:border-white/35 text-white/60 hover:text-white active:text-white/45 px-5 py-1.5 rounded-sm transition-colors duration-150"
            >
              閉じる
            </button>
          </div>
        </div>
      )}
    </>
  );
}
