import { Resend } from "resend";

// CONTACT と同じ Resend / 宛先設定を使う通知メール送信（Fan moments の通知で使用）。
// 環境変数: RESEND_API_KEY / CONTACT_TO_EMAIL / CONTACT_FROM_EMAIL
// 送信元は FAN_MOMENTS_FROM_EMAIL（例: "deddecay Fan moments <fanmoments@deddecay.tokyo>"。Resend で認証済みのドメイン）
// があればそれを使い、無ければ従来どおり CONTACT_FROM_EMAIL を使う。CONTACT フォーム自体の送信元は変えない。

export type NotifyMail = {
  subject: string;
  text: string;
  replyTo?: string;
};

export const FAN_MOMENTS_SENDER_NAME = "deddecay Fan moments";

// 送信者の決め方:
//   1. FAN_MOMENTS_FROM_EMAIL があればそのまま使う
//   2. 無ければ CONTACT_FROM_EMAIL の「アドレス部分」だけを使い、表示名を "deddecay Fan moments" にする
//      （Resend のドメイン認証は不要。アドレスは CONTACT と同じまま、表示名だけが Fan moments 用になる）
// CONTACT フォーム自体の送信元は変えない（このモジュールは Fan moments 通知専用）。
export const fanMomentsFrom = (env: Record<string, string | undefined> = process.env): string => {
  const explicit = env.FAN_MOMENTS_FROM_EMAIL?.trim();
  if (explicit) return explicit;
  const base = env.CONTACT_FROM_EMAIL?.trim();
  if (!base) return "";
  const address = /<([^<>]+)>\s*$/.exec(base)?.[1]?.trim() ?? base;
  return `${FAN_MOMENTS_SENDER_NAME} <${address}>`;
};

export const sendNotification = async (mail: NotifyMail): Promise<{ ok: boolean }> => {
  const to = process.env.CONTACT_TO_EMAIL;
  const from = fanMomentsFrom();
  if (!process.env.RESEND_API_KEY || !to || !from) {
    console.error("[mail] 環境変数が未設定: RESEND_API_KEY / CONTACT_TO_EMAIL / CONTACT_FROM_EMAIL");
    return { ok: false };
  }
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      to,
      from,
      subject: mail.subject,
      text: mail.text,
      ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
    });
    if (error) {
      console.error("[mail] resend error:", error);
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.error("[mail] unexpected error:", err);
    return { ok: false };
  }
};
