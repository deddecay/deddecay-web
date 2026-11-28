// チケット申し込みの自動返信（申込者宛て）と運営通知のメール本文。
// 会場の正確な住所・アクセス動画 URL はこのメールにだけ載せる（画面・API・クライアントのコードには出さない）。

import { EVENT, formatYen, totalPrice } from "./event.ts";
import type { Reservation } from "./ledger.ts";

// steps: 会場までの道順（番号なしの文の並び）。会場が特定できる内容なので、コードには書かず環境変数から読む
export type Venue = { address: string; accessUrl: string; steps?: string[] };

// 環境変数（改行区切り）を道順にする。空行・前後の空白・行頭の番号（「1.」「2、」「（3）」など）は外す
export const parseSteps = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:\d+\s*[.、．)）]|[（(]\d+[)）])\s*/, "").trim())
    .filter((line) => line !== "");

export type Mail = { subject: string; text: string; html: string; replyTo?: string };

export const APPLICANT_SUBJECT = `【deddecay】${EVENT.shortLabel} チケット申し込み受付完了`;

const PAYMENT_NOTES = [
  "チケット料金は当日、会場にてお支払いください。",
  "お支払いは原則として現金でお願いいたします。クレジットカード・PayPayもご利用いただけますが、可能な限り現金でのお支払いにご協力ください。",
  "本公演に関するキャンセル、お問い合わせは、公式サイトCONTACTの『チケット関連』よりご連絡ください。",
  "当日は他のスタジオ利用者様もいらっしゃいますので、ビル前でのたむろや長時間の滞留はご遠慮ください。皆様のご理解とご協力をお願いいたします。",
];

const ACCESS_LABEL = "会場への行き方（動画あり）";

const PENDING = "後日、改めてご案内いたします";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const safeUrl = (url: string): string | null => {
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
};

type Line = { label: string; value: string; href?: string | null; steps?: string[]; blankAfter?: boolean };
type Section = { heading: string; lines: Line[] } | { heading: string; notes: string[] };

const render = (intro: string[], sections: Section[], outro: string[]) => {
  const text: string[] = [...intro, ""];
  const html: string[] = [`<div style="font-family:sans-serif;font-size:14px;line-height:1.7;color:#111">`];
  html.push(...intro.map((p) => `<p style="margin:0 0 4px">${escapeHtml(p)}</p>`));
  for (const s of sections) {
    text.push(`■ ${s.heading}`);
    html.push(`<h3 style="font-size:14px;margin:20px 0 6px">■ ${escapeHtml(s.heading)}</h3>`);
    if ("lines" in s) {
      for (const l of s.lines) {
        // テキスト版は URL をそのまま出す（テキストのみのメールソフト向け）。HTML 版はリンクテキストにする
        text.push(l.href ? `・${l.label}：${l.href}` : `・${l.label}：${l.value}`);
        html.push(
          l.href
            ? `<div><a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a></div>`
            : `<div>${escapeHtml(l.label)}：${escapeHtml(l.value)}</div>`
        );
        // 道順（リンクの直下に番号付きで）
        if (l.steps && l.steps.length > 0) {
          l.steps.forEach((step, i) => text.push(`　${i + 1}. ${step}`));
          html.push(
            `<ol style="margin:4px 0 0;padding-left:1.6em">\n${l.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("\n")}\n</ol>`
          );
        }
        // 次の行との間を 1 行あける
        if (l.blankAfter) {
          text.push("");
          html.push("<br>");
        }
      }
    } else {
      for (const n of s.notes) {
        text.push(`・${n}`);
        html.push(`<div>・${escapeHtml(n)}</div>`);
      }
    }
    text.push("");
  }
  text.push(...outro);
  html.push(`<p style="margin:20px 0 0">${outro.map(escapeHtml).join("<br>")}</p></div>`);
  return { text: text.join("\n"), html: html.join("\n") };
};

