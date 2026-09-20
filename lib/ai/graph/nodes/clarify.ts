// `clarify` — when the recommendation agent is genuinely, honestly unsure
// (not a system failure, not a citation problem, not a coverage gap), ask the
// applicant ONE targeted question instead of going straight to an advisor.
//
// Doc: docs/recommendation_architecture.md's four-way split on low confidence
// only ever had one answer, "route to an advisor" — this adds exactly one
// more branch, and only for the one cause a question can actually resolve:
//
//   fallback / verify failure  → still routes straight to the advisor gate,
//                                 unchanged. A question to the applicant does
//                                 not fix a model failure or a hallucinated
//                                 figure, and coverage gaps are facts already
//                                 on the record, not information gaps.
//   genuine low confidence,
//     never asked before        → clarify (this file)
//   genuine low confidence,
//     already asked once        → advisor gate, same as today. At most one
//                                 clarifying question is ever asked per
//                                 application — see `clarificationAsked`
//                                 below, which is loaded fresh from a
//                                 `recommendation_clarify_asked`
//                                 conversation_action row's mere EXISTENCE
//                                 every round (lib/ai/recommendation-session.ts),
//                                 never carried in graph/checkpointer memory.
//                                 `interrupt()` here is only this one
//                                 invocation's control-flow exit.
//
// THE VOCABULARY: the clarification `target` is a `CriterionId` —
// lib/recommendation/types.ts's existing closed set of 8, the same one
// `score_plans` already validates against (doc §3.4). Nothing new is
// invented; a clarification can only ever point at something the scoring
// engine already knows how to act on. Every model-proposed clarification is
// deterministically re-validated (`validateClarification`) before the
// applicant ever sees it — an invented target, an irrelevant one, a question
// that names a plan or a figure nobody observed, a disguised questionnaire,
// or a PII/medical fishing expedition all fail closed into the SAME
// advisor-gate interrupt a live model failure already takes.

import "server-only";
import { z } from "zod";
import { interrupt } from "@langchain/langgraph";
import { structuredCall } from "@/lib/ai/openrouter";
import { CRITERION_IDS, isCriterionRelevant, type CriterionId } from "@/lib/recommendation";
import type { RecommendationStateType, RecommendationTraceStep } from "@/lib/ai/graph/state";

export const CLARIFY_PROMPT_VERSION = "clarify-v2";

/**
 * Below this, the weight set driving the shortlist rests on preferences we are
 * not sure the applicant actually holds — and unlike a low-confidence
 * RECOMMENDATION, that is a question's natural shape: we know exactly which
 * criterion we are unsure about, and one answer fixes it for every future
 * round. See `weakestWeightTarget` below.
 */
export const WEIGHT_CONFIDENCE_FLOOR = 0.5;

const clarifySchema = z.object({ target: z.string(), question: z.string().min(1) });

/** Every currency figure or month count worth citing — same regex `verify.ts` and `plan-converse.ts` each keep their own copy of. */
const numbersIn = (text: string): string[] => [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, ""));

const PII_BLOCKLIST = ["diagnos", "medication", "prescri", "passport", "bank account", "social security", "ssn", "condition name"];

/** The `criterionId`s the agent actually weighted this round, if it called `score_plans` at all. */
function scorePlansTargets(trace: RecommendationTraceStep[]): Set<CriterionId> {
  const ids = trace
    .filter((step) => step.tool === "score_plans" && step.validation === "ok")
    .flatMap((step) => {
      const args = step.args as { criteria?: { criterionId?: string }[] } | null;
      return (args?.criteria ?? []).map((c) => c.criterionId);
    })
    .filter((id): id is CriterionId => Boolean(id) && (CRITERION_IDS as readonly string[]).includes(id as string));
  return new Set(ids);
}

type ClarifyContext = {
  uncertaintyReason: string;
  candidateTargets: CriterionId[];
  provisionalShortlist: { planId: string; rank: number }[];
  relevantFacts: {
    needs: { benefitClass: string | null; horizonMonths: number | null }[];
    priorities: string[];
    providers: { tier: string | null }[];
  };
};

/**
 * Relevant to this record at all (`isCriterionRelevant`, the same gate
 * `score_plans` itself enforces), narrowed further to whatever this round's
 * `score_plans` call actually weighted, when there was one — the closed set
 * that concretely drove THIS round's uncertainty, not just any criterion
 * that could theoretically apply.
 */
