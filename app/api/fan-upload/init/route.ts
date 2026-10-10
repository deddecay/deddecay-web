import { NextRequest, NextResponse } from "next/server";
import { buildDeps } from "@/src/lib/fan-upload/runtime";
import { handleInit } from "@/src/lib/fan-upload/service";
import { clientIp } from "@/src/lib/fan-upload/ratelimit";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const deps = buildDeps();
  if (!deps) {
    console.error("[fan-upload] 必須環境変数が未設定です (GOOGLE_OAUTH_* / FAN_UPLOAD_SECRET / TURNSTILE_SECRET_KEY)");
    return NextResponse.json({ error: "現在、投稿の受付を準備中です" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400 });
  }

  const result = await handleInit(body, { ip: clientIp(req), origin: req.headers.get("origin") }, deps);
  return NextResponse.json(result.body, { status: result.status });
}
