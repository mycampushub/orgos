import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { SITE } from "@/lib/site";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: `${SITE.name} — ${SITE.tagline}`,
    template: `%s — ${SITE.name}`,
  },
  description: SITE.description,
  keywords: [
    "OrgOS",
    "enterprise SaaS",
    "organization operating system",
    "project management",
    "CRM",
    "HRMS",
    "recruitment software",
    "payroll",
    "ERP Bangladesh",
  ],
  applicationName: SITE.name,
  authors: [{ name: SITE.legalName }],
  creator: SITE.legalName,
  openGraph: {
    type: "website",
    siteName: SITE.name,
    locale: "en_US",
    images: [
      {
        url: "/brand/og-main.png",
        width: 1344,
        height: 768,
        alt: `${SITE.name} — ${SITE.tagline}`,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    images: ["/brand/og-main.png"],
  },
  icons: {
    icon: "/logo.svg",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
         * __name polyfill — MUST run before any inline script.
         *
         * When OpenNext/esbuild bundles the app with `keepNames: true`, it
         * injects `__name(fn, "name")` calls into function bodies to preserve
         * their `.name` property. This is fine inside bundled modules (where
         * esbuild also defines `__name`), but `next-themes` serializes one of
         * its internal functions to a string via `.toString()` and injects it
         * as an inline `<script>` tag. That script runs in the browser's
         * global scope, where `__name` is NOT defined — so it throws
         * `ReferenceError: __name is not defined` and crashes the page.
         *
         * Defining `window.__name` as a no-op (returns the function unchanged)
         * makes the inline script work. This runs in <head> before any
         * inline script in <body>.
         */}
        <script
          dangerouslySetInnerHTML={{
            __html: 'window.__name||(window.__name=function(f){return f});',
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
