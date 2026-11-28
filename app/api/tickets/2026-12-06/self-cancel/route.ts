import { NextRequest, NextResponse } from "next/server";
import { ticketEnabled } from "@/src/lib/ticket/flags";
import { EVENT } from "@/src/lib/ticket/event";
import { reduceReservation, summarize } from "@/src/lib/ticket/ledger";
import { buildCancelMail, buildCancelOperatorMail } from "@/src/lib/ticket/mail";
import { verifyCancelToken } from "@/src/lib/ticket/cancel-link";
import { getLedgerStore, sendMail, syncSheetSafely } from "@/src/lib/ticket/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 本人によるキャンセル手続き（キャンセル手続きページから呼ぶ）。
// { token, cancel: 取り消す枚数, expected: ページを開いたときの枚数 }
// 台帳を更新 → 申込者へ完了メール → 運営へ完了通知 → 集計表を書き直す
export async function POST(req: NextRequest) {
  if (!ticketEnabled()) return NextResponse.json({ error: "Not Found" }, { status: 404 });

  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 403 });
  }

  let body: { token?: unknown; cancel?: unknown; expected?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400 });
  }
  const id = verifyCancelToken(EVENT.id, body.token);
  if (!id) return NextResponse.json({ error: "リンクが無効か、有効期限が切れています" }, { status: 403 });

  const store = getLedgerStore();
  if (!store) return NextResponse.json({ error: "現在、手続きを受け付けられません" }, { status: 503 });

  const result = await reduceReservation(store, id, Number(body.cancel), Number(body.expected));
  switch (result.status) {
    case "not_found":
      return NextResponse.json({ error: "このご予約はすでにキャンセルされています", gone: true }, { status: 404 });
    case "changed":
      return NextResponse.json(
        { error: "ご予約の枚数が変更されています。ページを再読み込みしてください", tickets: result.current.tickets },
        { status: 409 }
      );
    case "invalid":
      return NextResponse.json({ error: "キャンセルする枚数が不正です" }, { status: 400 });
    case "conflict":
      return NextResponse.json({ error: "混み合っています。再度お試しください" }, { status: 503 });
  }

  const before = result.before;
  const kept = result.status === "reduced" ? result.after.tickets : 0;
  const change = { cancelled: before.tickets - kept, kept };
  const summary = summarize((await store.read()).ledger, EVENT.capacity);
  const to = process.env.CONTACT_TO_EMAIL;
  const applicantMailOk = await sendMail(before.email, { ...buildCancelMail(before, change), ...(to ? { replyTo: to } : {}) });
  const operatorMailOk =
    !!to && (await sendMail(to, buildCancelOperatorMail(before, summary, { applicantMailOk, via: "self" }, change)));
  if (!operatorMailOk) console.error(`[ticket] 本人キャンセルの運営通知の送信に失敗しました (reservation ${before.id})`);
  await syncSheetSafely(store);

  return NextResponse.json({ ok: true, cancelled: change.cancelled, kept, mailSent: applicantMailOk });
}
