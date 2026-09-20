// `negotiate` — when the applicant turns a shortlist down, answer them before
// rebuilding it, and stop arguing after two goes.
//
// Before this node existed, a `reject_shortlist` silently re-ran the whole
// agent loop: the applicant said "too expensive" and got a different set of
// cards back with no acknowledgement that they had said anything. That is a
// worse answer than a broker gives, and it is unbounded — nothing capped the
// rounds, so an applicant who rejects everything rejects forever.
//
// Two outcomes, and the agent picks one:
//
//   convince — the objection is answerable from plan facts they have not
//              weighed. The cheaper plan's maternity wait does not clear their
//              own horizon; the premium they are objecting to buys back more
//              than it costs under their own utilisation. The shortlist
//              STANDS and the agent says why, grounded in tool observations
//              and citation-checked exactly as `verify` checks the final
//              reasoning. Nothing is rebuilt, nothing is written but the turn.
//
//   concede  — the objection is a genuine preference change. It has already
//              become signals by the time this node runs (`signals` reads the
//              rejection reason), so conceding means re-entering the
//              price ∥ weights fan-out with weights that now reflect it.
//
// TERMINATION IS STRUCTURAL, NOT PROMPTED. Both counters are derived from
// `conversation_action` row counts at load time (lib/ai/recommendation-session.ts),
// so a restarted process, a retried background job, or a second worker cannot
// reset them:
//
//   negotiationTurns >= MAX_NEGOTIATION_TURNS  -> `concede` is forced, whatever
//                                                 the agent wanted. It may not
//                                                 argue a third time.
//   round >= MAX_RECOMMENDATION_ROUNDS         -> no new shortlist at all. The
//                                                 caller runs the compromise
//                                                 path: the best plan on the
//                                                 panel under the latest
//                                                 weights, presented as such,
//                                                 with an advisor attached.
//
// The applicant always ends with a plan in front of them and a person on it.
// Never a loop, never nothing.

import "server-only";
import { z } from "zod";
import { isAgentEnabled, structuredCall } from "@/lib/ai/openrouter";
import { describeTools, runTool, TOOL_NAMES, type ToolContext, type ToolName, type ToolResult } from "@/lib/ai/tools/plans";
import { calculateDynamicWeights, fallbackRecommend, priceAllPlans, scorePlans, suggestDefaultWeights } from "@/lib/recommendation";
import { shouldAskTradeOff } from "@/lib/ai/graph/nodes/tradeoff";
import type { NegotiationOutcome, RecommendationStateType, RecommendationTraceStep } from "@/lib/ai/graph/state";

export const NEGOTIATE_PROMPT_VERSION = "negotiate-v1";

/** How many times the agent may defend a shortlist to one applicant, ever. Two: one to answer the objection, one to answer the objection to the answer. A third is badgering, not advising. */
export const MAX_NEGOTIATION_TURNS = 2;

/** How many shortlists may be BUILT for one application. Beyond this the panel has been exhausted — 3 plans, 3 rounds; a fourth is rearranging the same cards. */
export const MAX_RECOMMENDATION_ROUNDS = 3;

/** A rebuttal needs a couple of lookups — this is answering one objection, not building a shortlist. */
const MAX_TOOL_CALLS = 4;

/** Everything except the terminal shortlist tool: `negotiate` may never write a shortlist, only defend or release the one that exists. */
const READ_ONLY_TOOLS = TOOL_NAMES.filter((name) => name !== "propose_shortlist") as Exclude<ToolName, "propose_shortlist">[];

const stepSchema = z.object({
  thought: z.string().catch(""),
  tool: z.string().optional(),
  args: z.unknown().optional(),
  /** Set only on the final turn — supplying it ends the loop. */
  outcome: z.enum(["convince", "concede"]).optional(),
  reply: z.string().optional(),
});

const numbersIn = (text: string): string[] => [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, ""));

const summarise = (result: ToolResult): string => (result.ok ? JSON.stringify(result.data).slice(0, 600) : `ERROR: ${result.error}`);