export const buildApplicantMail = (r: Reservation, venue: Venue): Mail => {
  const address = venue.address.trim();
  const accessUrl = safeUrl(venue.accessUrl);
  const steps = parseSteps((venue.steps ?? []).join("\n"));
  const { text, html } = render(
    [
      `${r.name} 様`,
      "",
      `このたびは deddecay ${EVENT.shortLabel}のチケットをお申し込みいただき、誠にありがとうございます。`,
      "以下の内容でお申し込みを受け付けました。",
    ],
    [
      {
        heading: "公演情報",
        lines: [
          { label: "公演タイトル", value: EVENT.title },
          { label: "開催日", value: EVENT.dateLabel },
          { label: "OPEN", value: EVENT.open },
          { label: "START", value: EVENT.start },
          { label: "チケット料金", value: EVENT.priceLabel },
        ],
      },
      {
        heading: "申し込み内容",
        lines: [
          { label: "お名前", value: r.name },
          { label: "メールアドレス", value: r.email },
          { label: "チケット枚数", value: `${r.tickets}枚` },
          { label: "合計金額", value: formatYen(totalPrice(r.tickets)) },
        ],
      },
      {
        heading: "会場案内",
        lines: [
          { label: "会場住所", value: address || PENDING, blankAfter: true },
          accessUrl
            ? { label: ACCESS_LABEL, value: "", href: accessUrl, steps }
            : { label: ACCESS_LABEL, value: steps.length ? "" : PENDING, steps },
        ],
      },
      { heading: "備考・注意事項", notes: PAYMENT_NOTES },
    ],
    ["当日お会いできるのを楽しみにしております。", "", "deddecay", "https://deddecay.tokyo"]
  );
  return { subject: APPLICANT_SUBJECT, text, html };
};

