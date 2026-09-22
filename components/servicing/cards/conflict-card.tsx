"use client";

import { Button } from "@/components/ui/button";
import type { ConflictCard as Payload } from "@/lib/servicing/cards";
import { CardShell, TOUCH, type CardViewProps } from "./shell";

/**
 * Two sources disagree, and the system does not choose. Both are put in front of the member, each naming
 * where it came from and quoting it. Neither is pre-selected, styled as the default, or listed as
 * "recommended": the point of asking is that the system does not know.
 */
export function ConflictCard({ card, handlers, answered, disabled, focusOnMount }: { card: Payload } & CardViewProps) {
  const locked = disabled || answered != null;
  return (
    <CardShell label="Two details don't match" focusOnMount={focusOnMount}>
      <p className="text-sm text-pretty">{card.question}</p>
      <div className="grid gap-2">
        {card.options.map((option) => {
          const chosen = answered === option.value;
          return (
            <Button
              key={option.value}
              type="button"
              variant="outline"
              aria-pressed={chosen}
              disabled={locked && !chosen}
              className={`${TOUCH} w-full flex-col items-start justify-start gap-0.5 text-left ${chosen ? "border-brand bg-brand-subtle" : ""}`}
              onClick={() => handlers?.onChooseConflict?.(option.value)}
            >
              <span className="text-sm font-medium">{option.display}</span>
              <span className="text-xs font-normal text-muted-foreground">{option.source}</span>
              <span className="text-xs font-normal text-muted-foreground italic text-pretty">&ldquo;{option.quote}&rdquo;</span>
            </Button>
          );
        })}
      </div>
    </CardShell>
  );
}
