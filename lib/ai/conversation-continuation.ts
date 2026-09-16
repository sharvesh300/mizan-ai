// What to say back to the applicant as assessment, and later recommendation,
// resolve — replacing the old behavior of unconditionally setting
// `conversation.status = "completed"` the moment an application is submitted.
//
// Two touchpoints, not one, because recommendation itself no longer happens
// inline with the request that triggered it — see
// `lib/ai/recommendation-session.ts`'s `scheduleRecommendation`, which runs
// the agent loop in the background (via `after()`) so an applicant's submit
// or an advisor's approve returns immediately instead of hanging on however
// long the model takes:
//
//   announceAssessmentOutcome    called synchronously, right after
//                                validateAndClassify, BEFORE recommendation
//                                has had a chance to run. Says what is true
//                                right now.
//
//   announceRecommendationOutcome  called from the background job once
//                                `runRecommendation` resolves. Looks the
//                                conversation up itself — it runs detached
//                                from whatever request originally triggered
//                                it, so nothing hands it a conversationId.
//
// The conversation only ever reaches `completed` via a decline (never
// re-opens) or once a policy has issued — nothing here sets that status.

import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { application, conversation, recommendation } from "@/db/schema";
import { sayAssistant, type RecommendationClarifyPayload, type RecommendationShortlistPayload } from "@/lib/ai/intake-session";

/**
 * Exported so `lib/ai/recommendation-session.ts` can find the conversation a
 * clarifying question needs to be posted into, without re-deriving this
 * lookup itself.
 */
export async function latestConversationForApplication(applicationId: string) {
  const [convo] = await db
    .select()
    .from(conversation)
    .where(eq(conversation.applicationId, applicationId))
    .orderBy(desc(conversation.startedAt))
    .limit(1);
  return convo ?? null;
}

/**
 * What's true immediately after `validateAndClassify`. Recommendation has, at
 * most, only just been scheduled — never awaited here — so this can only ever
 * report "an advisor has your record" or "one moment", never an actual
 * shortlist.
 *
 * A CLEAN record gets no waiting state: the constraint rules ran (that is
 * what assessment IS), nothing on the record needed a person, so the
 * applicant never surfaces in an "assessed, an advisor has this" step — the
 * thread stays `active` and the composer stays live while recommendation
 * runs in the background. Only a genuinely gated record (`in_review`) hands
 * the conversation to an advisor.
 */
export async function announceAssessmentOutcome(conversationId: string, applicationId: string): Promise<void> {
  const [app] = await db.select({ status: application.status }).from(application).where(eq(application.id, applicationId)).limit(1);
  if (!app) return;

  if (app.status === "in_review") {
    await sayAssistant(
      conversationId,
      "Thank you — an advisor is reviewing your details personally. No action needed from you right now.",
      { applicationId },
    );
    await db.update(conversation).set({ status: "awaiting_review", lastOutboundAt: new Date() }).where(eq(conversation.id, conversationId));
    return;
  }

  await sayAssistant(conversationId, "Thank you — I'm working out the best plan for you now. One moment.", { applicationId });
  await db.update(conversation).set({ status: "active", lastOutboundAt: new Date() }).where(eq(conversation.id, conversationId));
}

/**
 * The follow-up, once recommendation has actually resolved — posted from the
 * background job (`scheduleRecommendation`), never from request handling
 * directly. Finds the conversation itself since the caller has no
 * conversationId in scope (an advisor's approve, in particular, never did).
 *
 * Returns the conversation id it posted into (or null when there was none to
 * post into) so the background job can revalidate that chat route directly —
 * the applicant is sitting on that page waiting, and `scheduleRecommendation`
 * runs in `after()`, well past the request that could have revalidated it.
 */
export async function announceRecommendationOutcome(applicationId: string): Promise<string | null> {
  const convo = await latestConversationForApplication(applicationId);
  if (!convo || convo.status === "completed") return null;

  // Every completed round writes a live `recommendation` row — gated or not
  // (see `persistRecommendation`, lib/ai/recommendation-session.ts). A
  // fallback or low-confidence round still opens a review task alongside,
  // but that is an advisor's queue item, not a reason to withhold the card
  // from the applicant who is waiting on it.
  const [reco] = await db
    .select()
    .from(recommendation)
    .where(eq(recommendation.applicationId, applicationId))
    .orderBy(desc(recommendation.version))
    .limit(1);
  if (reco) {
    const payload: RecommendationShortlistPayload = {
      kind: "recommendation_shortlist",
      round: reco.version,
      recommendationId: reco.id,
      applicationId,
    };
    await sayAssistant(convo.id, "Here's the plan we'd suggest. Have a look and let me know what you think.", payload);
    await db.update(conversation).set({ status: "awaiting_user", lastOutboundAt: new Date() }).where(eq(conversation.id, convo.id));
    return convo.id;
  }

  // No recommendation row at all — `runRecommendation` threw before it ever
  // reached `persistRecommendation`. The one genuine "an advisor is looking
  // at this" case, since nothing was produced to show.
  await sayAssistant(convo.id, "An advisor is taking a closer look at the plan before we show it to you.", { applicationId });
  await db.update(conversation).set({ status: "awaiting_review", lastOutboundAt: new Date() }).where(eq(conversation.id, convo.id));
  return convo.id;
}

/**
 * The applicant-facing half of `clarify` (lib/ai/graph/nodes/clarify.ts) —
 * called from `scheduleRecommendation` when `outcome.pendingClarification` is
 * set, instead of `announceRecommendationOutcome`.
 *
 * `persistRecommendation` (lib/ai/recommendation-session.ts) already wrote the
 * authoritative `recommendation_clarify_asked` row — race-safe, inside its own
 * transaction alongside `model_run`/`ai_decision` — before this ever runs.
 * This function's only job is telling the applicant: post the question as the
 * assistant's own message (display only — `sendChatMessage`'s answer-handling
 * branch reads the DB row directly, never this message's payload) and open
 * the conversation for their reply.
 */
export async function announceClarificationRequest(applicationId: string, question: string): Promise<string | null> {
  const convo = await latestConversationForApplication(applicationId);
  if (!convo || convo.status === "completed") return null;

  const payload: RecommendationClarifyPayload = { kind: "recommendation_clarify", question, applicationId };
  await sayAssistant(convo.id, question, payload);
  await db.update(conversation).set({ status: "awaiting_user", lastOutboundAt: new Date() }).where(eq(conversation.id, convo.id));
  return convo.id;
}
