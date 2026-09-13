import { ArrowRightIcon, CheckCircle2Icon, InboxIcon } from "lucide-react";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { dateLabel, reviewStatusLabel, reviewStatusTone } from "@/lib/domain";
import { listOpenReviewTasks, listRecentlyResolvedTasks } from "@/lib/queries";
import { getCurrentUser } from "@/lib/session";
import { notFound } from "next/navigation";

/** Priority bands. The number is the sort key; this is what it means. */
function band(score: number): { label: string; tone: "danger" | "warning" | "info" | "neutral" } {
  if (score >= 85) return { label: "Urgent", tone: "danger" };
  if (score >= 65) return { label: "High", tone: "warning" };
  if (score >= 45) return { label: "Normal", tone: "info" };
  return { label: "Low", tone: "neutral" };
}

/** Where a task's subject lives, so "Review" always goes somewhere useful. */
function subjectHref(subjectType: string, subjectId: string): string {
  return subjectType === "servicing_event" ? `/policies` : `/applications/${subjectId}`;
}

export default async function QueuePage() {
  const user = await getCurrentUser();
  if (!user) return null;
  if (user.role !== "advisor") notFound();

  const [open, resolved] = await Promise.all([listOpenReviewTasks(), listRecentlyResolvedTasks(5)]);

  return (
    <>
      <PageHeader
        title="Review queue"
        description="Only what needs a human decision, highest priority first. Resolved work is kept below for context, not in the queue."
      />
      <PageBody className="space-y-6">
        {open.length === 0 ? (
          <Empty className="rounded-xl border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CheckCircle2Icon />
              </EmptyMedia>
              <EmptyTitle>Nothing waiting</EmptyTitle>
              <EmptyDescription>Every open case has been decided.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <InboxIcon className="size-4" />
                {open.length} waiting on you
              </CardTitle>
              <CardDescription>
                Ordered by priority, then oldest first so nothing starves at the bottom of the list.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <ul className="divide-y border-t">
                {open.map(({ task, assignee }) => {
                  const priority = band(task.priorityScore);
                  return (
                    <li key={task.id} id={task.id}>
                      <Item className="px-4 py-4 target:bg-brand-subtle/40">
                        <ItemContent>
                          <ItemTitle className="flex flex-wrap items-center gap-2">
                            <StatusBadge tone={priority.tone}>{priority.label}</StatusBadge>
                            <span className="text-pretty">{task.reason}</span>
                          </ItemTitle>
                          <ItemDescription>
                            {task.subjectType.replace(/_/g, " ")} · raised {dateLabel(task.createdAt)} ·{" "}
                            {assignee?.fullName ?? "unassigned"} ·{" "}
                            <StatusBadge tone={reviewStatusTone[task.status]}>
                              {reviewStatusLabel[task.status]}
                            </StatusBadge>
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <Button
            nativeButton={false}
                            size="sm"
                            render={
                              <Link href={subjectHref(task.subjectType, task.subjectId)}>
                                Open record
                                <ArrowRightIcon />
                              </Link>
                            }
                          />
                        </ItemActions>
                      </Item>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        )}

        {resolved.length > 0 ? (
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">Recently resolved</h2>
            <ul className="divide-y rounded-xl border">
              {resolved.map(({ task, assignee }) => (
                <li key={task.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                  <CheckCircle2Icon className="size-4 shrink-0 text-success" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{task.reason}</p>
                    <p className="text-xs text-muted-foreground">
                      {assignee?.fullName ?? "unassigned"} · {dateLabel(task.resolvedAt)}
                    </p>
                  </div>
                  <Button
            nativeButton={false}
                    size="xs"
                    variant="ghost"
                    render={<Link href={subjectHref(task.subjectType, task.subjectId)}>View</Link>}
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </PageBody>
    </>
  );
}