/** True when there is a rejection this round that has not been answered yet. */
export function isNegotiating(state: RecommendationStateType): boolean {
  return state.previousRounds.length > 0 && state.negotiationTurns < MAX_NEGOTIATION_TURNS && state.round <= MAX_RECOMMENDATION_ROUNDS;
}

/**
 * The conditional edge out of `signals`, and the only place the hard
 * thresholds are read:
 *
 *   compromise        the panel has been rebuilt as many times as it is going to be
 *   tradeOff          they are asking for something the record forbids — ask, do not rebuild
 *   negotiate         a rejection is on file and the agent may still answer it
 *   [price, weights]  build (or rebuild) — the two fan out in parallel
 *
 * `tradeOff` is checked BEFORE `negotiate` deliberately. When the cheaper
 * plan the applicant is asking for is ruled out by their own declared needs,
 * arguing for the current shortlist answers a question they did not ask, and
 * rebuilding cannot help at all — no weighting admits an ineligible plan. Both
 * roads lead back to the same conversation one round later, which is exactly
 * what they did before this branch existed.
 */
export function routeAfterSignals(
  state: RecommendationStateType,
): "negotiate" | "compromise" | "tradeOff" | ["price", "weights"] {
  if (state.previousRounds.length > 0 && state.round > MAX_RECOMMENDATION_ROUNDS) return "compromise";
  if (shouldAskTradeOff(state)) return "tradeOff";
  if (isNegotiating(state)) return "negotiate";
  return ["price", "weights"];
}

/** The conditional edge out of `negotiate`: the shortlist stands, or it gets rebuilt. */
export function routeAfterNegotiate(state: RecommendationStateType): "convince" | "concede" {
  return state.negotiationOutcome === "convince" ? "convince" : "concede";
}

function systemPrompt(ctx: ToolContext, shortlistNames: string[], objection: string, turnsLeft: number): string {
  const descriptions = describeTools(ctx);
  return [
    "You are an insurance advisor. You recommended a shortlist to an applicant and they have turned it down.",
    `They were shown: ${shortlistNames.join(", ")}.`,
    `Their objection, in their words: "${objection}"`,
    "",
    "Decide which of these is true, honestly:",
    "- CONVINCE: the objection rests on something they have not weighed — a waiting period that does not clear their own horizon, an out-of-pocket cost that outweighs the premium they are objecting to, a network that does not admit a provider they named. Answer them with those facts and the shortlist stands.",
    "- CONCEDE: they have told you something real about what they want that your shortlist did not reflect. Do not argue. Their preference has already been recorded and the shortlist will be rebuilt around it.",
    "",
    "Concede when they are right. An applicant who is talked out of a preference they actually hold ends up with a policy they will not keep — that is a worse outcome for them and for us than a second shortlist.",
    `You may argue ${turnsLeft} more time(s) in total on this application. After that the shortlist is rebuilt whatever you think.`,
    "",
    "TOOLS (call at most one per turn, to check a fact before you answer):",
    ...READ_ONLY_TOOLS.map((name) => `- ${name}: ${descriptions[name]}`),
    "",
    "RULES",
    "- Every figure in your reply must come from an observation a tool actually returned this turn. You supply no numbers of your own.",
    "- Never disparage a plan you did not shortlist, and never promise anything a tool did not tell you.",
    "- Do not name a new plan as a recommendation — you are defending the existing shortlist or releasing it, not picking.",
    "",
    "ANSWER FORMAT",
    'To check a fact: {"thought": "...", "tool": "...", "args": {...}}',
    'To finish:      {"thought": "...", "outcome": "convince"|"concede", "reply": "what the applicant reads"}',
    "On a concede, `reply` may be one short sentence acknowledging what they said; the new shortlist speaks for itself.",
    "No code fences, no commentary outside the JSON object.",
  ].join("\n");
}

/**
 * Conceding costs nothing to get wrong and is always available, so every
 * failure lands here: no model, a model error, a malformed reply, an
 * uncitable rebuttal, or a spent budget. The one outcome this node must never
 * reach by accident is `convince` — that one leaves the applicant holding a
 * shortlist they rejected.
 */
