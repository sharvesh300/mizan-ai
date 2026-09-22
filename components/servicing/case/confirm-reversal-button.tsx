"use client";

// One click, but only AFTER seeing the arithmetic (plan §13.3.1): the queue row shows `denied 0 → covered 4,400 / 1,600`
// above this button, and the note it records says so. A decline is never a single click from a list — "Uphold instead"
// and "Ask for more" live on the case page, where they need a written reason.

import { CheckIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { decideOverturn } from "@/app/policies/[id]/events/[eventId]/actions";
import { Button } from "@/components/ui/button";

export function ConfirmReversalButton({ policyId, eventId, taskId, summary }: { policyId: string; eventId: string; taskId: string; summary: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <div className="space-y-1.5">
      <Button
        type="button"
        size="sm"
        disabled={pending}
        onClick={() => {
          setProblem(null);
          startTransition(async () => {
            try {
              const r = await decideOverturn(policyId, eventId, { taskId, verb: "confirm", note: `Confirmed from the queue with the working on screen: ${summary}.` });
              if (r.ok) router.refresh();
              else setProblem(r.message);
            } catch {
              setProblem("That didn't go through. Nothing was signed — please try again.");
            }
          });
        }}
      >
        <CheckIcon />
        {pending ? "Signing…" : "Confirm reversal"}
      </Button>
      {problem ? (
        <p role="alert" className="max-w-xs text-xs text-pretty text-destructive">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
