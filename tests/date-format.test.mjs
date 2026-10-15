import test from "node:test";
import assert from "node:assert/strict";

// 実行環境が UTC（Vercel のサーバーと同じ）でも、日付は日本時間の暦日で表示されること
process.env.TZ = "UTC";

const { formatEntryDate, formatLiveDate } = await import("../src/lib/microcms.ts");

test("JST 0:00 の日時が前日にずれない（2026.07.19 のLIVE → 2026.07.19）", () => {
  // microCMS は ISO 8601（UTC）で返す。JST 2026-07-19 00:00 = UTC 2026-07-18T15:00:00Z
  assert.equal(formatEntryDate("2026-07-18T15:00:00.000Z"), "2026.07.19");
  // 比較用: タイムゾーン指定なしだと UTC の暦日になり、前日（07.18）になる（今回のバグの原因）
  assert.equal(
    new Date("2026-07-18T15:00:00.000Z").toLocaleDateString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" }),
    "2026/07/18"
  );
});

test("日付境界付近: JST の 0:00 直前・直後・9:00・23:59", () => {
  assert.equal(formatEntryDate("2026-07-18T14:59:59.999Z"), "2026.07.18"); // JST 07-18 23:59:59
  assert.equal(formatEntryDate("2026-07-18T15:00:00.000Z"), "2026.07.19"); // JST 07-19 00:00:00
  assert.equal(formatEntryDate("2026-07-19T00:00:00.000Z"), "2026.07.19"); // JST 07-19 09:00（UTC でも同日）
  assert.equal(formatEntryDate("2026-07-19T14:59:59.000Z"), "2026.07.19"); // JST 07-19 23:59:59
  assert.equal(formatEntryDate("2026-07-19T15:00:00.000Z"), "2026.07.20");
});

test("月・年をまたぐ境界と 1 桁の月日のゼロ埋め", () => {
  assert.equal(formatEntryDate("2026-12-31T15:00:00.000Z"), "2027.01.01"); // JST 2027-01-01 00:00
  assert.equal(formatEntryDate("2026-02-28T15:00:00.000Z"), "2026.03.01");
  assert.equal(formatEntryDate("2026-01-04T10:00:00.000Z"), "2026.01.04");
});

test("LIVE は eventDate（web画面表示日時）を使い、publishedAt（投稿・公開時刻）は使わない", () => {
  assert.equal(
    formatLiveDate({ eventDate: "2026-07-18T15:00:00.000Z", publishedAt: "2026-09-01T00:00:00.000Z" }),
    "2026.07.19"
  );
  // eventDate が無いときだけ publishedAt（既存仕様: eventDate ?? publishedAt）
  assert.equal(formatLiveDate({ publishedAt: "2026-09-01T15:00:00.000Z" }), "2026.09.02");
});

test("未設定・不正な値は空文字（Invalid Date を表示しない）", () => {
  assert.equal(formatEntryDate(undefined), "");
  assert.equal(formatEntryDate(""), "");
  assert.equal(formatEntryDate("not-a-date"), "");
});

test("NavMenu も共通の formatEntryDate を使う（独自の日付変換を持たない）", async () => {
  const { readFileSync } = await import("node:fs");
  const nav = readFileSync(new URL("../app/_components/NavMenu.tsx", import.meta.url), "utf8");
  assert.match(nav, /const formatDate = formatEntryDate/);
  assert.ok(!nav.includes("toLocaleDateString"));
});
