// Reassessment, run after every ledger-mutating event (plan §5.5).
//
// Reads the whole policy's log through `replayPolicy` (the same replay every other part of the system trusts),
// extracts the deterministic features, computes the deterministic verdict, and writes ONE new
// `plan_fit_reassessment` row citing them. This is intentionally best-effort: a reassessment that fails must
// never take down the claim decision, the appeal signature or the hand-off it followed, so every call site
// wraps it and only logs a failure.
//
// A `recommend_change` verdict is a sales act with a premium attached (plan §2.3's two-registers table), so —
// exactly like an appeal overturn — the MEMBER never reads it until a person has looked: `readServicingThread`
// and the member queries only surface a `recommend_change` row once its `review_task` has been resolved with
// `approve` or `edit`. Nothing here shows the member a plan name nobody has signed off.
//
// Not `server-only`: the checks drive it against a scratch database, the same discipline as every other session
// file.

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { appUser, plan, planFitReassessment, policy, reviewDecision, reviewTask } from "@/db/schema";
import type { EventOutcome, ReasonCode } from "@/db/schema/enums";
import {
  buildReassessmentProse,
  computeVerdict,
  extractFitFeatures,
  type AppealAttempt,
  type ReassessEvent,
} from "@/lib/servicing";
import { planRowToTerms, replayPolicy } from "@/lib/servicing/store";

/** Plan §12.2: a plan-change recommendation is a judgment call, not a blocker or an undecidable case. */
export const REASSESSMENT_PRIORITY = 60;

async function catalogue() {
  return (await db.select().from(plan)).map(planRowToTerms);
}

function appealAttempts(stored: { id: string; externalRef: string | null; description: string | null; policyMonth: number; kind: string; outcome: EventOutcome | null; appealOfEventId: string | null }[]): AppealAttempt[] {
  const byId = new Map(stored.map((r) => [r.id, r]));
  return stored
    .filter((r) => r.kind === "appeal" && r.appealOfEventId)
    .map((r) => {
      const contested = byId.get(r.appealOfEventId!);
      return {
        id: r.id,
        ref: r.externalRef ?? r.id.slice(0, 8),
        description: r.description,
        policyMonth: r.policyMonth,
        contestsRef: contested?.externalRef ?? contested?.id.slice(0, 8) ?? "",
        verdict: r.outcome === "overturned" ? ("overturned" as const) : ("upheld" as const),
        reasonCode: (contested as { reasonCode?: ReasonCode } | undefined)?.reasonCode ?? "insufficient_data",
      };
    });
}

/** Any OPEN review task on a reassessment belonging to this policy — there is at most one at a time. */
async function openReassessmentTask(policyId: string) {
  const rows = await db.select({ id: planFitReassessment.id }).from(planFitReassessment).where(eq(planFitReassessment.policyId, policyId));
  if (rows.length === 0) return null;
  const [task] = await db
    .select()
    .from(reviewTask)
    .where(and(eq(reviewTask.subjectType, "reassessment"), inArray(reviewTask.subjectId, rows.map((r) => r.id)), eq(reviewTask.status, "open")))
    .orderBy(desc(reviewTask.createdAt))
    .limit(1);
  return task ?? null;
}

export async function reassessAfterEvent(policyId: string, triggeredByEventId: string): Promise<void> {
  try {
    const [frame, plans, [policyRow]] = await Promise.all([replayPolicy(policyId), catalogue(), db.select().from(policy).where(eq(policy.id, policyId)).limit(1)]);
    if (!policyRow) return;

    const refOf = new Map<string, ReassessEvent>(
      frame.stored.map((r) => [r.id, { id: r.id, ref: r.externalRef ?? r.id.slice(0, 8), description: r.description, policyMonth: r.policyMonth }]),
    );
    const appeals = appealAttempts(frame.stored);
    const features = extractFitFeatures(frame.terms, frame.events, refOf, appeals);
    const verdict = computeVerdict(features, frame.terms, plans, frame.events);
    const recommendedPlan = verdict.verdict === "recommend_change" ? (plans.find((p) => p.id === verdict.recommendedPlanId) ?? null) : null;
    const policyRef = policyRow.externalRef ?? policyRow.policyNumber;
    const prose = buildReassessmentProse({ features, verdict, plan: frame.terms, recommendedPlan, policyRef });

    const [row] = await db
      .insert(planFitReassessment)
      .values({
        policyId,
        triggeredByEventId,
        verdict: verdict.verdict,
        recommendedPlanId: verdict.verdict === "recommend_change" ? verdict.recommendedPlanId : null,
        brokerReasoning: prose.broker,
        memberReasoning: prose.member,
        citations: prose.citations,
        createdBy: "system",
      })
      .returning();

    const openTask = await openReassessmentTask(policyId);
    if (verdict.verdict === "recommend_change") {
      // One live task at a time: a new event that still recommends the same kind of change does not raise a
      // second one while the first is still open for a person to look at.
      if (!openTask) {
        await db.insert(reviewTask).values({
          subjectType: "reassessment",
          subjectId: row.id,
          reason: `Plan-fit: recommends moving to ${recommendedPlan?.name ?? "another plan"} (${verdict.reasonCodes.join(", ")}).`,
          priorityScore: REASSESSMENT_PRIORITY,
          status: "open",
        });
      }
    } else if (openTask) {
      // The picture changed since the open task was raised: this event's own reassessment now confirms the
      // current plan, so the earlier recommendation is stale. Closed, not deleted — the row it pointed at stays
      // on the record, same as everything else in this system.
      await db.update(reviewTask).set({ status: "resolved", resolvedAt: new Date() }).where(eq(reviewTask.id, openTask.id));
    }
  } catch (error) {
    console.error("reassessment failed", policyId, triggeredByEventId, error);
  }
}

