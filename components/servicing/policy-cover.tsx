// The utilization and coverage-terms cards. These are the same facts for both
// audiences — spec §4b lists plan terms, premium and utilization as visible to
// both — so the components are shared. The WORDING is not: each view passes its
// own title and description, and nothing here knows who is reading.

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { UtilizationBar } from "@/components/utilization";
import { money, monthsLabel, percent } from "@/lib/domain";
import type { PolicyRecord } from "@/lib/queries";

export function UtilizationCard({
  record,
  title,
  description,
  maternityHint = true,
}: {
  record: PolicyRecord;
  title: string;
  description: string;
  /** The exhausted-benefit sentence is written to a member; a broker reads the numbers. */
  maternityHint?: boolean;
}) {
  const { plan, ledger } = record;
  const deductibleMet = Number(ledger?.deductibleMet ?? 0);
  const annualPaid = Number(ledger?.annualPaid ?? 0);
  const maternityUsed = Number(ledger?.sublimitUsed?.maternity ?? 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <UtilizationBar
          label="Deductible"
          used={deductibleMet}
          cap={plan.deductible}
          fullIsGood
          hint={
            plan.deductible === 0
              ? "This plan has no deductible."
              : deductibleMet >= plan.deductible
                ? "Met for the year. New claims skip straight to the co-pay."
                : `${money(plan.deductible - deductibleMet)} to go before the plan starts paying.`
          }
        />
        <UtilizationBar
          label="Annual limit"
          used={annualPaid}
          cap={plan.annualLimit}
          hint={`${money(plan.annualLimit - annualPaid)} of cover left this year.`}
        />
        {plan.maternityCovered && plan.maternityLimit ? (
          <UtilizationBar
            label="Maternity"
            used={maternityUsed}
            cap={plan.maternityLimit}
            tone="warning"
            hint={
              maternityHint && maternityUsed >= plan.maternityLimit
                ? "This benefit is fully used for the year — further maternity costs fall to you."
                : undefined
            }
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

export function CoverTermsCard({ record, title, description }: { record: PolicyRecord; title: string; description: string }) {
  const { plan, policy } = record;
  const terms: [string, string][] = [
    ["Premium", money(policy.annualPremium)],
    ["Deductible", money(plan.deductible)],
    ["Co-pay", percent(plan.outpatientCopayPct)],
    ["Annual limit", money(plan.annualLimit)],
    ["Network", plan.network],
    ["Dental & optical", plan.dentalOptical],
    ["Maternity", plan.maternityCovered ? `${money(plan.maternityLimit)} after ${monthsLabel(plan.maternityWaitingPeriodMonths)}` : "Not covered"],
    ["Existing conditions", plan.chronicCovered ? monthsLabel(plan.chronicWaitingPeriodMonths) : "Not covered"],
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          {terms.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="font-medium first-letter:uppercase">{value}</dd>
            </div>
          ))}
        </dl>
        {plan.networkNote ? <p className="mt-4 text-xs text-muted-foreground text-pretty">{plan.networkNote}</p> : null}
      </CardContent>
    </Card>
  );
}
