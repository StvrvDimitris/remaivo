import type { Metadata, Viewport } from "next";
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

export const viewport: Viewport = {
  themeColor: "#15372f",
};

const title = "Remaivo — Know what's left";
const description = "A clear, cross-device view of your money, budgets, commitments, savings, and raw investments.";

export const metadata: Metadata = {
  metadataBase: new URL("https://remaivo-personal-finance.stavrou.chatgpt.site"),
  applicationName: "Remaivo",
  title,
  description,
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/remaivo-v1-favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/remaivo-v1-icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    shortcut: "/remaivo-v1-favicon-32.png",
    apple: [{ url: "/remaivo-v1-apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Remaivo",
  },
  openGraph: { title, description, type: "website" },
  twitter: { card: "summary", title, description },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
