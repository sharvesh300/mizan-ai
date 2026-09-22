"use client";

// The two things a member can start from their policy. A real button each — `startServicing` opens the
// conversation and the client pushes to it, which the intercepting route turns into the drawer.

import { ClipboardCheckIcon, ReceiptTextIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { startServicing } from "@/app/policies/[id]/service/actions";
import { Button } from "@/components/ui/button";

export function ServicingActions({ policyId }: { policyId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [which, setWhich] = useState<"claim" | "preauth" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const start = (intent: "claim" | "preauth") => {
    if (pending) return;
    setProblem(null);
    setWhich(intent);
    startTransition(async () => {
      try {
        const r = await startServicing(policyId, intent);
        if (r.ok && r.href) router.push(r.href);
        else if (!r.ok) setProblem(r.message);
      } catch {
        setProblem("We couldn't start that just now. Please try again.");
      }
    });
  };

  return (
    <section aria-label="What would you like to do?" className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="button" variant="outline" className="h-auto min-h-14 justify-start gap-3 px-4 py-3 text-left whitespace-normal" disabled={pending} onClick={() => start("preauth")}>
          <ClipboardCheckIcon className="size-5 shrink-0 text-brand" />
          <span className="space-y-0.5">
            <span className="block text-sm font-medium">{pending && which === "preauth" ? "Opening…" : "Is this covered?"}</span>
            <span className="block text-xs font-normal text-muted-foreground">Check before you have the treatment</span>
          </span>
        </Button>
        <Button type="button" variant="outline" className="h-auto min-h-14 justify-start gap-3 px-4 py-3 text-left whitespace-normal" disabled={pending} onClick={() => start("claim")}>
          <ReceiptTextIcon className="size-5 shrink-0 text-brand" />
          <span className="space-y-0.5">
            <span className="block text-sm font-medium">{pending && which === "claim" ? "Opening…" : "Claim, or get money back"}</span>
            <span className="block text-xs font-normal text-muted-foreground">For treatment you have already had</span>
          </span>
        </Button>
      </div>
      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
    </section>
  );
}
