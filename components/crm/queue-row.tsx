import { ArrowRightIcon, CheckIcon, TriangleAlertIcon, WrenchIcon } from "lucide-react";
import Link from "next/link";
import { approveAssessment, approveRecommendation } from "@/app/applications/[id]/actions";
import { ArithmeticDiff } from "@/components/servicing/case/arithmetic";
import { ConfirmReversalButton } from "@/components/servicing/case/confirm-reversal-button";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent } from "@/components/ui/item";
import { ESCALATION_LABEL } from "@/lib/servicing/escalation";
import { cohortLabel, dateLabel, engineNote, money, reviewStatusLabel, reviewStatusTone, sameNote } from "@/lib/domain";
import type { listQueue } from "@/lib/queries";

export type QueueRowData = Awaited<ReturnType<typeof listQueue>>[number];

/** Priority bands. The number is the sort key; this is what it means. */
export function band(score: number): { label: string; tone: "danger" | "warning" | "info" | "neutral" } {
  if (score >= 85) return { label: "Urgent", tone: "danger" };
  if (score >= 65) return { label: "High", tone: "warning" };
  if (score >= 45) return { label: "Normal", tone: "info" };
  return { label: "Low", tone: "neutral" };
}

const confidenceTone = { high: "success", medium: "info", low: "warning" } as const;

/**
 * The two things a "recommendation" review task can mean (doc §2.2) —
 * spelled out here because approve/edit/override behave differently on each
 * (see the comment above `openRecommendationTask`,
 * app/applications/[id]/actions.ts): a quality check never issues a policy,
 * a selection review does.
 */
const REVIEW_KIND_LABEL = {
  quality: "Check before the applicant chooses",
  selection: "Sign off the applicant's choice",
} as const;
const REVIEW_KIND_TONE = { quality: "info", selection: "brand" } as const;

/** Where a task's subject lives — a recommendation's own id is not a route, its application's is. */
export function subjectHref(subjectType: string, subjectId: string, applicationId?: string, policyId?: string | null): string {
  // A servicing event has a CASE PAGE (plan §13.3.2), a conversation only its policy. Without a policy id — a task
  // whose subject could not be resolved — the policies list is where either can be found from.
  if (subjectType === "servicing_event") return policyId ? `/policies/${policyId}/events/${subjectId}` : "/policies";
  if (subjectType === "conversation") return policyId ? `/policies/${policyId}/conversations/${subjectId}` : "/policies";
  if (subjectType === "reassessment") return policyId ? `/policies/${policyId}/reassess/${subjectId}` : "/policies";
  // A payout is decided on the event's own case page — the decision it pays for is the thing worth reading first.
  if (subjectType === "settlement") return policyId ? `/policies/${policyId}` : "/policies";
  return `/applications/${applicationId ?? subjectId}`;
}

/**
 * One row of work, rendered identically in the queue and on the dashboard.
 *
 * It used to print `task.reason` as the title and the decision's
 * `uncertaintyReason` directly underneath — the same sentence twice, because
 * the same pass writes both. Now the second line appears only when it says
 * something the first did not (`sameNote`), and it is labelled by what kind of
 * note it turned out to be (`engineNote`): a concern is the reason a human is
 * here, a reassurance is the system saying it found nothing, and a failure is
 * a machine to unblock. Rendering all three under one "why this needs you"
 * heading is what made a settled record look unsettled.
 */
