// Replaying an agentic intake from its own log, and writing a turn back.
//
// Same principle as the scripted flow: nothing about the conversation is held
// in memory between requests. The draft is REPLAYED from `extraction` rows —
// the applicant's own words, re-parsed by the same deterministic steps both
// surfaces use — so the agent can never quietly hold a value it cannot show
// you the sentence for.

import "server-only";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import {
  aiDecision,
  conversation,
  conversationQuestion,
  extraction,
  message,
  modelRun,
} from "@/db/schema";
import { fieldByKey } from "@/lib/ai/fields";
import { MODEL_ID, PROMPT_VERSION, PROVIDER } from "@/lib/ai/openrouter";
import type { PendingQuestion, Turn } from "@/lib/ai/intake-agent";
import { emptyDraft, type IntakeDraft } from "@/lib/intake";
import { stepByKey } from "@/lib/intake-chat";

/**
 * Rebuild the draft from what the applicant said, in the order they said it.
 *
 * The `method` column decides the replay path:
 *
 *   "normalised" — the LLM translated freeform text to a normalised value
 *                  (e.g. "my daughter" → "child"). `step.apply` would need
 *                  to re-parse English it was never designed for, so we use
 *                  `field.validate(valueText)` directly.
 *
 *   "stated"     — rawSpan IS the valueText; the applicant said the value
 *                  verbatim (questionnaire click, or exact match). We replay
 *                  via `step.apply(rawSpan)` as before because the parsers
 *                  understand the UI option strings ("My child", "Low", …).
 *                  If the parser still can't read it we fall back to the
 *                  validator on `valueText`.
 */
export function replayFromExtractions(
  rows: { fieldKey: string; rawSpan: string; valueText: string | null; method: string | null }[],
): IntakeDraft {
  let draft = emptyDraft();
  for (const row of rows) {
    if (row.method === "normalised" && row.valueText) {
      // Agent-normalised path: LLM pre-processed the value; validate directly.
      const field = fieldByKey(row.fieldKey);
      if (!field) continue;
      const result = field.validate(draft, row.valueText, row.rawSpan);
      if (result.ok) draft = result.draft;
      continue;
    }

    // stated (or legacy rows with no method): rawSpan === valueText.
    // Use step.apply — it understands the questionnaire option strings.
    const step = stepByKey(row.fieldKey);
    if (!step) continue;
    const fromSpan = step.apply(draft, row.rawSpan);
    if (fromSpan.ok) {
      draft = fromSpan.draft;
      continue;
    }
    // Fallback: if the parser can't read the rawSpan (e.g. a legacy row
    // whose rawSpan is already normalised), try the validator on valueText.
    if (row.valueText) {
      const field = fieldByKey(row.fieldKey);
      const fallback = field?.validate(draft, row.valueText, row.rawSpan);
      if (fallback?.ok) draft = fallback.draft;
    }
  }
  return draft;
}

export type ChatState = {
  transcript: { role: "applicant" | "assistant"; text: string }[];
  draft: IntakeDraft;
  settled: string[];
  openQuestions: (typeof conversationQuestion.$inferSelect)[];
};

/** Everything a turn needs, rebuilt from the conversation's own rows. */
export async function loadChatState(conversationId: string): Promise<ChatState> {
  const [messages, questions, extractions] = await Promise.all([
    db.select().from(message).where(eq(message.conversationId, conversationId)).orderBy(asc(message.seq)),
    db
      .select()
      .from(conversationQuestion)
      .where(eq(conversationQuestion.conversationId, conversationId))
      .orderBy(asc(conversationQuestion.askedAt)),
    db
      .select()
      .from(extraction)
      .where(eq(extraction.conversationId, conversationId))
      .orderBy(asc(extraction.createdAt)),
  ]);

  const settled = new Set<string>();
  for (const row of extractions) settled.add(row.fieldKey);
  for (const q of questions) {
    if (q.status === "answered" || q.status === "skipped" || q.status === "declined") settled.add(q.fieldKey);
  }

  return {
    transcript: messages
      .filter((m) => m.bodyText)
      .map((m) => ({
        role: m.role === "applicant" ? ("applicant" as const) : ("assistant" as const),
        text: m.bodyText as string,
      })),
    draft: replayFromExtractions(extractions),
    settled: [...settled],
    openQuestions: questions.filter((q) => q.status === "asked"),
  };
}

async function nextSeq(conversationId: string): Promise<number> {
  const rows = await db
    .select({ seq: message.seq })
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.seq));
  return (rows.at(-1)?.seq ?? 0) + 1;
}

