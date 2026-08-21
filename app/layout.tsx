import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
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

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "remaivo.local";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const baseUrl = new URL(`${protocol}://${host}`);
  const title = "Remaivo — Know what's left";
  const description = "A clear, cross-device view of your money, budgets, commitments, savings, and raw investments.";

  return {
    metadataBase: baseUrl,
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
      title: "Remaivo",
      statusBarStyle: "black-translucent",
    },
    other: { "mobile-web-app-capable": "yes" },
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary", title, description },
  };
}

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
