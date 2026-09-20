// All nodes for the recommendation graph: price, recommend, verify, recommendationGate.
//
//   RECOMMENDATION (the record is clean)
//     signals ─┬─> price ───┐
//              └─> weights ─┴─> recommend ──> verify ──┬──> clarify            (interrupt: the applicant owns one question)
//                                                      ├──> recommendationGate (interrupt: an advisor owns it)
//                                                      └──> END  (present to the applicant)
//
// Pricing is deterministic and runs in parallel with weight derivation — they
// share no channels, so the fan-in at `recommend` is order-independent.
// Recommend executes the agentic tool-loop over closed catalogues and the
// derived weight set. Verify enforces hard eligibility and citation integrity.
// RecommendationGate flags edge cases for review.

import "server-only";
import { z } from "zod";
import { interrupt } from "@langchain/langgraph";
import { isAgentEnabled, structuredCall } from "@/lib/ai/openrouter";
import { describeTools, runTool, TOOL_NAMES, type ToolContext, type ToolResult } from "@/lib/ai/tools/plans";
import { fallbackRecommend, isEligible, priceAllPlans } from "@/lib/recommendation";
import type { RecommendationStateType, RecommendationTraceStep } from "@/lib/ai/graph/state";

/** Bumped whenever the prompt below changes, so `model_run` rows stay comparable. */
export const RECOMMENDATION_PROMPT_VERSION = "recommend-v3";

/** Doc §3.6: max 8 tool calls per round. */
const MAX_TOOL_CALLS = 8;
const MAX_SAME_ERROR_REJECTIONS = 3;

/**
 * `price` — one quote row per plan, before the agent sees anything.
 * Deterministic, no model.
 */
export function price(state: RecommendationStateType): Partial<RecommendationStateType> {
  return { quotes: priceAllPlans(state.catalogue, state.record) };
}

const stepSchema = z.object({
  thought: z.string().catch(""),
  tool: z.string(),
  args: z.unknown().optional(),
});

function systemPrompt(ctx: ToolContext): string {
  const descriptions = describeTools(ctx);
  return [
    "You are choosing a health insurance plan shortlist for one applicant, from a panel of 3 plans.",
    "You are NEVER given the plan corpus directly. You have tools that answer specific questions about specific plans — call them to find out what you need. Do not guess.",
    "You supply NO numbers of your own. Every amount, waiting period, and figure in your final reasoning must come from a tool's observation, never from your own knowledge of insurance.",
    "",
    "TOOLS (call exactly one per turn):",
    ...TOOL_NAMES.map((name) => `- ${name}: ${descriptions[name]}`),
    "",
    "RULES",
    "- Every argument must be a value a tool actually accepts — one of the exact ids or enum members spelled out above for that tool. An invented value is rejected and tells you what you sent and what was expected; use that to correct it. The SAME wrong value sent again ends your turn.",
    "- Ground every plan choice in what the tools told you, never in what a plan's name suggests.",
    "- Call get_dynamic_weights before score_plans. You do not choose the weights: they are derived from this applicant's cohort policy and the preferences they themselves stated, and the tool tells you which statement moved which criterion. Use that in your reasoning, and stay within the stated tolerance — score_plans rejects a call that ignores the derived set.",
    "- If the applicant rejected a plan on price, do NOT shortlist something more expensive unless every cheaper plan fails a need they declared — and if that is the case, say so plainly in both registers, naming what the cheaper plan does not cover. Coming back with a higher premium and no explanation is not an answer to what they asked.",
    "- Call propose_shortlist exactly once, when you have enough to decide.",
    "",
    "ANSWER FORMAT",
    'Return ONE JSON object, nothing else: {"thought": "...", "tool": "...", "args": {...}}',
    "No code fences, no commentary outside the JSON object.",
  ].join("\n");
}

const summarise = (result: ToolResult): string => (result.ok ? JSON.stringify(result.data).slice(0, 600) : `ERROR: ${result.error}`);

type ProposalData = {
  picks: { planId: string; rank: number }[];
  rejections: { planId: string; reason: string }[];
  confidence: "high" | "medium" | "low";
  uncertaintyReason: string | null;
  brokerReasoning: string;
  memberReasoning: string;
};

const outcomeFromProposal = (data: ProposalData, trace: RecommendationTraceStep[], servedBy: string | null, latencyMs: number): Partial<RecommendationStateType> => ({
  trace,
  shortlist: data.picks,
  rejections: data.rejections,
  brokerReasoning: data.brokerReasoning,
  memberReasoning: data.memberReasoning,
  recoConfidence: data.confidence,
  recoUncertaintyReason: data.uncertaintyReason,
  fellBackTo: null,
  servedBy,
  latencyMs,
});

