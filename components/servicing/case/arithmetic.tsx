// The two small pieces of arithmetic a broker signs on: what the decision IS, what it WOULD BE, and what the ledger
// does. Shared by the queue row and the case page so the two cannot show a different sum.
//
// Broker register: it names the reason code and says outright that a figure came from the engine. Nothing here is
// imported by a member component.

import { ArrowRightIcon } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { money, outcomeLabel, reasonCodeLabel } from "@/lib/domain";
import type { EventOutcome, ReasonCode } from "@/db/schema/enums";

type Side = { outcome?: string | null; reasonCode?: string | null; planPays: number | null; memberPays: number | null };

const label = (s: Side) => (s.outcome && s.outcome in outcomeLabel ? outcomeLabel[s.outcome as EventOutcome] : s.reasonCode && s.reasonCode in reasonCodeLabel ? (s.reasonCode === "covered" ? "Covered" : reasonCodeLabel[s.reasonCode as ReasonCode]) : "—");

/** `denied 0 / 6,000 → covered 4,400 / 1,600` — as a sentence a broker can read at a glance. */
export function ArithmeticDiff({ before, after, compact = false }: { before: Side; after: Side; compact?: boolean }) {
  const cell = (s: Side, tone: "danger" | "success") => (
    <div className="space-y-0.5">
      <StatusBadge tone={tone}>{label(s)}</StatusBadge>
      <p className="text-sm tabular-nums">
        <span className="text-muted-foreground">plan pays</span> {money(s.planPays)}
        <span className="mx-1.5 text-muted-foreground">·</span>
        <span className="text-muted-foreground">member</span> {money(s.memberPays)}
      </p>
    </div>
  );
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3 ${compact ? "py-2" : "py-3"}`} role="group" aria-label="Before and after">
      {cell(before, "danger")}
      <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      {cell(after, "success")}
    </div>
  );
}

type LedgerJson = { deductible_met?: number; annual_paid?: number; sublimit_used?: Record<string, number> };

/** The ledger before and after, two columns, only the rows that exist. */
export function LedgerDiff({ before, after, caption }: { before: unknown; after: unknown; caption?: string }) {
  const a = (before && typeof before === "object" ? before : {}) as LedgerJson;
  const b = (after && typeof after === "object" ? after : {}) as LedgerJson;
  const rows: [string, number | undefined, number | undefined][] = [
    ["Deductible met", a.deductible_met, b.deductible_met],
    ["Annual paid", a.annual_paid, b.annual_paid],
    ...Object.keys({ ...a.sublimit_used, ...b.sublimit_used }).map((k): [string, number | undefined, number | undefined] => [`${k.replace(/_/g, " ")} used`, a.sublimit_used?.[k], b.sublimit_used?.[k]]),
  ];
  return (
    <table className="w-full text-sm">
      {caption ? <caption className="pb-1.5 text-left text-xs text-muted-foreground">{caption}</caption> : null}
      <thead>
        <tr className="text-left text-xs text-muted-foreground">
          <th scope="col" className="py-1 font-normal" />
          <th scope="col" className="py-1 text-right font-normal">
            Before
          </th>
          <th scope="col" className="py-1 text-right font-normal">
            After
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([name, x, y]) => (
          <tr key={name} className="border-t">
            <th scope="row" className="py-1.5 text-left font-normal capitalize">
              {name}
            </th>
            <td className="py-1.5 text-right tabular-nums">{money(x)}</td>
            <td className={`py-1.5 text-right tabular-nums ${x !== y ? "font-medium" : "text-muted-foreground"}`}>{money(y)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
