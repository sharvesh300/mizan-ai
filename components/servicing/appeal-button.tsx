"use client";

// "Appeal this decision", from the policy screen. The button only exists for a decision the LOG says can be appealed
// (the server decides that; nothing here does), and it opens the appeal in the drawer like every other link to a
// conversation — `startAppeal` returns where it lives and the client pushes, so the intercepting route sees it.

import { GavelIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { startAppeal } from "@/app/policies/[id]/service/actions";
import { Button } from "@/components/ui/button";

export function AppealButton({ policyId, eventId }: { policyId: string; eventId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <div className="space-y-1.5">
      <Button
        type="button"
        variant="outline"
        className="h-auto min-h-11 whitespace-normal py-2"
        disabled={pending}
        onClick={() => {
          setProblem(null);
          startTransition(async () => {
            try {
              const r = await startAppeal(policyId, eventId);
              if (r.ok && r.href) router.push(r.href);
              else if (!r.ok) setProblem(r.message);
            } catch {
              setProblem("We couldn't start that just now. Please try again.");
            }
          });
        }}
      >
        <GavelIcon />
        {pending ? "Opening…" : "Appeal this decision"}
      </Button>
      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
