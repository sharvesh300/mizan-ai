// `tradeOff` — stop rebuilding and ask, when the applicant is asking for
// something the record forbids.
//
// Reached from `signals`, BEFORE `negotiate` and before any rebuild, when
// `detectTradeOff` (lib/recommendation/tradeoff.ts) finds a cheaper plan that
// the applicant's own declared needs rule out. That is a conflict weights
// cannot resolve: a weight reorders eligible plans, it cannot admit an
// ineligible one, so every rebuild is doomed to come back with something the
// applicant did not ask for — which is exactly what happened, twice, before
// this node existed.
//
// It is deliberately NOT `clarify`:
//
//   clarify    one question, once per application, about which CRITERION was
//              uncertain — asked when the system does not know what to weigh.
//   tradeOff   one question, once per application, about a CONFLICT between
//              what they want and what they declared — asked when the system
//              knows exactly what they want and cannot give it to them.
//
// They can both fire for one application, in either order, because they are
// asking about different things; neither ever fires twice, and each is gated
// by its own `conversation_action` row's existence.
//
// NO MODEL RUNS HERE. The question is composed from the two plans' own terms
// and every answer is pre-bound to a fixed set of preference signals
// (`signalsForChoice`), so the applicant's reply moves the weights by a route
// decided before they were asked. There is no prose for `verify` to
// citation-check because there is no prose a model wrote.

import "server-only";
import { interrupt } from "@langchain/langgraph";
import { describeTradeOff, detectTradeOff, type TradeOff } from "@/lib/recommendation";
import type { RecommendationStateType } from "@/lib/ai/graph/state";

/** Bumped whenever the question wording below changes, so the rows stay comparable. */
export const TRADEOFF_PROMPT_VERSION = "tradeoff-v1";

/**
 * The trade-off this round would be about, if there is one. Pure — the graph
 * router and the node both call it, and so does the session layer when it
 * needs to reconstruct what was asked.
 */
export function tradeOffFor(state: RecommendationStateType): TradeOff | null {
  const objection = state.previousRounds.at(-1)?.reason ?? "";
  if (objection.trim().length === 0) return null;

  // What they were actually looking at when they objected: the plan the last
  // round put in front of them.
  const rejected = state.previousRounds.at(-1)?.rejectedPlanIds[0] ?? state.shortlist[0]?.planId ?? null;

  return detectTradeOff({
    record: state.record,
    catalogue: state.catalogue,
    quotes: state.quotes,
    currentPlanId: rejected,
    objection,
  });
}

/**
 * True when this round should ask rather than argue or rebuild.
 *
 * `tradeOffAsked` is loaded fresh from the `recommendation_tradeoff_asked`
 * row's mere EXISTENCE every round (lib/ai/recommendation-session.ts), never
 * carried in graph or checkpointer memory — the same discipline
 * `clarificationAsked` holds, and for the same reason: `interrupt()` here is
 * only this one invocation's control-flow exit, not a durable fact.
 */
export function shouldAskTradeOff(state: RecommendationStateType): boolean {
  if (state.tradeOffAsked) return false;
  return tradeOffFor(state) != null;
}

export function tradeOff(state: RecommendationStateType): Partial<RecommendationStateType> {
  const detected = tradeOffFor(state);

  // Structurally shouldn't happen — the router only sends us here when
  // `shouldAskTradeOff` is true. Fail into the advisor gate rather than
  // interrupting with nothing, exactly as `clarify` does.
  if (!detected) {
    interrupt({
      applicationId: state.record.applicationId,
      reason: "trade-off question could not be composed",
      confidence: state.recoConfidence,
    });
    return {};
  }

  const { question, options } = describeTradeOff(detected);
  interrupt({
    applicationId: state.record.applicationId,
    kind: "tradeoff",
    question,
    options,
    tradeOff: detected,
  });

  return {};
}
