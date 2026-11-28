import { NextRequest, NextResponse } from "next/server";
import { ticketEnabled } from "@/src/lib/ticket/flags";
import { opsAuthorized } from "@/src/lib/ticket/ops";
import { EVENT } from "@/src/lib/ticket/event";
import { cancelReservation, parseApplication, summarize, type Reservation } from "@/src/lib/ticket/ledger";
import { buildCancelMail, buildCancelOperatorMail } from "@/src/lib/ticket/mail";
import { getLedgerStore, sendMail, syncSheetNow } from "@/src/lib/ticket/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 運用 API：キャンセル。scripts/tickets.mjs cancel <受付ID> --yes から呼ぶ。
//   { id }                      台帳から取り消し → 申込者へキャンセルのお知らせ → 運営へ通知 → 集計表を書き直す
//   { id, notifyOnly: {...} }   台帳は触らず、お知らせメールだけ送る（この API ができる前に取り消した人への連絡用）
// 合言葉（TICKET_OPS_SECRET）が一致しなければ 404（存在を知らせない）
export async function POST(req: NextRequest) {
  if (!ticketEnabled() || !opsAuthorized(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }
  const store = getLedgerStore();
  if (!store) return NextResponse.json({ error: "台帳の保存先が未設定です" }, { status: 503 });

  let body: { id?: unknown; notifyOnly?: { name?: unknown; email?: unknown; tickets?: unknown; createdAt?: unknown } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id : "";
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return NextResponse.json({ error: "受付ID が不正です" }, { status: 400 });

  let reservation: Reservation;
  if (body.notifyOnly) {
    const n = body.notifyOnly;
    const parsed = parseApplication(
      { requestId: `notify-${id}`.slice(0, 64).padEnd(16, "0"), name: n.name, email: n.email, tickets: n.tickets },
      EVENT.maxPerOrder
    );
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const createdAt = typeof n.createdAt === "string" && !Number.isNaN(Date.parse(n.createdAt)) ? n.createdAt : new Date().toISOString();
    reservation = { id, requestId: parsed.value.requestId, name: parsed.value.name, email: parsed.value.email, tickets: parsed.value.tickets, createdAt };
  } else {
    const result = await cancelReservation(store, id);
    if (result.status === "not_found") return NextResponse.json({ error: "受付ID が見つかりません" }, { status: 404 });
    if (result.status === "conflict") return NextResponse.json({ error: "混み合っています。再度お試しください" }, { status: 503 });
    reservation = result.reservation;
  }

  const summary = summarize((await store.read()).ledger, EVENT.capacity);
  const to = process.env.CONTACT_TO_EMAIL;
  // 送信元ドメインはメールを受信しないので、お知らせへの返信は運営の受信先へ向ける
  const applicantMailOk = await sendMail(reservation.email, { ...buildCancelMail(reservation), ...(to ? { replyTo: to } : {}) });
  const operatorMailOk = !!to && (await sendMail(to, buildCancelOperatorMail(reservation, summary, { applicantMailOk })));
  if (!operatorMailOk) console.error(`[ticket] キャンセルの運営通知の送信に失敗しました (reservation ${reservation.id})`);

  let sheet: { rows: number; url: string } | null = null;
  let sheetError = "";
  if (!body.notifyOnly) {
    try {
      sheet = await syncSheetNow(store);
      if (!sheet) sheetError = "Google 連携が未設定です";
    } catch (err) {
      sheetError = "集計表の反映に失敗しました";
      console.error("[ticket] 集計表の反映に失敗しました（キャンセル）:", err instanceof Error ? err.message : err);
    }
  }

  return NextResponse.json({
    ok: true,
    cancelled: !body.notifyOnly,
    reservation: { id: reservation.id, name: reservation.name, email: reservation.email, tickets: reservation.tickets },
    remaining: summary.remaining,
    mailSent: applicantMailOk,
    operatorMailSent: operatorMailOk,
    sheet,
    sheetError,
  });
}
