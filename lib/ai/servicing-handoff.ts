// What a person does with a case the agent handed over (plan §13.3.2): decide it, answer the member, close it, pass it on.
//
// Every verb that speaks to the member takes TWO texts — a note for the file, and the message the member reads — and the
// member's message is held to the same register and figure fence as anything the agent writes. Every verb is one
// transaction and leaves a `review_decision`: who, what, when, and why.
//
//   coverIt / denyIt   an undecidable case (CLM-9). Cover: the advisor names the missing INPUT (which tier to treat the
//                      provider as) and the engine computes the money — a person never types an amount. Deny: a zero the
//                      plan rules cannot produce, and the one stored result replay takes at its word (lib/servicing/handoff.ts).
//   replyInThread      a message in the member's own thread; the case stays with the advisor
//   resolve            close a hand-off with the last word to the member
//   handOff            reassign to a colleague
//   markCalled         a callback happened
//   closeQualityCheck  a close call that resolved, looked at and found fine
//
// Not `server-only`, like the session: the checks drive whole cases against a scratch database.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { appUser, conversation, conversationAction, policy, reviewDecision, reviewTask, servicingEvent } from "@/db/schema";
import { providerTierEnum, type ProviderTier } from "@/db/schema/enums";
import { isoToday, record } from "@/lib/ai/servicing-signoff";
import { latestState, postAdvisor, postAssistant, serialised, writeState } from "@/lib/ai/servicing-session";
import { adjudicateAt, buildCoverDraft, buildDenyDraft, checkMemberMessage, defaultDenyMessage, nextStepFacts, outcomeCard, type HandDraft, type HandSource } from "@/lib/servicing";
import { conversationForEvent, contestedRowOf } from "@/lib/servicing/appeal-store";
import { checkReplay, rebuildLedger, replayPolicy } from "@/lib/servicing/store";
import { reassessAfterEvent } from "@/lib/ai/servicing-reassess";
import { openSettlementForEvent } from "@/lib/ai/servicing-settlement";

export type HandoffResult = { ok: true; message: string } | { ok: false; reason: string };
const fail = (reason: string): HandoffResult => ({ ok: false, reason });
const needNote = (note: string) => (note.trim().length < 10 ? "Add a note for the file — a sentence on what you checked or decided." : null);

/** The task, the case behind it, and who is acting — or why not. */
async function load(taskId: string, advisorUserId: string) {
  const [advisor] = await db.select({ id: appUser.id, role: appUser.role, name: appUser.fullName }).from(appUser).where(eq(appUser.id, advisorUserId)).limit(1);
  if (!advisor || advisor.role !== "advisor") return { ok: false as const, error: "Only an advisor can decide this." };
  const [task] = await db.select().from(reviewTask).where(eq(reviewTask.id, taskId)).limit(1);
  if (!task) return { ok: false as const, error: "That task no longer exists." };
  if (task.status === "resolved") return { ok: false as const, error: "That has already been decided." };

  if (task.subjectType === "conversation") {
    const [convo] = await db.select().from(conversation).where(eq(conversation.id, task.subjectId)).limit(1);
    if (!convo?.policyId) return { ok: false as const, error: "The member's conversation is missing." };
    return { ok: true as const, advisor, task, convo, event: null, policyId: convo.policyId };
  }
  if (task.subjectType === "servicing_event") {
    const [event] = await db.select().from(servicingEvent).where(eq(servicingEvent.id, task.subjectId)).limit(1);
    if (!event) return { ok: false as const, error: "The event is missing." };
    const convoId = await conversationForEvent(event.policyId, event.id);
    const [convo] = convoId ? await db.select().from(conversation).where(eq(conversation.id, convoId)).limit(1) : [null];
    return { ok: true as const, advisor, task, convo: convo ?? null, event, policyId: event.policyId };
  }
  return { ok: false as const, error: "That task is not a servicing case." };
}

/** Every open task on this case — the event's and its conversation's — so a decision closes them all, not one of two. */
async function openTasksFor(eventId: string | null, convoId: string | null) {
  const rows = await db.select().from(reviewTask).where(and(inArray(reviewTask.status, ["open", "in_progress"])));
  return rows.filter((t) => (eventId && t.subjectType === "servicing_event" && t.subjectId === eventId) || (convoId && t.subjectType === "conversation" && t.subjectId === convoId));
}

