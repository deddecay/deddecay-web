import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "プライバシーポリシー | deddecay",
  description: "deddecay 公式サイトにおける情報の取り扱いについて",
  robots: { index: false, follow: false },
};

// プライバシーポリシー。導線は /upload 下部のテキストリンクのみ（グローバルナビ・サイトマップには載せない）。
// Google OAuth（Drive 連携）のブランディングに登録する URL を兼ねる
// Fan moments の項目は、投稿フォームの「利用について」（利用者が同意する文面）と食い違わない範囲だけを書く
const SECTIONS: { title: string; items: string[] }[] = [
  {
    title: "Fan moments で取得する情報",
    items: [
      "投稿された写真・動画のファイルと、その元のファイル名",
      "任意のメッセージ",
      "投稿先（LIVE または「その他」）と投稿日時",
      "お名前・メールアドレス等の個人情報はお求めしません。",
      "不正な利用を防ぐため、IP アドレスを送信回数・容量の制限に一時的に使用します。IP アドレスは投稿データには保存しません。",
      "ボット対策に Cloudflare Turnstile を使用しています。",
    ],
  },
  {
    title: "投稿された写真・動画の利用目的",
    items: [
      "deddecay が公式サイト・SNS・告知等で、投稿内容を紹介・利用する場合があります（事前の個別連絡はいたしません）。",
      "アップロードいただいたデータは、投稿者ご自身も引き続き SNS 等でご利用いただけます。",
    ],
  },
  {
    title: "保存場所",
    items: [
      "投稿されたファイルは、Cloudflare R2 に一時的に保管したのち、運営者の Google Drive に保存します。",
      "R2 の一時保管分は、Google Drive への保存を確認したあと削除します。",
      "いずれも非公開の保管場所で、他の方からは見られません。",
    ],
  },
  {
    title: "Google Drive との連携",
    items: [
      "本サイトは、運営者自身の Google アカウントでのみ Google Drive と連携し、投稿されたファイルを運営者の Google Drive に保存する目的に限って使用します。",
      "使用する権限は、本サイトが作成したファイルだけを扱う drive.file のみです。訪問者・投稿者の Google アカウントやデータにアクセスすることはありません。",
    ],
  },
  {
    title: "お問い合わせ",
    items: [
      "CONTACT フォームでは、お名前・メールアドレス・件名・お問い合わせ内容をお送りいただきます。",
      "いただいた情報は、お問い合わせへの返信のためにのみ使用します。",
    ],
  },
  {
    title: "アクセス解析",
    items: [
      "サイトの利用状況を把握するため、Google アナリティクスを使用しています。Google アナリティクスは Cookie を使用してデータを収集しますが、個人を特定する情報は含まれません。",
    ],
  },
  {
    title: "第三者への提供",
    items: ["法令に基づく場合を除き、いただいた情報を第三者に提供することはありません。"],
  },
  {
    title: "削除のご希望・お問い合わせ窓口",
    items: ["投稿の削除のご希望や、本ポリシーに関するお問い合わせは、公式サイトの CONTACT フォームからご連絡ください。"],
  },
];

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center px-8 pt-12 pb-16">
      <div className="w-full max-w-xs sm:max-w-sm flex flex-col gap-8">
        <Link
          href="/"
          className="text-[10px] tracking-widest text-white/45 hover:text-white/75 transition-colors duration-150"
        >
          ← deddecay
        </Link>

        <header className="flex flex-col gap-2">
          <h1 className="text-sm tracking-[0.2em] text-white/90">プライバシーポリシー</h1>
          <p className="text-[11px] leading-relaxed text-white/55">
            deddecay（以下「運営者」）は、公式サイト deddecay.tokyo における情報を、次のとおり取り扱います。
          </p>
        </header>

        {SECTIONS.map((section) => (
          <section key={section.title} className="flex flex-col gap-2">
            <h2 className="text-[11px] tracking-widest text-white/80">{section.title}</h2>
            <ul className="flex flex-col gap-1.5 list-disc pl-4 text-[11px] leading-relaxed text-white/55">
              {section.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        ))}

        <p className="text-[10px] tracking-widest text-white/35">2026年10月22日 制定</p>
      </div>
    </main>
  );
}
