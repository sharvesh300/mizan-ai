// One event, as the MEMBER reads it.
//
// The prop type is a row of `customer_event_view`. That view cannot project
// confidence, uncertainty_reason, decided_by or the broker's prose, so nothing in
// this file can reach for one — the compiler refuses, which is the point
// (plan §13.4). Do not widen this to a `servicing_event` row.
//
// Order of the page a member reads: the verdict, the three numbers, why, then how
// it was worked out. The prose already carries the dated next step (the wait ends
// on 1 July; the limit resets on 1 January) because it was written from
// `lib/servicing/next-steps.ts`, not typed.

import { StatusDot } from "@/components/status-badge";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { figureLabels } from "@/lib/servicing/labels";
import { memberSettlementLine } from "@/lib/servicing/settlement";
import { benefitClassLabel, eventKindLabel, monthWithDate, outcomeLabel, outcomeTone, reasonCodeLabel, type Tone } from "@/lib/domain";
import type { MemberEvent } from "@/lib/queries";
import { AppealButton } from "./appeal-button";
import { CalculationTrace, ESTIMATE_LABEL, Money, OutcomeBadge, traceLines } from "./primitives";

export function MemberEventCard({ event, inceptionDate, canAppeal = false, payment = null }: { event: MemberEvent; inceptionDate: string; /** The LOG says this decision can be appealed right now — decided by the server, never by this component. */ canAppeal?: boolean; /** Where the money is, if the plan owed any. Status and date only — never a reference or an advisor's name. */ payment?: { status: "awaiting_approval" | "approved" | "paid"; paidOn: string | null } | null }) {
  const estimate = event.kind === "preauth";
  const outcome = event.outcome;
  const tone: Tone = outcome ? (estimate && outcomeTone[outcome] === "success" ? "info" : outcomeTone[outcome]) : "neutral";
  const [billedLabel, planLabel, memberLabel] = figureLabels[event.kind];

  return (
    <li id={`event-${event.id}`} className="@container">
      <Card className={estimate ? "border-dashed" : undefined}>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <StatusDot tone={tone} />
            {event.description ?? eventKindLabel[event.kind]}
            {estimate ? <StatusBadge tone="info">Estimate</StatusBadge> : null}
            {outcome ? <OutcomeBadge outcome={outcome} tone={tone} label={estimate ? (ESTIMATE_LABEL[outcome] ?? outcomeLabel[outcome]) : undefined} /> : null}
          </CardTitle>
          <CardDescription className="flex flex-wrap items-center gap-x-2">
            <span>{eventKindLabel[event.kind]}</span>
            <span>· {monthWithDate(inceptionDate, event.policyMonth)}</span>
            {event.benefitClass ? <span>· {benefitClassLabel[event.benefitClass]}</span> : null}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Stack the figures on a narrow card: a six-figure amount does not fit a third of a phone. */}
          <dl className="grid gap-2 @[24rem]:grid-cols-3 @[24rem]:gap-4">
            <div className="flex items-baseline justify-between gap-3 @[24rem]:block">
              <dt className="text-xs text-muted-foreground">{billedLabel}</dt>
              <dd className="font-medium">
                <Money value={event.billedAmount ?? event.estimatedAmount} />
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 @[24rem]:block">
              <dt className="text-xs text-muted-foreground">{planLabel}</dt>
              <dd className="font-medium text-success">
                <Money value={event.planPays} />
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3 @[24rem]:block">
              <dt className="text-xs text-muted-foreground">{memberLabel}</dt>
              <dd className="font-medium">
                <Money value={event.memberPays} />
              </dd>
            </div>
          </dl>

          {/* Where their money is. Today the card says "the plan pays 2,000" and stops, which answers a question
              the member was not asking: what they want to know is whether it has arrived. */}
          {payment ? (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{memberSettlementLine(payment.status, payment.paidOn)}</span>
            </p>
          ) : null}

          {event.reasonCode ? (
            <Alert>
              <AlertTitle>{reasonCodeLabel[event.reasonCode]}</AlertTitle>
              <AlertDescription className="text-pretty">{event.explanation ?? reasonCodeLabel[event.reasonCode]}</AlertDescription>
            </Alert>
          ) : null}

          {canAppeal ? (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Think this is wrong? You can send us something that shows why, and we&apos;ll look again.</p>
              <AppealButton policyId={event.policyId} eventId={event.id} />
            </div>
          ) : null}

          <CalculationTrace lines={traceLines(event.calculation)} />
        </CardContent>
      </Card>
    </li>
  );
}