const resolveTasks = async (ids: string[], advisorUserId: string) => {
  for (const id of ids) await db.update(reviewTask).set({ status: "resolved", resolvedAt: new Date(), assignedToUserId: advisorUserId }).where(eq(reviewTask.id, id));
};

async function finishConversation(convo: typeof conversation.$inferSelect | null, newEventId: string | null) {
  if (!convo) return;
  const state = await latestState(convo.id);
  if (state) await writeState(convo.id, { ...state, phase: "done", committedEventId: newEventId ?? state.committedEventId }, convo.userId);
  await db.update(conversation).set({ status: "completed", closedAt: new Date() }).where(eq(conversation.id, convo.id));
}

// ---------------------------------------------------------------------------
// Cover it / don't cover it — an undecidable case
// ---------------------------------------------------------------------------

type Frame = Awaited<ReturnType<typeof replayPolicy>>;

async function undecidable(policyId: string, event: typeof servicingEvent.$inferSelect): Promise<{ ok: true; frame: Frame; source: HandSource; policyRef: string } | { ok: false; reason: string }> {
  const frame = await replayPolicy(policyId);
  const row = contestedRowOf(frame.stored, event.id);
  if (!row) return { ok: false, reason: "The event is missing." };
  if (row.supersededBy) return { ok: false, reason: "A decision has already been made on this one." };
  if (row.outcome !== "insufficient_data") return { ok: false, reason: "This is not a case the plan terms left undecided." };
  if (row.kind !== "claim" && row.kind !== "reimbursement") return { ok: false, reason: "A pre-authorization is a forecast — there is nothing to decide." };
  if (!row.benefitClass || !row.providerTier || row.amount === null) return { ok: false, reason: "The event is missing what a decision needs." };
  const [pol] = await db.select({ ref: policy.externalRef, number: policy.policyNumber }).from(policy).where(eq(policy.id, policyId)).limit(1);
  return {
    ok: true,
    frame,
    policyRef: pol?.ref ?? pol?.number ?? "policy",
    source: { id: row.id, ref: row.ref, kind: row.kind, policyMonth: row.policyMonth, benefitClass: row.benefitClass, providerTier: row.providerTier, geography: row.geography, amount: row.amount, description: row.description, occurredOn: event.occurredOn },
  };
}

async function appendDecided(d: HandDraft, ref: string, event: typeof servicingEvent.$inferSelect, advisorUserId: string, today: string) {
  const [row] = await db
    .insert(servicingEvent)
    .values({
      externalRef: ref,
      policyId: event.policyId,
      kind: d.kind,
      policyMonth: d.policyMonth,
      benefitClass: d.benefitClass,
      setting: event.setting,
      providerTier: d.providerTier,
      geography: d.geography,
      billedAmount: d.billedAmount,
      description: d.description,
      submittedByUserId: event.submittedByUserId,
      occurredOn: d.occurredOn ?? today,
      outcome: d.outcome,
      reasonCode: d.reasonCode,
      planPays: d.planPays,
      memberPays: d.memberPays,
      calculation: d.calculation,
      ledgerBefore: d.ledgerBefore,
      ledgerAfter: d.ledgerAfter,
      memberExplanation: d.memberExplanation,
      brokerExplanation: d.brokerExplanation,
      confidence: null,
      uncertaintyReason: null,
      decidedBy: "advisor",
      decidedByUserId: advisorUserId,
      supersedesEventId: d.supersedesEventId,
    })
    .returning({ id: servicingEvent.id });
  return row.id;
}

async function freshRef(base: string) {
  let ref = `${base}-A`;
  for (let n = 2; (await db.select({ id: servicingEvent.id }).from(servicingEvent).where(eq(servicingEvent.externalRef, ref)).limit(1)).length > 0; n++) ref = `${base}-A${n}`;
  return ref;
}

