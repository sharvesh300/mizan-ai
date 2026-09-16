"use server";

import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import {
  application,
  applicationStatusHistory,
  conversation,
  conversationAction,
  conversationQuestion,
  extraction,
  message,
  policy,
  quote,
  recommendation,
  recommendationRejection,
  reviewDecision,
  reviewTask,
} from "@/db/schema";
import {
  classifyBenefit,
  classifyPriority,
  classifyStability,
  createApplication,
  defaultInception,
  emptyDraft,
  parseHorizonMonths,
  splitList,
  updateApplicationFromDraft,
  type IntakeDraft,
} from "@/lib/intake";
import { nextStep, replayDraft, stepByKey, STEPS, summarise } from "@/lib/intake-chat";
import { labelForField, missingFields } from "@/lib/ai/fields";
import { buildQuestion, runIntakeTurn } from "@/lib/ai/intake-agent";
import {
  askQuestions,
  loadChatState,
  persistTurn,
  recordAnswers,
  sayAssistant,
  sayInbound,
} from "@/lib/ai/intake-session";
import { validateAndClassify } from "@/lib/ai/assessment-session";
import { announceAssessmentOutcome } from "@/lib/ai/conversation-continuation";
import { isAgentEnabled } from "@/lib/ai/openrouter";
import { answerPlanQuestion, type PlanChatTurn } from "@/lib/ai/plan-chat-session";
import { scheduleRecommendation } from "@/lib/ai/recommendation-session";
import { getCurrentUser } from "@/lib/session";
import type { BudgetBand, MaritalStatus, RelationshipType } from "@/db/schema";

// ---------------------------------------------------------------------------
// Form intake — one shot
// ---------------------------------------------------------------------------

export async function submitIntakeForm(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user || user.role !== "applicant") throw new Error("Only an applicant can submit an application.");

  const text = (key: string) => (formData.get(key)?.toString() ?? "").trim();
  const checked = (key: string) => formData.get(key) === "on";

  const conditionsRaw = text("conditions");
  const needsRaw = text("needs");
  const prioritiesRaw = text("priorities");
  const horizon = text("needHorizonMonths");

  // The same classifiers the chat uses — one definition of what a stated need
  // means, so a form application and a chat application are comparable.
  const relationship = (text("subjectRelationship") || "self") as RelationshipType;
  const draft: IntakeDraft = {
    ...emptyDraft(),
    subjectRelationship: relationship,
    subjectFullName: relationship === "self" ? null : text("subjectFullName") || null,
    age: Number(text("age")) || null,
    maritalStatus: (text("maritalStatus") || null) as MaritalStatus | null,
    smoker: checked("smoker"),
    emirate: text("emirate") || null,
    budget: (text("budget") || null) as BudgetBand | null,
    policyInception: text("policyInception") || defaultInception(),
    treatmentOutsideUaeExpected: checked("treatmentOutsideUaeExpected"),
    conditions: splitList(conditionsRaw).map((rawText) => ({
      rawText,
      stability: classifyStability(rawText),
    })),
    needs: splitList(needsRaw).map((rawText) => ({
      rawText,
      benefitClass: classifyBenefit(rawText),
      horizonMonths: horizon ? Number(horizon) : parseHorizonMonths(rawText),
    })),
    priorities: splitList(prioritiesRaw).map((rawText) => ({ rawText, tag: classifyPriority(rawText) })),
  };

  const applicationId = await createApplication(user, draft, "web_form");
  // Validated, classified and routed before the applicant sees the page — the
  // whole difference between "processed immediately" and a callback in two
  // hours. Awaited, not fired and forgotten: the redirect below lands on a
  // record that already knows what it is.
  await validateAndClassify(applicationId);
  revalidatePath("/applications");
  redirect(`/applications/${applicationId}?submitted=1`);
}

// ---------------------------------------------------------------------------
// Chat intake — one answer at a time
// ---------------------------------------------------------------------------

async function nextSeq(conversationId: string): Promise<number> {
  const [last] = await db
    .select({ seq: message.seq })
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(desc(message.seq))
    .limit(1);
  return (last?.seq ?? 0) + 1;
}

async function say(conversationId: string, bodyText: string, payload?: unknown) {
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
      provider: "internal",
      deliveryStatus: "delivered",
      providerTimestamp: new Date(),
    })
    .returning();
  return row;
}

/** Post a step's prompt and open the matching question row. */
async function ask(conversationId: string, step: (typeof STEPS)[number], draft: IntakeDraft) {
  const suggestions = step.suggestions?.(draft) ?? [];
  const asked = await say(conversationId, step.prompt(draft), suggestions.length ? { suggestions } : undefined);
  await db.insert(conversationQuestion).values({
    conversationId,
    askedMessageId: asked.id,
    fieldKey: step.key,
    targetTable: step.target.table,
    targetColumn: step.target.column,
    severity: step.severity,
    questionText: step.prompt(draft),
    status: "asked",
  });
}

