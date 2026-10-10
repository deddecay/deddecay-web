"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ACCEPT_ATTRIBUTE,
  DEFAULT_LIMITS,
  FIELD_LIMITS,
  GIB,
  checkDeclaredFiles,
  formatBytes,
} from "@/src/lib/fan-upload/policy";
import { UploadFatalError, uploadFile } from "@/src/lib/fan-upload/client-upload";

export type LiveOption = { id: string; label: string };

type Props = {
  lives: LiveOption[];
  initialLiveId?: string;
};

type Phase = "idle" | "uploading" | "completing" | "done";

type Session = {
  postId: string;
  token: string;
  uploads: { name: string; sessionUrl: string }[];
  done: Set<number>;
  signature: string;
};

type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
      theme?: string;
    }
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

const inputBase =
  "w-full bg-transparent border border-white/30 focus:border-white/50 text-white/85 text-xs placeholder:text-white/40 px-3 py-2 rounded-sm outline-none transition-colors duration-150";
const labelBase = "text-[10px] tracking-widest text-white/65";
const buttonBase =
  "text-[10px] tracking-[0.25em] border border-white/35 hover:border-white/65 active:border-white/40 text-white/60 hover:text-white/95 active:text-white/50 disabled:border-white/15 disabled:text-white/25 disabled:pointer-events-none px-5 py-2 rounded-sm transition-colors duration-150";

const fileSignature = (files: File[]) => files.map((f) => `${f.name}:${f.size}:${f.lastModified}`).join("|");