export async function coverIt(input: { taskId: string; advisorUserId: string; providerTier: string; note: string; memberMessage?: string; today?: string }): Promise<HandoffResult> {
  const p = await load(input.taskId, input.advisorUserId);
  if (!p.ok) return fail(p.error);
  if (!p.event) return fail("There is no claim on this task to cover.");
  const bad = needNote(input.note);
  if (bad) return fail(bad);
  if (!(providerTierEnum as readonly string[]).includes(input.providerTier)) return fail(`Choose which kind of provider to treat this as: one of ${providerTierEnum.join(", ")}.`);
  const tier = input.providerTier as ProviderTier;

  const u = await undecidable(p.policyId, p.event);
  if (!u.ok) return fail(u.reason);
  const { frame, source, policyRef } = u;
  const today = isoToday(input.today);

  // The advisor names the input; the ENGINE computes the money, at the event's own position in the history.
  const { result } = adjudicateAt({ plan: frame.terms, events: frame.events, eventId: source.id, overrides: { providerTier: tier, geography: "uae" } });
  if (result.outcome === "insufficient_data") return fail("The plan terms still cannot decide that — nothing was written.");
  const newRef = await freshRef(source.ref);
  const draft = buildCoverDraft({ plan: frame.terms, policyRef, inceptionDate: frame.inceptionDate, source, today, newRef, advisorName: p.advisor.name, note: input.note.trim() }, tier, result);
  const said = input.memberMessage?.trim() ? checkMemberMessage(input.memberMessage, draft, source.amount) : ({ ok: true, text: draft.memberExplanation } as const);
  if (!said.ok) return fail(said.reason);
  draft.memberExplanation = said.text;

  const open = await openTasksFor(source.id, p.convo?.id ?? null);
  const written = await serialised(() =>
    record(
      async () => {
        const eventId = await appendDecided(draft, newRef, p.event!, input.advisorUserId, today);
        await rebuildLedger(p.policyId);
        const report = await checkReplay(p.policyId);
        if (!report.ok) throw new Error(`replay failed after the decision: ${[...report.ledgerDiffs, ...report.drifted.map((d) => `${d.ref}.${d.field}`)].join("; ")}`);
        return { eventId, eventRef: newRef };
      },
      async ({ eventId }) => {
        await resolveTasks(open.map((t) => t.id), input.advisorUserId);
        await db.insert(reviewDecision).values({ reviewTaskId: p.task.id, actorUserId: input.advisorUserId, action: "override", notes: input.note.trim(), payload: { supplied: { providerTier: tier, geography: "uae" }, supersedes: source.ref, eventId } });
      },
    ),
  );

  // What the member sees — AFTER the record, like every other write.
  if (p.convo) {
    const facts = nextStepFacts({ plan: frame.terms, kind: source.kind, benefitClass: source.benefitClass, providerTier: tier, policyMonth: source.policyMonth, inceptionDate: frame.inceptionDate, result });
    const card = outcomeCard({ kind: source.kind, title: draft.description, policyMonth: source.policyMonth, inceptionDate: frame.inceptionDate, benefitClass: source.benefitClass, amount: source.amount, result, explanation: draft.memberExplanation, facts });
    await postAssistant(p.convo.id, { text: draft.memberExplanation, card });
    await finishConversation(p.convo, written.eventId);
  }
  if (written.eventId) await reassessAfterEvent(p.policyId, written.eventId);
  // Every commit site calls this; `owesPayment` alone decides whether there is anything to pay, so a
  // denial and an upheld appeal open nothing without this call site having to know that (§payouts).
  if (written.eventId) await openSettlementForEvent(p.policyId, written.eventId);
  return { ok: true, message: p.convo ? "Decided. The member has been told." : "Decided. It is on the member's policy." };
}

