import { NextRequest, NextResponse } from "next/server";
import { buildDeps } from "@/src/lib/fan-upload/runtime";
import { handleComplete } from "@/src/lib/fan-upload/service";
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

  const result = await handleComplete(body, { ip: clientIp(req), origin: req.headers.get("origin") }, deps);
  return NextResponse.json(result.body, { status: result.status });
}