export async function startChatIntake(): Promise<void> {
  // With a model configured the applicant gets the open conversation; without
  // one they get the scripted interview. Both end in the same rows.
  if (isAgentEnabled()) return startChatIntakeAgent();

  const user = await getCurrentUser();
  if (!user || user.role !== "applicant") throw new Error("Only an applicant can start an application.");

  const [created] = await db
    .insert(conversation)
    .values({ channel: "web_chat", purpose: "intake", status: "active", userId: user.id })
    .returning();

  await say(
    created.id,
    `Hi ${user.fullName.split(" ")[0]} — I'll take your details and put a plan in front of an advisor for you. It takes about a minute, and you can stop and come back any time.`,
  );
  await ask(created.id, STEPS[0], emptyDraft());

  redirect(`/applications/new/chat/${created.id}`);
}

/** Everything the chat needs, rebuilt from its own log. */
async function chatState(conversationId: string) {
  const questions = await db
    .select()
    .from(conversationQuestion)
    .where(eq(conversationQuestion.conversationId, conversationId))
    .orderBy(asc(conversationQuestion.askedAt));

  const draft = replayDraft(
    questions
      .filter((q) => q.status === "answered")
      .map((q) => ({ fieldKey: q.fieldKey, answerRaw: q.answerRaw })),
  );
  const settled = new Set(
    questions.filter((q) => q.status === "answered" || q.status === "skipped").map((q) => q.fieldKey),
  );
  const open = questions.find((q) => q.status === "asked") ?? null;
  return { questions, draft, settled, open };
}

export async function sendChatAnswer(conversationId: string, formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) throw new Error("No active user.");

  const [convo] = await db.select().from(conversation).where(eq(conversation.id, conversationId)).limit(1);
  if (!convo || convo.userId !== user.id) throw new Error("Conversation not found.");
  if (convo.status === "completed") return;

  const answer = (formData.get("answer")?.toString() ?? "").trim();
  if (!answer) return;

  const inbound = await db
    .insert(message)
    .values({
      conversationId,
      seq: await nextSeq(conversationId),
      direction: "inbound",
      role: "applicant",
      type: "text",
      bodyText: answer,
      provider: "internal",
      deliveryStatus: "received",
      providerTimestamp: new Date(),
      receivedAt: new Date(),
    })
    .returning();

  const { draft, settled, open } = await chatState(conversationId);

  // No open question means the recap is on screen and this is the yes/no.
  if (!open) {
    await finishOrAmend(conversationId, user, draft, answer);
    revalidatePath(`/applications/new/chat/${conversationId}`);
    return;
  }

  const step = stepByKey(open.fieldKey);
  if (!step) return;

  const result = step.apply(draft, answer);

  if (!result.ok) {
    // `ask_count <= 2` is a database check, so the second ask is the last one.
    if (open.askCount < 2) {
      await db
        .update(conversationQuestion)
        .set({ askCount: 2, questionText: result.retry })
        .where(eq(conversationQuestion.id, open.id));
      await say(conversationId, result.retry, { suggestions: step.suggestions?.(draft) ?? [] });
    } else if (step.severity === "block") {
      // Cannot be skipped — keep asking without touching the counter.
      await say(conversationId, result.retry, { suggestions: step.suggestions?.(draft) ?? [] });
    } else {
      await db
        .update(conversationQuestion)
        .set({ status: "skipped", resolvedAt: new Date() })
        .where(eq(conversationQuestion.id, open.id));
      settled.add(step.key);
      await say(conversationId, "No problem, I'll leave that one blank.");
      await advance(conversationId, draft, settled);
    }
    revalidatePath(`/applications/new/chat/${conversationId}`);
    return;
  }

  await db
    .update(conversationQuestion)
    .set({ status: "answered", answerRaw: answer, answeredMessageId: inbound[0].id, resolvedAt: new Date() })
    .where(eq(conversationQuestion.id, open.id));

  // Which sentence became which field. Never `inferred` — these are gated
  // fields, and the schema refuses inference on them.
  await db.insert(extraction).values({
    conversationId,
    messageId: inbound[0].id,
    questionId: open.id,
    fieldKey: step.key,
    targetTable: step.target.table,
    targetColumn: step.target.column,
    rawSpan: answer,
    valueText: result.valueText,
    method: answer === result.valueText ? "stated" : "normalised",
    confidence: 1,
  });

  await db
    .update(conversation)
    .set({ lastInboundAt: new Date(), lastOutboundAt: new Date() })
    .where(eq(conversation.id, conversationId));

  settled.add(step.key);
  await advance(conversationId, result.draft, settled);
  revalidatePath(`/applications/new/chat/${conversationId}`);
}

/** Ask the next question, or post the recap when there is nothing left. */
async function advance(conversationId: string, draft: IntakeDraft, settled: Set<string>) {
  const next = nextStep(draft, settled);
  if (next) {
    await ask(conversationId, next, draft);
    return;
  }
  await say(conversationId, `${summarise(draft)}\n\nShall I send this over to an advisor?`, {
    suggestions: ["Yes, send it", "Not yet"],
  });
  await db.update(conversation).set({ status: "awaiting_user" }).where(eq(conversation.id, conversationId));
}

