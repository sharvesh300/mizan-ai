// Application Amendment & Re-assessment Orchestrator.
//
// When an applicant or advisor amends an application after creation (e.g. changing
// budget, declared conditions, or needs), this module ensures:
// 1. SQLite durable state is updated with an audit trail (via `updateApplicationFromDraft`).
// 2. The entire assessment pipeline runs fresh from `validate` with { force: true }.
// 3. Stale recommendations/quotes are superseded, preventing outdated plan proposals.
// 4. If clean (`auto`), recommendation is scheduled; if flagged, it routes to review.

import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { application, type ApplicationStatus } from "@/db/schema";
import { validateAndClassify } from "@/lib/ai/assessment-session";
import { updateApplicationFromDraft, type IntakeDraft } from "@/lib/intake";

export type AmendmentResult = {
  applicationId: string;
  previousStatus: ApplicationStatus;
  newStatus: ApplicationStatus;
  assessed: boolean;
};

/**
 * Formally amend an existing application's declared facts and re-trigger
 * the assessment and recommendation pipeline from `validate`.
 */
export async function amendAndReassessApplication(
  applicationId: string,
  draft: IntakeDraft,
  actor: { id: string },
  reason = "Applicant amended their details",
): Promise<AmendmentResult> {
  const [app] = await db
    .select({ status: application.status })
    .from(application)
    .where(eq(application.id, applicationId))
    .limit(1);

  if (!app) throw new Error(`Application ${applicationId} not found.`);

  const previousStatus = app.status;

  // 1. Update application in SQLite, log status history to 'submitted'
  await updateApplicationFromDraft(applicationId, draft, actor, reason);

  // 2. Re-run assessment from `validate` (force: true re-evaluates flags and cohort).
  // If verdict.gate is 'auto', validateAndClassify automatically calls scheduleRecommendation.
  const outcome = await validateAndClassify(applicationId, { force: true });

  const [updated] = await db
    .select({ status: application.status })
    .from(application)
    .where(eq(application.id, applicationId))
    .limit(1);

  return {
    applicationId,
    previousStatus,
    newStatus: updated?.status ?? "submitted",
    assessed: outcome != null,
  };
}
