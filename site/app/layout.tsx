import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://www.wdim.app"),
  title: "wdim",
  description: "what did i miss: one place to catch up across Gmail, Telegram, GitHub, and X.",
  openGraph: {
    title: "What did I miss?",
    description: "One place to catch up while agents scan the sources you care about.",
    url: "https://www.wdim.app",
    siteName: "wdim",
    images: [
      {
        url: "/opengraph-image",
        width: 2400,
        height: 1260,
        alt: "What did I miss?"
      }
    ],
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    title: "What did I miss?",
    description: "One place to catch up while agents scan the sources you care about.",
    images: ["/opengraph-image"]
  },
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