export async function denyIt(input: { taskId: string; advisorUserId: string; note: string; memberMessage?: string; today?: string }): Promise<HandoffResult> {
  const p = await load(input.taskId, input.advisorUserId);
  if (!p.ok) return fail(p.error);
  if (!p.event) return fail("There is no claim on this task to decide.");
  const bad = needNote(input.note);
  if (bad) return fail(bad);
  const u = await undecidable(p.policyId, p.event);
  if (!u.ok) return fail(u.reason);
  const { frame, source, policyRef } = u;
  const today = isoToday(input.today);

  // "Not covered" consumes nothing: the ledger before this event is the ledger after it.
  const { ledgerBefore } = adjudicateAt({ plan: frame.terms, events: frame.events, eventId: source.id, overrides: { providerTier: "in_network_clinic", geography: "uae" } });
  const message = checkMemberMessage(input.memberMessage?.trim() || defaultDenyMessage(source.kind, source.amount), source.amount, ledgerBefore);
  if (!message.ok) return fail(message.reason);
  const newRef = await freshRef(source.ref);
  const draft = buildDenyDraft({ plan: frame.terms, policyRef, inceptionDate: frame.inceptionDate, source, today, newRef, advisorName: p.advisor.name, note: input.note.trim() }, ledgerBefore, message.text);

  const open = await openTasksFor(source.id, p.convo?.id ?? null);
  const written = await serialised(() =>
    record(
      async () => {
        const eventId = await appendDecided(draft, newRef, p.event!, input.advisorUserId, today);
        await rebuildLedger(p.policyId);
        const report = await checkReplay(p.policyId);
        if (!report.ok) throw new Error(`replay failed after the decision: ${[...report.ledgerDiffs, ...report.drifted.map((d) => `${d.ref}.${d.field}`)].join("; ")}`);
        return { eventId, eventRef: newRef };
      },
      async ({ eventId }) => {
        await resolveTasks(open.map((t) => t.id), input.advisorUserId);
        await db.insert(reviewDecision).values({ reviewTaskId: p.task.id, actorUserId: input.advisorUserId, action: "reject", notes: input.note.trim(), payload: { supersedes: source.ref, eventId } });
      },
    ),
  );
  if (p.convo) {
    const card = outcomeCard({ kind: source.kind, title: draft.description, policyMonth: source.policyMonth, inceptionDate: frame.inceptionDate, benefitClass: source.benefitClass, amount: source.amount, result: { outcome: "denied", planPays: 0, memberPays: source.amount, calculation: draft.calculation }, explanation: draft.memberExplanation, facts: { waitingPeriod: null, admittedProviders: null, limit: null, deductibleNowMet: false, appealable: false } });
    await postAssistant(p.convo.id, { text: draft.memberExplanation, card });
    await finishConversation(p.convo, written.eventId);
  }
  if (written.eventId) await reassessAfterEvent(p.policyId, written.eventId);
  // Every commit site calls this; `owesPayment` alone decides whether there is anything to pay, so a
  // denial and an upheld appeal open nothing without this call site having to know that (§payouts).
  if (written.eventId) await openSettlementForEvent(p.policyId, written.eventId);
  return { ok: true, message: p.convo ? "Decided. The member has been told." : "Decided. It is on the member's policy." };
}

// ---------------------------------------------------------------------------
// The human thread
// ---------------------------------------------------------------------------

export async function replyInThread(input: { taskId: string; advisorUserId: string; message: string }): Promise<HandoffResult> {
  const p = await load(input.taskId, input.advisorUserId);
  if (!p.ok) return fail(p.error);
  if (!p.convo) return fail("There is no conversation with the member on this case.");
  if (p.convo.status !== "escalated") return fail("This conversation is not with an advisor.");
  const said = checkMemberMessage(input.message);
  if (!said.ok) return fail(said.reason);
  await postAdvisor(p.convo.id, said.text);
  await db.insert(reviewDecision).values({ reviewTaskId: p.task.id, actorUserId: input.advisorUserId, action: "reply", notes: "Replied in the member's thread.", payload: { message: said.text } });
  // Someone has picked it up: an open task becomes "in progress", and stays on the queue until it is resolved.
  if (p.task.status === "open") await db.update(reviewTask).set({ status: "in_progress", assignedToUserId: input.advisorUserId }).where(eq(reviewTask.id, p.task.id));
  return { ok: true, message: "Sent. It is in the member's thread." };
}

