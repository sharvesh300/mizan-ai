"use server";

import { asc, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { conversation, conversationQuestion, extraction, message } from "@/db/schema";
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
import { isAgentEnabled } from "@/lib/ai/openrouter";
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
    await sayAssistant(
      conversationId,
      "Thank you — that's on your record now and back with your advisor.",
      { applicationId: existingId },
    );
    await db
      .update(conversation)
      .set({ status: "completed", lastOutboundAt: new Date() })
      .where(eq(conversation.id, conversationId));
    revalidatePath("/applications");
    revalidatePath("/queue");
    return;
  }

  const applicationId = await createApplication(user, draft, "chat");
  await validateAndClassify(applicationId);
  await db
    .update(conversation)
    .set({ status: "completed", applicationId, closedAt: new Date() })
    .where(eq(conversation.id, conversationId));
  await say(
    conversationId,
    "Sent. An advisor will look over your details and the plan we suggest before anything is confirmed — you'll see the progress on your application page.",
    { applicationId },
  );
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

export async function sendChatMessage(conversationId: string, formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) throw new Error("No active user.");

  const [convo] = await db.select().from(conversation).where(eq(conversation.id, conversationId)).limit(1);
  if (!convo || convo.userId !== user.id) throw new Error("Conversation not found.");
  if (convo.status === "completed") return;

  // A conversation started on the scripted path stays on it, key or no key.
  if (!isAgentEnabled() || !(await isAgentConversation(conversationId))) {
    return sendChatAnswer(conversationId, formData);
  }

  const answer = (formData.get("answer")?.toString() ?? "").trim();
  if (!answer) return;

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
    await sayAssistant(
      conversationId,
      "Thank you — that's on your record now and back with your advisor.",
      { applicationId: existingId },
    );
    await db
      .update(conversation)
      .set({ status: "completed", lastOutboundAt: new Date() })
      .where(eq(conversation.id, conversationId));
    revalidatePath("/applications");
    revalidatePath("/queue");
    return;
  }

  const applicationId = await createApplication(user, draft, "chat");
  await validateAndClassify(applicationId);
  await db
    .update(conversation)
    .set({ status: "completed", applicationId, closedAt: new Date() })
    .where(eq(conversation.id, conversationId));
  await sayAssistant(
    conversationId,
    "Sent. An advisor will look over your details and the plan we suggest before anything is confirmed — you'll see the progress on your application page.",
    { applicationId },
  );
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
    const outcome = await validateAndClassify(convo.applicationId, { force: true });

    await sayAssistant(
      conversationId,
      outcome && outcome.gate === "auto"
        ? "Thank you — that's updated and your application is moving again. Nothing else is needed from you."
        : "Thank you — that's on your record now and back with your advisor. They will come back to you.",
      { applicationId: convo.applicationId },
    );
    await db
      .update(conversation)
      .set({ status: "completed", lastOutboundAt: new Date() })
      .where(eq(conversation.id, conversationId));

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
