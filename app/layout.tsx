import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/toast";
import { getCurrentUser, listUsers } from "@/lib/session";
import "./globals.css";

const geistSans = Geist({ variable: "--font-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Mizan AI",
  description: "AI-assisted health insurance advisory",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const [users, currentUser] = await Promise.all([listUsers(), getCurrentUser()]);

  return (
    // suppressHydrationWarning: next-themes writes the theme class onto <html>
    // before hydration, so the server and client markup differ by design.
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <body className="min-h-full antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <Toaster>
            {currentUser ? (
              <SidebarProvider>
                <AppSidebar user={currentUser} users={users} />
                <SidebarInset className="min-w-0">
                  <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur-sm">
                    <SidebarTrigger className="-ml-1" />
                    <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
                    <span className="text-sm font-medium text-muted-foreground">
                      {currentUser.role === "advisor" ? "Advisor console" : "Your cover"}
                    </span>
                    <div className="ml-auto flex items-center gap-1">
                      <ThemeToggle />
                    </div>
                  </header>
                  <div className="min-w-0 flex-1">{children}</div>
                </SidebarInset>
              </SidebarProvider>
            ) : (
              <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6">
                <h1 className="text-lg font-semibold">No users found</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Seed the database with <code className="font-mono">bun db:seed</code>, then reload.
                </p>
              </main>
            )}
          </Toaster>
        </ThemeProvider>
      </body>
    </html>
  );
}
