"use client";

// The agent's shortlist, rendered inside the thread — every eligible plan on
// the panel, side by side, with the same terms the broker's own
// `PlanComparison` (app/applications/[id]/page.tsx) shows: deductible,
// co-pay, annual limit, maternity, existing-condition cover, network. The
// recommended plan carries the system's own reasoning underneath it; the
// others carry their own terms and nothing more — no broker-register
// rejection prose, which names the cohort and does not belong here (see the
// comment on `getActiveShortlist`, lib/queries.ts). Every plan gets its own
// equal "Choose this plan" button — this is the applicant's panel, not a
// nudge toward one answer.

import { useState, useTransition } from "react";
import { pickPlan, rejectShortlist } from "@/app/applications/new/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { money, monthsLabel, percent } from "@/lib/domain";
import type { ActiveShortlistPlan } from "@/lib/queries";

const NETWORK_LABEL: Record<string, string> = { restricted: "Restricted", standard: "Standard", wide: "Wide" };

/**
 * `capitalize` used to sit on the value cell and title-cased every word in it
 * — "AED 10,000 after 12 months" came out as "AED 10,000 After 12 Months".
 * Values arrive already written the way they should read.
 */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function PlanTerms({ plan }: { plan: ActiveShortlistPlan }) {
  return (
    <dl className="mt-3 space-y-1.5 text-sm">
      <Row label="Deductible" value={money(plan.deductible)} />
      <Row label="Co-pay" value={percent(plan.outpatientCopayPct)} />
      <Row label="Annual limit" value={money(plan.annualLimit)} />
      <Row
        label="Maternity"
        value={plan.maternityCovered ? `${money(plan.maternityLimit)} after ${monthsLabel(plan.maternityWaitingPeriodMonths).toLowerCase()}` : "Not covered"}
      />
      <Row label="Existing conditions" value={plan.chronicCovered ? monthsLabel(plan.chronicWaitingPeriodMonths) : "Not covered"} />
      <Row label="Network" value={NETWORK_LABEL[plan.network] ?? plan.network} />
    </dl>
  );
}

export function PlanCard({
  conversationId,
  plans,
  memberReasoning,
  selectedPlanId = null,
}: {
  conversationId: string;
  /** Every eligible plan on the panel, one flagged `recommended`. */
  plans: ActiveShortlistPlan[];
  /** The system's own reasoning for the recommended plan — never shown under any other. */
  memberReasoning: string;
  /**
   * Set once the applicant has actually picked a plan off this shortlist
   * (`pickPlan`, app/applications/new/actions.ts — Review 2, doc §2.2). The
   * card then reads as a receipt of that choice, not an open offer: one
   * plan, no buttons, no "none of these fit" — that decision is made.
   */
  selectedPlanId?: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [showReject, setShowReject] = useState(false);

  const choose = (planId: string) => startTransition(async () => { await pickPlan(conversationId, planId); });
  const reject = (formData: FormData) =>
    startTransition(async () => {
      await rejectShortlist(conversationId, formData);
    });

  if (selectedPlanId) {
    const chosen = plans.find((p) => p.planId === selectedPlanId) ?? plans[0];
    if (!chosen) return null;
    return (
      <div className="w-full max-w-md space-y-2 rounded-2xl rounded-bl-sm border bg-card p-4 shadow-sm">
        <p className="text-xs font-medium text-muted-foreground">You chose this plan</p>
        <div className="flex flex-wrap items-baseline gap-2">
          <p className="font-medium">{chosen.name}</p>
          <span className="text-sm text-muted-foreground">{money(chosen.annualPremium)} a year</span>
        </div>
        <p className="text-sm leading-relaxed text-pretty text-muted-foreground">{memberReasoning}</p>
        <PlanTerms plan={chosen} />
      </div>
    );
  }

  return (
    <div className="w-full max-w-3xl space-y-4 rounded-2xl rounded-bl-sm border bg-card p-4 shadow-sm">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {plans.map((plan) => (
          <div
            key={plan.planId}
            className={plan.recommended ? "rounded-xl border-2 border-brand bg-brand-subtle/30 p-4" : "rounded-xl border p-4"}
          >
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium">{plan.name}</p>
              {plan.recommended ? <Badge>Recommended</Badge> : null}
            </div>
            <p className="mt-1 text-xl font-semibold tabular-nums">{money(plan.annualPremium)}</p>
            <p className="text-xs text-muted-foreground">per year</p>

            {plan.recommended ? (
              <p className="mt-2 text-sm leading-relaxed text-pretty text-muted-foreground">{memberReasoning}</p>
            ) : null}

            <PlanTerms plan={plan} />

            <Button size="sm" className="mt-3 w-full" variant={plan.recommended ? "default" : "outline"} disabled={pending} onClick={() => choose(plan.planId)}>
              {pending ? <Spinner /> : plan.recommended ? "Choose this plan" : "Choose instead"}
            </Button>
          </div>
        ))}
      </div>

      <div className="border-t pt-3">
        {showReject ? (
          <form action={reject} className="space-y-2">
            <Textarea name="reason" rows={2} placeholder="What doesn't fit? (optional)" />
            <div className="flex gap-2">
              <Button type="submit" size="sm" variant="outline" disabled={pending}>
                {pending ? <Spinner /> : "Send"}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setShowReject(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setShowReject(true)}>
            None of these fit
          </Button>
        )}
      </div>
    </div>
  );
}
