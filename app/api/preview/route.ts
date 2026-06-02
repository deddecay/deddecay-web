import { NextRequest, NextResponse } from "next/server";

export function GET(req: NextRequest) {
  const { searchParams, origin } = req.nextUrl;
  const secret    = searchParams.get("secret");
  const contentId = searchParams.get("contentId");
  const draftKey  = searchParams.get("draftKey");
  const type      = searchParams.get("type");

  if (!process.env.PREVIEW_SECRET || secret !== process.env.PREVIEW_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  if (!contentId || !draftKey) {
    return new NextResponse("Bad Request: contentId and draftKey are required", { status: 400 });
  }

  if (type === "news") {
    return NextResponse.redirect(new URL(`/news/${contentId}?draftKey=${draftKey}`, origin));
  }

  if (type === "live") {
    return NextResponse.redirect(new URL(`/live/${contentId}?draftKey=${draftKey}`, origin));
  }

  return new NextResponse("Bad Request: type must be news or live", { status: 400 });
}
