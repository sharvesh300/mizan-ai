// Free-text Q&A about an existing shortlist — the chat-facing half of doc
// §5 ("the conversation does not stop"), answered through the read-only
// half of the recommendation agent's own tool registry
// (lib/ai/graph/nodes/plan-converse.ts). Same split as everywhere else in
// lib/ai/: the node is pure and drizzle-free, this module loads what it
// needs and writes down what happened.
//
// This module never calls `pickPlan`/`rejectShortlist`
// (app/applications/new/actions.ts) itself — it hands back the `intent` the
// model read off the question, and the caller decides what to do with it.
// Picking a plan opens Review 2 and is a commitment; a model's reading of a
// sentence is not the thing that should trigger it.
//
// No `model_run` row is written here, unlike `persistRecommendation`
// (lib/ai/recommendation-session.ts) — that discipline is about the
// decision a `plan_recommendation` ai_decision is graded against, which this
// is not. The `conversation_action` row below is this turn's full audit
// trail: the question, the reply, the intent read off it, and the trace
// behind both.

import "server-only";
import { db } from "@/db/client";
import { conversationAction } from "@/db/schema";
import { planConverse, type PlanConverseResult } from "@/lib/ai/graph/nodes/plan-converse";
import { sayAssistant } from "@/lib/ai/intake-session";
import { loadRecommendationInputs } from "@/lib/ai/recommendation-session";
import type { ToolContext } from "@/lib/ai/tools/plans";
import { getQuotes, getRecommendation } from "@/lib/queries";

export type PlanChatTurn = { role: "applicant" | "assistant"; text: string };

/**
 * Answer one applicant question about their existing shortlist and post the
 * reply into their conversation. Returns null when there is nothing to
 * answer questions about yet (no assessment, or no live recommendation) —
 * the caller falls back to whatever it does for that case.
 */
export async function answerPlanQuestion(
  conversationId: string,
  applicationId: string,
  question: string,
  history: PlanChatTurn[],
): Promise<PlanConverseResult | null> {
  const [inputs, reco] = await Promise.all([loadRecommendationInputs(applicationId), getRecommendation(applicationId)]);
  if (!inputs || !reco) return null;

  const quotes = await getQuotes(applicationId);

  const ctx: ToolContext = {
    applicationId,
    record: inputs.record,
    catalogue: inputs.catalogue,
    cohort: inputs.cohort.cohort,
    flags: inputs.verdict.flags,
    previousRounds: inputs.previousRounds,
  };

  const result = await planConverse({
    ctx,
    question,
    history,
    recommended: { planId: reco.plan.id, name: reco.plan.name },
    memberReasoning: reco.recommendation.memberReasoning,
    quotes: quotes.filter((q) => q.eligible).map((q) => ({ planId: q.planId, name: q.plan.name, annualPremium: q.annualPremium })),
  });

  await sayAssistant(conversationId, result.reply, { kind: "plan_chat_reply" });

  await db.insert(conversationAction).values({
    conversationId,
    actionType: "plan_chat_reply",
    toolName: "plan_converse",
    arguments: { question },
    subjectType: "recommendation",
    subjectId: reco.recommendation.id,
    status: "succeeded",
    actorKind: "system",
    result: {
      intent: result.intent,
      planId: result.planId,
      reason: result.reason,
      citationFailed: result.citationFailed,
      servedBy: result.servedBy,
      trace: result.trace,
    },
    completedAt: new Date(),
  });

  return result;
}