function candidateTargets(state: RecommendationStateType): CriterionId[] {
  const relevant = CRITERION_IDS.filter((id) => isCriterionRelevant(id, state.record));
  const weighted = scorePlansTargets(state.trace);
  const narrowed = weighted.size > 0 ? relevant.filter((id) => weighted.has(id)) : relevant;

  // A weight-confidence clarification is not an open question. We know which
  // criterion is resting on a shaky signal, so the target is decided here,
  // deterministically, and the model is left with only the wording. Falls
  // through to the open list if that criterion turns out not to be a legal
  // target at all.
  if (isWeightTriggered(state)) {
    const target = weakestWeightTarget(state);
    if (target && narrowed.includes(target)) return [target];
  }
  return narrowed;
}

/** True when the recommendation itself was fine and it is the WEIGHTS we are unsure of. */
function isWeightTriggered(state: RecommendationStateType): boolean {
  return state.recoConfidence !== "low" && state.weightConfidence < WEIGHT_CONFIDENCE_FLOOR;
}

/**
 * The criterion whose weight moved most on the least certain evidence:
 * `|shift| x (1 - mean signal confidence)`. Both halves matter — an uncertain
 * signal that barely moved anything is not worth a question, and a confident
 * signal that moved a lot is not in doubt.
 */
export function weakestWeightTarget(state: RecommendationStateType): CriterionId | null {
  let worst: { id: CriterionId; score: number } | null = null;
  for (const e of state.weightExplanation) {
    if (e.shift === 0 || e.drivenBy.length === 0) continue;
    const meanConfidence = e.drivenBy.reduce((sum, sig) => sum + sig.confidence, 0) / e.drivenBy.length;
    const score = Math.abs(e.shift) * (1 - meanConfidence);
    if (score > 0 && (worst == null || score > worst.score)) worst = { id: e.criterionId, score };
  }
  return worst?.id ?? null;
}

function buildClarifyContext(state: RecommendationStateType): ClarifyContext {
  const target = isWeightTriggered(state) ? weakestWeightTarget(state) : null;
  return {
    uncertaintyReason: target
      ? `The shortlist itself is sound, but the weight given to "${target}" rests on a preference we are not confident the applicant actually stated.`
      : state.recoUncertaintyReason ?? "no reason given",
    candidateTargets: candidateTargets(state),
    provisionalShortlist: state.shortlist,
    // Deliberately narrow — no brokerReasoning/memberReasoning, no raw tool
    // observation text. The question generator gets only what could inform
    // one of the candidate targets, nothing broker-only, nothing beyond what
    // a relevant target already implies (e.g. health conditions never appear
    // here at all — `chronic_depth` is a target, not a fact to restate).
    relevantFacts: {
      needs: state.record.needs.map((n) => ({ benefitClass: n.benefitClass, horizonMonths: n.horizonMonths })),
      priorities: state.record.priorities.map((p) => p.rawText),
      providers: state.record.providers.map((p) => ({ tier: p.tier })),
    },
  };
}

function systemPrompt(): string {
  return [
    "A health-insurance plan shortlist for an applicant came out genuinely low-confidence — not a system failure, a real judgement call between close options.",
    "Write ONE short, specific question to ask the applicant that would help resolve it.",
    "You may only pick a target from the `candidateTargets` list you are given — choose the one the uncertainty is actually about.",
    "Do not ask about anything already covered in `relevantFacts` — ask about what is genuinely undecided.",
    "Never name a specific plan. Never state a number, price, premium, or waiting period yourself — you were not given any figures and may not invent one; the question is about the applicant's preference, not a fact.",
    "Ask exactly one question, not a list.",
    'Return ONE JSON object, nothing else: {"target": "<one of candidateTargets>", "question": "..."}',
    "No code fences, no commentary outside the JSON object.",
  ].join("\n");
}

/**
 * All of these must pass before a clarifying question ever reaches the
 * applicant. Returns the rejection reason, or null when the question is
 * clean. Every check here is deterministic — no second model call judges
 * the first one.
 */
