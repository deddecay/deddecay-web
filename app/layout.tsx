import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://deddecay.tokyo"),
  title: "deddecay",
  description: "deddecay official website",
  robots: { index: true, follow: true },
  openGraph: {
    title: "deddecay",
    description: "deddecay official website",
    url: "https://deddecay.tokyo",
    siteName: "deddecay",
    type: "website",
    images: [{ url: "/og/og-default.jpg" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "deddecay",
    description: "deddecay official website",
    images: ["/og/og-default.jpg"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} antialiased`}
    >
      <body className="min-h-full">{children}</body>
    </html>
  );
}