function forcedProposeSystemPrompt(ctx: ToolContext): string {
  return [
    "Your tool-call budget for this round is spent. Decide now, using only what you already learned in this conversation — do not ask for anything further.",
    "",
    `Call propose_shortlist: ${describeTools(ctx).propose_shortlist}`,
    "",
    "ANSWER FORMAT",
    'Return ONE JSON object, nothing else: {"thought": "...", "tool": "propose_shortlist", "args": {...}}',
    "No code fences, no commentary outside the JSON object.",
  ].join("\n");
}

/**
 * `recommend` — the agent's tool-call loop.
 */
export async function recommend(state: RecommendationStateType): Promise<Partial<RecommendationStateType>> {
  const cohortLabel = state.cohort?.cohort ?? "unassigned";
  const flags = state.verdict?.flags ?? [];
  const ctx: ToolContext = {
    applicationId: state.record.applicationId,
    record: state.record,
    catalogue: state.catalogue,
    cohort: cohortLabel,
    flags,
    previousRounds: state.previousRounds,
    enforceWeightBaseline: true,
    preferenceSignals: state.preferenceSignals,
    // Derived by the `weights` node, which fans out in parallel with `price`
    // and joins here — the agent is handed a weight set, it does not pick one.
    dynamicWeights:
      state.dynamicWeights.length > 0
        ? { weights: state.dynamicWeights, confidence: state.weightConfidence, explanation: state.weightExplanation }
        : null,
  };

  if (!isAgentEnabled()) return fallBack(state, "no model configured", []);

  const system = systemPrompt(ctx);
  const trace: RecommendationTraceStep[] = [];
  const rejectionCounts = new Map<string, number>();
  let servedBy: string | null = null;
  let totalLatency = 0;

  const transcriptLines: string[] = [
    `Applicant cohort: ${cohortLabel}. ${flags.length} flag(s) already on file for this application.`,
    state.previousRounds.length > 0
      ? `This is round ${state.previousRounds.length + 1}. Call previous_rounds before re-offering anything already rejected.`
      : "This is round 1.",
  ];

  if (state.dynamicWeights.length > 0) {
    const moved = state.weightExplanation.filter((e) => e.shift !== 0);
    transcriptLines.push(
      moved.length > 0
        ? `This applicant's weights have already been derived from what they told us: ${moved
            .map((e) => `${e.criterionId} ${e.shift > 0 ? "up" : "down"} to ${e.finalWeight} (${e.drivenBy.map((sig) => sig.reason).join("; ")})`)
            .join(", ")}. Call get_dynamic_weights for the full set before score_plans.`
        : "This applicant stated no preference that moved their cohort's default weights. Call get_dynamic_weights for the set before score_plans.",
    );
  }

  if (state.clarification) {
    const { target, question, rawAnswer } = state.clarification;
    transcriptLines.push(
      `Earlier this application scored low confidence on "${target}". You asked the applicant: "${question}" — they answered: "${rawAnswer}". Treat this as their stated preference for ${target} specifically; do not infer facts they did not say, and do not ask another question.`,
    );
  }

  for (let step = 1; step <= MAX_TOOL_CALLS; step++) {
    const callsLeft = MAX_TOOL_CALLS - step + 1;
    const reminder = callsLeft <= 3 ? `\n\n${callsLeft} call(s) left in your tool budget. If you have enough to decide, call propose_shortlist now.` : "";

    let called;
    try {
      called = await structuredCall({ system, user: transcriptLines.join("\n\n") + reminder, schema: stepSchema, temperature: 0.2 });
    } catch (error) {
      return fallBack(state, `model call failed: ${error instanceof Error ? error.message : String(error)}`, trace);
    }

    servedBy = called.servedBy;
    totalLatency += called.latencyMs;
    const { thought, tool, args } = called.value;

    const result = runTool(ctx, tool, args);
    trace.push({
      step,
      thought,
      tool,
      args: args ?? null,
      validation: result.ok ? "ok" : result.error,
      observationSummary: summarise(result),
      latencyMs: called.latencyMs,
    });

    if (!result.ok) {
      const key = `${tool}::${result.error}`;
      const count = (rejectionCounts.get(key) ?? 0) + 1;
      rejectionCounts.set(key, count);
      if (count >= MAX_SAME_ERROR_REJECTIONS) {
        return fallBack(state, `"${tool}" sent the same invalid value ${count} times: ${result.error}`, trace, servedBy, totalLatency);
      }
      transcriptLines.push(`Step ${step}: you called "${tool}" with ${JSON.stringify(args ?? {})} — ERROR: ${result.error}. Try again with a corrected value.`);
      continue;
    }

    if (tool === "propose_shortlist") {
      return outcomeFromProposal(result.data as ProposalData, trace, servedBy, totalLatency);
    }

    transcriptLines.push(`Step ${step}: you called "${tool}" with ${JSON.stringify(args ?? {})} — OK.\nObservation: ${summarise(result)}`);
  }

  try {
    const called = await structuredCall({
      system: forcedProposeSystemPrompt(ctx),
      user: transcriptLines.join("\n\n"),
      schema: stepSchema,
      temperature: 0.2,
    });
    servedBy = called.servedBy;
    totalLatency += called.latencyMs;
    const result = runTool(ctx, "propose_shortlist", called.value.args);
    trace.push({
      step: MAX_TOOL_CALLS + 1,
      thought: called.value.thought,
      tool: "propose_shortlist",
      args: called.value.args ?? null,
      validation: result.ok ? "ok" : result.error,
      observationSummary: summarise(result),
      latencyMs: called.latencyMs,
    });
    if (result.ok) {
      return outcomeFromProposal(result.data as ProposalData, trace, servedBy, totalLatency);
    }
  } catch {
    // Falls through to fallback
  }

  return fallBack(state, "tool-call budget exhausted with no shortlist proposed", trace, servedBy, totalLatency);
}

