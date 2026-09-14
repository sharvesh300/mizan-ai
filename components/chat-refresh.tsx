"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Polls the server while recommendation runs in the background
 * (`scheduleRecommendation`, lib/ai/recommendation-session.ts) — the
 * applicant's submit or "none of these fit" already returned, and the
 * agent's tool-call loop can take several model round-trips before there is
 * a card to show.
 *
 * `scheduleRecommendation` revalidates this exact chat route once it
 * resolves, so this poller is the fallback for the ordinary case of the page
 * just sitting open — not the primary way the update arrives.
 *
 * Mounted by the chat page only while there is something to wait for; it
 * disappears on its own the next time the page re-renders with nothing left
 * to poll for (see the `working` check in
 * app/applications/new/chat/[id]/page.tsx).
 */
export function ChatRefresh({ intervalMs = 4000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);

  return null;
}
