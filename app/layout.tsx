import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "常天喆 · 知识星图",
  description: "常天喆的个人知识宇宙 —— 文学 × 哲学 × AI，每一簇星系是一个思想领域",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
