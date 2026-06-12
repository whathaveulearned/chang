import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chang-wiki",
  description: "The universe is made of stories, not of atoms.",
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
