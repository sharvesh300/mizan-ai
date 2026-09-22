import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ReassessmentCase } from "@/lib/servicing/reassess-case";
import { CitationChips } from "../citation-chip";
import { HindsightTable } from "./hindsight-table";
import { ReassessmentDecision } from "./reassessment-decision";

/** A plan-fit recommendation, for the person deciding on it — BROKER ONLY (plan §13.3.4). */
export function ReassessmentCasePage({ c }: { c: ReassessmentCase }) {
  return (
    <>
      <PageHeader
        backHref={`/policies/${c.policy.id}`}
        backLabel={c.policy.planName}
        title="Plan-fit reassessment"
        description={`${c.subject.fullName} · ${c.policy.ref}`}
      >
        <StatusBadge tone={c.verdict === "confirm" ? "success" : "warning"}>
          {c.verdict === "confirm" ? "Confirm" : `Recommend change to ${c.recommendedPlanName ?? "another plan"}`}
        </StatusBadge>
      </PageHeader>

      <PageBody className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>What the broker record says</CardTitle>
            <CardDescription>Written from the same replay every other part of this system trusts — not a live guess.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm leading-relaxed text-pretty">{c.brokerReasoning}</p>
            <CitationChips citations={c.citations} register="broker" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>What the member was told</CardTitle>
            <CardDescription>The member cannot read this until it is approved or edited.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm leading-relaxed text-pretty text-muted-foreground">{c.memberReasoning}</p>
            <CitationChips citations={c.citations} register="member" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Had this policy been on each plan from the start</CardTitle>
            <CardDescription>The same claim history, replayed against every catalogue plan.</CardDescription>
          </CardHeader>
          <CardContent>
            <HindsightTable rows={c.hindsight} />
          </CardContent>
        </Card>

        {c.task ? (
          <Card>
            <CardHeader>
              <CardTitle>Decide</CardTitle>
              <CardDescription>{c.task.reason}</CardDescription>
            </CardHeader>
            <CardContent>
              <ReassessmentDecision policyId={c.policy.id} reassessmentId={c.id} taskId={c.task.id} brokerReasoning={c.brokerReasoning} />
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="py-6 text-center text-sm text-muted-foreground">
              This case is closed — no open task is waiting on it.
            </CardContent>
          </Card>
        )}

        <Link href={`/policies/${c.policy.id}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:underline">
          <ArrowLeftIcon className="size-4" />
          Back to {c.policy.planName}
        </Link>
      </PageBody>
    </>
  );
}