export default function FanUploadForm({ lives, initialLiveId }: Props) {
  const [kind, setKind] = useState<"" | "live" | "other">(
    initialLiveId && lives.some((l) => l.id === initialLiveId) ? "live" : ""
  );
  const [liveId, setLiveId] = useState(
    initialLiveId && lives.some((l) => l.id === initialLiveId) ? initialLiveId : ""
  );
  const [message, setMessage] = useState("");
  const [consent, setConsent] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [turnstileToken, setTurnstileToken] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<number[]>([]);
  const [mailNote, setMailNote] = useState(false);
  // 途中まで送信済みのセッションがあるか（表示用。実体は sessionRef）
  const [resumable, setResumable] = useState(false);

  const sessionRef = useRef<Session | null>(null);
  const widgetRef = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | undefined>(undefined);
  const wakeLock = useRef<{ release: () => Promise<void> } | null>(null);

  // ── Turnstile ──────────────────────────────────────
  useEffect(() => {
    if (!SITE_KEY) return;
    let cancelled = false;

    const mount = () => {
      if (cancelled || !widgetRef.current || !window.turnstile || widgetId.current) return;
      widgetId.current = window.turnstile.render(widgetRef.current, {
        sitekey: SITE_KEY,
        theme: "dark",
        callback: (token) => setTurnstileToken(token),
        "expired-callback": () => setTurnstileToken(""),
        "error-callback": () => setTurnstileToken(""),
      });
    };

    if (window.turnstile) {
      mount();
    } else {
      let script = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
      if (!script) {
        script = document.createElement("script");
        script.src = SCRIPT_SRC;
        script.async = true;
        document.head.appendChild(script);
      }
      script.addEventListener("load", mount);
    }

    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = undefined;
    };
  }, []);

  const resetTurnstile = () => {
    setTurnstileToken("");
    if (widgetId.current && window.turnstile) window.turnstile.reset(widgetId.current);
  };

  // ── 画面スリープ防止（大容量送信中）──────────────────
  const acquireWakeLock = useCallback(async () => {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
      };
      wakeLock.current = (await nav.wakeLock?.request("screen")) ?? null;
    } catch {
      // 非対応・拒否は無視（送信自体は続ける）
    }
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && sessionRef.current && phase === "uploading") {
        void acquireWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [phase, acquireWakeLock]);

  // 送信中にページを離れようとしたら確認
  useEffect(() => {
    if (phase !== "uploading" && phase !== "completing") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [phase]);

  // ── 入力検証 ───────────────────────────────────────
  const fileCheck = files.length
    ? checkDeclaredFiles(files.map((f) => ({ name: f.name, size: f.size, type: f.type })))
    : null;

  const targetReady = kind === "other" || (kind === "live" && liveId !== "");
  const busy = phase === "uploading" || phase === "completing";
  const canSubmit =
    !busy &&
    targetReady &&
    consent &&
    files.length > 0 &&
    fileCheck?.ok === true &&
    (turnstileToken !== "" || resumable) &&
    SITE_KEY !== undefined;

  const onPickFiles = (list: FileList | null) => {
    sessionRef.current = null;
    setResumable(false);
    setProgress([]);
    setError("");
    setFiles(list ? Array.from(list) : []);
  };

  // ── 送信 ──────────────────────────────────────────
  const submit = async () => {
    setError("");
    setPhase("uploading");
    await acquireWakeLock();
    try {
      const signature = `${kind}:${liveId}|${fileSignature(files)}`;
      let session = sessionRef.current;

      if (!session || session.signature !== signature) {
        const res = await fetch("/api/fan-upload/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            liveId: kind === "live" ? liveId : undefined,
            message,
            consent: true,
            turnstileToken,
            files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
          }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          postId?: string;
          token?: string;
          uploads?: { name: string; sessionUrl: string }[];
        };
        if (!res.ok || !data.postId || !data.token || !data.uploads) {
          resetTurnstile();
          throw new Error(data.error ?? "送信の準備に失敗しました");
        }
        session = { postId: data.postId, token: data.token, uploads: data.uploads, done: new Set(), signature };
        sessionRef.current = session;
        setResumable(true);
        setProgress(files.map(() => 0));
      }

      for (let i = 0; i < files.length; i++) {
        if (session.done.has(i)) continue;
        await uploadFile(files[i], session.uploads[i].sessionUrl, (bytes) =>
          setProgress((prev) => prev.map((p, idx) => (idx === i ? bytes : p)))
        );
        session.done.add(i);
        setProgress((prev) => prev.map((p, idx) => (idx === i ? files[i].size : p)));
      }

      setPhase("completing");
      const res = await fetch("/api/fan-upload/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: session.token }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; mailed?: boolean };
      if (!res.ok) throw new Error(data.error ?? "保存結果の確認に失敗しました");

      setMailNote(data.mailed === false);
      sessionRef.current = null;
      setResumable(false);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "送信に失敗しました");
      if (err instanceof UploadFatalError) {
        sessionRef.current = null;
        setResumable(false);
      }
      setPhase("idle");
    } finally {
      void wakeLock.current?.release().catch(() => undefined);
      wakeLock.current = null;
    }
  };

  const reset = () => {
    sessionRef.current = null;
    setResumable(false);
    setFiles([]);
    setProgress([]);
    setMessage("");
    setConsent(false);
    setError("");
    setMailNote(false);
    resetTurnstile();
    setPhase("idle");
  };

  // ── 表示 ──────────────────────────────────────────
  if (phase === "done") {
    return (
      <div className="flex flex-col items-center gap-6 py-6 text-center">
        <p className="text-sm tracking-[0.15em] text-white/85">ありがとうございます！</p>
        <p className="text-xs text-white/65 leading-relaxed">
          アップロードいただいた写真や動画も引き続き自由にお使いください！
        </p>
        {mailNote && (
          <p className="text-[10px] text-white/40 leading-relaxed">※ 受付通知の送信に時間がかかっています。ファイルは保存済みです。</p>
        )}
        <button onClick={reset} className={buttonBase}>
          続けて投稿する
        </button>
      </div>
    );
  }

  const total = files.reduce((sum, f) => sum + f.size, 0);
  const uploaded = progress.reduce((sum, p) => sum + p, 0);
  const percent = total > 0 ? Math.min(100, Math.floor((uploaded / total) * 100)) : 0;

  return (
    <div className="flex flex-col gap-5 w-full">
      {/* 種類 */}
      <div className="flex flex-col gap-1.5">
        <span className={labelBase}>投稿の種類</span>
        <div className="flex gap-6">
          {(
            [
              ["live", "LIVE"],
              ["other", "その他"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-xs text-white/75 cursor-pointer">
              <input
                type="radio"
                name="kind"
                checked={kind === value}
                disabled={busy}
                onChange={() => setKind(value)}
                className="accent-white"
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      {kind === "live" && (
        <div className="flex flex-col gap-1.5">
          <span className={labelBase}>公演</span>
          <select
            value={liveId}
            disabled={busy}
            onChange={(e) => setLiveId(e.target.value)}
            className={`${inputBase} appearance-none`}
          >
            <option value="" disabled hidden>
              公演を選択してください
            </option>
            {lives.map((live) => (
              <option key={live.id} value={live.id} style={{ background: "#000", color: "#fff" }}>
                {live.label}
              </option>
            ))}
          </select>
          {lives.length === 0 && <span className="text-[10px] text-white/40">公演情報を取得できませんでした</span>}
        </div>
      )}

      {/* ファイル */}
      <div className="flex flex-col gap-1.5">
        <span className={labelBase}>ファイル（動画・画像・音声）</span>
        <input
          type="file"
          multiple
          accept={ACCEPT_ATTRIBUTE}
          disabled={busy}
          onChange={(e) => onPickFiles(e.target.files)}
          className="block w-full text-xs text-white/70 file:mr-3 file:rounded-sm file:border file:border-white/30 file:bg-transparent file:px-3 file:py-2 file:text-[10px] file:tracking-widest file:text-white/70"
        />
        <span className="text-[10px] text-white/35 leading-relaxed">
          1回 {DEFAULT_LIMITS.maxFiles} ファイルまで / 1ファイル {Math.floor(DEFAULT_LIMITS.maxFileBytes / GIB)}GB まで。
          大きな動画は Wi-Fi で、送信が終わるまで画面を開いたままにしてください。
        </span>
        {files.length > 0 && (
          <ul className="flex flex-col gap-1 pt-1">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex justify-between gap-3 text-[10px] text-white/55">
                <span className="truncate">{f.name}</span>
                <span className="flex-shrink-0">{formatBytes(f.size)}</span>
              </li>
            ))}
          </ul>
        )}
        {fileCheck && !fileCheck.ok && <span className="text-[10px] text-red-400/80">{fileCheck.reason}</span>}
      </div>

      {/* 投稿者の個人情報（名前・メール等）は求めない。メッセージは任意 */}
      <div className="flex flex-col gap-1.5">
        <span className={labelBase}>メッセージ（任意）</span>
        <textarea
          value={message}
          maxLength={FIELD_LIMITS.message}
          disabled={busy}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          placeholder="撮影した場面など"
          className={`${inputBase} resize-none`}
        />
      </div>

      {/* 利用許諾 */}
      <div className="flex flex-col gap-3 border border-white/15 p-3">
        <span className={labelBase}>利用について</span>
        <ul className="list-disc pl-4 text-[10px] leading-relaxed text-white/55 flex flex-col gap-1">
          <li>投稿するのは、ご自身が撮影・制作したもの、または投稿の権利をお持ちのものに限ります。</li>
          <li>deddecay が公式サイト・SNS・告知等で、投稿内容を紹介・利用する場合があります（事前の個別連絡なし）。</li>
          <li>他の方が大きく写っているもの、会場の撮影禁止区域のものはご遠慮ください。</li>
          <li>削除のご希望は、サイトの CONTACT からご連絡ください。</li>
          <li>投稿は非公開の保管場所に保存され、他の方からは見られません。</li>
        </ul>
        <label className="flex items-start gap-2 text-xs text-white/75 cursor-pointer">
          <input
            type="checkbox"
            checked={consent}
            disabled={busy}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5 accent-white"
          />
          上記に同意します
        </label>
      </div>

      {/* Turnstile */}
      {SITE_KEY ? (
        <div ref={widgetRef} className="min-h-[65px]" />
      ) : (
        <p className="text-[10px] text-white/40">現在、投稿の受付を準備中です。</p>
      )}

      {busy && (
        <div className="flex flex-col gap-1.5">
          <div className="h-px w-full bg-white/15">
            <div className="h-px bg-white/80 transition-all duration-300" style={{ width: `${percent}%` }} />
          </div>
          <span className="text-[10px] tracking-widest text-white/55">
            {phase === "uploading" ? `送信中 ${percent}%（画面を閉じないでください）` : "確認中..."}
          </span>
        </div>
      )}

      {error && <p className="text-[10px] text-red-400/80 leading-relaxed">{error}</p>}

      <button onClick={submit} disabled={!canSubmit} className={`${buttonBase} self-center`}>
        {resumable && !busy && error ? "再開する" : busy ? "送信中..." : "投稿する"}
      </button>
    </div>
  );
}