export async function sayInbound(conversationId: string, bodyText: string) {
  const [row] = await db
    .insert(message)
    .values({
      conversationId,
      seq: await nextSeq(conversationId),
      direction: "inbound",
      role: "applicant",
      type: "text",
      bodyText,
      provider: "internal",
      deliveryStatus: "received",
      providerTimestamp: new Date(),
      receivedAt: new Date(),
    })
    .returning();
  return row;
}

export async function sayAssistant(conversationId: string, bodyText: string, payload?: unknown) {
  const [row] = await db
    .insert(message)
    .values({
      conversationId,
      seq: await nextSeq(conversationId),
      direction: "outbound",
      role: "assistant",
      type: "text",
      bodyText,
      payload: payload ?? null,
      provider: PROVIDER,
      deliveryStatus: "delivered",
      providerTimestamp: new Date(),
    })
    .returning();
  return row;
}

/**
 * Write one agent turn: the audit trail first, then the extractions, then the
 * questions the applicant is about to see. Ordered so that nothing is shown to
 * the applicant that is not already recorded.
 */
export async function persistTurn(input: {
  conversationId: string;
  inboundMessageId: string;
  turn: Turn;
  latencyMs: number;
  openQuestions: (typeof conversationQuestion.$inferSelect)[];
}): Promise<void> {
  const { conversationId, inboundMessageId, turn, latencyMs, openQuestions } = input;

  // --- the mechanical call ------------------------------------------------
  const [run] = await db
    .insert(modelRun)
    .values({
      purpose: "intake_extraction",
      provider: PROVIDER,
      // What OpenRouter actually served, which is not always what was asked
      // for — free models get re-routed when their pool is rate-limited.
      modelId: turn.servedBy ?? MODEL_ID,
      promptVersion: PROMPT_VERSION,
      // Never the transcript itself — it is health information. A pointer is enough.
      request: { conversationId, messageId: inboundMessageId },
      response: {
        accepted: turn.accepted.map((v) => ({ fieldKey: v.fieldKey, valueText: v.valueText, method: v.method })),
        rejected: turn.rejected.map((v) => ({ fieldKey: v.fieldKey, inferred: v.inferred })),
        asked: turn.questions.map((q) => q.fieldKey),
        requested: MODEL_ID,
      },
      latencyMs: turn.latencyMs || latencyMs,
      status: "ok",
    })
    .returning();

  // --- the semantic claim -------------------------------------------------
  if (turn.accepted.length > 0 || turn.rejected.length > 0) {
    const confidence = turn.accepted.length
      ? Math.min(...turn.accepted.map((v) => v.confidence))
      : null;
    const requiresReview = turn.rejected.length > 0 || (confidence != null && confidence < 0.75);

    await db.insert(aiDecision).values({
      decisionType: "intake_extraction",
      subjectType: "conversation",
      subjectId: conversationId,
      conversationId,
      modelRunId: run.id,
      output: { accepted: turn.accepted, rejected: turn.rejected },
      summary: `Extracted ${turn.accepted.length} field(s) from one message`,
      confidence,
      uncertaintyReason: turn.rejected.length
        ? `Dropped ${turn.rejected.length} proposed value(s): inference is not allowed on gated intake fields.`
        : null,
      requiresReview,
      // Applied immediately because the value was re-parsed by the same
      // deterministic step the form uses — the model chose nothing on its own.
      status: requiresReview ? "proposed" : "auto_accepted",
    });
  }

  // --- which sentence became which field ----------------------------------
  for (const value of turn.accepted) {
    const field = fieldByKey(value.fieldKey);
    if (!field) continue;
    const answering = openQuestions.find((q) => q.fieldKey === value.fieldKey);

    await db.insert(extraction).values({
      conversationId,
      messageId: inboundMessageId,
      questionId: answering?.id ?? null,
      fieldKey: value.fieldKey,
      targetTable: field.table,
      targetColumn: field.column,
      rawSpan: value.rawSpan,
      valueText: value.valueText,
      method: value.method,
      confidence: value.confidence,
    });
  }

  // --- close out the questions this message answered ----------------------
  const answeredKeys = new Set(turn.accepted.map((v) => v.fieldKey));
  const answeredIds = openQuestions.filter((q) => answeredKeys.has(q.fieldKey)).map((q) => q.id);
  if (answeredIds.length > 0) {
    await db
      .update(conversationQuestion)
      .set({
        status: "answered",
        answerRaw: turn.accepted.find((v) => answeredKeys.has(v.fieldKey))?.rawSpan ?? null,
        answeredMessageId: inboundMessageId,
        resolvedAt: new Date(),
      })
      .where(inArray(conversationQuestion.id, answeredIds));
  }

  await db
    .update(conversation)
    .set({ lastInboundAt: new Date(), lastOutboundAt: new Date() })
    .where(eq(conversation.id, conversationId));
}

