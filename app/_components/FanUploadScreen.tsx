"use client";

import Link from "next/link";
import { useState } from "react";
import FanUploadForm, { type LiveOption } from "./FanUploadForm";
import type { UploadLimits } from "@/src/lib/fan-upload/policy";

// /upload の本体。投稿完了画面では、左上の「← deddecay」と共通ヘッダー（Fan moments の見出し・説明）を出さない
// （完了画面は「ありがとうございます！」「TOPへ戻る」「Fan momentsへ戻る」だけで構成する）。通常のフォーム画面では従来どおり表示する
type Props = {
  lives: LiveOption[];
  initialLiveId?: string;
  limits: UploadLimits;
};

export default function FanUploadScreen({ lives, initialLiveId, limits }: Props) {
  const [done, setDone] = useState(false);

  return (
    <>
      {!done && (
        <Link
          href="/"
          className="text-[10px] tracking-widest text-white/45 hover:text-white/75 transition-colors duration-150"
        >
          ← deddecay
        </Link>
      )}

      {!done && (
        <header className="flex flex-col gap-2">
          <h1 className="text-sm tracking-[0.2em] text-white/90">Fan moments</h1>
          <p className="text-[11px] leading-relaxed text-white/55">
            deddecayのライブで撮影した写真や動画をアップロードしてください！
            <br />
            SNS等での使用を目的としています。
          </p>
        </header>
      )}

      {/* 上限はサーバーが実際に適用している値（環境変数での変更に追従）を渡す */}
      <FanUploadForm lives={lives} initialLiveId={initialLiveId} limits={limits} onDoneChange={setDone} />

      {/* プライバシーポリシーへの控えめなリンク（フォーム画面の下部だけ。完了画面の構成は変えない） */}
      {!done && (
        <Link
          href="/privacy"
          className="self-start text-[10px] tracking-widest text-white/35 hover:text-white/65 transition-colors duration-150"
        >
          プライバシーポリシー
        </Link>
      )}
    </>
  );
}