const concede = (reason: string, turnsUsed: number, forced: boolean, servedBy: string | null = null, latencyMs = 0): Partial<RecommendationStateType> => ({
  negotiationOutcome: "concede",
  negotiationReply: null,
  negotiationTurns: turnsUsed,
  fellBackTo: forced ? null : reason,
  servedBy,
  latencyMs,
});

export async function negotiate(state: RecommendationStateType): Promise<Partial<RecommendationStateType>> {
  const turnsUsed = state.negotiationTurns + 1;
  const objection = state.previousRounds.at(-1)?.reason ?? "";
  const shortlistNames = state.shortlist
    .map((pick) => state.catalogue.plans.find((p) => p.id === pick.planId)?.name)
    .filter((name): name is string => name != null);

  // Nothing to defend: no objection in words, or no shortlist on file to
  // defend. Rebuild rather than argue with silence.
  if (objection.trim().length === 0 || shortlistNames.length === 0) {
    return concede("no objection or shortlist to negotiate over", turnsUsed, true);
  }
  if (!isAgentEnabled()) return concede("no model configured", turnsUsed, true);

  const ctx: ToolContext = {
    applicationId: state.record.applicationId,
    record: state.record,
    catalogue: state.catalogue,
    cohort: state.cohort?.cohort ?? "unassigned",
    flags: state.verdict?.flags ?? [],
    previousRounds: state.previousRounds,
    // A rebuttal is not a re-score: it may read the derived weights to explain
    // WHY the shortlist is what it is, but it builds nothing, so there is
    // nothing to hold to a baseline.
    enforceWeightBaseline: false,
    preferenceSignals: state.preferenceSignals,
    dynamicWeights: null,
  };

  const system = systemPrompt(ctx, shortlistNames, objection, MAX_NEGOTIATION_TURNS - state.negotiationTurns);
  const trace: RecommendationTraceStep[] = [...state.trace];
  const transcriptLines: string[] = [`Round ${state.round}. You have already built ${state.previousRounds.length} shortlist(s) for this applicant.`];
  let servedBy: string | null = null;
  let totalLatency = 0;

  for (let step = 1; step <= MAX_TOOL_CALLS; step++) {
    let called;
    try {
      called = await structuredCall({ system, user: transcriptLines.join("\n\n"), schema: stepSchema, temperature: 0.3 });
    } catch (error) {
      return concede(`negotiation model call failed: ${error instanceof Error ? error.message : String(error)}`, turnsUsed, false, servedBy, totalLatency);
    }

    servedBy = called.servedBy;
    totalLatency += called.latencyMs;
    const { thought, tool, args, outcome, reply } = called.value;

    if (outcome) {
      return settle(outcome, reply ?? "", trace, turnsUsed, servedBy, totalLatency);
    }
    if (!tool || !READ_ONLY_TOOLS.includes(tool as Exclude<ToolName, "propose_shortlist">)) {
      transcriptLines.push(`Step ${step}: "${tool ?? "(none)"}" is not a tool you may call here. Valid tools: ${READ_ONLY_TOOLS.join(", ")}. Or finish with an outcome.`);
      continue;
    }

    const result = runTool(ctx, tool, args);
    trace.push({
      step: trace.length + 1,
      thought,
      tool,
      args: args ?? null,
      validation: result.ok ? "ok" : result.error,
      observationSummary: summarise(result),
      latencyMs: called.latencyMs,
    });
    transcriptLines.push(
      result.ok
        ? `Step ${step}: you called "${tool}" — OK.\nObservation: ${summarise(result)}`
        : `Step ${step}: you called "${tool}" — ERROR: ${result.error}. Correct it, or finish with an outcome.`,
    );
  }

  // Budget spent without deciding. The applicant is owed an answer, not
  // another round of the agent thinking about it.
  return concede("negotiation budget spent with no outcome", turnsUsed, false, servedBy, totalLatency);

  /** The same citation discipline `verify` applies to the final reasoning, applied to the rebuttal — a number the applicant is being argued at with must have come from a tool. */
  function settle(
    outcome: NegotiationOutcome,
    reply: string,
    steps: RecommendationTraceStep[],
    used: number,
    served: string | null,
    latency: number,
  ): Partial<RecommendationStateType> {
    if (outcome === "concede") {
      return { negotiationOutcome: "concede", negotiationReply: reply.trim() || null, negotiationTurns: used, servedBy: served, latencyMs: latency };
    }

    const text = reply.trim();
    if (text.length === 0) return concede("convince with no reply to show the applicant", used, false, served, latency);

    const observed = new Set(steps.flatMap((s) => (s.validation === "ok" ? numbersIn(s.observationSummary) : [])));
    const uncited = numbersIn(text).filter((n) => !observed.has(n));
    if (uncited.length > 0) {
      // An argument built on a figure nobody observed is exactly the failure
      // `verify` exists to catch. Fail into `concede`, never into shipping it.
      return concede(`rebuttal cites unobserved figure(s): ${uncited.join(", ")}`, used, false, served, latency);
    }

    return { negotiationOutcome: "convince", negotiationReply: text, negotiationTurns: used, trace: steps, servedBy: served, latencyMs: latency };
  }
}

