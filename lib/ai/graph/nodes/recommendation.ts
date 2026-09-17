// All nodes for the recommendation graph: price, recommend, verify, recommendationGate.
//
//   RECOMMENDATION (the record is clean)
//     price ──> recommend ──> verify ──┬──> clarify           (interrupt: the applicant owns one question)
//                                      ├──> recommendationGate (interrupt: an advisor owns it)
//                                      └──> END  (present to the applicant)
//
// Pricing is deterministic. Recommend executes the agentic tool-loop over closed
// catalogues and baselines. Verify enforces hard eligibility and citation integrity.
// RecommendationGate flags edge cases for review.

import "server-only";
import { z } from "zod";
import { interrupt } from "@langchain/langgraph";
import { isAgentEnabled, structuredCall } from "@/lib/ai/openrouter";
import { describeTools, runTool, TOOL_NAMES, type ToolContext, type ToolResult } from "@/lib/ai/tools/plans";
import { fallbackRecommend, isEligible, priceAllPlans } from "@/lib/recommendation";
import type { RecommendationStateType, RecommendationTraceStep } from "@/lib/ai/graph/state";

/** Bumped whenever the prompt below changes, so `model_run` rows stay comparable. */
export const RECOMMENDATION_PROMPT_VERSION = "recommend-v2";

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
    "- Call suggest_default_weights before score_plans. It gives you a deterministic starting weight set for this applicant's cohort — you are not picking weights from nothing. score_plans will reject a call that ignores this baseline entirely.",
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
    suggestedWeights: null,
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
    const observed = new Set(state.trace.flatMap((step) => (step.validation === "ok" ? numbersIn(step.observationSummary) : [])));
    const cited = numbersIn(`${state.brokerReasoning ?? ""} ${state.memberReasoning ?? ""}`);
    uncited = cited.filter((n) => !observed.has(n));
  }

  const verifyFailed = stripped.length > 0 || uncited.length > 0 || validShortlist.length === 0;

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
    recoConfidence: verifyFailed ? "low" : state.recoConfidence,
    recoUncertaintyReason: verifyFailed
      ? uncited.length > 0
        ? `A figure in the reasoning (${uncited.join(", ")}) does not trace back to a tool observation.`
        : "One or more shortlisted plans failed the eligibility check at verification."
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