export const buildOperatorMail = (
  r: Reservation,
  summary: { reserved: number; remaining: number; capacity: number },
  status: { applicantMailOk: boolean }
): Mail => {
  const lines = [
    ...(status.applicantMailOk
      ? [`✓ 申込者（${r.email}）へ自動返信を送信しました。`, ""]
      : ["⚠ 申込者への自動返信の送信に失敗しました。会場案内を手動で送ってください。", ""]),
    `お名前: ${r.name}`,
    `メールアドレス: ${r.email}`,
    `チケット枚数: ${r.tickets}枚`,
    `合計金額: ${formatYen(totalPrice(r.tickets))}`,
    `受付日時: ${new Date(r.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`,
    `受付ID: ${r.id}`,
    "",
    `受付済み: ${summary.reserved} / ${summary.capacity}枚`,
    `残席: ${summary.remaining}`,
  ];
  const text = lines.join("\n");
  return {
    subject: `[TICKET 12/6] ${r.name} 様 ${r.tickets}枚（残席 ${summary.remaining}）`,
    text,
    html: `<pre style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
    replyTo: r.email,
  };
};

// ── キャンセル ─────────────────────────────────────────

export const CANCEL_SUBJECT = `【deddecay】${EVENT.shortLabel} チケットキャンセル受付完了`;

// 一部キャンセルのときの内訳。cancelled 枚を取り消し、kept 枚が残る（kept=0 なら全部キャンセル）
export type CancelChange = { cancelled: number; kept: number };

const fullChange = (r: Reservation): CancelChange => ({ cancelled: r.tickets, kept: 0 });

// 申込者宛て：キャンセルを承った連絡（会場情報は載せない）。r はキャンセル前の予約
export const buildCancelMail = (r: Reservation, change: CancelChange = fullChange(r)): Mail => {
  const partial = change.kept > 0;
  const { text, html } = render(
    [
      `${r.name} 様`,
      "",
      `deddecay ${EVENT.shortLabel}のチケットについて、以下の内容で${partial ? "一部" : ""}キャンセルを承りました。`,
    ],
    [
      {
        heading: "キャンセル内容",
        lines: [
          { label: "公演タイトル", value: EVENT.title },
          { label: "開催日", value: EVENT.dateLabel },
          { label: "お名前", value: r.name },
          { label: "キャンセル枚数", value: `${change.cancelled}枚` },
          ...(partial
            ? [
                { label: "変更後の枚数", value: `${change.kept}枚` },
                { label: "変更後の合計金額", value: `${formatYen(totalPrice(change.kept))}（当日、会場にてお支払いください）` },
              ]
            : [{ label: "金額", value: `${formatYen(totalPrice(change.cancelled))}（当日払いのため、お支払いは発生しません）` }]),
        ],
      },
      {
        heading: "備考",
        notes: [
          ...(partial ? ["会場のご案内は、先にお送りした受付完了メールをご覧ください。"] : []),
          "お心当たりのない場合や、ご不明な点がございましたら、公式サイトCONTACTの『チケット関連』よりご連絡ください。",
        ],
      },
    ],
    [partial ? "当日お会いできるのを楽しみにしております。" : "またお会いできる機会を楽しみにしております。", "", "deddecay", "https://deddecay.tokyo"]
  );
  return { subject: partial ? PARTIAL_CANCEL_SUBJECT : CANCEL_SUBJECT, text, html };
};

export const PARTIAL_CANCEL_SUBJECT = `【deddecay】${EVENT.shortLabel} チケット枚数変更（一部キャンセル）受付完了`;

// 運営宛て：キャンセルの記録。r はキャンセル前の予約。via=self は本人が手続きページから操作したもの
export const buildCancelOperatorMail = (
  r: Reservation,
  summary: { reserved: number; remaining: number; capacity: number },
  status: { applicantMailOk: boolean; via?: "ops" | "self" },
  change: CancelChange = fullChange(r)
): Mail => {
  const partial = change.kept > 0;
  const lines = [
    ...(status.via === "self" ? ["本人がキャンセル手続きページから手続きしました（台帳・集計表は自動で更新済み）。", ""] : []),
    ...(status.applicantMailOk
      ? [`✓ 申込者（${r.email}）へキャンセルのお知らせを送信しました。`, ""]
      : ["⚠ 申込者へのキャンセルのお知らせメールの送信に失敗しました。手動で連絡してください。", ""]),
    `お名前: ${r.name}`,
    `メールアドレス: ${r.email}`,
    `キャンセル枚数: ${change.cancelled}枚${partial ? `（${r.tickets}枚 → ${change.kept}枚）` : ""}`,
    `受付日時: ${new Date(r.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`,
    `受付ID: ${r.id}`,
    "",
    `受付済み: ${summary.reserved} / ${summary.capacity}枚`,
    `残席: ${summary.remaining}`,
  ];
  const text = lines.join("\n");
  return {
    subject: `[TICKET 12/6] ${partial ? "一部キャンセル" : "キャンセル"} ${r.name} 様 ${change.cancelled}枚（残席 ${summary.remaining}）`,
    text,
    html: `<pre style="font-family:sans-serif;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
    replyTo: r.email,
  };
};

export const CANCEL_LINK_SUBJECT = `【deddecay】${EVENT.shortLabel} チケットキャンセルのお手続き`;

// 申込者宛て：CONTACT からキャンセルの連絡が来たときに送る、手続きページへのリンク
export const buildCancelLinkMail = (r: Reservation, url: string): Mail => {
  const href = safeUrl(url);
  const { text, html } = render(
    [
      `${r.name} 様`,
      "",
      "公式サイトCONTACTより、チケットのキャンセルに関するご連絡をいただきました。",
      "下のリンクから、キャンセルする枚数を選んでお手続きください。",
    ],
    [
      {
        heading: "ご予約内容",
        lines: [
          { label: "公演タイトル", value: EVENT.title },
          { label: "開催日", value: EVENT.dateLabel },
          { label: "お名前", value: r.name },
          { label: "チケット枚数", value: `${r.tickets}枚`, blankAfter: true },
          { label: "キャンセル手続きページ", value: "", href },
        ],
      },
      {
        heading: "備考",
        notes: [
          "リンクを開いただけではキャンセルされません。手続きページで枚数を選び、ボタンを押すと完了します。",
          "手続きが完了すると、キャンセル受付完了のメールをお送りします。",
          "お心当たりのない場合は、このメールは破棄してください（ご予約はそのまま有効です）。",
          "リンクの有効期限は公演当日までです。",
        ],
      },
    ],
    ["deddecay", "https://deddecay.tokyo"]
  );
  return { subject: CANCEL_LINK_SUBJECT, text, html };
};

// 送信元: TICKET_FROM_EMAIL があればそれ、無ければ CONTACT_FROM_EMAIL のアドレス部分に表示名 "deddecay"
export const ticketFrom = (env: Record<string, string | undefined> = process.env): string => {
  const explicit = env.TICKET_FROM_EMAIL?.trim();
  if (explicit) return explicit;
  const base = env.CONTACT_FROM_EMAIL?.trim();
  if (!base) return "";
  const address = /<([^<>]+)>\s*$/.exec(base)?.[1]?.trim() ?? base;
  return `deddecay <${address}>`;
};
