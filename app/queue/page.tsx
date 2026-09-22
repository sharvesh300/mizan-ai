import type { Metadata } from "next";
import { CheckCircle2Icon, InboxIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { QueueRow, type QueueRowData, subjectHref } from "@/components/crm/queue-row";
import { SectionCard } from "@/components/crm/section-card";
import { PageBody, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { dateLabel, engineNote } from "@/lib/domain";
import { listQueue, listRecentlyResolvedTasks } from "@/lib/queries";
import { getCurrentUser } from "@/lib/session";

const isBlockedApplication = (row: QueueRowData) => row.subject?.kind === "application" && row.subject.blocked;
const needsApplicationDecision = (row: QueueRowData) =>
  row.subject?.kind !== "application" || row.subject.needsDecision;
/** Servicing tasks say for themselves which kind of attention they want (plan §13.3.1); the other groups read them from here. */
const servicingGroup = (row: QueueRowData) => (row.subject?.kind === "servicing" ? row.subject.group : null);

/**
 * Three groups, in the order a broker should work them.
 *
 * The ordering question the brief asks is really two questions — what is most
 * urgent, and what most needs a human — and they have different answers. The
 * priority score handles the first WITHIN a group; the group itself answers
 * the second. A blocked record cannot move at all until someone acts, so it
 * goes first regardless of score; a low-confidence record with no blocking
 * flag is genuinely arguable and wants unhurried attention, so it goes last
 * rather than competing with work that is merely urgent. A recommendation
 * task has no "blocked" concept of its own — it lands in "uncertain" when
 * confidence is low, otherwise "needs a decision", same as any other
 * genuinely open item.
 */
const GROUPS = [
  {
    // First: the only group where the system has told you it has NO answer, so the alternative to your attention is a
    // member with no outcome. Nothing else can resolve it.
    key: "undecidable",
    title: "Undecidable from the plan",
    description: "The plan terms do not decide these, and the system refused to guess. Nothing else can settle them.",
    match: (row: QueueRowData) => servicingGroup(row) === "undecidable",
  },
  {
    key: "blocked",
    title: "Blocked",
    description: "Cannot move until you act. A member is waiting on a person, or the record is missing something the rules need.",
    match: (row: QueueRowData) => isBlockedApplication(row) || servicingGroup(row) === "blocked",
  },
  {
    key: "uncertain",
    title: "Genuinely uncertain",
    description:
      "Nothing is stalled. These are close calls the rules would not settle alone — worth more than a glance, and the work a rubber-stamp would ruin.",
    match: (row: QueueRowData) => row.subject?.confidence === "low" || servicingGroup(row) === "uncertain",
  },
  {
    key: "decide",
    title: "Needs a decision",
    description: "The system has an answer and is not willing to act on it alone. The work is done — this is one informed click.",
    match: (row: QueueRowData) => servicingGroup(row) === "decide" || (servicingGroup(row) === null && !isBlockedApplication(row) && needsApplicationDecision(row)),
  },
] as const;

export const metadata: Metadata = {
  title: "Review queue · Mizan AI",
  description: "Everything waiting on a human decision.",
};

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
            <SectionCard
              key={group.key}
              flush
              title={
                <span className="flex items-center gap-2">
                  <InboxIcon className="size-4 text-muted-foreground" />
                  {group.title}
                  <span className="text-muted-foreground tabular-nums">({group.rows.length})</span>
                </span>
              }
              description={group.description}
            >
              <ul className="divide-y border-t">
                {group.rows.map((row) => (
                  <QueueRow key={row.task.id} row={row} />
                ))}
              </ul>
            </SectionCard>
          ))
        )}

        {resolved.length > 0 ? (
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">Recently resolved</h2>
            <ul className="divide-y rounded-xl border">
              {resolved.map(({ task, assignee, eventPolicyId, conversationPolicyId }) => (
                <li key={task.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                  <CheckCircle2Icon className="size-4 shrink-0 text-success" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{engineNote(task.reason)?.text ?? task.reason}</p>
                    <p className="text-xs text-muted-foreground">
                      {assignee?.fullName ?? "unassigned"} · {dateLabel(task.resolvedAt)}
                    </p>
                  </div>
                  <Button
                    nativeButton={false}
                    size="xs"
                    variant="ghost"
                    render={<Link href={subjectHref(task.subjectType, task.subjectId, undefined, eventPolicyId ?? conversationPolicyId)}>View</Link>}
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
