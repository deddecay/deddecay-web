import test from "node:test";
import assert from "node:assert/strict";

import {
  reserve,
  summarize,
  parseApplication,
  createMemoryStore,
  emptyLedger,
  cancelReservation,
  toCsv,
  ledgerKeyFor,
} from "../src/lib/ticket/ledger.ts";
import { ticketEnabled, ticketPublic, ticketLiveId } from "../src/lib/ticket/flags.ts";
import { buildApplicantMail, buildOperatorMail, ticketFrom } from "../src/lib/ticket/mail.ts";
import { EVENT, totalPrice, formatYen } from "../src/lib/ticket/event.ts";

const OPTS = { capacity: 50, maxPerOrder: 5, now: () => new Date("2026-11-22T00:00:00Z") };
const rid = (n) => `req-${String(n).padStart(16, "0")}`;
const app = (n, tickets, email = `user${n}@example.com`) => ({
  requestId: rid(n),
  name: `申込者${n}`,
  email,
  tickets,
});

// ── flags ─────────────────────────────────────────────

test("flags: 未設定なら無効・非公開。'1' 以外は無効", () => {
  assert.equal(ticketEnabled({}), false);
  assert.equal(ticketPublic({}), false);
  assert.equal(ticketEnabled({ TICKET_1206_ENABLED: "true" }), false);
  assert.equal(ticketEnabled({ TICKET_1206_ENABLED: "1" }), true);
  // PUBLIC だけでは公開しない（ENABLED も必要）
  assert.equal(ticketPublic({ TICKET_1206_PUBLIC: "1" }), false);
  assert.equal(ticketPublic({ TICKET_1206_ENABLED: "1", TICKET_1206_PUBLIC: "1" }), true);
  assert.equal(ticketLiveId({ TICKET_1206_LIVE_ID: " abc123 " }), "abc123");
  assert.equal(ticketLiveId({}), null);
});

// ── event ─────────────────────────────────────────────

test("event: 料金と合計", () => {
  assert.equal(EVENT.pricePerTicket, 2000);
  assert.equal(totalPrice(3), 6000);
  assert.equal(formatYen(10000), "10,000円");
});

// ── parseApplication ──────────────────────────────────

