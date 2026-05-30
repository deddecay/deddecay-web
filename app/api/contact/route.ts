import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";

const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400 });
  }

  const { category, name, email, subject, message, website } =
    body as Record<string, string>;

  // honeypot: bots fill this field, humans don't
  if (website) {
    return NextResponse.json({ ok: true });
  }

  if (!category || !name || !email || !subject || !message) {
    return NextResponse.json({ error: "必須項目が不足しています" }, { status: 400 });
  }

  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "valid email required" }, { status: 400 });
  }

  const to   = process.env.CONTACT_TO_EMAIL;
  const from = process.env.CONTACT_FROM_EMAIL;

  if (!to || !from) {
    console.error("[contact] 環境変数が未設定: CONTACT_TO_EMAIL / CONTACT_FROM_EMAIL");
    return NextResponse.json({ error: "サーバー設定エラー" }, { status: 500 });
  }

  const emailText = [
    `種別: ${category}`,
    `お名前: ${name}`,
    `メールアドレス: ${email}`,
    `件名: ${subject}`,
    "",
    "内容:",
    message,
  ].join("\n");

  try {
    const { error } = await resend.emails.send({
      to,
      from,
      replyTo: email,
      subject: `[${category}] ${subject}`,
      text: emailText,
    });

    if (error) {
      console.error("[contact] resend error:", error);
      return NextResponse.json({ error: "送信に失敗しました" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[contact] unexpected error:", err);
    return NextResponse.json({ error: "送信に失敗しました" }, { status: 500 });
  }
}
