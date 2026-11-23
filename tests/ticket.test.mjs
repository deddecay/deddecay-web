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
import { buildApplicantMail, buildOperatorMail, ticketFrom, parseSteps } from "../src/lib/ticket/mail.ts";
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

// ── sheet（集計表） ───────────────────────────────────

import { syncSheet, sheetKeyFor, sheetNameFor, sheetCsv } from "../src/lib/ticket/sheet.ts";

const fakeDrive = () => {
  const files = new Map(); // id -> { csv, key, createdTime }
  let n = 0;
  const calls = [];
  return {
    files,
    calls,
    async findSpreadsheets(key) {
      return [...files].filter(([, f]) => f.key === key).map(([id, f]) => ({ id, createdTime: f.createdTime }));
    },
    async createSpreadsheetFromCsv(name, csv, key) {
      const id = `s${++n}`;
      files.set(id, { csv, key, name, createdTime: `2026-11-22T00:00:0${n}Z` });
      calls.push(["create", id]);
      return id;
    },
    async replaceSpreadsheetCsv(id, csv) {
      files.get(id).csv = csv;
      calls.push(["replace", id]);
    },
    async trash(id) {
      files.delete(id);
      calls.push(["trash", id]);
    },
  };
};

const SHEET_OPTS = { sheetKey: sheetKeyFor("2026-12-06", "preview"), sheetName: "x", pricePerTicket: 2000 };

test("sheet: 初回は作成、2 回目以降は同じ表を書き直す（キャンセルも反映）", async () => {
  const store = createMemoryStore();
  const drive = fakeDrive();
  const a = await reserve(store, app(1, 2), OPTS);
  const first = await syncSheet(drive, store, SHEET_OPTS);
  assert.equal(drive.files.size, 1);
  assert.equal(first.rows, 1);
  await reserve(store, app(2, 3), OPTS);
  const second = await syncSheet(drive, store, SHEET_OPTS);
  assert.equal(second.id, first.id);
  assert.equal(drive.files.size, 1);
  assert.equal(drive.files.get(first.id).csv.trim().split("\r\n").length, 3);
  await cancelReservation(store, a.reservation.id);
  await syncSheet(drive, store, SHEET_OPTS);
  const csv = drive.files.get(first.id).csv;
  assert.ok(!csv.includes("user1@example.com"));
  assert.ok(csv.includes("user2@example.com"));
  assert.ok(!csv.startsWith("﻿"));
});

test("sheet: 同時の初回反映で 2 つできたら古い方だけ残す", async () => {
  const store = createMemoryStore();
  const drive = fakeDrive();
  await reserve(store, app(1, 1), OPTS);
  const [x, y] = await Promise.all([syncSheet(drive, store, SHEET_OPTS), syncSheet(drive, store, SHEET_OPTS)]);
  assert.equal(drive.files.size, 1);
  assert.equal(x.id, y.id);
  assert.equal(x.id, "s1");
});

test("sheet: 反映中に台帳が変わったら読み直して書き直す", async () => {
  const store = createMemoryStore();
  const drive = fakeDrive();
  await reserve(store, app(1, 1), OPTS);
  let injected = false;
  const racing = {
    ...drive,
    async replaceSpreadsheetCsv(id, csv) {
      await drive.replaceSpreadsheetCsv(id, csv);
      if (!injected) { injected = true; await reserve(store, app(2, 1), OPTS); }
    },
    async createSpreadsheetFromCsv(name, csv, key) {
      const id = await drive.createSpreadsheetFromCsv(name, csv, key);
      if (!injected) { injected = true; await reserve(store, app(2, 1), OPTS); }
      return id;
    },
  };
  const r = await syncSheet(racing, store, SHEET_OPTS);
  assert.equal(r.rows, 2);
  assert.ok(drive.files.get(r.id).csv.includes("user2@example.com"));
});

