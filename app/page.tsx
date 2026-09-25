import { ArrowRightIcon, FileTextIcon, InboxIcon, MessageSquareIcon, PlusIcon, ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { ApplicationJourney } from "@/components/application-journey";
import { Funnel } from "@/components/crm/funnel";
import { QueueRow } from "@/components/crm/queue-row";
import { SectionCard, SectionLink } from "@/components/crm/section-card";
import { StatRow, StatTile } from "@/components/crm/stat-tile";
import { StraightThroughBand } from "@/components/crm/straight-through-band";
import { UaePassCard } from "@/components/identity/uae-pass";
import { PageBody, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import {
  applicationStatusLabel,
  applicationStatusTone,
  dateLabel,
  isWithAdvisor,
  money,
  reviewActionLabel,
  reviewActionTone,
} from "@/lib/domain";
import {
  getAdvisorDashboard,
  getStraightThrough,
  listApplicationsForUser,
  listPoliciesForUser,
} from "@/lib/queries";
import { getCurrentUser } from "@/lib/session";
import { getVerification } from "@/lib/uae-pass";

export default async function Home() {
  const user = await getCurrentUser();
  if (!user) return null;
  return user.role === "advisor" ? (
    <AdvisorOverview name={user.fullName} />
  ) : (
    <ApplicantOverview userId={user.id} name={user.fullName} />
  );
}

// ---------------------------------------------------------------------------

async function ApplicantOverview({ userId, name }: { userId: string; name: string }) {
  const [applications, policies, verification] = await Promise.all([
    listApplicationsForUser(userId),
    listPoliciesForUser(userId),
    getVerification(userId),
  ]);
  const open = applications.filter((a) => a.status !== "policy_issued");

  return (
    <>
      <PageHeader
        title={`Hello, ${name.split(" ")[0]}`}
        description="Your cover, your applications, and anything we're still working on."
      />
      <PageBody className="space-y-6">
        <UaePassCard verification={verification} returnTo="/" />

        {policies.length > 0 ? (
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">Your cover</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {policies.map(({ policy, plan, ledger, personName }) => (
                <Card key={policy.id}>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <ShieldCheckIcon className="size-4 text-success" />
                      {plan.name}
                    </CardTitle>
                    <CardDescription>
                      {personName} · active since {dateLabel(policy.inceptionDate)}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <dl className="grid grid-cols-2 gap-3 text-sm">
                      <div>
                        <dt className="text-xs text-muted-foreground">Paid by your plan this year</dt>
                        <dd className="font-medium tabular-nums">{money(ledger?.annualPaid ?? 0)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Deductible met</dt>
                        <dd className="font-medium tabular-nums">
                          {money(ledger?.deductibleMet ?? 0)}
                          <span className="font-normal text-muted-foreground"> of {money(plan.deductible)}</span>
                        </dd>
                      </div>
                    </dl>
                    <Button
            nativeButton={false}
                      variant="outline"
                      size="sm"
                      className="w-full"
                      render={
                        <Link href={`/policies/${policy.id}`}>
                          View cover and claims
                          <ArrowRightIcon />
                        </Link>
                      }
                    />
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        ) : null}

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-muted-foreground">
              {open.length > 0 ? "In progress" : "Applications"}
            </h2>
            <Button
            nativeButton={false}
              size="sm"
              variant="outline"
              render={
                <Link href="/applications/new">
                  <PlusIcon />
                  New application
                </Link>
              }
            />
          </div>

          {applications.length === 0 ? (
            <StartHere />
          ) : (
            <div className="space-y-4">
              {(open.length > 0 ? open : applications).slice(0, 3).map((app) => (
                <Card key={app.id}>
                  <CardHeader>
                    <CardTitle className="text-base">{app.reference}</CardTitle>
                    <CardDescription>
                      {app.personName} · started {dateLabel(app.createdAt)}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <ApplicationJourney status={app.status} withAdvisor={isWithAdvisor(app.status)} />
                    <Button
            nativeButton={false}
                      variant="outline"
                      size="sm"
                      render={
                        <Link href={`/applications/${app.id}`}>
                          Open application
                          <ArrowRightIcon />
                        </Link>
                      }
                    />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      </PageBody>
    </>
  );
}

function StartHere() {
  return (
    <Card>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/applications/new/form"
          className="group rounded-xl border p-4 transition-colors hover:border-brand hover:bg-brand-subtle/40"
        >
          <FileTextIcon className="size-5 text-brand" />
          <p className="mt-2 font-medium">Fill in a form</p>
          <p className="text-sm text-muted-foreground text-pretty">
            Everything on one page. Best if you already have your details to hand.
          </p>
        </Link>
        <Link
          href="/applications/new/chat"
          className="group rounded-xl border p-4 transition-colors hover:border-brand hover:bg-brand-subtle/40"
        >
          <MessageSquareIcon className="size-5 text-brand" />
          <p className="mt-2 font-medium">Talk it through</p>
          <p className="text-sm text-muted-foreground text-pretty">
            A few questions, one at a time. Stop and pick it up whenever you like.
          </p>
        </Link>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

/**
 * The advisor's morning read.
 *
 * It replaces a page that was two more lists on top of a product already made
 * of lists. Four bands, densest first: what is waiting on me, the top of the
 * queue itself, what the book is doing, and what has been decided (plus what
 * has stalled — priority ordering starves an old low-priority record, and the
 * queue cannot show that about itself).
 */
async function AdvisorOverview({ name }: { name: string }) {
  const [{ queue, counts, money: sums, funnel, uncertainty, stalled, decisions, decisionsThisWeek }, straightThrough] = await Promise.all([getAdvisorDashboard(), getStraightThrough()]);

  const top = queue.slice(0, 5);
  const lowConfidence = uncertainty.find((row) => row.level === "low")?.count ?? 0;

  return (
    <>
      <PageHeader
        title={`Good morning, ${name.split(" ")[0]}`}
        description="What needs a human decision right now, what the system is handling on its own, and where the book has got to."
      />
      <PageBody className="space-y-6">
        <StatRow>
          <StatTile
            label="Open decisions"
            value={counts.queueOpen}
            hint={counts.queueUnassigned > 0 ? `${counts.queueUnassigned} unassigned` : "all assigned"}
            tone={counts.queueOpen > 0 ? "warning" : "success"}
            href="/queue"
          />
          <StatTile
            label="Longest wait"
            value={counts.oldestWaitingDays == null ? "—" : `${counts.oldestWaitingDays}d`}
            hint="oldest item still open"
            tone={counts.oldestWaitingDays != null && counts.oldestWaitingDays > 7 ? "danger" : "neutral"}
            href="/queue"
          />
          <StatTile label="In flight" value={counts.inFlight} hint="applications not yet closed" tone="info" href="/applications" />
          <StatTile label="Policies live" value={counts.policiesLive} hint="active cover" tone="brand" href="/policies" />
          <StatTile
            label="Premium live"
            value={money(sums.liveAnnual)}
            hint={`${money(sums.pipelineAnnual)} more quoted`}
            href="/policies"
          />
        </StatRow>

        <StraightThroughBand s={straightThrough} queue={queue} />

        <SectionCard
          flush
          title="Needs you now"
          description={
            counts.queueOpen > top.length
              ? `The top ${top.length} of ${counts.queueOpen}, in queue order.`
              : "In queue order — blocked records first, then close calls, then everything else."
          }
          action={<SectionLink href="/queue">Open the queue</SectionLink>}
        >
          {top.length === 0 ? (
            <Empty className="border-t border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <InboxIcon />
                </EmptyMedia>
                <EmptyTitle>Queue is clear</EmptyTitle>
                <EmptyDescription>Nothing is waiting on a human decision.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="divide-y border-t">
              {top.map((row) => (
                <QueueRow key={row.task.id} row={row} compact />
              ))}
            </ul>
          )}
        </SectionCard>

        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard
            title="Where the book is"
            description="Every application by stage. Bars are scaled to the busiest stage, so a pile-up reads as one."
            action={<SectionLink href="/applications">All applications</SectionLink>}
          >
            <Funnel stages={funnel} hrefFor={() => "/applications"} />
          </SectionCard>

          <SectionCard
            title="Where the uncertainty is"
            description="How sure the system was about the records now waiting on you. Broker-only — this vocabulary never reaches an applicant."
          >
            <ul className="space-y-3">
              {uncertainty.map((row) => (
                <li key={row.level} className="flex items-baseline gap-3">
                  <StatusBadge tone={CONFIDENCE_TONE[row.level]} className="shrink-0">
                    {row.level} confidence
                  </StatusBadge>
                  <span className="w-6 shrink-0 text-sm font-medium tabular-nums">{row.count}</span>
                  <span className="min-w-0 flex-1 text-xs text-muted-foreground text-pretty">
                    {CONFIDENCE_HINT[row.level]}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs text-muted-foreground text-pretty">
              {lowConfidence > 0
                ? `${lowConfidence} of the ${counts.queueOpen} open item${counts.queueOpen === 1 ? "" : "s"} ${lowConfidence === 1 ? "is" : "are"} a genuine judgement call rather than a rubber stamp.`
                : "Nothing open is a genuine close call — the queue is rules and sign-offs today."}
            </p>
          </SectionCard>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard
            title="Decided this week"
            description={
              decisionsThisWeek === 0
                ? "No decisions recorded in the last seven days."
                : `${decisionsThisWeek} decision${decisionsThisWeek === 1 ? "" : "s"} recorded, newest first. Every action carries who took it.`
            }
          >
            {decisions.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing yet.</p>
            ) : (
              <ul className="space-y-3">
                {decisions.map(({ decision, actor, subject }) => (
                  <li key={decision.id} className="flex items-start gap-2.5 text-sm">
                    <StatusBadge tone={reviewActionTone[decision.action]} className="mt-0.5 shrink-0">
                      {reviewActionLabel[decision.action]}
                    </StatusBadge>
                    <div className="min-w-0 flex-1">
                      {subject ? (
                        <Link href={`/applications/${subject.applicationId}`} className="block truncate hover:underline">
                          {subject.personName}
                          <span className="text-muted-foreground"> · {subject.reference}</span>
                        </Link>
                      ) : (
                        <p className="truncate text-muted-foreground">record no longer on file</p>
                      )}
                      <p className="truncate text-xs text-muted-foreground">
                        {actor.fullName} · {dateLabel(decision.decidedAt)}
                        {decision.notes ? ` · ${decision.notes}` : ""}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            title="Not moved in a week"
            description="Open applications the queue's priority ordering will keep pushing down. Nothing here is urgent; that is the problem."
          >
            {stalled.length === 0 ? (
              <p className="text-sm text-muted-foreground">Everything open has moved in the last seven days.</p>
            ) : (
              <ul className="space-y-2.5">
                {stalled.map((row) => (
                  <li key={row.id}>
                    <Link
                      href={`/applications/${row.id}`}
                      className="flex items-baseline justify-between gap-3 rounded-md text-sm hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {row.personName}
                        <span className="text-muted-foreground"> · {row.reference}</span>
                      </span>
                      <StatusBadge tone={applicationStatusTone[row.status]}>
                        {applicationStatusLabel[row.status]}
                      </StatusBadge>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{row.idleDays}d</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      </PageBody>
    </>
  );
}

const CONFIDENCE_TONE = { low: "warning", medium: "info", high: "success" } as const;
const CONFIDENCE_HINT = {
  low: "genuinely arguable — read the record",
  medium: "the system has a view, capped by a flag",
  high: "settled; you are confirming, not deciding",
} as const;