async function finishOrAmend(
  conversationId: string,
  user: { id: string; fullName: string },
  draft: IntakeDraft,
  answer: string,
) {
  if (!/^\s*(y|yes|yep|sure|send|ok|okay|go ahead|please do)\b/i.test(answer)) {
    await say(
      conversationId,
      "No problem — nothing has been sent. Tell me what you'd like to change and I'll ask that one again, or start a fresh application whenever you're ready.",
    );
    return;
  }

  // The same guard as the questionnaire path: a conversation that has already
  // produced an application updates it rather than producing another.
  const existingId = await applicationIdFor(conversationId);
  if (existingId) {
    await updateApplicationFromDraft(existingId, draft, user, "Applicant amended their details in chat");
    await validateAndClassify(existingId, { force: true });
    await announceAssessmentOutcome(conversationId, existingId);
    revalidatePath("/applications");
    revalidatePath("/queue");
    return;
  }

  const applicationId = await createApplication(user, draft, "chat");
  await db.update(conversation).set({ applicationId }).where(eq(conversation.id, conversationId));
  await validateAndClassify(applicationId);
  await announceAssessmentOutcome(conversationId, applicationId);
  revalidatePath("/applications");
}

// ---------------------------------------------------------------------------
// Agentic chat intake — the applicant talks, the agent works out what is missing
//
// Same persistence contract as the scripted flow above, and the same review
// queue at the end. The difference is who chooses the next question: STEPS
// walks a fixed order, the agent reads what has already been said and asks only
// for the gaps. When OPENROUTER_API_KEY is absent, every conversation stays on
// the scripted path and nothing here runs.
// ---------------------------------------------------------------------------

/** The application this conversation has already produced, if any. */
async function applicationIdFor(conversationId: string): Promise<string | null> {
  const [row] = await db
    .select({ applicationId: conversation.applicationId })
    .from(conversation)
    .where(eq(conversation.id, conversationId))
    .limit(1);
  return row?.applicationId ?? null;
}

/** The greeting carries the mode, so a conversation keeps the flow it started in. */
const AGENT_GREETING_PAYLOAD = { mode: "agent" as const };

async function isAgentConversation(conversationId: string): Promise<boolean> {
  const [first] = await db
    .select({ payload: message.payload })
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(asc(message.seq))
    .limit(1);
  return (first?.payload as { mode?: string } | null)?.mode === "agent";
}

export async function startChatIntakeAgent(): Promise<void> {
  const user = await getCurrentUser();
  if (!user || user.role !== "applicant") throw new Error("Only an applicant can start an application.");

  const [created] = await db
    .insert(conversation)
    .values({ channel: "web_chat", purpose: "intake", status: "active", userId: user.id })
    .returning();

  await sayAssistant(
    created.id,
    `Hi ${user.fullName.split(" ")[0]} — tell me what you're after and I'll put a plan in front of an advisor for you.\n\nJust say it however you like: who the cover is for, anything health-wise we should know, and what matters most to you. I'll ask about anything I still need.`,
    AGENT_GREETING_PAYLOAD,
  );

  redirect(`/applications/new/chat/${created.id}`);
}

// ---------------------------------------------------------------------------
// Post-submission chat — the panel, not more fields
//
// Intake is over the moment an application exists. Routing a message typed
// after that back into `runIntakeTurn`/`sendChatAnswer` is what used to
// answer "why did you recommend Balanced?" by asking for the applicant's
// emirate again (docs/recommendation_architecture.md §5). Everything below
// exists to draw that line correctly — TWO states still legitimately belong
// to intake even though an application already exists: an open
// `conversation_question` (an advisor's `requestInfo` re-ask, or a scripted
// question not yet answered) and the "shall I send this to an advisor?"
// recap prompt on an amend. Only once neither is true does free text mean a
// question about the plan.
// ---------------------------------------------------------------------------

/** An advisor's request_info re-ask, or an unanswered scripted question — still intake, not plan chat. */
async function hasOpenQuestion(conversationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: conversationQuestion.id })
    .from(conversationQuestion)
    .where(and(eq(conversationQuestion.conversationId, conversationId), eq(conversationQuestion.status, "asked")))
    .limit(1);
  return Boolean(row);
}

/**
 * The "Shall I send this over to an advisor?" recap (`advance()` and
 * `sendChatMessage`'s own agent branch below both post it with this exact
 * suggestion pair) is the one other `awaiting_user` state that is not the
 * shortlist — an applicant's "yes"/"not yet" to it is not a plan question.
 */
async function isRecapConfirmationPending(conversationId: string): Promise<boolean> {
  const [last] = await db
    .select({ payload: message.payload })
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(desc(message.seq))
    .limit(1);
  const suggestions = (last?.payload as { suggestions?: string[] } | null)?.suggestions;
  return Array.isArray(suggestions) && suggestions.includes("Yes, send it");
}