export async function resolveCase(input: { taskId: string; advisorUserId: string; note: string; memberMessage: string }): Promise<HandoffResult> {
  const p = await load(input.taskId, input.advisorUserId);
  if (!p.ok) return fail(p.error);
  const bad = needNote(input.note);
  if (bad) return fail(bad);
  if (p.event && p.event.outcome === "insufficient_data") return fail("A claim the plan could not decide is decided with Cover it or Don't cover it, not closed.");
  if (p.convo) {
    const said = checkMemberMessage(input.memberMessage);
    if (!said.ok) return fail(said.reason);
    const open = await openTasksFor(p.event?.id ?? null, p.convo.id);
    await resolveTasks(open.map((t) => t.id), input.advisorUserId);
    await db.insert(reviewDecision).values({ reviewTaskId: p.task.id, actorUserId: input.advisorUserId, action: "resolve", notes: input.note.trim(), payload: { message: said.text } });
    await postAdvisor(p.convo.id, said.text);
    await finishConversation(p.convo, null);
    return { ok: true, message: "Resolved. The member has been told." };
  }
  await resolveTasks([p.task.id], input.advisorUserId);
  await db.insert(reviewDecision).values({ reviewTaskId: p.task.id, actorUserId: input.advisorUserId, action: "resolve", notes: input.note.trim() });
  return { ok: true, message: "Resolved." };
}

export async function handOff(input: { taskId: string; advisorUserId: string; toUserId: string; note: string }): Promise<HandoffResult> {
  const p = await load(input.taskId, input.advisorUserId);
  if (!p.ok) return fail(p.error);
  const bad = needNote(input.note);
  if (bad) return fail(bad);
  const [to] = await db.select({ id: appUser.id, role: appUser.role, name: appUser.fullName }).from(appUser).where(eq(appUser.id, input.toUserId)).limit(1);
  if (!to || to.role !== "advisor") return fail("Choose a colleague to hand this to.");
  if (to.id === p.advisor.id) return fail("That is you — choose a colleague.");
  await db.update(reviewTask).set({ assignedToUserId: to.id, status: "in_progress" }).where(eq(reviewTask.id, p.task.id));
  await db.insert(reviewDecision).values({ reviewTaskId: p.task.id, actorUserId: input.advisorUserId, action: "hand_off", notes: input.note.trim(), payload: { to: to.name } });
  return { ok: true, message: `Handed to ${to.name}.` };
}

export async function markCalled(input: { taskId: string; advisorUserId: string; note: string }): Promise<HandoffResult> {
  const p = await load(input.taskId, input.advisorUserId);
  if (!p.ok) return fail(p.error);
  if (!p.convo) return fail("There is no conversation on this case.");
  const [cb] = await db.select({ id: conversationAction.id }).from(conversationAction).where(and(eq(conversationAction.conversationId, p.convo.id), eq(conversationAction.actionType, "callback_requested"))).limit(1);
  if (!cb) return fail("The member has not asked for a callback.");
  const bad = needNote(input.note);
  if (bad) return fail(bad);
  await db.insert(reviewDecision).values({ reviewTaskId: p.task.id, actorUserId: input.advisorUserId, action: "called", notes: input.note.trim() });
  if (p.task.status === "open") await db.update(reviewTask).set({ status: "in_progress", assignedToUserId: input.advisorUserId }).where(eq(reviewTask.id, p.task.id));
  return { ok: true, message: "Recorded that you called." };
}

export async function closeQualityCheck(input: { taskId: string; advisorUserId: string; note: string }): Promise<HandoffResult> {
  const p = await load(input.taskId, input.advisorUserId);
  if (!p.ok) return fail(p.error);
  if (!p.event || p.event.outcome === "insufficient_data") return fail("That is not a quality check.");
  const [pending] = await db.select({ id: conversationAction.id }).from(conversationAction).where(and(eq(conversationAction.actionType, "appeal_overturn_proposal"), eq(conversationAction.subjectId, p.event.id), eq(conversationAction.status, "pending"))).limit(1);
  if (pending) return fail("A reversal is waiting on this one — decide that instead.");
  const bad = needNote(input.note);
  if (bad) return fail(bad);
  await resolveTasks([p.task.id], input.advisorUserId);
  await db.insert(reviewDecision).values({ reviewTaskId: p.task.id, actorUserId: input.advisorUserId, action: "approve", notes: input.note.trim() });
  return { ok: true, message: "Closed. It stays on the record." };
}

