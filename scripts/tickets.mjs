#!/usr/bin/env node
// 12/6 フロアライブ チケット台帳の運用ツール（ローカルで手動実行する）。
//
// R2 の認証情報（R2_ACCOUNT_ID / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY）を環境変数で渡す。
// 例: Vercel から本番の値を一時ファイルに取り出して使い、終わったら消す
//   vercel env pull /tmp/dd-prod.env --environment=production
//   node --env-file=/tmp/dd-prod.env scripts/tickets.mjs list
//   rm /tmp/dd-prod.env
//
// 使い方:
//   node scripts/tickets.mjs list                       受付一覧と合計・残席
//   node scripts/tickets.mjs csv [出力ファイル]          CSV（Excel / Google スプレッドシートで開ける。既定: tickets-2026-12-06.csv）
//   node scripts/tickets.mjs cancel <受付ID>            取り消す内容を表示するだけ（変更しない）
//   node scripts/tickets.mjs cancel <受付ID> --yes      取り消して席を戻す
// オプション:
//   --stage production|preview|local   対象の台帳（既定 production）
//
// 申込者の個人情報を含むため、CSV は共有範囲に注意し、リポジトリに入れないこと（*.csv は .gitignore 済み）。

import { writeFileSync } from "node:fs";
import { R2Client, R2Error, loadR2Config } from "../src/lib/fan-upload/r2.ts";
import { cancelReservation, emptyLedger, ledgerKeyFor, parseLedger, summarize, toCsv } from "../src/lib/ticket/ledger.ts";
import { EVENT } from "../src/lib/ticket/event.ts";

const args = process.argv.slice(2);
const stageIndex = args.indexOf("--stage");
const stage = stageIndex >= 0 ? args[stageIndex + 1] : "production";
const positional = args.filter((a, i) => !a.startsWith("--") && !(stageIndex >= 0 && i === stageIndex + 1));
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
    const result = await cancelReservation(store, arg);
    if (result.status !== "cancelled") {
      console.error(`取り消せませんでした: ${result.status}`);
      process.exit(1);
    }
    const after = summarize((await store.read()).ledger, EVENT.capacity);
    console.log(`取り消しました。残席 ${after.remaining}（申込者への連絡は別途行ってください）`);
    break;
  }
  default:
    console.error("使い方: node scripts/tickets.mjs list | csv [file] | cancel <受付ID> [--yes]  [--stage production|preview|local]");
    process.exit(1);
}
