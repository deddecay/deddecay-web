import { getLiveById, formatLiveDate } from "../microcms";
import { sendNotification } from "../mail";
import { getR2Client } from "./r2";
import { consume } from "./ratelimit";
import { verifyTurnstile } from "./turnstile";
import { GIB } from "./policy";
import { readAllowedOrigins, readLimits, type Deps } from "./service";

// 本番用 Deps を環境変数から組み立てる。必須設定が欠けていれば null（API は 503 を返す）。
export const buildDeps = (): Deps | null => {
  const store = getR2Client();
  const secret = process.env.FAN_UPLOAD_SECRET;
  if (!store || !secret || secret.length < 32 || !process.env.TURNSTILE_SECRET_KEY) return null;

  const gb = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return (Number.isFinite(n) && n > 0 ? n : fallback) * GIB;
  };

  return {
    store,
    verifyTurnstile,
    consume,
    getLive: async (id) => {
      const entry = await getLiveById(id);
      if (!entry) return null;
      return {
        id: entry.id,
        title: entry.title,
        dateLabel: formatLiveDate(entry),
        eventAt: entry.eventDate ?? entry.publishedAt,
      };
    },
    sendMail: sendNotification,
    secret,
    allowedOrigins: readAllowedOrigins(),
    limits: readLimits(),
    appCapBytes: gb(process.env.FAN_UPLOAD_APP_CAP_GB, 50),
    dailyBytesPerIp: gb(process.env.FAN_UPLOAD_DAILY_GB_PER_IP, 20),
    now: Date.now,
  };
};
