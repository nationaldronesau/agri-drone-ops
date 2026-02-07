import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import AuthProvider from "@/components/providers/session-provider";
import { AppShell } from "@/components/layout/AppShell";

export const metadata: Metadata = {
  title: "AgriDrone Ops - Agricultural Drone Operations Platform",
  description: "AI-powered platform for agricultural drone operations. Upload drone imagery, detect weeds and crops, and generate precise spray coordinates.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${GeistSans.variable} ${GeistMono.variable} antialiased`}
      >
        <AuthProvider>
          <AppShell>
            {children}
          </AppShell>
        </AuthProvider>
      </body>
    </html>
  );
}