test("sheet: 環境ごとに別の表・名前", () => {
  assert.equal(sheetKeyFor("2026-12-06", "production"), "ticket:2026-12-06:production");
  assert.notEqual(sheetKeyFor("2026-12-06", "preview"), sheetKeyFor("2026-12-06", "production"));
  assert.ok(!sheetNameFor("12/6", "production").includes("（"));
  assert.ok(sheetNameFor("12/6", "preview").includes("（preview）"));
  assert.equal(sheetCsv({ version: 1, reservations: [] }, 2000).split("\r\n")[0], "受付日時,お名前,メールアドレス,枚数,合計金額,受付ID");
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
  const order = ["公演情報", "2026年12月6日（日）", "2,000円／名（ドリンク込み）", "申し込み内容", "山田 <太郎>", "2枚", "4,000円", "会場案内", "東京都世田谷区テスト1-2-3", "会場への行き方（動画あり）", "備考・注意事項", "チケット料金は当日、会場にてお支払いください。", "現金", "チケット関連", "ビル前でのたむろ"];
  let pos = -1;
  for (const s of order) {
    const at = t.indexOf(s, pos + 1);
    assert.ok(at > pos, `順序: ${s}`);
    pos = at;
  }
  // HTML 版: URL はリンクテキスト「会場への行き方（動画あり）」として出し、名前はエスケープする
  assert.match(mail.html, /<a href="https:\/\/www\.dropbox\.com\/scl\/fi\/abc\/video\.mp4\?rlkey=xyz&amp;dl=0">会場への行き方（動画あり）<\/a>/);
  assert.ok(!mail.html.replace(/href="[^"]*"/g, "").includes("dropbox.com"), "URL を本文に表示しない");
  assert.ok(mail.html.includes("山田 &lt;太郎&gt;"));
  assert.ok(!mail.html.includes("<太郎>"));
});

test("mail: 行き方のリンク直下に番号付きの道順を出す（番号は付け直す）", () => {
  const steps = ["1. 駅の南口を出て右へ", "道路に出たら<左折>", "", "  3. 4階までお越しください  "];
  const mail = buildApplicantMail(reservation, { address: "x", accessUrl: "https://www.dropbox.com/v", steps });
  // HTML: リンクのすぐ後に <ol>、元の番号は外して付け直す・エスケープする
  assert.match(mail.html, /会場への行き方（動画あり）<\/a><\/div>\s*<ol[^>]*>\s*<li>駅の南口を出て右へ<\/li>\s*<li>道路に出たら&lt;左折&gt;<\/li>\s*<li>4階までお越しください<\/li>\s*<\/ol>/);
  // テキスト: 1. 2. 3. と番号を振り直す
  const t = mail.text;
  const a = t.indexOf("会場への行き方（動画あり）");
  assert.ok(a >= 0 && a < t.indexOf("1. 駅の南口を出て右へ"));
  assert.ok(t.indexOf("1. 駅の南口を出て右へ") < t.indexOf("2. 道路に出たら<左折>"));
  assert.ok(t.indexOf("2. 道路に出たら<左折>") < t.indexOf("3. 4階までお越しください"));
  assert.ok(t.indexOf("3. 4階までお越しください") < t.indexOf("備考・注意事項"));
});

test("mail: 会場住所の下に 1 行あけて行き方を続ける", () => {
  const mail = buildApplicantMail(reservation, { address: "東京都テスト1-2-3", accessUrl: "https://www.dropbox.com/v" });
  assert.match(mail.text, /・会場住所：東京都テスト1-2-3\n\n・会場への行き方（動画あり）/);
  assert.match(mail.html, /<div>会場住所：東京都テスト1-2-3<\/div>\n<br>\n<div><a href/);
});

test("mail: 道順が無ければ一覧を出さない", () => {
  const mail = buildApplicantMail(reservation, { address: "x", accessUrl: "https://www.dropbox.com/v" });
  assert.ok(!mail.html.includes("<ol"));
});

test("mail: 注意事項は既存の文言を残して、たむろ・滞留の注意を最後に追加", () => {
  const mail = buildApplicantMail(reservation, { address: "x", accessUrl: "" });
  const t = mail.text;
  const notes = [
    "チケット料金は当日、会場にてお支払いください。",
    "お支払いは原則として現金でお願いいたします。",
    "本公演に関するキャンセル、お問い合わせは、公式サイトCONTACTの『チケット関連』よりご連絡ください。",
    "当日は他のスタジオ利用者様もいらっしゃいますので、ビル前でのたむろや長時間の滞留はご遠慮ください。皆様のご理解とご協力をお願いいたします。",
  ];
  let pos = t.indexOf("備考・注意事項");
  for (const n of notes) {
    const at = t.indexOf(n, pos + 1);
    assert.ok(at > pos, `注意事項: ${n.slice(0, 12)}`);
    pos = at;
  }
});

test("readSteps: 環境変数の改行区切りを道順にする（空行・前後空白・元の番号を除く）", () => {
  assert.deepEqual(parseSteps("1. A\r\n\n2.  B \n3、C\n（4）D\nE"), ["A", "B", "C", "D", "E"]);
  assert.deepEqual(parseSteps(""), []);
  assert.deepEqual(parseSteps(undefined), []);
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
