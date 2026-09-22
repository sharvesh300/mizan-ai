"use client";

import { GavelIcon } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import type { AppealIntroCard as Payload } from "@/lib/servicing/cards";
import { CardShell, type CardViewProps } from "./shell";

/**
 * The start of an appeal (plan §13.2.6): what the decision turned on, and what could change it — before the member writes
 * a word. It is the admissibility table in their own words, and the most useful screen in the flow: it stops them sending a
 * document that cannot help, and tells them which one can.
 *
 * Nothing on it is asked of them. The request for a document is the NEXT card; this one only says where they stand.
 */
export function AppealIntroCard({ card, focusOnMount }: { card: Payload } & CardViewProps) {
  return (
    <CardShell label="Your appeal" wide focusOnMount={focusOnMount}>
      <div className="space-y-1.5">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <GavelIcon className="size-3.5" />
          You&apos;re appealing
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-medium text-pretty">{card.contested.title}</h3>
          <StatusBadge tone="danger">{card.contested.decision}</StatusBadge>
        </div>
        <p className="text-xs text-muted-foreground">{card.contested.monthLabel}</p>
      </div>

      <p className="text-sm text-pretty">
        This decision turned on <span className="font-medium">{card.turnedOn}</span>.
      </p>

      <section aria-labelledby="could-change" className="space-y-1.5">
        <h4 id="could-change" className="text-xs font-medium">
          What could change it
        </h4>
        <ul className="list-disc space-y-1 pl-5 text-sm text-pretty">
          {card.couldChange.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      {card.cannotChange.length > 0 ? (
        <section aria-labelledby="cannot-change" className="space-y-1.5">
          <h4 id="cannot-change" className="text-xs font-medium">
            What can&apos;t change it on its own
          </h4>
          <ul className="list-disc space-y-1 pl-5 text-sm text-pretty text-muted-foreground">
            {card.cannotChange.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </CardShell>
  );
}