/**
 * The still-open clarifying question for this application, if any —
 * `target`/`question` are read straight off the authoritative
 * `recommendation_clarify_asked` row `persistRecommendation`
 * (lib/ai/recommendation-session.ts) wrote, NEVER from anything the client's
 * request carries. "Open" means asked and not yet answered — the caller only
 * ever supplies the raw answer text; everything else is reconstructed here.
 * See lib/ai/graph/nodes/clarify.ts.
 */
async function openClarification(applicationId: string): Promise<{ target: string; question: string } | null> {
  const [asked] = await db
    .select()
    .from(conversationAction)
    .where(and(eq(conversationAction.subjectType, "application"), eq(conversationAction.subjectId, applicationId), eq(conversationAction.actionType, "recommendation_clarify_asked")))
    .limit(1);
  if (!asked) return null;

  const [answered] = await db
    .select({ id: conversationAction.id })
    .from(conversationAction)
    .where(and(eq(conversationAction.subjectType, "application"), eq(conversationAction.subjectId, applicationId), eq(conversationAction.actionType, "recommendation_clarify_answered")))
    .limit(1);
  if (answered) return null;

  const args = asked.arguments as { target?: string; question?: string } | null;
  if (!args?.target || !args.question) return null;
  return { target: args.target, question: args.question };
}

/** The last few turns, oldest first, for the plan-chat node's conversational memory — bounded so a long thread does not balloon the prompt. */
async function recentPlanHistory(conversationId: string, limit = 8): Promise<PlanChatTurn[]> {
  const rows = await db
    .select({ role: message.role, bodyText: message.bodyText })
    .from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(desc(message.seq))
    .limit(limit + 1); // +1 to drop the inbound message just inserted for this turn
  return rows
    .slice(1)
    .reverse()
    .map((m) => ({ role: m.role === "assistant" ? ("assistant" as const) : ("applicant" as const), text: m.bodyText ?? "" }));
}

/**
 * Answer a question about the panel. Only `escalate` is auto-actioned — it is
 * genuinely additive, a review task that costs the applicant nothing and
 * changes nothing they see.
 *
 * `reject_shortlist` and `choose_plan` are both deliberately NOT auto-acted
 * on, and for the same reason: the live plan card (`getActiveShortlist`,
 * lib/queries.ts) is already on screen below this reply, with its own
 * "Choose this plan" / "None of these fit" buttons, and a model's READING of
 * a sentence is not the thing that should stand in for either. This used to
 * auto-fire `rejectShortlist` on `intent === "reject_shortlist"` — a model
 * reading an ordinary question ("what if none of these work for someone with
 * my situation?") as a rejection would silently spend one of the applicant's
 * 3 rounds, hide the cards behind "Still working on this…", and kick off a
 * real re-run, all without the applicant ever having clicked anything. The
 * button already on the card is the one place that decision should be made.
 */
async function handlePlanChatMessage(conversationId: string, applicationId: string, question: string): Promise<void> {
  const history = await recentPlanHistory(conversationId);
  const result = await answerPlanQuestion(conversationId, applicationId, question, history);
  if (!result) {
    await sayAssistant(conversationId, "I'm still working out your plan — I'll have it ready shortly, and you can ask me anything about it then.");
    return;
  }

  if (result.intent === "escalate") {
    await db.insert(reviewTask).values({
      subjectType: "application",
      subjectId: applicationId,
      reason: result.reason ? `Applicant asked for help in chat: ${result.reason}` : "Applicant asked to speak with someone about their plan.",
      priorityScore: 60,
      status: "open",
    });
    revalidatePath("/queue");
  }
}

