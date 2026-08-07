import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.APP_URL || "http://localhost:3000"),
  title: "爆片分析",
  description: "上传或粘贴 TikTok 链接，拆解画面、声音、钩子、爆点与带货转化结构。",
  icons: { icon: "/og.png", shortcut: "/og.png" },
  openGraph: {
    title: "爆片分析",
    description: "看懂钩子 · 找到爆点 · 复刻转化",
    images: [{ url: "/og.png", width: 1672, height: 936, alt: "爆片分析" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "爆片分析",
    description: "看懂钩子 · 找到爆点 · 复刻转化",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
