import { NextRequest, NextResponse, after } from "next/server";
import { ticketEnabled } from "@/src/lib/ticket/flags";
import { EVENT } from "@/src/lib/ticket/event";
import { parseApplication, reserve } from "@/src/lib/ticket/ledger";
import { buildApplicantMail, buildOperatorMail } from "@/src/lib/ticket/mail";
import { getLedgerStore, readVenue, sendMail, syncSheetSafely } from "@/src/lib/ticket/runtime";
import { clientIp, consume } from "@/src/lib/fan-upload/ratelimit";

export const dynamic = "force-dynamic";

const SOLD_OUT = "定員に達したため、チケットのお申し込み受付は終了しました。";

// 12/6 フロアライブ チケット申し込み。会場情報は自動返信メールにだけ載せ、レスポンスには含めない
export async function POST(req: NextRequest) {
  // 公開前（ENABLED 未設定）は存在しないものとして扱う
  if (!ticketEnabled()) return NextResponse.json({ error: "Not Found" }, { status: 404 });

  // 別サイトからの送信を拒否する（ブラウザは同一オリジンでも Origin を付ける）
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400 });
  }

  // honeypot: bot が埋めたら受け付けたふりをする
  if (body && typeof body === "object" && (body as Record<string, unknown>).website) {
    return NextResponse.json({ ok: true, tickets: 0 });
  }

  const parsed = parseApplication(body, EVENT.maxPerOrder);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const rate = await consume(`ticket:${EVENT.id}:${clientIp(req)}`, 10, 3600);
  if (!rate.allowed) {
    return NextResponse.json({ error: "しばらく時間をおいてから再度お試しください" }, { status: 429 });
  }

  const store = getLedgerStore();
  if (!store) {
    console.error("[ticket] 台帳の保存先が未設定です (R2_*)");
    return NextResponse.json({ error: "現在、受付を準備中です" }, { status: 503 });
  }

  let result;
  try {
    result = await reserve(store, parsed.value, { capacity: EVENT.capacity, maxPerOrder: EVENT.maxPerOrder });
  } catch (err) {
    console.error("[ticket] reserve error:", err);
    return NextResponse.json({ error: "送信に失敗しました。時間をおいて再度お試しください" }, { status: 500 });
  }

  switch (result.status) {
    case "sold_out":
      return NextResponse.json({ error: SOLD_OUT, soldOut: true, remaining: 0 }, { status: 409 });
    case "insufficient":
      return NextResponse.json(
        { error: `残りのお席は${result.remaining}枚です。枚数を変更してお申し込みください。`, remaining: result.remaining },
        { status: 409 }
      );
    case "duplicate_email":
      return NextResponse.json(
        { error: "このメールアドレスでは既にお申し込みを受け付けています。変更はCONTACTの『チケット関連』よりご連絡ください。" },
        { status: 409 }
      );
    case "conflict":
      return NextResponse.json({ error: "混み合っています。少し時間をおいて再度お試しください" }, { status: 503 });
    case "replayed":
      // 二重送信。受付済みの結果を返し、メールは送り直さない
      return NextResponse.json({ ok: true, tickets: result.reservation.tickets });
    case "accepted": {
      const { reservation, reserved, remaining } = result;
      const to = process.env.CONTACT_TO_EMAIL;
      // 送信元ドメイン（deddecay.tokyo）はメールを受信しないので、自動返信への返信は運営の受信先へ向ける
      const applicantMail = { ...buildApplicantMail(reservation, readVenue()), ...(to ? { replyTo: to } : {}) };
      const applicantMailOk = await sendMail(reservation.email, applicantMail);
      const operatorMail = buildOperatorMail(reservation, { reserved, remaining, capacity: EVENT.capacity }, { applicantMailOk });
      if (!to || !(await sendMail(to, operatorMail))) {
        console.error(`[ticket] 運営通知の送信に失敗しました (reservation ${reservation.id})`);
      }
      // 集計表への反映は応答のあとで行う（申込者を待たせない・失敗しても受付には影響しない）
      after(() => syncSheetSafely(store));
      return NextResponse.json({ ok: true, tickets: reservation.tickets, mailSent: applicantMailOk });
    }
  }
}
