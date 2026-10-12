import { NextRequest, NextResponse, after } from "next/server";
import { buildDeps, buildTransferDeps, transferBudgetMs } from "@/src/lib/fan-upload/runtime";
import { handleComplete } from "@/src/lib/fan-upload/service";
import { transferUpload } from "@/src/lib/fan-upload/transfer";
import { verifyPostToken } from "@/src/lib/fan-upload/token";
import { clientIp } from "@/src/lib/fan-upload/ratelimit";
import { fanMomentsEnabled } from "@/src/lib/fan-upload/flags";

export const dynamic = "force-dynamic";
// 先頭バイト検証・メール送信まで含めるため余裕を持たせる
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  // 公開前は存在しないものとして扱う
  if (!fanMomentsEnabled()) return NextResponse.json({ error: "Not Found" }, { status: 404 });
  const deps = buildDeps();
  if (!deps) {
    return NextResponse.json({ error: "現在、投稿の受付を準備中です" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400 });
  }

  const startedAt = Date.now();
  const result = await handleComplete(body, { ip: clientIp(req), origin: req.headers.get("origin") }, deps);

  // 保存が確定したら、応答を返したあとに Drive への転送を始める（失敗しても投稿者の画面・通知には影響しない。
  // 続きと再試行は日次 Cron が担当する）。Drive 連携が未設定なら何もしない
  if (result.status === 200) {
    const payload = verifyPostToken(deps.secret, (body as { token?: unknown } | null)?.token, startedAt);
    const prefix = payload?.k;
    if (prefix) {
      after(async () => {
        const transfer = buildTransferDeps();
        if (!transfer) return;
        try {
          await transferUpload(transfer, prefix, startedAt + transferBudgetMs());
        } catch (err) {
          console.error("[fan-upload] background transfer error:", err);
        }
      });
    }
  }
  return NextResponse.json(result.body, { status: result.status });
}
