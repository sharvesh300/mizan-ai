"use client";

import { CheckIcon, PencilIcon } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import type { ConfirmCard as Payload } from "@/lib/servicing/cards";
import { CardShell, TOUCH, type CardViewProps } from "./shell";

/**
 * "Here's what I've got — is it right?" The model's reading meeting the member's knowledge, before any
 * money is computed. Rows the model DERIVED rather than heard are marked, so the member checks those
 * hardest; nothing here is broker vocabulary, and the condition is named in the member's own application words.
 */
export function ConfirmCard({ card, handlers, answered, disabled, focusOnMount }: { card: Payload } & CardViewProps) {
  const locked = disabled || answered != null;
  return (
    <CardShell label="Check these details" focusOnMount={focusOnMount}>
      <p className="text-sm font-medium">{card.title}</p>

      <dl className="divide-y rounded-lg border text-sm">
        {card.rows.map((row) => (
          // minmax(0, 1fr), not 1fr: a bare 1fr has a min-content floor, so a non-wrapping badge would force the row
          // wider than the card on a phone. The badge sits under the value for the same reason.
          <div key={row.fieldKey} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 py-2">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 space-y-1 break-words text-pretty">
              <span className="font-medium">{row.value}</span>
              {row.origin === "worked_out" ? (
                <div>
                  <StatusBadge tone="info" className="h-auto whitespace-normal text-left">
                    Worked out — please check
                  </StatusBadge>
                </div>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-2 sm:grid-cols-2">
        <Button type="button" className={TOUCH} disabled={locked} onClick={() => handlers?.onConfirm?.()}>
          <CheckIcon />
          Looks right
        </Button>
        <Button type="button" variant="outline" className={TOUCH} disabled={locked} onClick={() => handlers?.onChange?.()}>
          <PencilIcon />
          Change something
        </Button>
      </div>
      {answered ? <p className="text-xs text-muted-foreground">You said: {answered}</p> : null}
    </CardShell>
  );
}
