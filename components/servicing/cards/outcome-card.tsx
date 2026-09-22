"use client";

// The outcome, and the estimate — verdict, then the three numbers, then why, then what to do, then how it
// was worked out (plan §13.2.5). One component, two payloads, because they are the same sentence with a
// different weight: an ESTIMATE has a dashed border, an "Estimate" badge and softer words, so it cannot be
// mistaken for a decision.

import { GavelIcon } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { outcomeLabel, outcomeTone, type Tone } from "@/lib/domain";
import type { EstimateCard as EstimatePayload, OutcomeCard as OutcomePayload } from "@/lib/servicing/cards";
import { CalculationTrace, ESTIMATE_LABEL, Money } from "../primitives";
import { CardShell, TOUCH, type CardViewProps } from "./shell";

export function OutcomeCard({ card, handlers, disabled, focusOnMount, canAppeal = true }: { card: OutcomePayload | EstimatePayload; /** False until the appeal loop exists: a button that does nothing is worse than no button. */ canAppeal?: boolean } & CardViewProps) {
  const estimate = card.kind === "servicing_estimate";
  const tone: Tone = estimate && outcomeTone[card.outcome] === "success" ? "info" : outcomeTone[card.outcome];
  const label = estimate ? (ESTIMATE_LABEL[card.outcome] ?? outcomeLabel[card.outcome]) : outcomeLabel[card.outcome];
  const denied = card.outcome === "denied";
  const { billed, plan, member } = card.figures;

  return (
    <CardShell label={estimate ? "Your estimate" : "The outcome"} wide dashed={estimate} focusOnMount={focusOnMount}>
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-medium text-pretty">{card.title}</h3>
          {estimate ? <StatusBadge tone="info">Estimate</StatusBadge> : null}
          <StatusBadge tone={tone}>{label}</StatusBadge>
        </div>
        <p className="text-xs text-muted-foreground">
          {card.monthLabel} · {card.categoryLabel}
        </p>
      </div>

      {/* Three columns only when they fit: "AED 180,000" needs ~92px, and a phone gives each column ~80. Below the
          card width where that holds, the figures stack as label-left, value-right rows instead. */}
      <dl className="grid gap-2 rounded-lg border bg-muted/30 px-3 py-2.5 @[22rem]:grid-cols-3 @[22rem]:gap-3">
        {[billed, plan, member].map((f, i) => (
          <div key={f.label} className="flex items-baseline justify-between gap-3 @[22rem]:block">
            <dt className="text-xs text-muted-foreground">{f.label}</dt>
            <dd className={`font-medium ${i === 1 ? "text-success" : ""}`}>
              <Money value={f.value} />
            </dd>
          </div>
        ))}
      </dl>

      <p className="text-sm leading-relaxed text-pretty">{card.explanation}</p>

      {card.nextSteps.length > 0 || (!estimate && card.appealable && canAppeal) ? (
        <div className="space-y-2">
          <p className="text-xs font-medium">{denied ? "What you can do" : "What happens next"}</p>
          {card.nextSteps.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-sm text-pretty">
              {card.nextSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          ) : null}
          {!estimate && card.appealable && canAppeal ? (
            <Button type="button" variant="outline" className={TOUCH} disabled={disabled} onClick={() => handlers?.onAppeal?.()}>
              <GavelIcon />
              Appeal this decision
            </Button>
          ) : null}
        </div>
      ) : null}

      {(estimate ? card.caveat : card.settlement) ? <p className="text-xs text-muted-foreground text-pretty">{estimate ? card.caveat : card.settlement}</p> : null}

      <CalculationTrace lines={card.trace} />
    </CardShell>
  );
}