/** What the chat page needs to render a questionnaire from a message payload. */
export type QuestionnairePayload = {
  kind: "questionnaire";
  questions: PendingQuestion[];
};

export const isQuestionnairePayload = (payload: unknown): payload is QuestionnairePayload =>
  typeof payload === "object" && payload !== null && (payload as { kind?: string }).kind === "questionnaire";

/**
 * What the chat page needs to know a shortlist is waiting — the plan cards
 * themselves are re-read live from `quote`/`recommendation` (getQuotes /
 * getRecommendation, lib/queries.ts) rather than frozen onto the payload, the
 * same reasoning `applicationId` alone carries on the "sent" message below.
 */
export type RecommendationShortlistPayload = {
  kind: "recommendation_shortlist";
  round: number;
  recommendationId: string;
  applicationId: string;
};

export const isRecommendationShortlistPayload = (payload: unknown): payload is RecommendationShortlistPayload =>
  typeof payload === "object" && payload !== null && (payload as { kind?: string }).kind === "recommendation_shortlist";

/**
 * Display only — `question` here is for rendering the assistant's message.
 * `sendChatMessage`'s answer-handling (app/applications/new/actions.ts) never
 * reads this payload back as a data source; it re-derives `target`/`question`
 * from the authoritative `recommendation_clarify_asked` conversation_action
 * row the server itself wrote. See lib/ai/graph/nodes/clarify.ts.
 */
export type RecommendationClarifyPayload = {
  kind: "recommendation_clarify";
  question: string;
  applicationId: string;
};

export const isRecommendationClarifyPayload = (payload: unknown): payload is RecommendationClarifyPayload =>
  typeof payload === "object" && payload !== null && (payload as { kind?: string }).kind === "recommendation_clarify";

/**
 * The trade-off question (lib/ai/graph/nodes/tradeoff.ts), rendered as two
 * buttons rather than as free text to type at.
 *
 * `options` rides on the payload because the applicant has to READ what they
 * are choosing between — but nothing here is trusted as a data source on the
 * way back. `answerTradeOff` (app/applications/new/actions.ts) takes only
 * which of the two was pressed and re-derives the label, the trade-off and
 * the signals it writes from the authoritative
 * `recommendation_tradeoff_asked` conversation_action row the server itself
 * wrote. Same discipline as `RecommendationClarifyPayload` above.
 */
export type RecommendationTradeOffPayload = {
  kind: "recommendation_tradeoff";
  question: string;
  options: { premium: string; requirement: string };
  applicationId: string;
};

export const isRecommendationTradeOffPayload = (payload: unknown): payload is RecommendationTradeOffPayload =>
  typeof payload === "object" && payload !== null && (payload as { kind?: string }).kind === "recommendation_tradeoff";

/**
 * Post the assistant's reply and open a question row per thing it asked.
 *
 * The questionnaire itself rides on the message payload, so the form the
 * applicant saw is recoverable from the log — not just the questions, but the
 * options they were offered.
 *
 * A question still open on a field we are re-asking is updated rather than
 * duplicated — `ask_count <= 2` is a database check, and two rows for one
 * field would read as two separate asks in the audit trail.
 */
export async function askQuestions(
  conversationId: string,
  bodyText: string,
  questions: PendingQuestion[],
  openQuestions: (typeof conversationQuestion.$inferSelect)[],
): Promise<void> {
  const payload: QuestionnairePayload = { kind: "questionnaire", questions };
  const asked = await sayAssistant(conversationId, bodyText, payload);

  const askingKeys = new Set(questions.map((q) => q.fieldKey));

  // Anything still open that we did not just re-ask has been overtaken.
  const stale = openQuestions.filter((q) => !askingKeys.has(q.fieldKey) && q.status === "asked").map((q) => q.id);
  if (stale.length > 0) {
    await db
      .update(conversationQuestion)
      .set({ status: "superseded", resolvedAt: new Date() })
      .where(inArray(conversationQuestion.id, stale));
  }

  for (const question of questions) {
    const existing = openQuestions.find((q) => q.fieldKey === question.fieldKey && q.status === "asked");
    if (existing) {
      await db
        .update(conversationQuestion)
        .set({
          askCount: Math.min(existing.askCount + 1, 2),
          questionText: question.questionText,
          askedMessageId: asked.id,
        })
        .where(eq(conversationQuestion.id, existing.id));
      continue;
    }

    const field = fieldByKey(question.fieldKey);
    await db.insert(conversationQuestion).values({
      conversationId,
      askedMessageId: asked.id,
      fieldKey: question.fieldKey,
      targetTable: field?.table ?? null,
      targetColumn: field?.column ?? null,
      severity: question.severity,
      questionText: question.questionText,
      // The agent picked this question because the field was outstanding.
      triggerRule: "agent:missing_field",
      status: "asked",
    });
  }
}