export function validateClarification(candidate: { target: string; question: string }, state: RecommendationStateType): string | null {
  if (!(CRITERION_IDS as readonly string[]).includes(candidate.target)) {
    return `unknown target "${candidate.target}"`;
  }
  const target = candidate.target as CriterionId;
  if (!isCriterionRelevant(target, state.record)) {
    return `target "${target}" is not relevant to this record`;
  }
  const weighted = scorePlansTargets(state.trace);
  if (weighted.size > 0 && !weighted.has(target)) {
    return `target "${target}" was not among the criteria actually weighted this round`;
  }

  const question = candidate.question.trim();
  if (question.length === 0) return "empty question";
  if (question.length > 200) return "question too long — reads as a questionnaire, not one question";
  if ((question.match(/\?/g) ?? []).length > 1) return "more than one question mark — not a single targeted question";

  const lower = question.toLowerCase();
  const planNames = state.catalogue.plans.flatMap((p) => [p.id.toLowerCase(), p.name.toLowerCase()]);
  if (planNames.some((name) => lower.includes(name))) return "question names a specific plan — steering, not asking";

  // No figure in the question may go beyond what this round's trace actually
  // observed — the same discipline `verify.ts` applies to the agent's final
  // prose, applied here to the question itself.
  const observed = new Set(state.trace.flatMap((step) => (step.validation === "ok" ? numbersIn(step.observationSummary) : [])));
  const uncited = numbersIn(question).filter((n) => !observed.has(n));
  if (uncited.length > 0) return `question states a figure never observed this round (${uncited.join(", ")})`;

  if (PII_BLOCKLIST.some((kw) => lower.includes(kw))) return "question requests medical/PII detail beyond the closed target vocabulary";

  return null;
}

/**
 * The conditional edge out of `verify` — clarify is reachable only when
 * genuinely uncertain and never asked before.
 *
 *   fallback / verify failure          -> gate. A question to the applicant
 *                                         fixes neither a model failure nor a
 *                                         hallucinated figure.
 *   low recommendation confidence      -> clarify, or gate if already asked.
 *   confident recommendation built on
 *     low-confidence WEIGHTS           -> clarify, or gate if already asked.
 *                                         The shortlist may be a perfectly
 *                                         sound answer to a question we are
 *                                         not sure we were asked.
 */
export function routeAfterVerify(state: RecommendationStateType): "clarify" | "gate" | "present" {
  if (state.fellBackTo != null || state.verifyFailed) return "gate";
  if (state.recoConfidence === "low") return state.clarificationAsked ? "gate" : "clarify";
  if (isWeightTriggered(state)) return state.clarificationAsked ? "gate" : "clarify";
  return "present";
}

export async function clarify(state: RecommendationStateType): Promise<Partial<RecommendationStateType>> {
  const targets = candidateTargets(state);

  // Same interrupt shape `recommendationGate` already uses — no `kind` field
  // — so a clarification that can't be produced or can't be validated
  // degrades into exactly the same advisor-gate path a live model failure
  // already takes. `runRecommendation` (lib/ai/graph.ts) tells the two apart
  // purely by checking `kind === "clarify"` on the interrupt value.
  const toGate = (reason: string) =>
    interrupt({ applicationId: state.record.applicationId, reason, confidence: state.recoConfidence });

  if (targets.length === 0) {
    toGate("no clarification target is relevant to this record");
    return {};
  }

  // `interrupt()` signals a pause by THROWING — that's the mechanism LangGraph
  // uses to unwind the stack back to its own executor. Only the network call
  // may sit inside this try/catch; an `interrupt()` call must never be inside
  // it, or its own throw gets swallowed here and misreported as "generation
  // failed" even on a full success. (Caught live: a validated question really
  // was produced, then silently lost to exactly this bug.)
  let called: z.infer<typeof clarifySchema>;
  try {
    const ctx = buildClarifyContext(state);
    called = (
      await structuredCall({
        system: systemPrompt(),
        user: JSON.stringify(ctx),
        schema: clarifySchema,
        temperature: 0.4,
      })
    ).value;
  } catch (error) {
    toGate(`clarification question generation failed: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }

  const rejection = validateClarification(called, state);
  if (rejection) {
    toGate(`clarification rejected: ${rejection}`);
  } else {
    interrupt({
      applicationId: state.record.applicationId,
      kind: "clarify",
      target: called.target,
      question: called.question,
    });
  }

  return {};
}
