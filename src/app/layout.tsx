import "./globals.css";
import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";

export const metadata: Metadata = { title: "ATEC Outage Operations", description: "Network outage communications & incident management" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0b0b0c" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = cookies().get("theme")?.value === "light" ? "light" : "dark";
  return (
    <html lang="en-ZA" data-theme={theme}>
      <body className="min-h-full font-sans text-[14px] leading-[1.45]">{children}</body>
    </html>
  );
}