/** An answer the deterministic parser refused, and the words to say back. */
export type RejectedAnswer = { fieldKey: string; text: string; retry: string };

/**
 * Record a questionnaire submission.
 *
 * No model is involved: the applicant picked from a list we wrote, so each
 * answer maps straight to its field. It still goes through the same `apply`
 * the form and the scripted chat use — one parser, one definition of what
 * "Moderate" or "Within 3 months" means — and it still leaves an `extraction`
 * row naming the words the applicant chose.
 */
export async function recordAnswers(input: {
  conversationId: string;
  inboundMessageId: string;
  answers: { fieldKey: string; text: string }[];
  skippedFieldKeys: string[];
  openQuestions: (typeof conversationQuestion.$inferSelect)[];
}): Promise<{ accepted: string[]; rejected: RejectedAnswer[] }> {
  const { conversationId, inboundMessageId, answers, skippedFieldKeys, openQuestions } = input;

  // Replay to the current draft first: `apply` is relative to it (a stability
  // answer edits the conditions already on the draft).
  const existing = await db
    .select()
    .from(extraction)
    .where(eq(extraction.conversationId, conversationId))
    .orderBy(asc(extraction.createdAt));
  let draft = replayFromExtractions(existing);

  const accepted: string[] = [];
  const rejected: RejectedAnswer[] = [];

  for (const answer of answers) {
    const step = stepByKey(answer.fieldKey);
    const field = fieldByKey(answer.fieldKey);
    if (!step || !field || !answer.text.trim()) continue;

    const applied = step.apply(draft, answer.text);
    if (!applied.ok) {
      // The parser refused the answer, so nothing is recorded — but the reason
      // travels back with it. Dropping it here is what left an out-of-range
      // age being asked for over and over with no explanation on screen.
      rejected.push({ fieldKey: answer.fieldKey, text: answer.text, retry: applied.retry });
      continue;
    }
    draft = applied.draft;
    accepted.push(answer.fieldKey);

    await db.insert(extraction).values({
      conversationId,
      messageId: inboundMessageId,
      questionId: openQuestions.find((q) => q.fieldKey === answer.fieldKey)?.id ?? null,
      fieldKey: answer.fieldKey,
      targetTable: field.table,
      targetColumn: field.column,
      rawSpan: answer.text,
      valueText: applied.valueText,
      // Chosen from a list we offered, so it is stated unless the parser
      // rewrote it into a different value.
      method: answer.text === applied.valueText ? "stated" : "normalised",
      confidence: 1,
    });
  }

  const acceptedSet = new Set(accepted);
  const answeredIds = openQuestions.filter((q) => acceptedSet.has(q.fieldKey)).map((q) => q.id);
  for (const id of answeredIds) {
    const question = openQuestions.find((q) => q.id === id);
    await db
      .update(conversationQuestion)
      .set({
        status: "answered",
        answerRaw: answers.find((a) => a.fieldKey === question?.fieldKey)?.text ?? null,
        answeredMessageId: inboundMessageId,
        resolvedAt: new Date(),
      })
      .where(eq(conversationQuestion.id, id));
  }

  // Skipping is the applicant declining to say, which is a real answer for
  // anything that is not blocking. Blocking fields are simply asked again.
  const skippable = openQuestions.filter(
    (q) => skippedFieldKeys.includes(q.fieldKey) && q.severity !== "block" && !acceptedSet.has(q.fieldKey),
  );
  if (skippable.length > 0) {
    await db
      .update(conversationQuestion)
      .set({ status: "skipped", resolvedAt: new Date() })
      .where(inArray(conversationQuestion.id, skippable.map((q) => q.id)));
  }

  await db
    .update(conversation)
    .set({ lastInboundAt: new Date(), lastOutboundAt: new Date() })
    .where(eq(conversation.id, conversationId));

  return { accepted, rejected };
}
