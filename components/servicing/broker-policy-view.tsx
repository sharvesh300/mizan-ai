// The broker's policy record — the full picture (brief: "the full record").
//
// Everything the member sees, plus what a member must not: how sure the system was
// and why, who decided each event, both explanations side by side, and the ledger
// as a running table with proof it can be rebuilt from history. Reads the whole
// `servicing_event` row. This is a different component tree from the member's on
// purpose (plan §13.4) — sharing only primitives, never a role flag.

import { ArrowRightIcon, LightbulbIcon } from "lucide-react";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { dateLabel } from "@/lib/domain";
import { listBrokerEvents, listBrokerReassessments, listBrokerSettlements, type PolicyRecord } from "@/lib/queries";
import { checkReplay, replayPolicy } from "@/lib/servicing/store";
import { BrokerEventRow } from "./broker-event-row";
import { CitationChips } from "./citation-chip";
import { SettlementPanel } from "./settlement-panel";
import { LedgerTable } from "./ledger-table";
import { CoverTermsCard, UtilizationCard } from "./policy-cover";
import { ReplayChip } from "./replay-chip";

export async function BrokerPolicyView({ record }: { record: PolicyRecord }) {
  const { policy, plan, subject } = record;
  const [events, reassessments, settlements, replayed, report] = await Promise.all([
    listBrokerEvents(policy.id),
    listBrokerReassessments(policy.id),
    listBrokerSettlements(policy.id),
    replayPolicy(policy.id),
    checkReplay(policy.id),
  ]);

  const refOf = new Map(events.map(({ event }) => [event.id, event.externalRef ?? event.id.slice(0, 8)]));
  const supersededBy = new Map<string, string>();
  for (const { event } of events) {
    if (event.supersedesEventId) supersededBy.set(event.supersedesEventId, event.externalRef ?? event.id.slice(0, 8));
  }

  return (
    <>
      <PageHeader
        backHref="/policies"
        backLabel="Policies"
        title={plan.name}
        description={`${policy.policyNumber} · ${subject.fullName} · active since ${dateLabel(policy.inceptionDate)}`}
      >
        <StatusBadge tone={policy.status === "active" ? "success" : "neutral"}>{policy.status}</StatusBadge>
      </PageHeader>

      <PageBody className="space-y-6">
        <ReplayChip report={report} />

        <div className="grid gap-4 lg:grid-cols-2">
          <UtilizationCard
            record={record}
            title="Utilization"
            description="Projected from the event log below — never edited directly."
            maternityHint={false}
          />
          <CoverTermsCard record={record} title="Plan terms" description="What every event on this policy is adjudicated against." />
        </div>

        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-medium">Running ledger</h2>
            <p className="text-sm text-muted-foreground">
              One row per event, in the order it took effect — an overturn lands at the denial&apos;s position, not the appeal&apos;s. A pre-authorization is a
              forecast: it reads the ledger and never moves it.
            </p>
          </div>
          {replayed.steps.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">No events on this policy yet.</CardContent>
            </Card>
          ) : (
            <LedgerTable replayed={replayed} />
          )}
        </section>

        {reassessments.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <LightbulbIcon className="size-4 text-brand" />
                Does this plan still fit?
              </CardTitle>
              <CardDescription>Reviewed against what has actually happened on this policy.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {reassessments.map(({ reassessment, plan: suggested }) => (
                <div key={reassessment.id} className="space-y-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge tone={reassessment.verdict === "confirm" ? "success" : "warning"}>
                      {reassessment.verdict === "confirm" ? "Confirm" : `Recommend change to ${suggested?.name ?? "another plan"}`}
                    </StatusBadge>
                    <StatusBadge tone="neutral">Written by {reassessment.createdBy}</StatusBadge>
                  </div>
                  <p className="text-sm leading-relaxed text-pretty">{reassessment.brokerReasoning}</p>
                  <CitationChips citations={reassessment.citations} register="broker" />
                  <details className="group rounded-md border bg-muted/30 px-3 py-2 text-sm">
                    <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none group-open:mb-2">What the member was told</summary>
                    <p className="text-pretty text-muted-foreground">{reassessment.memberReasoning}</p>
                    <CitationChips citations={reassessment.citations} register="member" />
                  </details>
                  {reassessment.verdict === "recommend_change" ? (
                    <Link
                      href={`/policies/${policy.id}/reassess/${reassessment.id}`}
                      className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
                    >
                      Open the case
                      <ArrowRightIcon className="size-3.5" />
                    </Link>
                  ) : null}
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        {settlements.length > 0 ? (
          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-medium">Payments</h2>
              <p className="text-sm text-muted-foreground">
                What the plan owes, and whether it has actually left. A payment is not an adjudication: nothing here moves the
                ledger above, and dropping every row would not change a single outcome.
              </p>
            </div>
            <div className="space-y-2">
              {settlements.map((s) => (
                <SettlementPanel key={s.settlementId} policyId={policy.id} row={s} />
              ))}
            </div>
          </section>
        ) : null}

        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-medium">History</h2>
            <p className="text-sm text-muted-foreground">The event log — the source of truth the ledger above is projected from. Nothing here is ever edited or deleted.</p>
          </div>
          {events.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">Nothing claimed yet.</CardContent>
            </Card>
          ) : (
            <ol className="space-y-3">
              {events.map((item) => (
                <BrokerEventRow
                  key={item.event.id}
                  item={item}
                  inceptionDate={policy.inceptionDate}
                  refOf={refOf}
                  supersededBy={supersededBy.get(item.event.id) ?? null}
                  restated={report.restated.filter((d) => d.ref === (item.event.externalRef ?? item.event.id.slice(0, 8)))}
                />
              ))}
            </ol>
          )}
        </section>

        <Card>
          <CardContent>
            <Link href={`/applications/${policy.applicationId}`} className="flex items-center gap-2 text-sm font-medium text-brand hover:underline">
              Open the application this policy came from
              <ArrowRightIcon className="size-4" />
            </Link>
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
