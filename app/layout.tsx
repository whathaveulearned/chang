import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chang's Wiki - Knowledge Graph",
  description: "常天喆的个人知识库知识图谱",
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
