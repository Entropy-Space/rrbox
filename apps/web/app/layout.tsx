import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "@researchbox/viewer/styles.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const rawHost =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const host = /^[a-z0-9.-]+(?::\d+)?$/i.test(rawHost)
    ? rawHost
    : "localhost:3000";
  const forwardedProtocol = requestHeaders
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const protocol =
    forwardedProtocol === "http" || forwardedProtocol === "https"
      ? forwardedProtocol
      : host.startsWith("localhost")
        ? "http"
        : "https";
  const metadataBase = new URL(`${protocol}://${host}`);
  const description = "A browser-native workspace for Pi agents.";

  return {
    metadataBase,
    title: {
      default: "rrbox",
      template: "%s · rrbox",
    },
    description,
    openGraph: {
      title: "rrbox",
      description,
      type: "website",
      images: [
        {
          url: new URL("/og.png", metadataBase).toString(),
          width: 1536,
          height: 1024,
          alt: "rrbox browser-native Pi agent workspace",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "rrbox",
      description,
      images: [new URL("/og.png", metadataBase).toString()],
    },
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