export async function sendChatMessage(conversationId: string, formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) throw new Error("No active user.");

  const [convo] = await db.select().from(conversation).where(eq(conversation.id, conversationId)).limit(1);
  if (!convo || convo.userId !== user.id) throw new Error("Conversation not found.");

  const answer = (formData.get("answer")?.toString() ?? "").trim();
  if (!answer) return;

  // Intake is over the moment an application exists and nothing is still
  // open on it (see the comment above hasOpenQuestion). This runs before the
  // scripted/agent split below on purpose — it applies regardless of which
  // mode the conversation started in, and regardless of `completed` too:
  // `completed` today means the policy has issued (issuePolicy,
  // app/applications/[id]/actions.ts, is the only writer of that status) —
  // not that the applicant's questions have. "What's my deductible?" is a
  // perfectly good thing to ask about a plan that is now theirs, and
  // `handlePlanChatMessage` already answers off the live recommendation/
  // policy's own terms, so there is nothing intake-shaped left to gate here.
  if (convo.applicationId) {
    // Checked first — a pending clarifying question (lib/ai/graph/nodes/clarify.ts)
    // takes this reply as its answer, not a plan-chat question. `target`/
    // `question` never come from this request; see `openClarification`.
    const pendingClarification = await openClarification(convo.applicationId);
    if (pendingClarification) {
      await sayInbound(conversationId, answer);

      // Race-safe against a second rapid message: db/schema/actions.ts's
      // one_clarify_answer_per_application index caps this at one row. Only
      // the write that actually happens triggers a rerun.
      const [recorded] = await db
        .insert(conversationAction)
        .values({
          conversationId,
          actionType: "recommendation_clarify_answered",
          arguments: { rawAnswer: answer },
          subjectType: "application",
          subjectId: convo.applicationId,
          status: "succeeded",
          actorKind: "applicant",
          actorUserId: user.id,
          completedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();

      if (recorded) {
        await sayAssistant(conversationId, "Thanks — let me have another look with that in mind.");
        await db.update(conversation).set({ status: "active", lastOutboundAt: new Date() }).where(eq(conversation.id, conversationId));
        scheduleRecommendation(convo.applicationId, { force: true });
      } else {
        await sayAssistant(conversationId, "Got it — I already have your answer and I'm looking into it.");
      }
      revalidatePath(`/applications/new/chat/${conversationId}`);
      return;
    }

    const [openQuestion, recapPending] = await Promise.all([hasOpenQuestion(conversationId), isRecapConfirmationPending(conversationId)]);
    if (!openQuestion && !recapPending) {
      await sayInbound(conversationId, answer);
      await handlePlanChatMessage(conversationId, convo.applicationId, answer);
      revalidatePath(`/applications/new/chat/${conversationId}`);
      return;
    }
  }

  // Only a scripted/agent-intake conversation with no application at all can
  // still be `completed` with nothing above to route it — e.g. an applicant
  // reopening a link after declining before ever submitting. Nothing past
  // this point makes sense to run again.
  if (convo.status === "completed") return;

  // A conversation started on the scripted path stays on it, key or no key.
  if (!isAgentEnabled() || !(await isAgentConversation(conversationId))) {
    return sendChatAnswer(conversationId, formData);
  }

  const inbound = await sayInbound(conversationId, answer);
  const state = await loadChatState(conversationId);

  // The recap is on screen and nothing is outstanding — this message is the
  // yes or no on sending it to an advisor.
  if (convo.status === "awaiting_user" && missingFields(state.draft, new Set(state.settled)).length === 0) {
    await finishOrAmendAgent(conversationId, user, state.draft, answer);
    revalidatePath(`/applications/new/chat/${conversationId}`);
    return;
  }

  const startedAt = Date.now();
  const turn = await runIntakeTurn({
    transcript: state.transcript,
    draft: state.draft,
    settled: state.settled,
  });

  await persistTurn({
    conversationId,
    inboundMessageId: inbound.id,
    turn,
    latencyMs: Date.now() - startedAt,
    openQuestions: state.openQuestions,
  });

  if (turn.questions.length > 0) {
    // The bubble carries the words; the questionnaire itself is the payload.
    await askQuestions(
      conversationId,
      turn.reply || "A few quick things and I'll have everything I need.",
      turn.questions,
      state.openQuestions,
    );
    await db.update(conversation).set({ status: "active" }).where(eq(conversation.id, conversationId));
  } else {
    await sayAssistant(conversationId, turn.recap ?? `${summarise(turn.draft)}\n\nShall I send this over to an advisor?`, {
      suggestions: ["Yes, send it", "Not yet"],
    });
    await db.update(conversation).set({ status: "awaiting_user" }).where(eq(conversation.id, conversationId));
  }

  revalidatePath(`/applications/new/chat/${conversationId}`);
}

async function finishOrAmendAgent(
  conversationId: string,
  user: { id: string; fullName: string },
  draft: IntakeDraft,
  answer: string,
) {
  if (!/^\s*(y|yes|yep|sure|send|ok|okay|go ahead|please do)\b/i.test(answer)) {
    await sayAssistant(
      conversationId,
      "No problem — nothing has been sent. Tell me what you'd like to change and I'll update it.",
    );
    await db.update(conversation).set({ status: "active" }).where(eq(conversation.id, conversationId));
    return;
  }

  // The same guard as the questionnaire path: a conversation that has already
  // produced an application updates it rather than producing another.
  const existingId = await applicationIdFor(conversationId);
  if (existingId) {
    await updateApplicationFromDraft(existingId, draft, user, "Applicant amended their details in chat");
    await validateAndClassify(existingId, { force: true });
    await announceAssessmentOutcome(conversationId, existingId);
    revalidatePath("/applications");
    revalidatePath("/queue");
    return;
  }

  const applicationId = await createApplication(user, draft, "chat");
  await db.update(conversation).set({ applicationId }).where(eq(conversation.id, conversationId));
  await validateAndClassify(applicationId);
  await announceAssessmentOutcome(conversationId, applicationId);
  revalidatePath("/applications");
}

/**
 * A questionnaire came back. The answers are already field-shaped, so they are
 * recorded directly and the agent is asked only one thing: what is still
 * missing now.
 */
export async function submitQuestionnaire(conversationId: string, formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) throw new Error("No active user.");

  const [convo] = await db.select().from(conversation).where(eq(conversation.id, conversationId)).limit(1);
  if (!convo || convo.userId !== user.id) throw new Error("Conversation not found.");
  if (convo.status === "completed") return;

  const asked = (await loadChatState(conversationId)).openQuestions;
  if (asked.length === 0) return;

  // One entry per field; `multi` controls arrive as repeated values.
  const answers = asked
    .map((question) => ({
      fieldKey: question.fieldKey,
      text: formData
        .getAll(question.fieldKey)
        .map((value) => value.toString().trim())
        .filter(Boolean)
        .join(", "),
    }))
    .filter((answer) => answer.text.length > 0);

  const answeredKeys = new Set(answers.map((a) => a.fieldKey));
  const skippedFieldKeys = asked.filter((q) => !answeredKeys.has(q.fieldKey)).map((q) => q.fieldKey);
  if (answers.length === 0 && skippedFieldKeys.length === 0) return;

  // What the applicant said, in the transcript, in their own chosen words.
  const inbound = await sayInbound(
    conversationId,
    answers
      .map((answer) => `${labelForField(answer.fieldKey)}: ${answer.text}`)
      .join("\n") || "I'd rather not say for now.",
  );

  const { rejected } = await recordAnswers({
    conversationId,
    inboundMessageId: inbound.id,
    answers,
    skippedFieldKeys,
    openQuestions: asked,
  });

  // The parser refused something they typed — an age of 10 in the
  // policyholder's age box, say. Say so and put the same question back,
  // without a model call: the model has no idea the value was dropped, so
  // asking it for a turn here produces a cheerful "thanks, just a couple
  // more" over a field that never landed, and the same question forever.
  if (rejected.length > 0) {
    const state = await loadChatState(conversationId);
    const rejectedKeys = new Set(rejected.map((r) => r.fieldKey));
    const questions = [
      ...rejected.map((r) => ({
        ...buildQuestion(r.fieldKey, state.draft),
        helpText: `You entered "${r.text}".`,
      })),
      // Anything else still open rides along, or `askQuestions` would
      // supersede it and the applicant would be asked it again next turn.
      ...state.openQuestions
        .filter((q) => !rejectedKeys.has(q.fieldKey))
        .map((q) => ({ ...buildQuestion(q.fieldKey, state.draft), questionText: q.questionText })),
    ];
    await askQuestions(conversationId, rejected.map((r) => r.retry).join("\n\n"), questions, state.openQuestions);
    await db.update(conversation).set({ status: "active" }).where(eq(conversation.id, conversationId));
    revalidatePath(`/applications/new/chat/${conversationId}`);
    return;
  }

  // An advisor asked for this, on an application that already exists. The
  // answers belong to THAT record — creating a second application because the
  // conversation reached the end again would give one person two applications
  // and the broker two recommendations to choose between.
  //
  // No model call either: the advisor named the fields, the applicant answered
  // them, and there is nothing left to work out. Update, re-run the rules,
  // say so.
  if (convo.applicationId) {
    const updated = await loadChatState(conversationId);
    await updateApplicationFromDraft(
      convo.applicationId,
      updated.draft,
      user,
      `Applicant answered the advisor's questions: ${answers.map((a) => labelForField(a.fieldKey)).join(", ")}`,
    );
    await validateAndClassify(convo.applicationId, { force: true });
    await announceAssessmentOutcome(conversationId, convo.applicationId);

    revalidatePath(`/applications/new/chat/${conversationId}`);
    revalidatePath(`/applications/${convo.applicationId}`);
    revalidatePath("/queue");
    return;
  }

  const state = await loadChatState(conversationId);
  const startedAt = Date.now();
  const turn = await runIntakeTurn({
    transcript: state.transcript,
    draft: state.draft,
    settled: state.settled,
    skipExtraction: true,
  });

  await persistTurn({
    conversationId,
    inboundMessageId: inbound.id,
    turn,
    latencyMs: Date.now() - startedAt,
    openQuestions: state.openQuestions,
  });

  if (turn.questions.length > 0) {
    await askQuestions(
      conversationId,
      turn.reply || "Thanks — just a couple more.",
      turn.questions,
      state.openQuestions,
    );
    await db.update(conversation).set({ status: "active" }).where(eq(conversation.id, conversationId));
  } else {
    await sayAssistant(
      conversationId,
      turn.recap ?? `${summarise(turn.draft)}\n\nShall I send this over to an advisor?`,
      { suggestions: ["Yes, send it", "Not yet"] },
    );
    await db.update(conversation).set({ status: "awaiting_user" }).where(eq(conversation.id, conversationId));
  }

  revalidatePath(`/applications/new/chat/${conversationId}`);
}

