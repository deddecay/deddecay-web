// チケット受付一覧を Google スプレッドシートに写す（集計表）。
//
// 正本は R2 の台帳。スプレッドシートは「見るための写し」で、反映のたびに台帳の全件で丸ごと書き直す
// （キャンセルも反映される。表に直接書いたメモ・色は消える）。
// 本番・Preview・ローカルで別のスプレッドシートを使う（sheetKey で見分ける）。
// 反映に失敗しても受付・自動返信には影響させない（呼び出し側でログだけ残す）。

import { toCsv, type Ledger, type LedgerStore } from "./ledger.ts";

export type SheetDrive = {
  findSpreadsheets(sheetKey: string): Promise<{ id: string; createdTime: string }[]>;
  createSpreadsheetFromCsv(name: string, csv: string, sheetKey: string): Promise<string>;
  replaceSpreadsheetCsv(fileId: string, csv: string): Promise<void>;
  trash(fileId: string): Promise<void>;
};

export const sheetKeyFor = (eventId: string, stage: string | undefined): string =>
  `ticket:${eventId}:${stage ?? "local"}`;

export const sheetNameFor = (label: string, stage: string | undefined): string =>
  stage === "production" ? `deddecay ${label} 申し込み一覧` : `deddecay ${label} 申し込み一覧（${stage ?? "local"}）`;

export const sheetUrl = (id: string): string => `https://docs.google.com/spreadsheets/d/${id}/edit`;

// スプレッドシート取り込み用の CSV（BOM はセルに混ざるので外す）
export const sheetCsv = (ledger: Ledger, pricePerTicket: number): string =>
  toCsv(ledger, pricePerTicket).replace(/^﻿/, "");

// 1 つだけ残す。同時に初回反映が走って 2 つ作られた場合は、古い方を残して新しい方をゴミ箱へ
const ensureSheet = async (drive: SheetDrive, key: string, name: string, csv: string): Promise<{ id: string; created: boolean }> => {
  const found = await drive.findSpreadsheets(key);
  if (found.length > 0) return { id: found[0].id, created: false };
  const id = await drive.createSpreadsheetFromCsv(name, csv, key);
  const after = (await drive.findSpreadsheets(key)).sort((a, b) => a.createdTime.localeCompare(b.createdTime));
  const keep = after[0]?.id ?? id;
  for (const extra of after.slice(1)) await drive.trash(extra.id);
  return { id: keep, created: keep === id };
};

// 台帳を読んでスプレッドシートに反映する。反映中に台帳が変わったら（同時の申し込み）読み直してもう一度書く
export const syncSheet = async (
  drive: SheetDrive,
  store: Pick<LedgerStore, "read">,
  opts: { sheetKey: string; sheetName: string; pricePerTicket: number; maxRounds?: number }
): Promise<{ id: string; rows: number }> => {
  const maxRounds = opts.maxRounds ?? 3;
  let { ledger, etag } = await store.read();
  let id = "";
  for (let round = 0; round < maxRounds; round++) {
    const csv = sheetCsv(ledger, opts.pricePerTicket);
    if (!id) {
      const ensured = await ensureSheet(drive, opts.sheetKey, opts.sheetName, csv);
      id = ensured.id;
      if (!ensured.created) await drive.replaceSpreadsheetCsv(id, csv);
    } else {
      await drive.replaceSpreadsheetCsv(id, csv);
    }
    const latest = await store.read();
    if (latest.etag === etag) break;
    ({ ledger, etag } = latest);
  }
  return { id, rows: ledger.reservations.length };
};