/**
 * `compromise` — the terminal round. The applicant has rejected
 * `MAX_RECOMMENDATION_ROUNDS` shortlists; there are three plans on the panel
 * and rearranging them a fourth time is not advice, it is stalling.
 *
 * Deterministic, no model: price the panel, score it under the LATEST derived
 * weights (which by now carry everything the applicant said across every
 * round, including the rejections), and present the top plan as what it
 * honestly is — the closest thing available to what they have described,
 * offered by a system that has run out of alternatives rather than one that
 * thinks it has found the answer.
 *
 * `fellBackTo` is set, so `routeAfterVerify` sends this straight to the
 * advisor gate: the applicant gets a plan on screen AND a person attached.
 * That is the whole point of ending here rather than looping.
 */
export function compromise(state: RecommendationStateType): Partial<RecommendationStateType> {
  const quotes = priceAllPlans(state.catalogue, state.record);
  const base = suggestDefaultWeights(state.record, state.cohort?.cohort ?? "unassigned");
  const derived = calculateDynamicWeights(base, state.preferenceSignals, state.record);

  // The deterministic pick is the floor — it applies eligibility and the
  // cohort tie-break, and it is what runs when scoring cannot (a single
  // eligible plan, an empty panel).
  const floor = fallbackRecommend(state.record, state.catalogue, quotes);

  let planId = floor.planId;
  let ranked: string[] = [];
  try {
    const eligible = state.catalogue.plans.filter((plan) => quotes.find((q) => q.planId === plan.id)?.eligible);
    if (eligible.length > 0 && derived.weights.length > 0) {
      const scored = scorePlans(eligible, state.record, state.catalogue, derived.weights);
      ranked = scored.perPlan.map((p) => p.planId);
      planId = ranked[0] ?? floor.planId;
    }
  } catch {
    // Scoring refused this weight set (every criterion irrelevant, say).
    // The deterministic pick already stands.
  }

  const name = state.catalogue.plans.find((p) => p.id === planId)?.name ?? planId;
  const priorities = derived.weights.map((w) => w.criterionId).join(", ");

  return {
    quotes,
    baseWeights: base,
    dynamicWeights: derived.weights,
    weightExplanation: derived.explanation,
    weightConfidence: derived.confidence,
    shortlist: [{ planId, rank: 1 }],
    rejections: state.catalogue.plans
      .filter((p) => p.id !== planId)
      .map((p) => ({ planId: p.id, reason: "Ranked below the closest available plan on this applicant's own stated priorities, after the panel was exhausted." })),
    brokerReasoning: `Negotiation exhausted after ${state.previousRounds.length} rejected shortlist(s). ${name} is the highest-ranked eligible plan on the panel under this applicant's latest derived weights (${priorities}). No further shortlist was built — the panel has no other combination to offer. Needs an advisor.`,
    memberReasoning: `Of the plans available to you, ${name} is the closest to what you've told us matters. We haven't been able to find something better on this panel, so one of our advisors will pick this up with you.`,
    recoConfidence: "low",
    recoUncertaintyReason: `The applicant rejected ${state.previousRounds.length} shortlist(s); this is the closest remaining plan, not a confident match.`,
    fellBackTo: "negotiation exhausted",
    negotiationOutcome: null,
    negotiationReply: null,
  };
}