// ---------------------------------------------------------------------------
// Recommendation shortlist — the applicant's turn
//
// The chat stays open through this phase (see lib/ai/conversation-continuation.ts):
// a shortlist arrives as a message payload, the applicant picks a plan or
// says none of them fit, and either way Review 2 is what happens next —
// never a policy issued on the applicant's word alone.
// ---------------------------------------------------------------------------

const LIVE_RECO_STATUSES = ["pending_review", "approved", "edited", "overridden"] as const;

async function liveRecommendation(applicationId: string) {
  const [row] = await db
    .select()
    .from(recommendation)
    .where(and(eq(recommendation.applicationId, applicationId), inArray(recommendation.status, LIVE_RECO_STATUSES)))
    .orderBy(desc(recommendation.version))
    .limit(1);
  return row ?? null;
}

/**
 * The applicant picked a plan off the shortlist card.
 *
 * Picking the recommended plan changes nothing about `recommendation` — the
 * applicant agreed with the system. Picking one of the other two plans on
 * the panel inserts a NEW `recommendation` row for their choice (the schema
 * allows only one live row per application — `one_live_recommendation` — so
 * "the chosen plan's recommendation becomes the live one" means superseding
 * the old row and creating a new live one for the applicant's pick, not two
 * simultaneously-live rows). Either way, Review 2 opens.
 */
