// `signals` — read what the applicant actually wants out of their own words,
// in the only vocabulary the scoring engine can act on.
//
// Two layers, and the order matters:
//
//   1. DETERMINISTIC (`signalsFromRecord`) — every tagged `application_priority`
//      that maps onto a criterion relevant to this record. No model. This is
//      the floor: with `isAgentEnabled()` false, the weight engine still runs
//      on real preferences rather than degrading to the bare cohort baseline,
//      the same way `fallbackRecommend` keeps a shortlist coming.
//
//   2. MODEL (this node's one `structuredCall`) — the free text nobody tagged:
//      an untagged priority, the answer to `clarify`'s single question, and the
//      reason a shortlist was just rejected. Every candidate is re-validated
//      deterministically (`validateSignals`) against the closed `CriterionId`
//      vocabulary AND this record's own relevance gate. An invented dimension
//      is DROPPED, never repaired — and the drop reason is carried into the
//      trace, so a model that keeps proposing "coverage" is visible instead of
//      silently ignored.
//
// Model failure is not an error here: zero model signals is a legal outcome
// that leaves the deterministic layer standing.

import "server-only";
import { z } from "zod";
import { isAgentEnabled, structuredCall } from "@/lib/ai/openrouter";
import {
  CRITERION_IDS,
  isCriterionRelevant,
  mergeSignals,
  PREFERENCE_DIRECTIONS,
  signalsFromRecord,
  validateSignals,
  type PreferenceSignal,
} from "@/lib/recommendation";
import type { RecommendationStateType } from "@/lib/ai/graph/state";

/** Bumped whenever the prompt below changes, so `model_run` rows stay comparable. */
export const SIGNALS_PROMPT_VERSION = "signals-v1";

/** An answer to a question we chose to ask is the strongest thing an applicant ever says about a criterion — they were asked precisely about it and replied. */
const CLARIFICATION_CONFIDENCE = 0.95;

const candidateSchema = z.object({
  signals: z
    .array(
      z.object({
        dimension: z.string(),
        direction: z.string(),
        strength: z.number(),
        confidence: z.number(),
        reason: z.string().catch(""),
      }),
    )
    .catch([]),
});

function systemPrompt(candidateDimensions: string[]): string {
  return [
    "You are reading one health-insurance applicant's own words to work out which scoring criteria matter to them, and how much.",
    "",
    `You may ONLY use these dimensions: ${candidateDimensions.join(", ")}. Anything else is discarded.`,
    `direction is one of: ${PREFERENCE_DIRECTIONS.join(", ")}.`,
    "",
    "direction is about how much the criterion MATTERS, never about which way its value should go.",
    'So "I will pay more for better cover" is premium_cost DECREASE (price matters less to them) together with need_coverage INCREASE — it is NOT premium_cost increase.',
    '"Keep it as cheap as possible" is premium_cost INCREASE — cost is what they are judging on.',
    "",
    "strength (0-1): how hard they are pushing. A passing mention is 0.3; a stated priority is 0.6; an emphatic, repeated demand is 0.9.",
    "confidence (0-1): how sure you are they meant it. Words they actually said are high; something you are reading between the lines of is low.",
    "Do not invent a preference to fill a dimension. Returning an empty list is correct when they did not say anything about any of these.",
    "reason: one short line, quoting or closely paraphrasing what they said.",
    "",
    'Return ONE JSON object, nothing else: {"signals": [{"dimension": "...", "direction": "...", "strength": 0.0, "confidence": 0.0, "reason": "..."}]}',
    "No code fences, no commentary outside the JSON object.",
  ].join("\n");
}

/**
 * Deliberately narrow: only free text that could bear on a criterion. No plan
 * names, no figures, no broker reasoning — the same discipline
 * `buildClarifyContext` applies, for the same reason. The model is reading the
 * applicant, not the shortlist.
 */
function freeText(state: RecommendationStateType): { priorities: string[]; clarification: string | null; rejection: string | null } {
  const latestRejection = state.previousRounds.at(-1)?.reason ?? null;
  return {
    priorities: state.record.priorities.map((p) => p.rawText),
    clarification: state.clarification ? `Asked about ${state.clarification.target}: "${state.clarification.rawAnswer}"` : null,
    rejection: latestRejection && latestRejection.trim().length > 0 ? latestRejection : null,
  };
}

/**
 * The clarification answer, as a signal, with no model in the path. `clarify`
 * already validated that `target` is a relevant `CriterionId` before the
 * question was ever asked, so the dimension is known-good; what the model
 * layer adds above this is the DIRECTION and strength read out of the prose.
 * This exists so the loop closes even when that call fails: a question asked
 * because a weight was uncertain still raises that weight's confidence.
 */
function clarificationSignal(state: RecommendationStateType): PreferenceSignal[] {
  const clarification = state.clarification;
  if (!clarification || !isCriterionRelevant(clarification.target, state.record)) return [];
  return [
    {
      dimension: clarification.target,
      direction: "increase",
      strength: 0.6,
      confidence: CLARIFICATION_CONFIDENCE,
      source: "clarification",
      reason: `Answered "${clarification.question}" with: "${clarification.rawAnswer}"`,
      evidence: { table: "conversation_action", id: state.record.applicationId },
    },
  ];
}

export async function signals(state: RecommendationStateType): Promise<Partial<RecommendationStateType>> {
  const deterministic = [...signalsFromRecord(state.record), ...clarificationSignal(state)];
  const candidateDimensions = CRITERION_IDS.filter((id) => isCriterionRelevant(id, state.record));

  const text = freeText(state);
  const nothingToRead = text.priorities.length === 0 && text.clarification == null && text.rejection == null;

  if (!isAgentEnabled() || candidateDimensions.length === 0 || nothingToRead) {
    return {
      extractedSignals: deterministic,
      preferenceSignals: mergeSignals(state.preferenceSignals, deterministic),
      signalsDropped: [],
    };
  }

  let dropped: string[] = [];
  let fromModel: PreferenceSignal[] = [];
  try {
    const called = await structuredCall({
      system: systemPrompt(candidateDimensions),
      user: JSON.stringify(text),
      schema: candidateSchema,
      temperature: 0.2,
    });
    // `source` is decided HERE, not by the model: a signal read out of a
    // rejection is a rejection signal whatever the model calls it.
    const source = text.rejection != null ? "rejection" : text.clarification != null ? "clarification" : "inferred";
    const validated = validateSignals(
      called.value.signals.map((s) => ({ ...s, source })),
      state.record,
    );
    fromModel = validated.signals;
    dropped = validated.dropped;
  } catch (error) {
    // Not an error path worth failing the round for — the deterministic layer
    // stands on its own and the weight engine runs either way.
    dropped = [`signal extraction failed: ${error instanceof Error ? error.message : String(error)}`];
  }

  const extracted = mergeSignals(deterministic, fromModel);
  return {
    extractedSignals: extracted,
    preferenceSignals: mergeSignals(state.preferenceSignals, extracted),
    signalsDropped: dropped,
  };
}
