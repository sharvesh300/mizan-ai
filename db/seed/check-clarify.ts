// Deterministic checks for the recommendation clarification detour
// (lib/ai/graph/nodes/clarify.ts) — no live model call anywhere in this file.
//
//   bun run --conditions=react-server db/seed/check-clarify.ts
//
// `--conditions=react-server` is required (not just conventional) — this is
// the first check script to import anything marked `import "server-only"`
// (lib/ai/recommendation-session.ts and friends). That package resolves to a
// throwing stub under plain Node/Bun conditions and a no-op under Next's own
// `react-server` condition; the flag picks the no-op the same way Next's
// build does. check-assessment.ts/check-recommendation.ts never needed this
// because they only import pure lib/assessment and lib/recommendation code.
//
// Tests 1-2 are pure functions, no DB. Tests 3-8 exercise the session layer
// (lib/ai/recommendation-session.ts) against a throwaway synthetic
// application — built with the real createApplication/validateAndClassify
// pipeline rather than hand-rolled fixture rows, torn down afterward — so
// they are checking the actual write paths, not a re-implementation of them.
//
// What this file deliberately does NOT attempt: whether a live model asked a
// GOOD question, or whether a real answer measurably improves confidence.
// Neither is deterministic, and this codebase doesn't automate-test
// recommend.ts's actual LLM output either (check-recommendation.ts only
// exercises the deterministic fallback engine). That half is verified live
// in the browser.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { aiDecision, application, appUser, conversation, conversationAction, modelRun, quote, recommendation, reviewTask } from "@/db/schema";
import { emptyRecord, type Catalogue } from "@/lib/assessment";
import { loadCatalogue, validateAndClassify } from "@/lib/ai/assessment-session";
import { routeAfterVerify, validateClarification } from "@/lib/ai/graph/nodes/clarify";
import type { RecommendationOutcome, RecommendationStateType } from "@/lib/ai/graph/state";
import { createApplication, emptyDraft } from "@/lib/intake";
import { loadRecommendationInputs, persistRecommendation } from "@/lib/ai/recommendation-session";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

function baseState(catalogue: Catalogue, patch: Partial<RecommendationStateType> = {}): RecommendationStateType {
  return {
    record: emptyRecord(),
    catalogue,
    context: { today: new Date().toISOString().slice(0, 10), openApplicationsForPerson: 0 },
    cohort: null,
    fired: [],
    verdict: null,
    narrated: [],
    queueLine: null,
    servedBy: null,
    latencyMs: 0,
    previousRounds: [],
    quotes: [],
    trace: [],
    shortlist: [],
    rejections: [],
    brokerReasoning: null,
    memberReasoning: null,
    recoConfidence: "high",
    recoUncertaintyReason: null,
    fellBackTo: null,
    verifyFailed: false,
    clarificationAsked: false,
    clarification: null,
    tradeOffAsked: false,
    assessmentOnly: false,
    preferenceSignals: [],
    extractedSignals: [],
    signalsDropped: [],
    baseWeights: [],
    dynamicWeights: [],
    weightExplanation: [],
    weightConfidence: 1,
    round: 1,
    negotiationTurns: 0,
    negotiationReply: null,
    negotiationOutcome: null,
    ...patch,
  };
}