test("parseApplication: 正常系は整形して返す", () => {
  const r = parseApplication({ requestId: rid(1), name: "  山田 太郎 ", email: " Taro@Example.com ", tickets: "2" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { requestId: rid(1), name: "山田 太郎", email: "Taro@Example.com", tickets: 2 });
});

test("parseApplication: 不正な入力を拒否する", () => {
  const base = { requestId: rid(1), name: "a", email: "a@b.cc", tickets: 1 };
  assert.equal(parseApplication(null).ok, false);
  assert.equal(parseApplication({ ...base, name: "  " }).ok, false);
  assert.equal(parseApplication({ ...base, name: "x".repeat(101) }).ok, false);
  assert.equal(parseApplication({ ...base, name: "a\u0000b" }).ok, false);
  assert.equal(parseApplication({ ...base, email: "aaa@bbb" }).ok, false);
  assert.equal(parseApplication({ ...base, tickets: 0 }).ok, false);
  assert.equal(parseApplication({ ...base, tickets: 6 }).ok, false);
  assert.equal(parseApplication({ ...base, tickets: 1.5 }).ok, false);
  assert.equal(parseApplication({ ...base, requestId: "short" }).ok, false);
});

// ── reserve ───────────────────────────────────────────

test("reserve: 受付して残席を減らす", async () => {
  const store = createMemoryStore();
  const r = await reserve(store, app(1, 3), OPTS);
  assert.equal(r.status, "accepted");
  assert.equal(r.reservation.tickets, 3);
  assert.equal(r.remaining, 47);
  const { ledger } = await store.read();
  assert.equal(summarize(ledger, 50).reserved, 3);
});

test("reserve: 50 枚ちょうどで締め切り、以降は sold_out", async () => {
  const store = createMemoryStore();
  for (let i = 0; i < 10; i++) {
    const r = await reserve(store, app(i, 5), OPTS);
    assert.equal(r.status, "accepted");
  }
  const r = await reserve(store, app(99, 1), OPTS);
  assert.equal(r.status, "sold_out");
  assert.equal(summarize((await store.read()).ledger, 50).remaining, 0);
});

test("reserve: 残席より多い枚数は insufficient（残席を返す）", async () => {
  const store = createMemoryStore();
  for (let i = 0; i < 9; i++) await reserve(store, app(i, 5), OPTS); // 45
  await reserve(store, app(50, 3), OPTS); // 48
  const r = await reserve(store, app(51, 3), OPTS);
  assert.equal(r.status, "insufficient");
  assert.equal(r.remaining, 2);
  assert.equal((await reserve(store, app(52, 2), OPTS)).status, "accepted");
});

test("reserve: 同じ requestId の再送は二重に受け付けない（replayed）", async () => {
  const store = createMemoryStore();
  const first = await reserve(store, app(1, 2), OPTS);
  const again = await reserve(store, app(1, 2), OPTS);
  assert.equal(first.status, "accepted");
  assert.equal(again.status, "replayed");
  assert.equal(again.reservation.id, first.reservation.id);
  assert.equal(summarize((await store.read()).ledger, 50).reserved, 2);
});

test("reserve: 同じメールアドレス（大文字小文字違い含む）は duplicate_email", async () => {
  const store = createMemoryStore();
  await reserve(store, app(1, 1, "Same@Example.com"), OPTS);
  const r = await reserve(store, app(2, 1, " same@example.COM"), OPTS);
  assert.equal(r.status, "duplicate_email");
  assert.equal(summarize((await store.read()).ledger, 50).reserved, 1);
});

test("reserve: 同時申し込みでも定員を超えない（条件付き書き込みの競合をやり直す）", async () => {
  const store = createMemoryStore({ latencyMs: 2 });
  // 60 件 × 1 枚を同時に送る → ちょうど 50 件だけ受け付ける
  const results = await Promise.all(
    Array.from({ length: 60 }, (_, i) => reserve(store, app(i, 1), { ...OPTS, maxAttempts: 200 }))
  );
  const accepted = results.filter((r) => r.status === "accepted").length;
  const soldOut = results.filter((r) => r.status === "sold_out").length;
  assert.equal(accepted, 50);
  assert.equal(soldOut, 10);
  const { ledger } = await store.read();
  assert.equal(summarize(ledger, 50).reserved, 50);
  assert.equal(ledger.reservations.length, 50);
});

test("reserve: 同じ requestId を同時に送っても 1 件だけ", async () => {
  const store = createMemoryStore({ latencyMs: 2 });
  const results = await Promise.all(Array.from({ length: 5 }, () => reserve(store, app(7, 4), { ...OPTS, maxAttempts: 50 })));
  assert.equal(results.filter((r) => r.status === "accepted").length, 1);
  assert.equal(results.filter((r) => r.status === "replayed").length, 4);
  assert.equal(summarize((await store.read()).ledger, 50).reserved, 4);
});

test("reserve: 競合が続けば conflict を返す（無限に回らない）", async () => {
  const store = {
    read: async () => ({ ledger: emptyLedger(), etag: "e1" }),
    write: async () => false,
  };
  const r = await reserve(store, app(1, 1), { ...OPTS, maxAttempts: 3 });
  assert.equal(r.status, "conflict");
});

// ── mail ──────────────────────────────────────────────

const reservation = {
  id: "r1",
  requestId: rid(1),
  name: "山田 <太郎>",
  email: "taro@example.com",
  tickets: 2,
  createdAt: "2026-11-22T00:00:00.000Z",
};

test("mail: 自動返信は件名・順序・金額・会場・注意事項を含む", () => {
  const venue = { address: "東京都世田谷区テスト1-2-3", accessUrl: "https://www.dropbox.com/scl/fi/abc/video.mp4?rlkey=xyz&dl=0" };
  const mail = buildApplicantMail(reservation, venue);
  assert.equal(mail.subject, "【deddecay】12月6日 フロアライブ チケット申し込み受付完了");
  const t = mail.text;
  const order = ["公演情報", "2026年12月6日（日）", "2,000円／名（ドリンク込み）", "申し込み内容", "山田 <太郎>", "2枚", "4,000円", "会場案内", "東京都世田谷区テスト1-2-3", "会場までの行き方", "備考・注意事項", "チケット料金は当日、会場にてお支払いください。", "現金", "チケット関連"];
  let pos = -1;
  for (const s of order) {
    const at = t.indexOf(s, pos + 1);
    assert.ok(at > pos, `順序: ${s}`);
    pos = at;
  }
  // HTML 版: URL はリンクテキスト「会場までの行き方」として出し、名前はエスケープする
  assert.match(mail.html, /<a href="https:\/\/www\.dropbox\.com\/scl\/fi\/abc\/video\.mp4\?rlkey=xyz&amp;dl=0">会場までの行き方<\/a>/);
  assert.ok(mail.html.includes("山田 &lt;太郎&gt;"));
  assert.ok(!mail.html.includes("<太郎>"));
});

test("mail: 会場情報が未設定なら『後日ご案内』とし、リンクを出さない", () => {
  const mail = buildApplicantMail(reservation, { address: "", accessUrl: "" });
  assert.ok(mail.text.includes("後日"));
  assert.ok(!mail.html.includes("<a href"));
});

test("mail: http(s) 以外の URL はリンクにしない", () => {
  const mail = buildApplicantMail(reservation, { address: "x", accessUrl: "javascript:alert(1)" });
  assert.ok(!mail.html.includes("javascript:"));
});

test("mail: 運営通知は申込内容と残席、自動返信の失敗を含む", () => {
  const m = buildOperatorMail(reservation, { reserved: 10, remaining: 40, capacity: 50 }, { applicantMailOk: false });
  assert.match(m.subject, /12\/6/);
  assert.ok(m.text.includes("taro@example.com"));
  assert.ok(m.text.includes("残席: 40"));
  assert.ok(m.text.includes("自動返信の送信に失敗"));
  assert.equal(m.replyTo, "taro@example.com");
});

// ── 運用（キャンセル・CSV・保存先） ───────────────────────

test("cancelReservation: 受付 ID で取り消すと席が戻る。無い ID は not_found", async () => {
  const store = createMemoryStore();
  const a = await reserve(store, app(1, 5), OPTS);
  await reserve(store, app(2, 2), OPTS);
  assert.equal((await cancelReservation(store, "nope")).status, "not_found");
  const r = await cancelReservation(store, a.reservation.id);
  assert.equal(r.status, "cancelled");
  assert.equal(r.reservation.email, "user1@example.com");
  assert.equal(summarize((await store.read()).ledger, 50).reserved, 2);
  // 取り消した人は同じメールで申し込み直せる
  assert.equal((await reserve(store, app(3, 1, "user1@example.com"), OPTS)).status, "accepted");
});

test("toCsv: Excel/スプレッドシート向け（BOM・ヘッダ・JST・エスケープ）", () => {
  const ledger = {
    version: 1,
    reservations: [
      { id: "id1", requestId: rid(1), name: '山田 "太郎", Jr', email: "a@b.cc", tickets: 2, createdAt: "2026-11-22T15:30:00.000Z" },
    ],
  };
  const csv = toCsv(ledger);
  assert.ok(csv.startsWith("﻿"));
  const lines = csv.slice(1).trim().split("\r\n");
  assert.equal(lines[0], "受付日時,お名前,メールアドレス,枚数,合計金額,受付ID");
  assert.equal(lines[1], '2026/11/23 0:30:00,"山田 ""太郎"", Jr",a@b.cc,2,4000,id1');
});

test("toCsv: 先頭が = + - @ のセルは数式として解釈されないようにする", () => {
  const ledger = { version: 1, reservations: [{ id: "x", requestId: rid(1), name: "=HYPERLINK(1)", email: "a@b.cc", tickets: 1, createdAt: "2026-11-22T00:00:00.000Z" }] };
  assert.ok(toCsv(ledger).includes(",'=HYPERLINK(1),"));
});

test("ledgerKeyFor: 本番と Preview・ローカルで台帳を分ける", () => {
  assert.equal(ledgerKeyFor("2026-12-06", "production"), "tickets/2026-12-06/ledger.json");
  assert.equal(ledgerKeyFor("2026-12-06", "preview"), "tickets/2026-12-06/ledger-preview.json");
  assert.equal(ledgerKeyFor("2026-12-06", undefined), "tickets/2026-12-06/ledger-local.json");
});

test("mail: 送信元は TICKET_FROM_EMAIL、無ければ CONTACT_FROM_EMAIL のアドレスに表示名 deddecay", () => {
  assert.equal(ticketFrom({ TICKET_FROM_EMAIL: "X <x@d.tokyo>" }), "X <x@d.tokyo>");
  assert.equal(ticketFrom({ CONTACT_FROM_EMAIL: "Contact <noreply@d.tokyo>" }), "deddecay <noreply@d.tokyo>");
  assert.equal(ticketFrom({ CONTACT_FROM_EMAIL: "noreply@d.tokyo" }), "deddecay <noreply@d.tokyo>");
  assert.equal(ticketFrom({}), "");
});
