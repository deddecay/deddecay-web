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

export const sendNotification = async (mail: NotifyMail): Promise<{ ok: boolean }> => {
  const to = process.env.CONTACT_TO_EMAIL;
  const from = process.env.FAN_MOMENTS_FROM_EMAIL || process.env.CONTACT_FROM_EMAIL;
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
