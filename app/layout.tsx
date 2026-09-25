import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppSidebar } from "@/components/app-sidebar";
import { AdvisorReplyToast } from "@/components/chat/advisor-reply-toast";
import { ChatLauncher } from "@/components/chat/chat-launcher";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/toast";
import { findWaitingServicing } from "@/lib/ai/servicing-session";
import { listIntakeConversations } from "@/lib/queries";
import { getCurrentUser, listUsers } from "@/lib/session";
import { getVerification } from "@/lib/uae-pass";
import "./globals.css";

const geistSans = Geist({ variable: "--font-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Mizan AI",
  description: "AI-assisted health insurance advisory",
};

export default async function RootLayout({ children, chat }: LayoutProps<"/">) {
  const [users, currentUser] = await Promise.all([listUsers(), getCurrentUser()]);

  /**
   * Does the launcher need a dot on it?
   *
   * True when a conversation is waiting on the applicant rather than on us —
   * `awaiting_review` means a person now owns the record, which is the one
   * state where nothing will happen until an advisor acts, so it does NOT
   * count. An active conversation that is not completed does.
   */
  const intakeWaiting =
    currentUser?.role === "applicant"
      ? (await listIntakeConversations(currentUser.id)).some((convo) => convo.status === "active")
      : false;
  // A servicing conversation waiting on the member lights the dot too, and the launcher goes straight to it.
  // Intake wins the link when both are waiting — it is the older, bigger commitment — and the servicing one
  // is always reachable from the policy's "In progress" strip.
  const servicingWaiting = currentUser?.role === "applicant" ? await findWaitingServicing(currentUser.id) : null;
  const chatAttention = intakeWaiting || servicingWaiting !== null;
  const chatHref = !intakeWaiting && servicingWaiting ? `/policies/${servicingWaiting.policyId}/service/${servicingWaiting.conversationId}` : undefined;
  const advisorReply = servicingWaiting?.reason === "advisor_reply" ? servicingWaiting.messageId : null;
  const verified = currentUser?.role === "applicant" ? (await getVerification(currentUser.id)) !== null : false;

  return (
    // suppressHydrationWarning: next-themes writes the theme class onto <html>
    // before hydration, so the server and client markup differ by design.
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <body className="min-h-full antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <Toaster>
            {currentUser ? (
              <SidebarProvider>
                <AppSidebar user={currentUser} users={users} verified={verified} />
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

                  {/* The applicant's way back into their conversation from any
                      page. The drawer it opens is the `chat` slot below — an
                      intercepted render of the real chat route, so the URL,
                      the back button and a reload all behave. */}
                  {currentUser.role === "applicant" ? <ChatLauncher attention={chatAttention} href={chatHref} /> : null}
                  {currentUser.role === "applicant" && advisorReply ? <AdvisorReplyToast key={advisorReply} messageId={advisorReply} /> : null}
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
            {chat}
          </Toaster>
        </ThemeProvider>
      </body>
    </html>
  );
}
