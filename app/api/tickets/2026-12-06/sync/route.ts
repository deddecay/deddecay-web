import { NextRequest, NextResponse } from "next/server";
import { ticketEnabled } from "@/src/lib/ticket/flags";
import { opsAuthorized } from "@/src/lib/ticket/ops";
import { getLedgerStore, syncSheetNow } from "@/src/lib/ticket/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 運用 API：台帳の全件で集計表（Google スプレッドシート）を書き直す。
// scripts/tickets.mjs の cancel --yes / sheet から呼ぶ（Google 連携は本番サーバーにしか無いため）。
// 合言葉（TICKET_OPS_SECRET）が一致しなければ 404（存在を知らせない）
export async function POST(req: NextRequest) {
  if (!ticketEnabled() || !opsAuthorized(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }
  const store = getLedgerStore();
  if (!store) return NextResponse.json({ error: "台帳の保存先が未設定です" }, { status: 503 });
  try {
    const result = await syncSheetNow(store);
    if (!result) return NextResponse.json({ error: "Google 連携が未設定です" }, { status: 503 });
    return NextResponse.json({ ok: true, rows: result.rows, url: result.url });
  } catch (err) {
    console.error("[ticket] 集計表の反映に失敗しました（運用 API）:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "集計表の反映に失敗しました" }, { status: 502 });
  }
}
