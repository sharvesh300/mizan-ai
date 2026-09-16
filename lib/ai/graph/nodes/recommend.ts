// `recommend` — the agent's tool-call loop.
//
// `lib/ai/openrouter.ts` is explicit that the free models in the chain
// advertise neither strict structured output nor reliable tool calling, so
// this is a JSON action loop built on the same `structuredCall` every other
// node uses — not native function calling. Each turn the model emits
// `{thought, tool, args}`; the runtime validates the call against the
// vocabulary tables in lib/ai/tools/plans.ts, executes it, and appends the
// observation to the transcript. The loop ends when the model calls
// `propose_shortlist`, or falls back to the deterministic path
// (lib/recommendation/fallback.ts) on a model failure, the same invalid
// value sent 3 times, or the call budget running out — see fallBack() below.
//
// Point OPENROUTER_MODEL at a tool-capable model later and the same registry
// binds natively via bindTools; the tools are the contract, the transport
// is not (same note lib/ai/openrouter.ts makes about the intake agent).

import "server-only";
import { z } from "zod";
import { isAgentEnabled, structuredCall } from "@/lib/ai/openrouter";
import { describeTools, runTool, TOOL_NAMES, type ToolContext, type ToolResult } from "@/lib/ai/tools/plans";
import { fallbackRecommend } from "@/lib/recommendation";
import type { RecommendationStateType, RecommendationTraceStep } from "@/lib/ai/graph/state";

/** Bumped whenever the prompt below changes, so `model_run` rows stay comparable. */
export const RECOMMENDATION_PROMPT_VERSION = "recommend-v2";

/** Doc §3.6: max 8 tool calls per round. */
const MAX_TOOL_CALLS = 8;
/**
 * Rejections are counted per (tool, error) pair, not per tool — a model that
 * tries `chronic_preexisting`, gets told the value it sent was wrong, and
 * then sends the corrected value has fixed its mistake and should not be
 * punished for having made it once. The same wrong guess sent twice in a row
 * is a model that did not read the error, and 3 of those ends the round.
 */
const MAX_SAME_ERROR_REJECTIONS = 3;

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

/**
 * The final forced turn once the ordinary budget is spent (doc §3.6's budget
 * cap): the tool list narrows to `propose_shortlist` alone so the model
 * decides from what it already gathered instead of reaching for one more
 * lookup it does not have room for.
 */
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

export async function recommend(state: RecommendationStateType): Promise<Partial<RecommendationStateType>> {
  // record/catalogue/cohort/flags are the assessment's own — read straight
  // off the shared state rather than re-derived (see the comment on
  // AssessmentState in lib/ai/graph/state.ts).
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
  // Keyed by "tool::error" — a wrong guess corrected on the next turn is not
  // punished; the SAME wrong guess sent again is what ends the round.
  const rejectionCounts = new Map<string, number>();
  let servedBy: string | null = null;
  let totalLatency = 0;

  const transcriptLines: string[] = [
    `Applicant cohort: ${cohortLabel}. ${flags.length} flag(s) already on file for this application.`,
    state.previousRounds.length > 0
      ? `This is round ${state.previousRounds.length + 1}. Call previous_rounds before re-offering anything already rejected.`
      : "This is round 1.",
  ];

  // A prior round asked the applicant a clarifying question about exactly one
  // of the closed criteria (lib/ai/graph/nodes/clarify.ts) and got an answer
  // back — loaded fresh from the DB (lib/ai/recommendation-session.ts), never
  // from graph memory. Their literal words are handed over verbatim; the
  // agent may interpret them, but any figure it states from here still has to
  // pass `verify`'s citation check same as always, so it cannot use this as
  // licence to invent a number.
  if (state.clarification) {
    const { target, question, rawAnswer } = state.clarification;
    transcriptLines.push(
      `Earlier this application scored low confidence on "${target}". You asked the applicant: "${question}" — they answered: "${rawAnswer}". Treat this as their stated preference for ${target} specifically; do not infer facts they did not say, and do not ask another question.`,
    );
  }

  for (let step = 1; step <= MAX_TOOL_CALLS; step++) {
    const callsLeft = MAX_TOOL_CALLS - step + 1;
    // Pressure applied to the message sent, not to the permanent transcript
    // — a reminder appended to transcriptLines every turn from here on would
    // pile up rather than just nudge the next decision.
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

  // Budget exhausted without a shortlist — one last forced turn, narrowed to
  // propose_shortlist alone, before giving up to the deterministic fallback.
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
    // Falls through to the deterministic fallback below — the forced turn
    // was already a last resort, so a second failure here is not worth a
    // third round-trip.
  }

  return fallBack(state, "tool-call budget exhausted with no shortlist proposed", trace, servedBy, totalLatency);
}

/**
 * No key, unparseable output, repeated validation failure, or budget
 * exhausted — the deterministic recommender ranks on need coverage +
 * MEDIUM_OUTPATIENT cost, writes the shortlist with `confidence: low`, and
 * `recommendationGate` (the next node) routes it to an advisor before the
 * applicant ever sees it. Same principle lib/intake.ts holds for the scripted
 * chat: the app runs end to end with no model configured.
 */
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