function fallBack(
  state: RecommendationStateType,
  reason: string,
  trace: RecommendationTraceStep[],
  servedBy: string | null = null,
  latencyMs = 0,
): Partial<RecommendationStateType> {
  const outcome = fallbackRecommend(state.record, state.catalogue, state.quotes);
  return {
    trace,
    shortlist: [{ planId: outcome.planId, rank: 1 }],
    rejections: outcome.rejections,
    brokerReasoning: outcome.brokerReasoning,
    memberReasoning: outcome.memberReasoning,
    recoConfidence: outcome.confidence,
    recoUncertaintyReason: outcome.uncertaintyReason,
    fellBackTo: reason,
    servedBy,
    latencyMs,
  };
}

/** Every currency figure or waiting-period month worth citing, pulled out of prose. */
function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, ""));
}

/**
 * Pairs is enough to bound this: the arithmetic an agent legitimately does in
 * prose is one step over two observed figures, never a chain. More than this
 * and it is not citing, it is modelling — which is what the cost tool is for.
 */
const MAX_OBSERVED_FOR_DERIVATION = 80;

/**
 * Whether a cited figure is one the trace can REPRODUCE, rather than one it
 * literally printed.
 *
 * `verify`'s citation rule used to be exact set membership, which made it
 * reject the class of number an agent is not only allowed but expected to
 * produce: the difference between two premiums, a year's visits at the stated
 * per-visit cost, a total that adds a premium to a deductible and a co-pay.
 * Those are not inventions — every input is on the record of the turn — so
 * they are checked by re-deriving them, not by banning them.
 *
 * Anything needing more than one operation over two observed figures still
 * fails, and so does anything with an input nobody observed. That is the
 * point: the rule is "your arithmetic must be checkable", not "you may do
 * arithmetic".
 */
function isDerivable(target: number, observed: number[]): boolean {
  const values = observed.slice(-MAX_OBSERVED_FOR_DERIVATION);
  const matches = (candidate: number) => Number.isFinite(candidate) && Math.abs(candidate - target) < 0.51;

  for (let i = 0; i < values.length; i++) {
    const a = values[i];
    for (let j = 0; j < values.length; j++) {
      if (i === j) continue;
      const b = values[j];
      // Sum (premium + deductible + co-pay), difference (the gap between two
      // plans), product (visits x unit cost), and percentage-of (a co-pay
      // rate applied to an amount) — the four shapes the cost engine itself
      // uses, and nothing else.
      if (matches(a + b) || matches(a - b) || matches(a * b) || matches((a * b) / 100)) return true;
    }
  }
  return false;
}

/** Words an applicant uses when the objection is about money. Read alongside the signals, because the signal extractor may not have run (no model) or may have read the sentence the other way round. */
const PRICE_OBJECTION = /\b(cheap|cheaper|cheapest|afford|budget|price|pricey|cost|costly|expensive|premium|less|lower|reduce|save)\b/i;

/**
 * Did this round answer "make it cheaper" with something MORE expensive?
 *
 * The failure this catches, from a real transcript: the applicant was shown
 * Balanced at AED 8,900, asked "could we reduce the price a bit, could we go
 * for Essential?", and the next round came back with Comprehensive at AED
 * 16,500. Every individual step was defensible — Essential is ineligible, the
 * chronic criteria outrank premium for this cohort — and the result was still
 * indefensible: a price objection answered with a plan that costs nearly
 * twice as much, presented as a fresh suggestion with no acknowledgement that
 * it had gone the wrong way.
 *
 * `tradeOff` (./tradeoff.ts) now catches the common cause of this before a
 * rebuild ever happens. This is the backstop for every other cause, and it is
 * deliberately deterministic: it compares two premiums the quotes already
 * hold, so no prompt wording and no model judgement can talk its way past it.
 *
 * Returns null when there is nothing wrong, or the reason there is.
 */
