import { ArrowRightIcon, FileTextIcon, InboxIcon, MessageSquareIcon, PlusIcon, ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { ApplicationJourney } from "@/components/application-journey";
import { PageBody, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import {
  applicationStatusLabel,
  applicationStatusTone,
  cohortLabel,
  dateLabel,
  money,
  reviewStatusLabel,
  reviewStatusTone,
} from "@/lib/domain";
import {
  listAllApplications,
  listAllPolicies,
  listApplicationsForUser,
  listOpenReviewTasks,
  listPoliciesForUser,
} from "@/lib/queries";
import { getCurrentUser } from "@/lib/session";

export default async function Home() {
  const user = await getCurrentUser();
  if (!user) return null;
  return user.role === "advisor" ? <AdvisorOverview /> : <ApplicantOverview userId={user.id} name={user.fullName} />;
}

// ---------------------------------------------------------------------------

async function ApplicantOverview({ userId, name }: { userId: string; name: string }) {
  const [applications, policies] = await Promise.all([
    listApplicationsForUser(userId),
    listPoliciesForUser(userId),
  ]);
  const open = applications.filter((a) => a.status !== "policy_issued");

  return (
    <>
      <PageHeader
        title={`Hello, ${name.split(" ")[0]}`}
        description="Your cover, your applications, and anything we're still working on."
      />
      <PageBody className="space-y-6">
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
                    <ApplicationJourney status={app.status} />
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

async function AdvisorOverview() {
  const [tasks, applications, policies] = await Promise.all([
    listOpenReviewTasks(),
    listAllApplications(),
    listAllPolicies(),
  ]);

  const awaiting = applications.filter(
    (a) => a.status !== "policy_issued" && a.status !== "declined" && a.status !== "withdrawn",
  );

  const stats = [
    { label: "Needs a decision", value: tasks.length, href: "/queue", icon: InboxIcon, tone: tasks.length > 0 ? "warning" : "success" },
    { label: "Applications in flight", value: awaiting.length, href: "/applications", icon: FileTextIcon, tone: "info" },
    { label: "Active policies", value: policies.length, href: "/policies", icon: ShieldCheckIcon, tone: "brand" },
  ] as const;

  return (
    <>
      <PageHeader
        title="Advisor console"
        description="What needs a human decision right now, and what the system is handling on its own."
      />
      <PageBody className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          {stats.map((stat) => (
            <Link key={stat.label} href={stat.href} className="group">
              <Card className="transition-colors group-hover:ring-brand/40">
                <CardContent className="flex items-center gap-3">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
                    <stat.icon className="size-4 text-muted-foreground" />
                  </span>
                  <div>
                    <p className="text-2xl font-semibold tabular-nums leading-none">{stat.value}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{stat.label}</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-muted-foreground">Top of the queue</h2>
            <Button
            nativeButton={false} variant="ghost" size="sm" render={<Link href="/queue">See all<ArrowRightIcon /></Link>} />
          </div>
          {tasks.length === 0 ? (
            <Empty className="rounded-xl border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <InboxIcon />
                </EmptyMedia>
                <EmptyTitle>Queue is clear</EmptyTitle>
                <EmptyDescription>Nothing is waiting on a human decision.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="rounded-xl border divide-y">
              {tasks.slice(0, 5).map(({ task, assignee }) => (
                <Item key={task.id} className="px-4 py-3">
                  <ItemContent>
                    <ItemTitle className="flex flex-wrap items-center gap-2">
                      {task.reason}
                      <StatusBadge tone={reviewStatusTone[task.status]}>
                        {reviewStatusLabel[task.status]}
                      </StatusBadge>
                    </ItemTitle>
                    <ItemDescription>
                      {task.subjectType.replace(/_/g, " ")} · priority {task.priorityScore}
                      {assignee?.fullName ? ` · ${assignee.fullName}` : " · unassigned"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
            nativeButton={false}
                      size="sm"
                      variant="outline"
                      render={<Link href={`/queue#${task.id}`}>Review</Link>}
                    />
                  </ItemActions>
                </Item>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Recent applications</h2>
          <div className="rounded-xl border divide-y">
            {applications.slice(0, 6).map((app) => (
              <Item key={app.id} className="px-4 py-3">
                <ItemContent>
                  <ItemTitle className="flex flex-wrap items-center gap-2">
                    {app.reference}
                    <StatusBadge tone={applicationStatusTone[app.status]}>
                      {applicationStatusLabel[app.status]}
                    </StatusBadge>
                  </ItemTitle>
                  <ItemDescription>
                    {app.personName} · age {app.age}
                    {app.cohort ? ` · ${cohortLabel(app.cohort)}` : ""}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
            nativeButton={false}
                    size="sm"
                    variant="ghost"
                    render={<Link href={`/applications/${app.id}`}>Open<ArrowRightIcon /></Link>}
                  />
                </ItemActions>
              </Item>
            ))}
          </div>
        </section>
      </PageBody>
    </>
  );
}
