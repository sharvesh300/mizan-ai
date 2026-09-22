// The reassessment case page's data — BROKER ONLY (plan §13.3.4).
//
// One `plan_fit_reassessment` row, with everything a broker reads to decide on it: the verdict and both
// registers' prose, the citations that back it (structured, never parsed back out), the hindsight table (§13.3.4
// stretch — "had you been on this plan from the start"), and the open review task, if one is still waiting.
// Reads only. Returns the whole record — a member surface never imports this.

import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { person, plan, planFitReassessment, policy, reviewTask } from "@/db/schema";
import type { Citation } from "./reassess-template";
import { buildHindsightTable, type HindsightRow } from "./reassess";
import { planRowToTerms, replayPolicy } from "./store";

export type ReassessmentCase = {
  id: string;
  policy: { id: string; ref: string; number: string; planName: string };
  subject: { fullName: string };
  verdict: "confirm" | "recommend_change";
  reasonCodes: string[] | null;
  recommendedPlanName: string | null;
  brokerReasoning: string;
  memberReasoning: string;
  citations: Citation[];
  createdBy: string;
  createdAt: Date;
  hindsight: HindsightRow[];
  task: { id: string; reason: string; priorityScore: number; status: string } | null;
};

export async function getReassessmentCase(policyId: string, reassessmentId: string): Promise<ReassessmentCase | null> {
  const [row] = await db.select().from(planFitReassessment).where(eq(planFitReassessment.id, reassessmentId)).limit(1);
  if (!row || row.policyId !== policyId) return null;

  const [[policyRow], [recommendedPlan], catalogue, frame] = await Promise.all([
    db.select().from(policy).innerJoin(person, eq(policy.personId, person.id)).innerJoin(plan, eq(policy.planId, plan.id)).where(eq(policy.id, policyId)).limit(1),
    row.recommendedPlanId ? db.select().from(plan).where(eq(plan.id, row.recommendedPlanId)).limit(1) : Promise.resolve([undefined]),
    db.select().from(plan),
    replayPolicy(policyId),
  ]);
  if (!policyRow) return null;

  // OPEN only — same discipline as the event case page's own task lookup (`lib/servicing/case.ts`). A resolved
  // task must not re-show the decision panel: `task: truthy` used to be enough to render it, so a dismissed or
  // approved reassessment re-offered Approve/Edit/Dismiss with a blank note on the very next load.
  const [openTask] = await db
    .select()
    .from(reviewTask)
    .where(and(eq(reviewTask.subjectType, "reassessment"), eq(reviewTask.subjectId, row.id), eq(reviewTask.status, "open")))
    .limit(1);

  return {
    id: row.id,
    policy: { id: policyId, ref: policyRow.policy.externalRef ?? policyRow.policy.policyNumber, number: policyRow.policy.policyNumber, planName: policyRow.plan.name },
    subject: { fullName: policyRow.person.fullName },
    verdict: row.verdict,
    reasonCodes: null,
    recommendedPlanName: recommendedPlan?.name ?? null,
    brokerReasoning: row.brokerReasoning,
    memberReasoning: row.memberReasoning,
    citations: row.citations,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    hindsight: buildHindsightTable(catalogue.map(planRowToTerms), policyRow.policy.planId, frame.events),
    task: openTask ? { id: openTask.id, reason: openTask.reason, priorityScore: openTask.priorityScore, status: openTask.status } : null,
  };
}
