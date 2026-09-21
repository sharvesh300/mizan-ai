import { eq } from "drizzle-orm";
import { ArrowRightIcon, LightbulbIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageBody, PageHeader } from "@/components/page-header";
import { StatusBadge, StatusDot } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { UtilizationBar } from "@/components/utilization";
import { db } from "@/db/client";
import { benefitLedger, person, plan as planTable, policy as policyTable } from "@/db/schema";
import {
  dateLabel,
  eventKindLabel,
  money,
  monthsLabel,
  outcomeLabel,
  outcomeTone,
  percent,
  reasonCodeLabel,
} from "@/lib/domain";
import { listEvents, listReassessments } from "@/lib/queries";
import { getCurrentUser } from "@/lib/session";

export default async function PolicyPage(props: PageProps<"/policies/[id]">) {
  const { id } = await props.params;
  const user = await getCurrentUser();
  if (!user) return null;

  const [row] = await db
    .select({ policy: policyTable, plan: planTable, ledger: benefitLedger, subject: person })
    .from(policyTable)
    .innerJoin(planTable, eq(policyTable.planId, planTable.id))
    .innerJoin(person, eq(policyTable.personId, person.id))
    .leftJoin(benefitLedger, eq(benefitLedger.policyId, policyTable.id))
    .where(eq(policyTable.id, id))
    .limit(1);

  if (!row) notFound();
  const isAdvisor = user.role === "advisor";
  if (!isAdvisor && row.subject.ownerUserId !== user.id) notFound();

  const [events, reassessments] = await Promise.all([listEvents(id), listReassessments(id)]);
  const { policy, plan, ledger } = row;
  const sublimitUsed = ledger?.sublimitUsed ?? {};

  return (
    <>
      <PageHeader
        backHref="/policies"
        backLabel={isAdvisor ? "Policies" : "My cover"}
        title={plan.name}
        description={`${policy.policyNumber} · ${row.subject.fullName} · active since ${dateLabel(policy.inceptionDate)}`}
      >
        <StatusBadge tone={policy.status === "active" ? "success" : "neutral"}>{policy.status}</StatusBadge>
      </PageHeader>

      <PageBody className="space-y-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>What you&apos;ve used</CardTitle>
              <CardDescription>Everything below is worked out from your claim history.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <UtilizationBar
                label="Deductible"
                used={ledger?.deductibleMet ?? 0}
                cap={plan.deductible}
                hint={
                  (ledger?.deductibleMet ?? 0) >= plan.deductible
                    ? "Met for the year. New claims skip straight to the co-pay."
                    : `${money(plan.deductible - (ledger?.deductibleMet ?? 0))} to go before the plan starts paying.`
                }
              />
              <UtilizationBar
                label="Annual limit"
                used={ledger?.annualPaid ?? 0}
                cap={plan.annualLimit}
                hint={`${money(plan.annualLimit - (ledger?.annualPaid ?? 0))} of cover left this year.`}
              />
              {plan.maternityCovered && plan.maternityLimit ? (
                <UtilizationBar
                  label="Maternity"
                  used={sublimitUsed.maternity ?? 0}
                  cap={plan.maternityLimit}
                  tone="warning"
                  hint={
                    (sublimitUsed.maternity ?? 0) >= plan.maternityLimit
                      ? "This benefit is fully used for the year — further maternity costs fall to you."
                      : undefined
                  }
                />
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Your cover</CardTitle>
              <CardDescription>The terms your claims are settled against.</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-4 text-sm">
                {[
                  ["Premium", money(policy.annualPremium)],
                  ["Deductible", money(plan.deductible)],
                  ["Co-pay", percent(plan.outpatientCopayPct)],
                  ["Annual limit", money(plan.annualLimit)],
                  ["Network", plan.network],
                  ["Dental & optical", plan.dentalOptical],
                  [
                    "Maternity",
                    plan.maternityCovered
                      ? `${money(plan.maternityLimit)} after ${monthsLabel(plan.maternityWaitingPeriodMonths)}`
                      : "Not covered",
                  ],
                  [
                    "Existing conditions",
                    plan.chronicCovered ? monthsLabel(plan.chronicWaitingPeriodMonths) : "Not covered",
                  ],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="font-medium first-letter:uppercase">{value}</dd>
                  </div>
                ))}
              </dl>
              {plan.networkNote ? (
                <p className="mt-4 text-xs text-muted-foreground text-pretty">{plan.networkNote}</p>
              ) : null}
            </CardContent>
          </Card>
        </div>

        {reassessments.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <LightbulbIcon className="size-4 text-brand" />
                Does this plan still fit?
              </CardTitle>
              <CardDescription>Reviewed against what has actually happened on this policy.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {reassessments.map(({ reassessment, plan: suggested }) => (
                <div key={reassessment.id} className="space-y-2">
                  <StatusBadge tone={reassessment.verdict === "confirm" ? "success" : "warning"}>
                    {reassessment.verdict === "confirm"
                      ? "Still the right plan"
                      : `Consider moving to ${suggested?.name ?? "another plan"}`}
                  </StatusBadge>
                  <p className="text-sm leading-relaxed text-pretty">
                    {isAdvisor ? reassessment.brokerReasoning : reassessment.memberReasoning}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-medium">Claim history</h2>
            <p className="text-sm text-muted-foreground">
              {isAdvisor
                ? "The event log — the source of truth the ledger above is projected from."
                : "Everything that has happened on your policy, and what each one cost you."}
            </p>
          </div>

          {events.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                Nothing claimed yet.
              </CardContent>
            </Card>
          ) : (
            <ol className="space-y-3">
              {events.map((event) => (
                <li key={event.id}>
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                        <StatusDot tone={event.outcome ? outcomeTone[event.outcome] : "neutral"} />
                        {event.description ?? eventKindLabel[event.kind]}
                        {event.outcome ? (
                          <StatusBadge tone={outcomeTone[event.outcome]}>{outcomeLabel[event.outcome]}</StatusBadge>
                        ) : null}
                      </CardTitle>
                      <CardDescription className="flex flex-wrap items-center gap-x-2">
                        <span>{eventKindLabel[event.kind]}</span>
                        <span>· month {event.policyMonth}</span>
                        {event.benefitClass ? <span>· {event.benefitClass.replace(/_/g, " ")}</span> : null}
                        {isAdvisor && event.externalRef ? (
                          <Badge variant="outline" className="font-mono">
                            {event.externalRef}
                          </Badge>
                        ) : null}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                        <div>
                          <dt className="text-xs text-muted-foreground">
                            {event.kind === "preauth" ? "Estimated" : "Billed"}
                          </dt>
                          <dd className="font-medium tabular-nums">
                            {money(event.billedAmount ?? event.estimatedAmount)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">Plan pays</dt>
                          <dd className="font-medium tabular-nums text-success">{money(event.planPays)}</dd>
                        </div>
                        <div>
                          <dt className="text-xs text-muted-foreground">
                            {isAdvisor ? "Member pays" : "You pay"}
                          </dt>
                          <dd className="font-medium tabular-nums">{money(event.memberPays)}</dd>
                        </div>
                      </dl>

                      {/* Same reason_code for both audiences; the prose around
                          it is written twice, never filtered. */}
                      {event.reasonCode ? (
                        <Alert>
                          <AlertTitle>{reasonCodeLabel[event.reasonCode]}</AlertTitle>
                          <AlertDescription className="text-pretty">
                            {isAdvisor
                              ? (event.brokerExplanation ?? event.memberExplanation)
                              : (event.memberExplanation ?? reasonCodeLabel[event.reasonCode])}
                          </AlertDescription>
                        </Alert>
                      ) : null}

                      {Array.isArray(event.calculation) && event.calculation.length > 0 ? (
                        <>
                          <Separator />
                          <div>
                            <p className="mb-1.5 text-xs text-muted-foreground">How that was worked out</p>
                            <ol className="space-y-1 font-mono text-xs text-muted-foreground">
                              {(event.calculation as string[]).map((line, index) => (
                                <li key={index}>{line}</li>
                              ))}
                            </ol>
                          </div>
                        </>
                      ) : null}
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ol>
          )}
        </section>

        {isAdvisor ? (
          <Card>
            <CardContent>
              <Link
                href={`/applications/${policy.applicationId}`}
                className="flex items-center gap-2 text-sm font-medium text-brand hover:underline"
              >
                Open the application this policy came from
                <ArrowRightIcon className="size-4" />
              </Link>
            </CardContent>
          </Card>
        ) : null}
      </PageBody>
    </>
  );
}