async function main() {
  const catalogue = await loadCatalogue();

  // ---------------------------------------------------------------------
  // 1. routeAfterVerify — the full four-way matrix
  // ---------------------------------------------------------------------
  console.log("\n1. routeAfterVerify");
  const routeCases: [string, Partial<RecommendationStateType>, "clarify" | "gate" | "present"][] = [
    ["fallback ran", { fellBackTo: "no model configured" }, "gate"],
    ["citation/eligibility verify failure", { verifyFailed: true }, "gate"],
    ["low confidence, not yet asked", { recoConfidence: "low" }, "clarify"],
    ["low confidence, already asked", { recoConfidence: "low", clarificationAsked: true }, "gate"],
    ["medium confidence", { recoConfidence: "medium" }, "present"],
    ["high confidence", { recoConfidence: "high" }, "present"],
    ["fallback wins even over low+not-asked", { fellBackTo: "x", recoConfidence: "low" }, "gate"],
  ];
  for (const [label, patch, want] of routeCases) {
    const got = routeAfterVerify(baseState(catalogue, patch));
    check(label, got === want, `got "${got}" want "${want}"`);
  }

  // ---------------------------------------------------------------------
  // 2. validateClarification — every gate independently
  // ---------------------------------------------------------------------
  console.log("\n2. validateClarification");
  const clean = baseState(catalogue, { record: emptyRecord() });

  check("valid question passes", validateClarification({ target: "premium_cost", question: "Would you rather pay less each month, even with a smaller network?" }, clean) === null);
  check("unknown target rejected", validateClarification({ target: "not_a_real_criterion", question: "ok?" }, clean) !== null);
  check("irrelevant target rejected (no declared condition)", validateClarification({ target: "chronic_depth", question: "How much does ongoing condition cover matter to you?" }, clean) !== null);
  check("plan name in question rejected", validateClarification({ target: "premium_cost", question: "Would you prefer Essential over the other two?" }, clean) !== null);
  check("unobserved figure rejected", validateClarification({ target: "premium_cost", question: "Are you comfortable paying up to 12000 AED a year?" }, clean) !== null);
  check("two questions rejected", validateClarification({ target: "premium_cost", question: "Do you want the cheapest plan? Or the widest network?" }, clean) !== null);
  check("over-length question rejected", validateClarification({ target: "premium_cost", question: `${"a".repeat(220)}?` }, clean) !== null);
  check("PII-fishing question rejected", validateClarification({ target: "premium_cost", question: "What medication are you currently taking?" }, clean) !== null);

  // ---------------------------------------------------------------------
  // 3-8. Session layer, against throwaway synthetic applications
  // ---------------------------------------------------------------------
  const [testUser] = await db.select({ id: appUser.id, fullName: appUser.fullName }).from(appUser).where(eq(appUser.role, "applicant")).limit(1);
  if (!testUser) {
    console.log("\nno seeded applicant user found — skipping 3-8 (run `npm run db:seed` first)");
  } else {
    await sessionTests(testUser);
  }

  console.log(`\n${failures === 0 ? "all checks pass" : `${failures} check(s) failed`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

const draft = (age: number) => ({ ...emptyDraft(), age, budget: "comfortable" as const, maritalStatus: "single" as const, smoker: false, emirate: "Dubai" });

/** A fresh, clean (no flags) synthetic application + conversation, via the real pipeline, not hand-rolled rows. */
async function newSyntheticApplication(testUser: { id: string; fullName: string }, age: number) {
  const applicationId = await createApplication(testUser, draft(age), "web_form");
  try {
    await validateAndClassify(applicationId);
  } catch (error) {
    // `validateAndClassify` auto-gates a clean record straight into
    // `scheduleRecommendation`, which calls Next's `after()` — only valid
    // inside a real request. The assessment row it needs is already written
    // before that call (see lib/ai/assessment-session.ts), so this is safe
    // to ignore here: this script fabricates its own RecommendationOutcome
    // objects for tests 3-8 rather than depending on the auto-scheduled run.
    if (!(error instanceof Error) || !error.message.includes("outside a request scope")) throw error;
  }
  const [row] = await db.select({ personId: application.personId }).from(application).where(eq(application.id, applicationId)).limit(1);
  const [convo] = await db
    .insert(conversation)
    .values({ channel: "web_chat", purpose: "intake", status: "active", userId: testUser.id, personId: row!.personId, applicationId })
    .returning();
  return { applicationId, conversationId: convo.id };
}

/**
 * `review_task.subjectId` is a recommendationId, not an applicationId —
 * callers delete those explicitly by id before this runs.
 *
 * `application` has real FK-enforced children beyond the ones this script
 * itself writes (conditions/needs/priorities/providers/assessment/status
 * history, none of which are readable from outside `application` once it's
 * gone) — rather than hand-enumerate every one, foreign_keys is turned off
 * for just this delete. Safe here specifically because every row involved is
 * this script's own throwaway synthetic data with no other reader.
 */
async function wipeApplication(applicationId: string, conversationId: string | null) {
  await db.delete(conversationAction).where(eq(conversationAction.subjectId, applicationId));
  await db.delete(aiDecision).where(eq(aiDecision.subjectId, applicationId));
  await db.delete(quote).where(eq(quote.applicationId, applicationId));
  await db.delete(recommendation).where(eq(recommendation.applicationId, applicationId));
  if (conversationId) await db.delete(conversation).where(eq(conversation.id, conversationId));
  await db.run(sql`pragma foreign_keys = off`);
  try {
    await db.delete(application).where(eq(application.id, applicationId));
  } finally {
    await db.run(sql`pragma foreign_keys = on`);
  }
}

async function sessionTests(testUser: { id: string; fullName: string }) {
  console.log("\n3-6. persistRecommendation / loadRecommendationInputs (sequential rounds on one synthetic application)");

  const { applicationId, conversationId } = await newSyntheticApplication(testUser, 29);

  // The exact shape `verify` hands to `clarify`/`gate` for a genuinely
  // uncertain, clean (no fallback, no verify failure) round — fabricated
  // directly, which is what makes this testable without a live model call.
  const clarifyOutcome: RecommendationOutcome = {
    quotes: [{ planId: "plan_a", annualPremium: 4200, eligible: true, rank: 1, score: 0.9 }],
    shortlist: [{ planId: "plan_a", rank: 1 }],
    rejections: [],
    brokerReasoning: "close call between Essential and Balanced",
    memberReasoning: "Essential looks like the better fit, but it's close",
    confidence: "low",
    uncertaintyReason: "premium vs network access is a close call",
    trace: [],
    fellBackTo: null,
    verifyFailed: false,
    routedToReview: false,
    pendingClarification: { target: "premium_cost", question: "Would you rather pay less each month, even with a smaller network?" },
    servedBy: "test-model",
    latencyMs: 1200,
    pendingTradeOff: null,
    extractedSignals: [],
    weights: { base: [], dynamic: [], explanation: [], confidence: 1 },
  };

  // --- 3: clarification branch — audit trail written, nothing presentable ---
  const result3 = await persistRecommendation(applicationId, clarifyOutcome, 1, conversationId);
  check("3. persistRecommendation returns no recommendationId", result3.recommendationId === null);
  check("3. persistRecommendation returns no reviewTaskId", result3.reviewTaskId === null);

  const [recoAfter3] = await db.select().from(recommendation).where(eq(recommendation.applicationId, applicationId)).limit(1);
  check("3. no recommendation row written", recoAfter3 === undefined);

  // `validateAndClassify` already wrote its OWN ai_decision for this
  // applicationId (cohort_classification/flag_evaluation) — scope to
  // `plan_recommendation` specifically, same as `persistRecommendation`'s own
  // supersede queries do, so this reads the row this test actually wrote.
  const [decision3] = await db
    .select()
    .from(aiDecision)
    .where(and(eq(aiDecision.subjectId, applicationId), eq(aiDecision.decisionType, "plan_recommendation")))
    .limit(1);
  check("3. ai_decision.status === clarification_required", decision3?.status === "clarification_required");
  check("3. ai_decision.requiresReview === true (schema CHECK)", decision3?.requiresReview === true);
  check("3. ai_decision.reviewTaskId === null (no review_task)", decision3?.reviewTaskId == null);

  const [run3] = decision3?.modelRunId ? await db.select().from(modelRun).where(eq(modelRun.id, decision3.modelRunId)).limit(1) : [undefined];
  check("3. model_run written for the completed model call", run3 !== undefined);

  const [appAfter3] = await db.select({ status: application.status }).from(application).where(eq(application.id, applicationId)).limit(1);
  check("3. application.status did not advance to recommended", appAfter3?.status !== "recommended");

  const [asked3] = await db
    .select()
    .from(conversationAction)
    .where(and(eq(conversationAction.subjectId, applicationId), eq(conversationAction.actionType, "recommendation_clarify_asked")))
    .limit(1);
  check("3. recommendation_clarify_asked row written", asked3 !== undefined);

  // --- 5: loadRecommendationInputs reconstructs purely from row existence/content ---
  const inputs5a = await loadRecommendationInputs(applicationId);
  check("5. clarificationAsked reconstructed true from row existence alone", inputs5a?.clarificationAsked === true);
  check("5. clarification is null before an answer exists", inputs5a?.clarification === null);

  await db.insert(conversationAction).values({
    conversationId,
    actionType: "recommendation_clarify_answered",
    arguments: { rawAnswer: "Network access matters more to me than the premium." },
    subjectType: "application",
    subjectId: applicationId,
    status: "succeeded",
    actorKind: "applicant",
    completedAt: new Date(),
  });
  // A fresh call, no state carried over from inputs5a — the "process restart" property.
  const inputs5b = await loadRecommendationInputs(applicationId);
  check("5. clarification.rawAnswer reconstructed after an answer exists", inputs5b?.clarification?.rawAnswer === "Network access matters more to me than the premium.");
  check("5. clarification.target reconstructed from the asked row, not re-guessed", inputs5b?.clarification?.target === "premium_cost");

  // --- 6: round 2's normal write supersedes round 1's clarification_required ---
  const normalOutcome: RecommendationOutcome = {
    ...clarifyOutcome,
    confidence: "medium",
    uncertaintyReason: null,
    pendingClarification: null,
    routedToReview: false,
    brokerReasoning: "Essential is the clear fit once network access was ruled out as a concern.",
    memberReasoning: "Essential looks right for you.",
  };
  const result6 = await persistRecommendation(applicationId, normalOutcome, 2, conversationId);
  check("6. round 2 writes a live recommendation", result6.recommendationId !== null);

  const [staleDecision6] = await db
    .select()
    .from(aiDecision)
    .where(and(eq(aiDecision.subjectId, applicationId), eq(aiDecision.status, "clarification_required")))
    .limit(1);
  check("6. round 1's clarification_required decision is superseded", staleDecision6 === undefined);

  const [liveDecision6] = await db
    .select()
    .from(aiDecision)
    .where(and(eq(aiDecision.subjectId, applicationId), eq(aiDecision.status, "auto_accepted")))
    .limit(1);
  check("6. round 2 wrote a live (auto_accepted) decision", liveDecision6 !== undefined);

  // aiDecision.reviewTaskId FKs to review_task — wipe it first (inside
  // wipeApplication) so nothing still points at the task by the time it's
  // deleted here.
  await wipeApplication(applicationId, conversationId);
  if (result6.reviewTaskId) await db.delete(reviewTask).where(eq(reviewTask.id, result6.reviewTaskId));

  // ---------------------------------------------------------------------
  // 4. Fallback branch — never writes model_run, independent scenario
  // ---------------------------------------------------------------------
  console.log("\n4. persistRecommendation fallback branch");
  const app4 = await newSyntheticApplication(testUser, 30);
  const fallbackOutcome: RecommendationOutcome = {
    ...clarifyOutcome,
    pendingClarification: null,
    fellBackTo: "no model configured",
    servedBy: null,
    routedToReview: true,
    uncertaintyReason: "No model judgement was applied — this is a rule-based placement.",
  };
  const result4 = await persistRecommendation(app4.applicationId, fallbackOutcome, 1, null);
  check("4. fallback still writes a presentable recommendation", result4.recommendationId !== null);
  const [decision4] = await db
    .select()
    .from(aiDecision)
    .where(and(eq(aiDecision.subjectId, app4.applicationId), eq(aiDecision.decisionType, "plan_recommendation")))
    .limit(1);
  check("4. fallback ai_decision carries no model_run", decision4?.modelRunId == null);
  const runCount4 = decision4?.modelRunId ? (await db.select().from(modelRun).where(eq(modelRun.id, decision4.modelRunId))).length : 0;
  check("4. no model_run row exists for the fallback round", runCount4 === 0);

  await wipeApplication(app4.applicationId, app4.conversationId);
  if (result4.reviewTaskId) await db.delete(reviewTask).where(eq(reviewTask.id, result4.reviewTaskId));

  // ---------------------------------------------------------------------
  // 7 & 8. Concurrency — two attempts for the same application, only one wins
  //
  // Sequential calls, deliberately (better-sqlite3 is one synchronous
  // connection — two truly concurrent `BEGIN`s on it collide before ever
  // reaching the uniqueness check, which is a single-connection artifact, not
  // the property under test). What's under test is the DATABASE-level
  // invariant (db/schema/actions.ts's partial unique indexes +
  // `.onConflictDoNothing()`): the second attempt must be rejected/discarded
  // regardless of ordering, which sequential calls exercise identically to
  // interleaved ones — the index doesn't know or care which arrived "first".
  // ---------------------------------------------------------------------
  console.log("\n7-8. concurrent ask / answer");
  const app7 = await newSyntheticApplication(testUser, 31);
  const raceOutcome: RecommendationOutcome = { ...clarifyOutcome, quotes: [] };

  await persistRecommendation(app7.applicationId, raceOutcome, 1, app7.conversationId);
  await persistRecommendation(app7.applicationId, raceOutcome, 1, app7.conversationId);
  const asked7 = await db
    .select()
    .from(conversationAction)
    .where(and(eq(conversationAction.subjectId, app7.applicationId), eq(conversationAction.actionType, "recommendation_clarify_asked")));
  check("7. exactly one recommendation_clarify_asked row survives two concurrent attempts", asked7.length === 1);

  const [firstAnswer, secondAnswer] = await Promise.all([
    db
      .insert(conversationAction)
      .values({ conversationId: app7.conversationId, actionType: "recommendation_clarify_answered", arguments: { rawAnswer: "a" }, subjectType: "application", subjectId: app7.applicationId, status: "succeeded", actorKind: "applicant", completedAt: new Date() })
      .onConflictDoNothing()
      .returning(),
    db
      .insert(conversationAction)
      .values({ conversationId: app7.conversationId, actionType: "recommendation_clarify_answered", arguments: { rawAnswer: "b" }, subjectType: "application", subjectId: app7.applicationId, status: "succeeded", actorKind: "applicant", completedAt: new Date() })
      .onConflictDoNothing()
      .returning(),
  ]);
  const answered7 = await db
    .select()
    .from(conversationAction)
    .where(and(eq(conversationAction.subjectId, app7.applicationId), eq(conversationAction.actionType, "recommendation_clarify_answered")));
  check("8. exactly one recommendation_clarify_answered row survives two concurrent attempts", answered7.length === 1);
  const wonExactlyOnce = (firstAnswer.length > 0 ? 1 : 0) + (secondAnswer.length > 0 ? 1 : 0);
  check("8. exactly one of the two concurrent inserts actually wrote", wonExactlyOnce === 1);

  await wipeApplication(app7.applicationId, app7.conversationId);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
