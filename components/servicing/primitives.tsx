// The few things a member's card and a broker's row genuinely share.
//
// Nothing here takes a `role` or an `isAdvisor` — that is the rule (plan §13.4).
// The two audiences are two components (`MemberEventCard`, `BrokerEventRow`) built
// from these primitives. A shared component that branches on who is looking is the
// "same object with different styling" the brief warns against, and it is one
// dropped conditional away from putting a broker's note in front of a member.

import { StatusBadge } from "@/components/status-badge";
import { money, outcomeLabel, outcomeTone } from "@/lib/domain";
import type { EventOutcome } from "@/db/schema";
import { cn } from "cn";

/** A money amount: AED, tabular figures so a column of them lines up. */
export function Money({ value, className }: { value: number | string | null | undefined; className?: string }) {
  return <span className={cn("tabular-nums", className)}>{money(value === null || value === undefined ? null : Number(value))}</span>;
}

/** `calculation` is stored as JSON of unknown shape; only strings are traces. */
export function traceLines(calculation: unknown): string[] {
  return Array.isArray(calculation) ? calculation.filter((line): line is string => typeof line === "string") : [];
}

/**
 * The arithmetic trace, closed by default. A native <details>: keyboard-accessible,
 * needs no script, and the component library has no accordion. Closed because the
 * trace is for the reader who wants to check the answer, not the one who wants it.
 */
export function CalculationTrace({ lines, label = "How that was worked out" }: { lines: string[]; label?: string }) {
  if (lines.length === 0) return null;
  return (
    <details className="group rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none marker:text-muted-foreground group-open:mb-2">
        {label}
      </summary>
      <ol className="space-y-1 font-mono text-xs text-muted-foreground">
        {lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ol>
    </details>
  );
}

/** The outcome as a labelled badge. Text always — colour alone never carries a verdict. */
export function OutcomeBadge({ outcome, label, tone }: { outcome: EventOutcome; label?: string; tone?: Parameters<typeof StatusBadge>[0]["tone"] }) {
  return <StatusBadge tone={tone ?? outcomeTone[outcome]}>{label ?? outcomeLabel[outcome]}</StatusBadge>;
}

/**
 * A pre-authorization is a forecast, not a decision, and must not be mistakable for one: different words, and a
 * softer tone than a real "covered". Shared by the history card and the outcome card so the two cannot disagree.
 */
export const ESTIMATE_LABEL: Partial<Record<EventOutcome, string>> = {
  covered: "Expected to be covered",
  approved_with_limit: "Covered up to a limit",
  denied: "Wouldn't be covered",
};
