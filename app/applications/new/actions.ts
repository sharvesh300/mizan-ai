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
  type IntakeDraft,
} from "@/lib/intake";
import { nextStep, replayDraft, stepByKey, STEPS, summarise } from "@/lib/intake-chat";
import { getCurrentUser } from "@/lib/session";
import type { BudgetBand, MaritalStatus } from "@/db/schema";

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
  const draft: IntakeDraft = {
    ...emptyDraft(),
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

  const applicationId = await createApplication(user, draft, "chat");
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
