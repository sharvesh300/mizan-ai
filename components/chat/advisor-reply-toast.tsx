"use client";

import { useEffect } from "react";
import { toast } from "@/components/ui/toast";

/**
 * "Your advisor replied" — once per reply. The dot on the launcher is the standing signal; this is the one-off nudge when a
 * member is looking at something else. Keyed on the advisor's message, so a second reply toasts again and a reload of the
 * same page does not. The words promise nothing: no time, and nothing the advisor has not said.
 */
export function AdvisorReplyToast({ messageId }: { messageId: string }) {
  useEffect(() => {
    const key = `mizan:reply-toast:${messageId}`;
    try {
      if (window.localStorage.getItem(key)) return;
      window.localStorage.setItem(key, "1");
    } catch {
      // Storage can be blocked; showing the toast again is better than never showing it.
    }
    toast.add({ title: "Your advisor replied", description: "Open your conversation to read it.", type: "info" });
  }, [messageId]);
  return null;
}
