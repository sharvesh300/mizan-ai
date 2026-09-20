"use client";

// The trade-off question (lib/ai/graph/nodes/tradeoff.ts), as the fork it
// actually is: two buttons, not a box to type in.
//
// The applicant is being asked which side of a HARD GATE they want to be on —
// a cheaper plan that does not cover something they declared, or the cover at
// the higher premium. Both options are stated in full, at their real cost,
// including the one that costs us more; neither is styled as the obvious
// answer, because the whole point of asking is that the system does not know
// which they want. That is also why there is no "recommended" badge here and
// no default-variant button: this is the one question in the flow where a
// nudge would be the system answering on the applicant's behalf.
//
// Pressing a button sends only WHICH of the two it was. The label shown here
// is display; the server re-derives the wording, the trade-off and every
// preference signal it writes from the row it wrote when it asked
// (`answerTradeOff`, app/applications/new/actions.ts).

import { useTransition } from "react";
import { answerTradeOff } from "@/app/applications/new/actions";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export function TradeOffCard({
  conversationId,
  options,
}: {
  conversationId: string;
  /** The two answers, worded by the server when it asked (lib/recommendation/tradeoff.ts). */
  options: { premium: string; requirement: string };
}) {
  const [pending, startTransition] = useTransition();

  const answer = (choice: "premium" | "requirement") =>
    startTransition(async () => {
      await answerTradeOff(conversationId, choice);
    });

  return (
    <div className="w-full max-w-md space-y-3 rounded-2xl rounded-bl-sm border bg-card p-4 shadow-sm">
      <p className="text-xs font-medium text-muted-foreground">Which matters more to you?</p>

      {/* Deliberately identical treatment — same variant, same size, same
          width. The order is cheaper-first only because that is the thing
          they asked for. */}
      <div className="grid gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-auto w-full justify-start py-2.5 text-left whitespace-normal"
          disabled={pending}
          onClick={() => answer("premium")}
        >
          {pending ? <Spinner /> : null}
          {options.premium}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-auto w-full justify-start py-2.5 text-left whitespace-normal"
          disabled={pending}
          onClick={() => answer("requirement")}
        >
          {pending ? <Spinner /> : null}
          {options.requirement}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">Or tell me in your own words below.</p>
    </div>
  );
}
