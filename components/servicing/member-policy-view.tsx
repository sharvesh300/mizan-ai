// The member's policy screen — deliberately the one screen (plan §13.2).
//
// Everything a member reads about their own cover: what it is, what they have
// used, what has happened on it and what each thing cost them, and whether the
// plan still fits. Reads ONLY through the member-typed queries, which return the
// customer views' columns — no risk vocabulary, no flags, no reviewer notes, no
// confidence. There is no `isAdvisor` anywhere in this file, by design.

import { ArrowRightIcon, LightbulbIcon } from "lucide-react";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { dateLabel } from "@/lib/domain";
import { listOpenServicing } from "@/lib/ai/servicing-session";
import { listAppealableEventIds } from "@/lib/servicing/appeal-store";
import { listMemberEvents, listMemberReassessments, listMemberSettlements, type PolicyRecord } from "@/lib/queries";
import { CitationChips } from "./citation-chip";
import { MemberEventCard } from "./member-event-card";
import { CoverTermsCard, UtilizationCard } from "./policy-cover";
import { ServicingActions } from "./servicing-actions";

export async function MemberPolicyView({ record }: { record: PolicyRecord }) {
  const { policy, plan, subject } = record;
  const [events, reassessments, settlements, inProgress, appealable] = await Promise.all([listMemberEvents(policy.id), listMemberReassessments(policy.id), listMemberSettlements(policy.id), listOpenServicing(subject.ownerUserId, policy.id), listAppealableEventIds(policy.id)]);

  return (
    <>
      <PageHeader
        backHref="/policies"
        backLabel="My cover"
        title={plan.name}
        description={`${policy.policyNumber} · ${subject.fullName} · active since ${dateLabel(policy.inceptionDate)}`}
      >
        <StatusBadge tone={policy.status === "active" ? "success" : "neutral"}>{policy.status}</StatusBadge>
      </PageHeader>

      {/* pb-24: clearance for the floating chat launcher, which would otherwise cover the last card on a phone. */}
      <PageBody className="space-y-6 pb-24">
        <ServicingActions policyId={policy.id} />

        {inProgress.length > 0 ? (
          <section className="space-y-2" aria-labelledby="in-progress">
            <h2 id="in-progress" className="text-sm font-medium">
              In progress
            </h2>
            <ul className="space-y-2">
              {inProgress.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/policies/${policy.id}/service/${c.id}`}
                    className="flex min-h-14 items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3 text-sm shadow-xs transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    <span className="min-w-0 space-y-0.5">
                      <span className="block font-medium">{c.intent === "preauth" ? "Checking cover" : c.intent === "appeal" ? "Your appeal" : "Your claim"}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {c.status === "awaiting_user"
                          ? c.preview
                            ? `Waiting for you · ${c.preview}`
                            : "Waiting for you"
                          : c.status === "awaiting_review" && c.intent === "appeal"
                            ? "Finalising the numbers"
                            : "With an advisor"}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      {c.status === "awaiting_user" ? "Continue" : "View"}
                      <ArrowRightIcon className="size-3.5" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-2">
          <UtilizationCard record={record} title="What you've used" description="Everything below is worked out from your claim history." />
          <CoverTermsCard record={record} title="Your cover" description="The terms your claims are settled against." />
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
              {reassessments.map((r) => (
                <div key={r.id} className="space-y-2">
                  <StatusBadge tone={r.verdict === "confirm" ? "success" : "warning"}>
                    {r.verdict === "confirm" ? "Still the right plan" : `Consider moving to ${r.suggestedPlanName ?? "another plan"}`}
                  </StatusBadge>
                  <p className="text-sm leading-relaxed text-pretty">{r.memberReasoning}</p>
                  <CitationChips citations={r.citations} register="member" />
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}

        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-medium">What&apos;s happened</h2>
            <p className="text-sm text-muted-foreground">Everything that has happened on your policy, and what each one cost you.</p>
          </div>

          {events.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">Nothing claimed yet.</CardContent>
            </Card>
          ) : (
            <ol className="space-y-3">
              {events.map((event) => (
                <MemberEventCard
                  key={event.id}
                  event={event}
                  inceptionDate={policy.inceptionDate}
                  canAppeal={appealable.has(event.id)}
                  payment={(() => {
                    const s = settlements.get(event.id);
                    return s ? { status: s.status, paidOn: s.paidAt ? dateLabel(s.paidAt) : null } : null;
                  })()}
                />
              ))}
            </ol>
          )}
        </section>
      </PageBody>
    </>
  );
}