function priceObjectionViolated(state: RecommendationStateType): { reason: string; hadCheaperOption: boolean } | null {
  const lastRound = state.previousRounds.at(-1);
  if (!lastRound) return null;

  const objectedOnPrice =
    PRICE_OBJECTION.test(lastRound.reason) ||
    state.preferenceSignals.some((s) => s.dimension === "premium_cost" && s.direction === "increase" && s.source === "rejection");
  if (!objectedOnPrice) return null;

  const premiumOf = (planId: string | undefined) =>
    planId ? state.quotes.find((q) => q.planId === planId)?.annualPremium ?? null : null;

  const rejectedPremium = premiumOf(lastRound.rejectedPlanIds[0]);
  const proposedPremium = premiumOf(state.shortlist[0]?.planId);
  if (rejectedPremium == null || proposedPremium == null || proposedPremium <= rejectedPremium) return null;

  // Was there anything cheaper they could actually have had? That is the
  // difference between a mistake and an unavoidable answer badly delivered.
  const cheaperEligible = state.quotes.filter((q) => q.eligible && q.annualPremium < rejectedPremium && q.planId !== state.shortlist[0]?.planId);

  return {
    hadCheaperOption: cheaperEligible.length > 0,
    reason:
      cheaperEligible.length > 0
        ? `The applicant rejected a plan at AED ${rejectedPremium} on price and this round proposed one at AED ${proposedPremium}, when ${cheaperEligible.length} cheaper eligible plan(s) were available.`
        : `The applicant rejected a plan at AED ${rejectedPremium} on price and the only plans that meet their declared needs cost more (AED ${proposedPremium}). Nothing cheaper is available to them.`,
  };
}

/**
 * `verify` — deterministic checks over what the agent (or the fallback)
 * proposed, before anything is persisted or shown to anyone.
 */
export function verify(state: RecommendationStateType): Partial<RecommendationStateType> {
  const validShortlist = state.shortlist.filter((pick) => {
    const plan = state.catalogue.plans.find((p) => p.id === pick.planId);
    return plan != null && isEligible(plan, state.record);
  });
  const stripped = state.shortlist.filter((pick) => !validShortlist.some((v) => v.planId === pick.planId));

  let uncited: string[] = [];
  if (state.fellBackTo == null) {
    const observedText = state.trace.flatMap((step) => (step.validation === "ok" ? numbersIn(step.observationSummary) : []));
    const observed = new Set(observedText);
    const observedValues = observedText.map(Number).filter((n) => Number.isFinite(n));
    const cited = numbersIn(`${state.brokerReasoning ?? ""} ${state.memberReasoning ?? ""}`);
    uncited = cited.filter((n) => !observed.has(n) && !isDerivable(Number(n), observedValues));
  }

  // A price objection answered with a more expensive plan when something
  // cheaper WAS available is a real failure, not a close call — it
  // contradicts a preference the applicant stated in as many words, and no
  // amount of good reasoning makes it the right answer. When nothing cheaper
  // is available it is not a failure at all, but it must not be presented as
  // a confident match either: the applicant is about to be shown, for the
  // second time, a plan that costs more than the one they just turned down.
  const priceViolation = priceObjectionViolated(state);
  const priceFailed = priceViolation?.hadCheaperOption === true;

  const verifyFailed = stripped.length > 0 || uncited.length > 0 || validShortlist.length === 0 || priceFailed;

  return {
    shortlist: validShortlist.length > 0 ? validShortlist : state.shortlist,
    rejections:
      stripped.length > 0
        ? [
            ...state.rejections,
            ...stripped.map((s) => ({ planId: s.planId, reason: "Stripped at verification — does not cover a declared need." })),
          ]
        : state.rejections,
    verifyFailed,
    recoConfidence: verifyFailed || priceViolation ? "low" : state.recoConfidence,
    recoUncertaintyReason: verifyFailed
      ? uncited.length > 0
        ? `A figure in the reasoning (${uncited.join(", ")}) does not trace back to a tool observation.`
        : priceFailed
          ? priceViolation!.reason
          : "One or more shortlisted plans failed the eligibility check at verification."
      : priceViolation
        ? priceViolation.reason
        : state.recoUncertaintyReason,
  };
}

/**
 * `recommendationGate` — flag the shortlist for an INFORMATIONAL advisor
 * quality check, running in parallel with the applicant seeing the cards.
 */
export function recommendationGate(state: RecommendationStateType): Partial<RecommendationStateType> {
  interrupt({
    applicationId: state.record.applicationId,
    reason: state.fellBackTo ?? (state.verifyFailed ? "verification failed" : `confidence: ${state.recoConfidence}`),
    confidence: state.recoConfidence,
  });
  return {};
}