export async function pickPlan(conversationId: string, planId: string): Promise<void> {
  const user = await getCurrentUser();
  if (!user) throw new Error("No active user.");

  const [convo] = await db.select().from(conversation).where(eq(conversation.id, conversationId)).limit(1);
  if (!convo || convo.userId !== user.id) throw new Error("Conversation not found.");
  if (!convo.applicationId) throw new Error("No application on this conversation.");
  const applicationId = convo.applicationId;

  const live = await liveRecommendation(applicationId);
  if (!live) throw new Error("No live recommendation to choose from.");

  // A choice is made once. Without this, a second tap — a double-click, a
  // replayed form post — would open a second Review 2 task on top of one
  // already live, or reach `pickPlan` after a policy already exists.
  const [existingPolicy] = await db.select({ id: policy.id }).from(policy).where(eq(policy.applicationId, applicationId)).limit(1);
  if (existingPolicy) throw new Error("A policy has already been issued on this application.");
  const [alreadyPicked] = await db
    .select({ id: conversationAction.id })
    .from(conversationAction)
    .where(and(eq(conversationAction.actionType, "select_plan"), eq(conversationAction.subjectType, "recommendation"), eq(conversationAction.subjectId, live.id)))
    .limit(1);
  if (alreadyPicked) throw new Error("A plan has already been chosen for this recommendation.");

  const agreedWithTop = live.planId === planId;
  let liveRecommendationId = live.id;

  await db.run(sql`begin`);
  try {
    if (!agreedWithTop) {
      const [quoteRow] = await db.select().from(quote).where(and(eq(quote.applicationId, applicationId), eq(quote.planId, planId))).limit(1);
      if (!quoteRow || !quoteRow.eligible) throw new Error("That plan is not on this applicant's panel.");

      const [rejection] = await db
        .select()
        .from(recommendationRejection)
        .where(and(eq(recommendationRejection.recommendationId, live.id), eq(recommendationRejection.planId, planId)))
        .limit(1);

      await db.update(recommendation).set({ status: "superseded" }).where(eq(recommendation.id, live.id));

      const [created] = await db
        .insert(recommendation)
        .values({
          applicationId,
          planId,
          version: live.version + 1,
          status: "pending_review",
          brokerReasoning: `Applicant chose this plan over the recommended ${live.planId}.${rejection ? ` The system's own note against it: "${rejection.reason}"` : ""}`,
          memberReasoning: "You picked this one yourself.",
          uncertaintyReason: "Applicant chose against the system's top-ranked plan — worth a second look.",
          createdBy: "applicant",
          createdByUserId: user.id,
        })
        .returning();
      liveRecommendationId = created.id;
    }

    // Anything still open on the recommendation being chosen (or the one it
    // superseded) is now overtaken by the applicant's own choice — resolve it
    // rather than leave two open tasks racing on the same `recommendation`
    // row, which is what collides on `one_live_recommendation` /
    // `recommendation_application_id_version_key` and drops the applicant's
    // choice on the floor before a policy is ever issued.
    const staleTaskIds = new Set([live.id, liveRecommendationId]);
    const openTasks = await db
      .select({ id: reviewTask.id })
      .from(reviewTask)
      .where(and(eq(reviewTask.subjectType, "recommendation"), inArray(reviewTask.subjectId, [...staleTaskIds]), ne(reviewTask.status, "resolved")));
    for (const t of openTasks) {
      await db.insert(reviewDecision).values({
        reviewTaskId: t.id,
        actorUserId: user.id,
        action: "approve",
        notes: "Overtaken — the applicant chose a plan before this quality check was worked.",
      });
      await db.update(reviewTask).set({ status: "resolved", resolvedAt: new Date() }).where(eq(reviewTask.id, t.id));
    }

    await db.insert(conversationAction).values({
      conversationId,
      actionType: "select_plan",
      arguments: { planId },
      subjectType: "recommendation",
      subjectId: liveRecommendationId,
      status: "succeeded",
      actorKind: "applicant",
      actorUserId: user.id,
      result: { agreedWithTop },
      completedAt: new Date(),
    });

    await db.insert(reviewTask).values({
      subjectType: "recommendation",
      subjectId: liveRecommendationId,
      reason: agreedWithTop
        ? "Applicant selected the recommended plan — sign-off."
        : `Applicant chose ${planId} over the recommended ${live.planId}.`,
      priorityScore: agreedWithTop ? 20 : 55,
      status: "open",
    });

    const [current] = await db.select({ status: application.status }).from(application).where(eq(application.id, applicationId)).limit(1);
    await db.update(application).set({ status: "plan_selected", statusChangedAt: new Date() }).where(eq(application.id, applicationId));
    await db.insert(applicationStatusHistory).values({
      applicationId,
      fromStatus: current?.status ?? null,
      toStatus: "plan_selected",
      changedBy: "applicant",
      changedByUserId: user.id,
      reason: agreedWithTop ? `Chose the recommended plan (${planId})` : `Chose ${planId} over the recommended ${live.planId}`,
    });

    await db.update(conversation).set({ status: "awaiting_review", lastOutboundAt: new Date() }).where(eq(conversation.id, conversationId));

    await db.run(sql`commit`);
  } catch (error) {
    await db.run(sql`rollback`);
    throw error;
  }

  revalidatePath(`/applications/new/chat/${conversationId}`);
  revalidatePath(`/applications/${applicationId}`);
  revalidatePath("/queue");
}

