// 固定窓の rate limit / 使用量カウンタ。
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN があれば Redis（インスタンス間で共有）、
// 無ければインスタンス内メモリ（ベストエフォート）で動く。

type Counter = { count: number; resetAt: number };

const memory = new Map<string, Counter>();

const consumeMemory = (key: string, amount: number, windowSec: number, now: number): number => {
  const current = memory.get(key);
  if (!current || current.resetAt <= now) {
    memory.set(key, { count: amount, resetAt: now + windowSec * 1000 });
    if (memory.size > 5000) {
      for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
    }
    return amount;
  }
  current.count += amount;
  return current.count;
};

const consumeRedis = async (
  url: string,
  token: string,
  key: string,
  amount: number,
  windowSec: number
): Promise<number> => {
  const res = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify([
      ["INCRBY", key, amount],
      ["EXPIRE", key, windowSec, "NX"],
    ]),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  const data = (await res.json()) as { result?: number }[];
  const count = data[0]?.result;
  if (typeof count !== "number") throw new Error("redis: unexpected response");
  return count;
};

export type RateResult = { allowed: boolean; count: number };

// amount を加算し、limit を超えたら allowed=false。超過分も加算済みのまま（連打を許さない）
export const consume = async (
  key: string,
  limit: number,
  windowSec: number,
  amount = 1
): Promise<RateResult> => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  let count: number;
  if (url && token) {
    try {
      count = await consumeRedis(url, token, `fanup:${key}`, amount, windowSec);
    } catch (err) {
      console.error("[fan-upload] redis rate limit error, falling back to memory:", err);
      count = consumeMemory(key, amount, windowSec, Date.now());
    }
  } else {
    count = consumeMemory(key, amount, windowSec, Date.now());
  }
  return { allowed: count <= limit, count };
};

export const clientIp = (req: Request): string => {
  const h = req.headers;
  const forwarded = h.get("x-vercel-forwarded-for") ?? h.get("x-real-ip") ?? h.get("x-forwarded-for") ?? "";
  return forwarded.split(",")[0]?.trim() || "unknown";
};

// テスト用
export const _resetMemoryForTest = () => memory.clear();
