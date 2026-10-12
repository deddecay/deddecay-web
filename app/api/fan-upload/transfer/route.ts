import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { buildTransferDeps, transferBudgetMs } from "@/src/lib/fan-upload/runtime";
import { sweep } from "@/src/lib/fan-upload/transfer";
import { fanMomentsEnabled } from "@/src/lib/fan-upload/flags";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const authorized = (req: NextRequest): boolean => {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const given = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// Vercel Cron（日次）から呼ばれる。未転送・失敗した投稿の再試行と、転送確認済みで保持期間を過ぎた R2 の掃除
export async function GET(req: NextRequest) {
  // 公開前・秘密未設定は存在しないものとして扱う
  if (!fanMomentsEnabled() || !authorized(req)) return NextResponse.json({ error: "Not Found" }, { status: 404 });
  const deps = buildTransferDeps();
  if (!deps) return NextResponse.json({ ok: false, reason: "Drive 連携の設定が未完了です" }, { status: 503 });

  const result = await sweep(deps, Date.now() + transferBudgetMs());
  return NextResponse.json({ ok: true, ...result });
}