// ---------------------------------------------------------------------------
// The broker's verbs on a `recommend_change` task (plan §13.3.3: Approve · Edit reasoning · Dismiss)
// ---------------------------------------------------------------------------

export type ReassessDecisionResult = { ok: true; message: string } | { ok: false; reason: string };

async function loadReassessTask(taskId: string, advisorUserId: string) {
  const [advisor] = await db.select({ id: appUser.id, role: appUser.role }).from(appUser).where(eq(appUser.id, advisorUserId)).limit(1);
  if (!advisor || advisor.role !== "advisor") return { ok: false as const, error: "Only an advisor can decide this." };
  const [task] = await db.select().from(reviewTask).where(eq(reviewTask.id, taskId)).limit(1);
  if (!task || task.subjectType !== "reassessment") return { ok: false as const, error: "That task is not a plan-fit reassessment." };
  if (task.status === "resolved") return { ok: false as const, error: "That has already been decided." };
  const [row] = await db.select().from(planFitReassessment).where(eq(planFitReassessment.id, task.subjectId)).limit(1);
  if (!row) return { ok: false as const, error: "The reassessment is missing." };
  return { ok: true as const, task, row };
}

/** Accept the recommendation as written — the member can now read it. */
export async function approveReassessment(input: { taskId: string; advisorUserId: string; note: string }): Promise<ReassessDecisionResult> {
  const p = await loadReassessTask(input.taskId, input.advisorUserId);
  if (!p.ok) return { ok: false, reason: p.error };
  const note = input.note.trim();
  if (note.length < 10) return { ok: false, reason: "Add a note for the file — a sentence on what you checked." };
  await db.update(reviewTask).set({ status: "resolved", resolvedAt: new Date(), assignedToUserId: input.advisorUserId }).where(eq(reviewTask.id, p.task.id));
  await db.insert(reviewDecision).values({ reviewTaskId: p.task.id, actorUserId: input.advisorUserId, action: "approve", notes: note });
  return { ok: true, message: "Approved. The member can now see it." };
}

/** Keep the recommendation, but with the broker's own wording — still unlocks it for the member. */
export async function editReassessmentReasoning(input: { taskId: string; advisorUserId: string; note: string; brokerReasoning: string }): Promise<ReassessDecisionResult> {
  const p = await loadReassessTask(input.taskId, input.advisorUserId);
  if (!p.ok) return { ok: false, reason: p.error };
  const note = input.note.trim();
  if (note.length < 10) return { ok: false, reason: "Add a note for the file — a sentence on what you checked." };
  const text = input.brokerReasoning.trim();
  if (text.length < 20) return { ok: false, reason: "Write the reasoning you want on the file." };
  await db.update(planFitReassessment).set({ brokerReasoning: text }).where(eq(planFitReassessment.id, p.row.id));
  await db.update(reviewTask).set({ status: "resolved", resolvedAt: new Date(), assignedToUserId: input.advisorUserId }).where(eq(reviewTask.id, p.task.id));
  await db.insert(reviewDecision).values({ reviewTaskId: p.task.id, actorUserId: input.advisorUserId, action: "edit", notes: note, payload: { brokerReasoning: text } });
  return { ok: true, message: "Saved. The member can now see it." };
}

/** Not now — the member never sees it, and the row stays on the record. */
export async function dismissReassessment(input: { taskId: string; advisorUserId: string; note: string }): Promise<ReassessDecisionResult> {
  const p = await loadReassessTask(input.taskId, input.advisorUserId);
  if (!p.ok) return { ok: false, reason: p.error };
  const note = input.note.trim();
  if (note.length < 10) return { ok: false, reason: "Add a note for the file — a sentence on why." };
  await db.update(reviewTask).set({ status: "resolved", resolvedAt: new Date(), assignedToUserId: input.advisorUserId }).where(eq(reviewTask.id, p.task.id));
  await db.insert(reviewDecision).values({ reviewTaskId: p.task.id, actorUserId: input.advisorUserId, action: "reject", notes: note });
  return { ok: true, message: "Dismissed." };
}

/** Whether a `recommend_change` reassessment is one the member may read — approved or edited, never on its own say-so. */
export async function reassessmentApproved(reassessmentId: string): Promise<boolean> {
  const [decision] = await db
    .select({ action: reviewDecision.action })
    .from(reviewDecision)
    .innerJoin(reviewTask, eq(reviewDecision.reviewTaskId, reviewTask.id))
    .where(and(eq(reviewTask.subjectType, "reassessment"), eq(reviewTask.subjectId, reassessmentId)))
    .orderBy(desc(reviewDecision.decidedAt))
    .limit(1);
  return decision?.action === "approve" || decision?.action === "edit";
}