/**
 * "None of these fit." Rounds 1-2 re-run recommendation with the objection
 * on record — `previous_rounds` (lib/ai/tools/plans.ts) reads it so the agent
 * does not re-offer what was already refused. By round 3 the honest answer is
 * an advisor, not another attempt — a hard limit, stated plainly (doc §5).
 */
export async function rejectShortlist(conversationId: string, formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) throw new Error("No active user.");

  const [convo] = await db.select().from(conversation).where(eq(conversation.id, conversationId)).limit(1);
  if (!convo || convo.userId !== user.id) throw new Error("Conversation not found.");
  if (!convo.applicationId) throw new Error("No application on this conversation.");
  const applicationId = convo.applicationId;

  const reason = (formData.get("reason")?.toString() ?? "").trim() || "None of the shortlisted plans fit.";
  const live = await liveRecommendation(applicationId);

  const priorRounds = await db
    .select({ id: conversationAction.id })
    .from(conversationAction)
    .where(and(eq(conversationAction.subjectType, "application"), eq(conversationAction.subjectId, applicationId), eq(conversationAction.actionType, "reject_shortlist")));
  const roundNumber = priorRounds.length + 1;

  await db.insert(conversationAction).values({
    conversationId,
    actionType: "reject_shortlist",
    arguments: { planIds: live ? [live.planId] : [], reason },
    subjectType: "application",
    subjectId: applicationId,
    status: "succeeded",
    actorKind: "applicant",
    actorUserId: user.id,
    completedAt: new Date(),
  });

  if (roundNumber >= 3) {
    await db.insert(reviewTask).values({
      subjectType: "recommendation",
      subjectId: live?.id ?? applicationId,
      reason: `Round ${roundNumber} — nothing on the panel fits what the applicant is asking for: ${reason}`,
      priorityScore: 90,
      status: "open",
    });
    await sayAssistant(
      conversationId,
      "I've looked at this three times now and I can't find something on our panel that genuinely fits — I've handed this to an advisor to take a closer look.",
    );
    await db.update(conversation).set({ status: "awaiting_review", lastOutboundAt: new Date() }).where(eq(conversation.id, conversationId));
  } else {
    // Scheduled, not awaited — same reasoning as scheduleRecommendation's own
    // doc comment: the agent's tool-call loop can take several model
    // round-trips, and this response should not hang on it. An immediate
    // acknowledgement goes out now; the actual round-2 shortlist (or a gate
    // to an advisor) arrives via announceRecommendationOutcome once the
    // background job resolves.
    //
    // Status stays `active`, not `awaiting_review` — no advisor is involved
    // in a re-round, it is the agent recomputing. `awaiting_review` is
    // reserved for the round-3 branch above, where a person genuinely does
    // own it next; conflating the two is what made the chat page's "With an
    // advisor" panel appear while the system was just thinking.
    await sayAssistant(conversationId, "Okay — let me have another look at this.");
    await db.update(conversation).set({ status: "active", lastOutboundAt: new Date() }).where(eq(conversation.id, conversationId));
    scheduleRecommendation(applicationId, { force: true });
  }

  revalidatePath(`/applications/new/chat/${conversationId}`);
  revalidatePath(`/applications/${applicationId}`);
  revalidatePath("/queue");
}
