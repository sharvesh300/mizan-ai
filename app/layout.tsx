import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { UserSwitcher } from "@/components/user-switcher";
import { getCurrentUser, listUsers } from "@/lib/session";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Mizan AI",
  description: "AI-assisted health insurance advisory",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const [users, currentUser] = await Promise.all([listUsers(), getCurrentUser()]);

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-black/10 px-6 py-3 dark:border-white/15">
          <span className="font-semibold tracking-tight">Mizan AI</span>
          {currentUser ? (
            <UserSwitcher users={users} currentUserId={currentUser.id} />
          ) : (
            <span className="text-sm text-zinc-500">No users seeded — run bun db:seed</span>
          )}
        </header>
        {children}
      </body>
    </html>
  );
}
