import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "wdim",
  description: "what did i miss: one place to catch up across Gmail, Telegram, GitHub, and X.",
  icons: {
    icon: "/wdim-icon.png",
    apple: "/wdim-icon.png"
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