export function QueueRow({ row, compact = false }: { row: QueueRowData; compact?: boolean }) {
  const { task, assignee, subject } = row;
  const priority = band(task.priorityScore);

  const headline = engineNote(task.reason);
  const note = sameNote(task.reason, subject?.uncertaintyReason) ? null : engineNote(subject?.uncertaintyReason);

  // One click clears the straightforward ones. Anything blocking needs the
  // full record in front of you, and a decline is never a single click from
  // a list — both of those open the record instead. A recommendation task is
  // only ever a single click here when it is a SELECTION review (the
  // applicant has chosen and this issues a policy) — a quality check has no
  // approve verb at all (see app/applications/[id]/actions.ts's
  // openRecommendationTask), so it always opens the record.
  const canApproveInline =
    (task.subjectType === "application" && subject?.kind === "application" && !subject.blocked) ||
    (task.subjectType === "recommendation" && subject?.kind === "recommendation" && subject.reviewKind === "selection");
  const approveAction = task.subjectType === "recommendation" ? approveRecommendation : approveAssessment;
  const servicing = subject?.kind === "servicing" ? subject : null;
  const href = subjectHref(
    task.subjectType,
    task.subjectId,
    subject?.kind === "recommendation" ? subject.applicationId : undefined,
    servicing?.policyId,
  );

  return (
    <li id={task.id}>
      {/* Below `sm` the row stacks: badge rows are made of whole words and
          cannot shrink, so side-by-side content and actions collide on a
          phone. */}
      <Item className="items-start gap-4 px-4 py-4 max-sm:flex-col max-sm:items-stretch target:bg-brand-subtle/40">
        <ItemContent className="min-w-0 gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge tone={priority.tone}>{priority.label}</StatusBadge>
            {subject?.confidence ? (
              <StatusBadge tone={confidenceTone[subject.confidence]}>{subject.confidence} confidence</StatusBadge>
            ) : null}
            {subject?.kind === "recommendation" ? (
              <StatusBadge tone={REVIEW_KIND_TONE[subject.reviewKind]}>
                {REVIEW_KIND_LABEL[subject.reviewKind]}
              </StatusBadge>
            ) : null}
            {servicing?.overturn ? <StatusBadge tone="brand">Reversal to sign</StatusBadge> : null}
            {servicing?.task === "undecidable" ? <StatusBadge tone="danger">Undecidable</StatusBadge> : null}
            {servicing?.task === "quality" ? <StatusBadge tone="info">Quality check</StatusBadge> : null}
            {servicing?.task === "escalation" && servicing.cause ? <StatusBadge tone="warning">{ESCALATION_LABEL[servicing.cause]}</StatusBadge> : null}
            {servicing?.task === "reassessment" ? <StatusBadge tone="brand">Plan-fit: recommends a change</StatusBadge> : null}
            {servicing?.settlement ? (
              <StatusBadge tone={servicing.settlement.status === "approved" ? "info" : "brand"}>
                {servicing.settlement.status === "approved" ? "Approved — awaiting payment" : "Payment to approve"}
              </StatusBadge>
            ) : null}
            {servicing?.memberReplied ? <StatusBadge tone="brand">Member replied</StatusBadge> : null}
            {headline?.kind === "failure" ? (
              <StatusBadge tone="warning">
                <WrenchIcon className="size-3" />
                System step did not finish
              </StatusBadge>
            ) : null}
          </div>

          <p className="text-sm font-medium text-pretty">{headline?.text ?? "Needs a decision"}</p>

          {/* The system's own account of why it would not decide this alone —
              shown only when it is not a restatement of the line above. */}
          {note && !compact ? <EngineNoteLine note={note} /> : null}

          <p className="text-xs text-muted-foreground text-pretty">
            {subject?.kind === "application" ? (
              <>
                <span className="text-foreground">{subject.personName}</span> · {subject.reference} · age {subject.age} ·{" "}
                {subject.budget.replace(/_/g, " ")} budget
                {subject.cohort ? ` · ${cohortLabel(subject.cohort)}` : ""}
              </>
            ) : subject?.kind === "recommendation" ? (
              <>
                <span className="text-foreground">{subject.personName}</span> · {subject.reference} · recommending{" "}
                {subject.planName}
              </>
            ) : servicing ? (
              <>
                <span className="text-foreground">{servicing.personName}</span> · {servicing.policyRef}
                {servicing.eventRef ? ` · ${servicing.eventRef}` : ""}
                {servicing.eventKind ? ` · ${servicing.eventKind}${servicing.amount ? `, ${money(servicing.amount)}` : ""}` : ""}
              </>
            ) : (
              <>{task.subjectType.replace(/_/g, " ")}</>
            )}
            {" · raised "}
            {dateLabel(task.createdAt)}
            {" · "}
            {assignee?.fullName ?? "unassigned"}
          </p>

          {servicing?.callback && !compact ? (
            <p className="text-xs text-muted-foreground text-pretty">
              <span className="font-medium text-foreground">{servicing.callback.called ? "Called" : "Callback requested"}</span> · {servicing.callback.window} · {servicing.callback.phone}
            </p>
          ) : null}

          {/* A payout moves real money, so the row shows the amount and who it goes to before anything is clicked —
              the same reflex as an overturn's arithmetic. */}
          {servicing?.settlement && !compact ? (
            <p className="text-xs text-muted-foreground text-pretty">
              <span className="font-medium text-foreground">{money(servicing.settlement.amount)}</span>{" "}
              to the {servicing.settlement.payee === "member" ? "member" : "provider"}
              {servicing.settlement.status === "approved" ? " · approved, not yet paid" : " · not yet approved"}
            </p>
          ) : null}

          {/* A plan-fit recommendation is a premium change, so its row shows the two prices INLINE — the same reflex as an
              overturn's arithmetic: see the numbers before you decide. */}
          {servicing?.reassessment && !compact ? (
            <p className="text-xs text-muted-foreground text-pretty">
              <span className="font-medium text-foreground">{servicing.reassessment.currentPlanName}</span> {money(servicing.reassessment.currentPremium)}/yr → recommend{" "}
              <span className="font-medium text-foreground">{servicing.reassessment.recommendedPlanName}</span> {money(servicing.reassessment.recommendedPremium)}/yr
            </p>
          ) : null}

          {/* An overturn moves money, so its row shows the arithmetic INLINE: one click to sign, but only after seeing the sum. */}
          {servicing?.overturn && !compact ? (
            <div className="space-y-1.5">
              <ArithmeticDiff
                compact
                before={{ outcome: servicing.overturn.before.outcome, planPays: servicing.overturn.before.planPays, memberPays: servicing.overturn.before.memberPays }}
                after={{ reasonCode: servicing.overturn.after.reasonCode, planPays: servicing.overturn.after.planPays, memberPays: servicing.overturn.after.memberPays }}
              />
              <p className="text-xs text-muted-foreground text-pretty">
                {servicing.overturn.correction.field.replace(/_/g, " ")} corrected {servicing.overturn.correction.from.replace(/_/g, " ")} → {servicing.overturn.correction.to.replace(/_/g, " ")}; deductible met{" "}
                {money(servicing.overturn.deductible.before)} → {money(servicing.overturn.deductible.after)}.
              </p>
            </div>
          ) : null}

          {/* "Open" on every row of a queue of open work says nothing — only a
              task somebody has already picked up is worth a badge here. */}
          {!compact && (task.status !== "open" || headline?.code || note?.code) ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {task.status !== "open" ? (
                <StatusBadge tone={reviewStatusTone[task.status]}>{reviewStatusLabel[task.status]}</StatusBadge>
              ) : null}
              {headline?.code ? <RuleChip code={headline.code} /> : null}
              {note?.code && note.code !== headline?.code ? <RuleChip code={note.code} /> : null}
            </div>
          ) : null}
        </ItemContent>

        <ItemActions className="gap-2 max-sm:justify-end">
          {servicing?.overturn && servicing.eventId && !compact ? (
            <ConfirmReversalButton
              policyId={servicing.policyId}
              eventId={servicing.eventId}
              taskId={task.id}
              summary={`${servicing.overturn.before.outcome ?? "denied"} ${money(servicing.overturn.before.planPays)} → covered ${money(servicing.overturn.after.planPays)} plan / ${money(servicing.overturn.after.memberPays)} member`}
            />
          ) : null}
          {canApproveInline && !compact ? (
            <form action={approveAction.bind(null, task.id)}>
              <Button type="submit" size="sm" variant="outline">
                <CheckIcon />
                Approve
              </Button>
            </form>
          ) : null}
          <Button
            nativeButton={false}
            size="sm"
            variant={compact ? "outline" : "default"}
            render={
              <Link href={href}>
                {compact ? "Open" : servicing ? "Open the case" : "Open record"}
                <ArrowRightIcon />
              </Link>
            }
          />
        </ItemActions>
      </Item>
    </li>
  );
}

/**
 * The second line, labelled by what it actually is. A reassurance gets no
 * icon and a quieter lead-in, because "No uncertainty — plan_c is the only
 * plan that fits" under a warning triangle is the system contradicting itself.
 */
function EngineNoteLine({ note }: { note: NonNullable<ReturnType<typeof engineNote>> }) {
  const lead =
    note.kind === "concern"
      ? "Why this needs you"
      : note.kind === "failure"
        ? "What went wrong"
        : "The system's own note";

  return (
    <p className="flex gap-1.5 text-xs text-muted-foreground text-pretty">
      {note.kind === "concern" ? <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" /> : null}
      <span>
        <span className="font-medium text-foreground/80">{lead}: </span>
        {note.text}
      </span>
    </p>
  );
}

/** The rule that fired, kept readable for anyone who wants it, out of the prose. */
function RuleChip({ code }: { code: string }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground">{code}</code>
  );
}
