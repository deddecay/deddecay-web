import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// 投稿(post)ごとの署名トークン。init で発行し、complete で検証する。
// 内容: postId / 申告ファイル数 / 申告合計サイズ / 保存先プレフィックス / 期限。クライアントは改ざんできない。

export type PostTokenPayload = {
  pid: string;
  n: number;
  total: number;
  // 保存先の R2 プレフィックス（fan-moments/live/{liveId}/{postId} または fan-moments/other/{postId}）
  k?: string;
  exp: number; // epoch ms
};

const PREFIX_PATTERN = /^fan-moments\/(?:live\/[A-Za-z0-9_-]{1,64}\/|other\/)[A-Za-z0-9_-]{8,40}$/;

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const b64url = (buf: Buffer) => buf.toString("base64url");

const sign = (secret: string, body: string) =>
  b64url(createHmac("sha256", secret).update(body).digest());

export const newPostId = (): string => b64url(randomBytes(12));

export const issuePostToken = (
  secret: string,
  payload: Omit<PostTokenPayload, "exp">,
  now = Date.now()
): string => {
  const body = b64url(Buffer.from(JSON.stringify({ ...payload, exp: now + TOKEN_TTL_MS })));
  return `${body}.${sign(secret, body)}`;
};

export const verifyPostToken = (
  secret: string,
  token: unknown,
  now = Date.now()
): PostTokenPayload | null => {
  if (typeof token !== "string" || token.length > 1024) return null;
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(secret, body));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PostTokenPayload;
    if (
      typeof payload.pid !== "string" ||
      !/^[A-Za-z0-9_-]{8,40}$/.test(payload.pid) ||
      !Number.isInteger(payload.n) ||
      !Number.isFinite(payload.total) ||
      (payload.k !== undefined && (typeof payload.k !== "string" || !PREFIX_PATTERN.test(payload.k))) ||
      typeof payload.exp !== "number" ||
      payload.exp < now
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
};
