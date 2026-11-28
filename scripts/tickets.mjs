#!/usr/bin/env node
// 12/6 フロアライブ チケット台帳の運用ツール（ローカルで手動実行する）。
//
// R2 の認証情報（R2_ACCOUNT_ID / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY）を環境変数で渡す。
// 注意: vercel env pull では R2・Google の値は取り出せない（Sensitive のため空になる）。docs/ticket.md の「運用」を参照
//   node --env-file=/tmp/dd-prod.env scripts/tickets.mjs list
//
// 使い方:
//   node scripts/tickets.mjs list                       受付一覧と合計・残席
//   node scripts/tickets.mjs csv [出力ファイル]          CSV（Excel / Google スプレッドシートで開ける。既定: tickets-2026-12-06.csv）
//   node scripts/tickets.mjs cancel <受付ID>            取り消す内容を表示するだけ（変更しない）
//   node scripts/tickets.mjs cancel <受付ID> --yes      取り消して席を戻す。TICKET_OPS_SECRET があれば本番サーバーで行い、
//                                                      申込者へのキャンセルのお知らせ・運営通知・集計表の更新まで自動
//   node scripts/tickets.mjs notify-cancel <受付ID> --name 名前 --email アドレス --tickets 枚数 [--yes]
//                                                      取り消し済みの人にキャンセルのお知らせだけ送る（台帳は変更しない）
//   node scripts/tickets.mjs sheet                      集計表（Google スプレッドシート）を台帳の内容で更新し、URL を表示
// オプション:
//   --stage production|preview|local   対象の台帳（既定 production）
// 集計表の更新: 手元に GOOGLE_OAUTH_* があれば直接、無ければ TICKET_OPS_SECRET で本番サーバーの運用 API
//   （POST /api/tickets/2026-12-06/sync）に頼む。Preview なら TICKET_OPS_URL に Preview の URL を入れる
//
// 申込者の個人情報を含むため、CSV は共有範囲に注意し、リポジトリに入れないこと（*.csv は .gitignore 済み）。

import { writeFileSync } from "node:fs";
import { R2Client, R2Error, loadR2Config } from "../src/lib/fan-upload/r2.ts";
import { cancelReservation, emptyLedger, ledgerKeyFor, parseLedger, summarize, toCsv } from "../src/lib/ticket/ledger.ts";
import { EVENT } from "../src/lib/ticket/event.ts";
import { DriveClient, loadDriveConfig } from "../src/lib/fan-upload/drive.ts";
import { sheetKeyFor, sheetNameFor, sheetUrl, syncSheet } from "../src/lib/ticket/sheet.ts";

const args = process.argv.slice(2);
const stageIndex = args.indexOf("--stage");
const stage = stageIndex >= 0 ? args[stageIndex + 1] : "production";
// 値を取るオプション（--stage / --name / --email / --tickets）の値は位置引数に数えない
const VALUE_OPTS = new Set(["--stage", "--name", "--email", "--tickets"]);
const positional = args.filter((a, i) => !a.startsWith("--") && !VALUE_OPTS.has(args[i - 1]));
const [command, arg] = positional;

const config = loadR2Config();
if (!config) {
  console.error("R2 の環境変数が未設定です（R2_ACCOUNT_ID / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY）");
  process.exit(1);
}
const client = new R2Client(config);
const key = ledgerKeyFor(EVENT.id, stage);

const store = {
  async read() {
    const obj = await client.getObject(key);
    return obj ? { ledger: parseLedger(obj.text), etag: obj.etag } : { ledger: emptyLedger(), etag: null };
  },
  async write(ledger, etag) {
    try {
      await client.putObjectIf(key, JSON.stringify(ledger, null, 1), "application/json", etag ? { ifMatch: etag } : { ifNoneMatch: true });
      return true;
    } catch (err) {
      if (err instanceof R2Error && err.status === 412) return false;
      throw err;
    }
  },
};

// --name 値 のようなオプションの値
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// 本番サーバーの運用 API（Google 連携・メール送信は本番サーバーにしか無いため、そちらに頼む）。
// TICKET_OPS_SECRET（運用 API の合言葉）が必要。送り先は TICKET_OPS_URL、無ければ本番なら https://deddecay.tokyo
const opsBase = () => {
  const base = process.env.TICKET_OPS_URL ?? (stage === "production" ? "https://deddecay.tokyo" : "");
  return process.env.TICKET_OPS_SECRET && base ? base.replace(/\/$/, "") : "";
};

