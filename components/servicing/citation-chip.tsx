// A citation, made clickable — plan §13.3.4: "the reassessment's prose is never a bare claim; each fact it rests on
// is a chip that scrolls to the exact history row it came from." The two registers read the SAME chip differently:
// a broker gets the reference their system already prints on the event (`CLM-3`) because that's what they search
// the record by; a member gets the plain description they'd recognise, never a code that means nothing to them.
// Both link to the same anchor (`#event-<id>`, the id `MemberEventCard`/`BrokerEventRow` already render) — the row
// the sentence is standing on is one scroll away either way.

import Link from "next/link";
import type { Citation } from "@/lib/servicing";

export function CitationChip({ citation, register }: { citation: Citation; register: "member" | "broker" }) {
  const label = register === "broker" ? citation.ref : citation.description;
  return (
    <Link
      href={`#event-${citation.eventId}`}
      className="inline-flex items-center rounded-full border bg-muted/60 px-2 py-0.5 text-xs font-medium text-muted-foreground no-underline transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      title={register === "broker" ? citation.description : undefined}
    >
      {label}
    </Link>
  );
}

/** A whole citation list, inline — the row of chips a reassessment's prose stands on. */
export function CitationChips({ citations, register }: { citations: Citation[]; register: "member" | "broker" }) {
  if (citations.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{register === "broker" ? "From:" : "Based on:"}</span>
      {citations.map((c) => (
        <CitationChip key={`${c.eventId}-${c.ref}`} citation={c} register={register} />
      ))}
    </div>
  );
}
