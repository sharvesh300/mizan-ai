"use client";

import { MessageCircleIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "cn";

/**
 * The applicant's way back into their conversation, from anywhere.
 *
 * It is a `Link`, not a button that opens something: the destination is a real
 * route, so the drawer that appears is an intercepted render of it
 * (app/@chat). That buys deep-linking, a working back button, and a full-page
 * fallback on reload for free, and it means every `revalidatePath` the chat
 * actions already call keeps working unchanged inside the drawer.
 *
 * `attention` is computed on the server and passed in, so a closed launcher
 * costs one boolean rather than a poll.
 */
export function ChatLauncher({ attention = false }: { attention?: boolean }) {
  const pathname = usePathname();

  // Inside the chat itself the launcher is noise — and on the full-page chat
  // it would sit on top of the composer.
  if (pathname.startsWith("/applications/new/chat")) return null;

  return (
    <Link
      href="/applications/new/chat"
      aria-label={attention ? "Open your chat — something is waiting for you" : "Open your chat"}
      className={cn(
        "fixed right-4 bottom-4 z-40 flex size-13 items-center justify-center rounded-full bg-brand text-brand-foreground shadow-lg transition-transform",
        "hover:scale-105 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        "sm:right-6 sm:bottom-6",
      )}
    >
      <MessageCircleIcon className="size-5.5" />
      {attention ? (
        <span className="absolute top-0.5 right-0.5 flex size-3.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-warning opacity-60" />
          <span className="relative inline-flex size-3.5 rounded-full bg-warning ring-2 ring-background" />
        </span>
      ) : null}
    </Link>
  );
}
