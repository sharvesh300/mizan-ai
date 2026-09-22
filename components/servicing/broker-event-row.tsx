// One event, as the BROKER reads it — the full record.
//
// Where the member card answers "what happened to me and what do I do", this
// answers "which policy, which event, how sure was the system, who decided, and
// what does it imply". It also shows the broker WHAT THE MEMBER WAS TOLD, in a
// closed <details> under the broker's own note: two documents side by side, so a
// broker can see they are two documents — and can catch a member message that
// reads badly before deciding, not after.

import { ArrowRightIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { StatusBadge, StatusDot } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { confidenceBand, eventKindLabel, money, outcomeTone, reasonCodeLabel } from "@/lib/domain";
import { monthYear, policyMonthStart } from "@/lib/servicing/dates";
import type { EventDrift } from "@/lib/servicing/store";
import type { BrokerEvent } from "@/lib/queries";
import { CalculationTrace, Money, OutcomeBadge, traceLines } from "./primitives";

type LedgerJson = { deductible_met?: number; annual_paid?: number; sublimit_used?: Record<string, number> };
const asLedger = (value: unknown): LedgerJson | null => (value && typeof value === "object" ? (value as LedgerJson) : null);

/** Only what moved. "Ledger unchanged" is itself information: a denial consumed nothing. */
function ledgerChanges(before: unknown, after: unknown): string[] {
  const a = asLedger(before);
  const b = asLedger(after);
  if (!a || !b) return [];
  const out: string[] = [];
  const diff = (label: string, x?: number, y?: number) => {
    if (x !== undefined && y !== undefined && Number(x) !== Number(y)) out.push(`${label} ${money(Number(x))} → ${money(Number(y))}`);
  };
  diff("Deductible met", a.deductible_met, b.deductible_met);
  diff("Annual paid", a.annual_paid, b.annual_paid);
  diff("Maternity used", a.sublimit_used?.maternity, b.sublimit_used?.maternity);
  return out;
}

const CONFIDENCE_TONE = { high: "success", medium: "info", low: "warning" } as const;

export function BrokerEventRow({
  item,
  inceptionDate,
  refOf,
  supersededBy,
  restated,
}: {
  item: BrokerEvent;
  inceptionDate: string;
  /** event id → its reference (CLM-4), so a supersession chain reads in the vocabulary a broker uses. */
  refOf: Map<string, string>;
  /** The reference of the event that superseded this one, if any. */
  supersededBy: string | null;
  /** Fields where this event's stored result differs from a replay for a legitimate reason (§3.2). */
  restated: EventDrift[];
}) {
  const { event, decidedByName } = item;
  const ref = event.externalRef ?? event.id.slice(0, 8);
  const band = confidenceBand(event.confidence);
  const changes = ledgerChanges(event.ledgerBefore, event.ledgerAfter);
  const supersedes = event.supersedesEventId ? (refOf.get(event.supersedesEventId) ?? "an earlier event") : null;
  const forecast = event.kind === "preauth";
  const showNote = event.uncertaintyReason && band !== "high";

  return (
    <li id={`event-${event.id}`}>
      <Card className={forecast ? "border-dashed" : undefined}>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <StatusDot tone={event.outcome ? outcomeTone[event.outcome] : "neutral"} />
            {event.description ?? eventKindLabel[event.kind]}
            {event.outcome ? <OutcomeBadge outcome={event.outcome} /> : null}
          </CardTitle>
          <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <Badge variant="outline" className="font-mono">
              {ref}
            </Badge>
            <span>{eventKindLabel[event.kind]}</span>
            <span>
              · month {event.policyMonth} ({monthYear(policyMonthStart(inceptionDate, event.policyMonth))})
            </span>
            {event.benefitClass ? <span>· {event.benefitClass.replace(/_/g, " ")}</span> : null}
            {event.providerTier ? <span>· {event.providerTier.replace(/_/g, " ")}</span> : null}
            {event.geography !== "uae" ? <StatusBadge tone="warning">treated {event.geography}</StatusBadge> : null}
            <Link href={`/policies/${event.policyId}/events/${event.id}`} className="ml-auto flex items-center gap-1 text-xs hover:text-foreground">
              Open the case <ArrowRightIcon className="size-3" />
            </Link>
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge tone="neutral">
              Decided by {event.decidedBy === "advisor" ? (decidedByName ?? "an advisor") : "the system"}
            </StatusBadge>
            {band ? (
              <StatusBadge tone={CONFIDENCE_TONE[band]}>{band} confidence</StatusBadge>
            ) : event.outcome === "insufficient_data" ? (
              <StatusBadge tone="warning">No answer from the plan terms</StatusBadge>
            ) : null}
            {supersedes ? (
              <StatusBadge tone="brand">
                <ArrowRightIcon className="size-3" />
                Supersedes {supersedes}
              </StatusBadge>
            ) : null}
            {supersededBy ? <StatusBadge tone="neutral">Superseded by {supersededBy}</StatusBadge> : null}
            {restated.length > 0 ? (
              <StatusBadge tone="info">
                <RefreshCwIcon className="size-3" />
                Restated
              </StatusBadge>
            ) : null}
          </div>

          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">{forecast ? "Estimated" : "Billed"}</dt>
              <dd className="font-medium">
                <Money value={event.billedAmount ?? event.estimatedAmount} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Plan pays</dt>
              <dd className="font-medium text-success">
                <Money value={event.planPays} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Member pays</dt>
              <dd className="font-medium">
                <Money value={event.memberPays} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Ledger</dt>
              <dd className="text-xs text-muted-foreground">
                {forecast ? "Forecast — nothing written" : changes.length ? changes.map((c) => <span key={c} className="block">{c}</span>) : "Unchanged"}
              </dd>
            </div>
          </dl>

          {showNote ? (
            <Alert className="border-warning/40">
              <AlertTitle>Why this is worth a look</AlertTitle>
              <AlertDescription className="text-pretty">{event.uncertaintyReason}</AlertDescription>
            </Alert>
          ) : null}

          {restated.length > 0 ? (
            <p className="rounded-md border border-info/30 bg-info-subtle px-3 py-2 text-xs text-pretty">
              <span className="font-medium">Restated.</span> This was recorded before a later appeal was reversed at an earlier position in the history, so
              replaying the log now gives a different result:{" "}
              {restated.map((d) => `${d.field.replace(/_/g, " ")} ${d.stored} → ${d.replayed}`).join("; ")}. Expected under the spec&apos;s rule that an overturn
              writes at the original event&apos;s position — not drift.
            </p>
          ) : null}

          {event.reasonCode ? (
            <Alert>
              <AlertTitle className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">{event.reasonCode}</span>
                <span className="font-normal text-muted-foreground">{reasonCodeLabel[event.reasonCode]}</span>
              </AlertTitle>
              <AlertDescription className="text-pretty">{event.brokerExplanation ?? event.memberExplanation}</AlertDescription>
            </Alert>
          ) : null}

          {event.memberExplanation ? (
            <details className="group rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none group-open:mb-2">
                What the member was told
              </summary>
              <p className="text-pretty text-muted-foreground">{event.memberExplanation}</p>
            </details>
          ) : null}

          <CalculationTrace lines={traceLines(event.calculation)} label="Calculation trace" />

          {event.evidenceText ? (
            <details className="group rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none group-open:mb-2">Evidence on file</summary>
              <p className="whitespace-pre-line text-pretty text-muted-foreground">{event.evidenceText}</p>
            </details>
          ) : null}
        </CardContent>
      </Card>
    </li>
  );
}
