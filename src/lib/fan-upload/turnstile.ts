// Cloudflare Turnstile のサーバー側検証。トークンは単発使用なので init の 1 回だけ検証する。

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export const verifyTurnstile = async (token: unknown, remoteIp?: string): Promise<boolean> => {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.error("[fan-upload] TURNSTILE_SECRET_KEY が未設定です");
    return false;
  }
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) return false;

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);

  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    console.error("[fan-upload] turnstile verify error:", err);
    return false;
  }
};