const callOps = async (path, body) => {
  const res = await fetch(`${opsBase()}/api/tickets/${EVENT.id}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TICKET_OPS_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    // 合言葉の不一致（またはサーバー側が未設定・未反映）も 404 になる
    console.error(`本番サーバーでの処理に失敗しました（${res.status}${data.error ? ` ${data.error}` : ""}）`);
    process.exit(1);
  }
  return data;
};

const reportCancel = (data) => {
  const r = data.reservation;
  if (data.cancelled) console.log(`取り消しました: ${r.name} <${r.email}> ${r.tickets}枚。残席 ${data.remaining}`);
  console.log(data.mailSent ? "申込者へキャンセルのお知らせを送りました" : "⚠ 申込者へのお知らせの送信に失敗しました。手動で連絡してください");
  if (!data.operatorMailSent) console.log("⚠ 運営への通知の送信に失敗しました");
  if (data.cancelled) {
    console.log(data.sheet ? `集計表を更新しました（${data.sheet.rows}件）: ${data.sheet.url}` : `⚠ 集計表を更新できませんでした（${data.sheetError}）`);
  }
};

const syncViaServer = async () => {
  if (!opsBase()) {
    console.log("（GOOGLE_OAUTH_* も TICKET_OPS_SECRET も未設定のため、集計表は更新していません）");
    return;
  }
  const data = await callOps("sync");
  console.log(`集計表を更新しました（${data.rows}件）: ${data.url}`);
};

// 集計表（Google スプレッドシート）へ反映する。手元に GOOGLE_OAUTH_* があれば直接、無ければ本番サーバー経由
const syncToSheet = async () => {
  const driveConfig = loadDriveConfig();
  if (!driveConfig) {
    await syncViaServer();
    return;
  }
  const r = await syncSheet(new DriveClient(driveConfig), store, {
    sheetKey: sheetKeyFor(EVENT.id, stage),
    sheetName: sheetNameFor(EVENT.shortLabel, stage),
    pricePerTicket: EVENT.pricePerTicket,
  });
  console.log(`集計表を更新しました（${r.rows}件）: ${sheetUrl(r.id)}`);
};

const jst = (iso) => new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

console.error(`台帳: ${key}`);
const { ledger } = await store.read();
const sum = summarize(ledger, EVENT.capacity);

switch (command) {
  case "list": {
    for (const r of ledger.reservations) {
      console.log(`${jst(r.createdAt)}\t${r.tickets}枚\t${r.name}\t${r.email}\t${r.id}`);
    }
    console.log(`\n受付 ${ledger.reservations.length}件 / ${sum.reserved}枚（定員 ${sum.capacity}・残席 ${sum.remaining}）`);
    break;
  }
  case "csv": {
    const out = arg ?? `tickets-${EVENT.id}${stage === "production" ? "" : `-${stage}`}.csv`;
    writeFileSync(out, toCsv(ledger, EVENT.pricePerTicket), { mode: 0o600 });
    console.log(`${out} に ${ledger.reservations.length}件を書き出しました（${sum.reserved}枚・残席 ${sum.remaining}）`);
    break;
  }
  case "cancel": {
    if (!arg) {
      console.error("受付ID を指定してください（list で確認できます）");
      process.exit(1);
    }
    const target = ledger.reservations.find((r) => r.id === arg);
    if (!target) {
      console.error(`受付ID ${arg} は見つかりません`);
      process.exit(1);
    }
    console.log(`対象: ${jst(target.createdAt)} ${target.name} <${target.email}> ${target.tickets}枚`);
    if (!args.includes("--yes")) {
      console.log("確認のみ（変更していません）。取り消すには --yes を付けて再実行してください");
      break;
    }
    // 合言葉があれば本番サーバーで取り消す（取り消し・申込者へのお知らせ・運営通知・集計表をまとめて行う）
    if (opsBase()) {
      const data = await callOps("cancel", { id: arg });
      reportCancel(data);
      break;
    }
    const result = await cancelReservation(store, arg);
    if (result.status !== "cancelled") {
      console.error(`取り消せませんでした: ${result.status}`);
      process.exit(1);
    }
    const after = summarize((await store.read()).ledger, EVENT.capacity);
    console.log(`取り消しました。残席 ${after.remaining}（TICKET_OPS_SECRET が無いため、申込者への連絡は別途行ってください）`);
    await syncToSheet();
    break;
  }
  // 運用 API ができる前に取り消した人へ、キャンセルのお知らせだけを送る（台帳は変更しない）
  case "notify-cancel": {
    const name = opt("--name");
    const email = opt("--email");
    const tickets = Number(opt("--tickets"));
    if (!arg || !name || !email || !tickets) {
      console.error("使い方: node scripts/tickets.mjs notify-cancel <受付ID> --name 名前 --email アドレス --tickets 枚数 [--yes]");
      process.exit(1);
    }
    if (ledger.reservations.some((r) => r.id === arg)) {
      console.error(`受付ID ${arg} はまだ台帳にあります。取り消すなら cancel を使ってください`);
      process.exit(1);
    }
    console.log(`送信先: ${name} <${email}> ${tickets}枚（キャンセルのお知らせ）`);
    if (!args.includes("--yes")) {
      console.log("確認のみ（送信していません）。送るには --yes を付けて再実行してください");
      break;
    }
    if (!opsBase()) {
      console.error("TICKET_OPS_SECRET が未設定です");
      process.exit(1);
    }
    reportCancel(await callOps("cancel", { id: arg, notifyOnly: { name, email, tickets } }));
    break;
  }
  case "sheet": {
    await syncToSheet();
    break;
  }
  default:
    console.error(
      "使い方: node scripts/tickets.mjs list | csv [file] | sheet | cancel <受付ID> [--yes] | notify-cancel <受付ID> --name --email --tickets [--yes]  [--stage production|preview|local]"
    );
    process.exit(1);
}
