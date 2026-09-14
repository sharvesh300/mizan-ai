import { ArrowRightIcon, CheckCircle2Icon, CheckIcon, InboxIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { approveAssessment } from "@/app/applications/[id]/actions";
import { PageBody, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { cohortLabel, dateLabel, reviewStatusLabel, reviewStatusTone } from "@/lib/domain";
import { listQueue, listRecentlyResolvedTasks } from "@/lib/queries";
import { getCurrentUser } from "@/lib/session";

type QueueRow = Awaited<ReturnType<typeof listQueue>>[number];

/** Priority bands. The number is the sort key; this is what it means. */
function band(score: number): { label: string; tone: "danger" | "warning" | "info" | "neutral" } {
  if (score >= 85) return { label: "Urgent", tone: "danger" };
  if (score >= 65) return { label: "High", tone: "warning" };
  if (score >= 45) return { label: "Normal", tone: "info" };
  return { label: "Low", tone: "neutral" };
}

const confidenceTone = { high: "success", medium: "info", low: "warning" } as const;

/** Where a task's subject lives, so "Review" always goes somewhere useful. */
function subjectHref(subjectType: string, subjectId: string): string {
  return subjectType === "servicing_event" ? `/policies` : `/applications/${subjectId}`;
}

/**
 * Three groups, in the order a broker should work them.
 *
 * The ordering question the brief asks is really two questions — what is most
 * urgent, and what most needs a human — and they have different answers. The
 * priority score handles the first WITHIN a group; the group itself answers
 * the second. A blocked record cannot move at all until someone acts, so it
 * goes first regardless of score; a low-confidence record with no blocking
 * flag is genuinely arguable and wants unhurried attention, so it goes last
 * rather than competing with work that is merely urgent.
 */
const GROUPS = [
  {
    key: "blocked",
    title: "Blocked",
    description: "Cannot move at all until you act. The record is missing something the rules need.",
    match: (row: QueueRow) => Boolean(row.subject?.blocked),
  },
  {
    key: "uncertain",
    title: "Genuinely uncertain",
    description:
      "Nothing is wrong with the record. These are close calls the rules would not settle alone — worth more than a glance.",
    match: (row: QueueRow) => row.subject?.confidence === "low",
  },
  {
    key: "decide",
    title: "Needs a decision",
    description: "The system has an answer and is not willing to act on it alone.",
    match: (row: QueueRow) => !row.subject?.blocked && (row.subject?.needsDecision ?? true),
  },
] as const;

export default async function QueuePage() {
  const user = await getCurrentUser();
  if (!user) return null;
  if (user.role !== "advisor") notFound();

  const [open, resolved] = await Promise.all([listQueue(), listRecentlyResolvedTasks(5)]);

  // First matching group wins, so nothing is worked twice.
  const claimed = new Set<string>();
  const grouped = GROUPS.map((group) => {
    const rows = open.filter((row) => !claimed.has(row.task.id) && group.match(row));
    for (const row of rows) claimed.add(row.task.id);
    return { ...group, rows: [...rows] };
  });

  // Anything the groups did not claim — a task on a subject that is not an
  // application, or one raised before its record was assessed — still has to
  // appear. A queue that silently drops work it cannot categorise is worse
  // than one that categorises it badly.
  const leftover = open.filter((row) => !claimed.has(row.task.id));
  const decide = grouped.find((group) => group.key === "decide");
  if (decide) decide.rows.push(...leftover);

  const visible = grouped.filter((group) => group.rows.length > 0);

  return (
    <>
      <PageHeader
        title="Review queue"
        description="Only what needs a human decision. Grouped by what kind of attention it wants, then by priority within each group, then oldest first so nothing starves."
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
          visible.map((group) => (
            <Card key={group.key}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <InboxIcon className="size-4" />
                  {group.title} ({group.rows.length})
                </CardTitle>
                <CardDescription>{group.description}</CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                <ul className="divide-y border-t">
                  {group.rows.map((row) => (
                    <QueueItem key={row.task.id} row={row} />
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))
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

function QueueItem({ row }: { row: QueueRow }) {
  const { task, assignee, subject } = row;
  const priority = band(task.priorityScore);

  // One click clears the straightforward ones. Anything blocking needs the
  // full record in front of you, and a decline is never a single click from
  // a list — both of those open the record instead.
  const canApproveInline = task.subjectType === "application" && !subject?.blocked;

  return (
    <li id={task.id}>
      <Item className="px-4 py-4 target:bg-brand-subtle/40">
        <ItemContent>
          <ItemTitle className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={priority.tone}>{priority.label}</StatusBadge>
            {subject?.confidence ? (
              <StatusBadge tone={confidenceTone[subject.confidence]}>
                {subject.confidence} confidence
              </StatusBadge>
            ) : null}
            <span className="text-pretty">{task.reason}</span>
          </ItemTitle>

          {/* The system's own account of why it would not decide this alone. */}
          {subject?.uncertaintyReason ? (
            <p className="mt-1 text-xs text-muted-foreground text-pretty">{subject.uncertaintyReason}</p>
          ) : null}

          <ItemDescription>
            {subject ? (
              <>
                {subject.personName} · {subject.reference} · age {subject.age} ·{" "}
                {subject.budget.replace(/_/g, " ")} budget
                {subject.cohort ? ` · ${cohortLabel(subject.cohort)}` : ""} ·{" "}
              </>
            ) : (
              <>{task.subjectType.replace(/_/g, " ")} · </>
            )}
            raised {dateLabel(task.createdAt)} · {assignee?.fullName ?? "unassigned"} ·{" "}
            <StatusBadge tone={reviewStatusTone[task.status]}>{reviewStatusLabel[task.status]}</StatusBadge>
          </ItemDescription>
        </ItemContent>

        <ItemActions className="gap-2">
          {canApproveInline ? (
            <form action={approveAssessment.bind(null, task.id)}>
              <Button type="submit" size="sm" variant="outline">
                <CheckIcon />
                Approve
              </Button>
            </form>
          ) : null}
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
}
