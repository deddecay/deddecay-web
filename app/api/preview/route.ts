import { NextRequest, NextResponse } from "next/server";
import { getEntryById } from "@/src/lib/microcms";

export async function GET(req: NextRequest) {
  const { searchParams, origin } = req.nextUrl;
  const secret    = searchParams.get("secret");
  const contentId = searchParams.get("contentId");
  const draftKey  = searchParams.get("draftKey");

  if (!process.env.PREVIEW_SECRET || secret !== process.env.PREVIEW_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  if (!contentId || !draftKey) {
    return new NextResponse("Bad Request: contentId and draftKey are required", { status: 400 });
  }

  let entry;
  try {
    entry = await getEntryById(contentId, draftKey);
  } catch {
    return new NextResponse("Internal Server Error", { status: 500 });
  }

  if (!entry) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const type = Array.isArray(entry.type) ? entry.type[0] : entry.type;

  if (type === "news") {
    return NextResponse.redirect(new URL(`/news/${contentId}?draftKey=${draftKey}`, origin));
  }

  if (type === "live") {
    return NextResponse.redirect(new URL(`/live/${contentId}?draftKey=${draftKey}`, origin));
  }

  return new NextResponse("Bad Request: unsupported entry type", { status: 400 });
}
