// The signature on an overturn — the one place an appeal changes money.
//
// The system never self-signs a reversal (plan §2.3, §5.4.7). An overturn moves money and rewrites the ledger at a
// PAST point, and the log is append-only, so the agent stops at a PROPOSAL: the finished row, plus the working, held
// as a pending `conversation_action` with a `review_task` in front of it. This file is what happens when a person
// answers that task, and it has three verbs (plan §13.3.2):
//
//   confirmReversal   append the overturn row, supersede the denial, refold the ledger, tell the member
//   upholdInstead     the person disagrees with the proposal: append an UPHELD row instead, tell the member
//   requestMoreEvidence   the proposal was not enough: back to the member, with the evidence request on screen
//
// Two disciplines. Nothing is trusted from the client: the proposal is PARSED out of its row (a corrupted one fails
// closed), and a reversal is re-adjudicated against the log as it stands NOW before it is signed — if the numbers no
// longer match what the person was shown, they are not signed. And everything is one transaction: the row, the
// ledger, the task and the decision land together or not at all, and replay must still pass afterwards.
//
// Not `server-only`, like the session: the checks drive whole appeals against a scratch database.

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { appUser, conversation, conversationAction, policy, reviewDecision, reviewTask, servicingEvent } from "@/db/schema";
import { latestState, nextEventRef, postAssistant, serialised, writeState } from "@/lib/ai/servicing-session";
import { askOrderFor } from "@/lib/ai/tools/appeal";
import { buildUpheldDraft, evidenceRequestCard, kindInfo, parseOverturnProposal, reAdjudicate, type AppealEventDraft, type OverturnProposal } from "@/lib/servicing";
import { appealOutcomeCard } from "@/lib/servicing/appeal-commit";
import { contestedRowOf } from "@/lib/servicing/appeal-store";
import { identifyContested } from "@/lib/servicing/appeal";
import { memberCopyViolations } from "@/lib/servicing/copy-rules";
import { numbersIn, observedNumbers } from "@/lib/servicing/facts";
import { checkReplay, rebuildLedger, replayPolicy } from "@/lib/servicing/store";
import { readLimits } from "@/lib/servicing";
import { reassessAfterEvent } from "@/lib/ai/servicing-reassess";
import { openSettlementForEvent } from "@/lib/ai/servicing-settlement";

export type SignoffResult = { ok: true; eventRef: string | null } | { ok: false; reason: string };

const fail = (reason: string): SignoffResult => ({ ok: false, reason });

/** The pending proposal behind a task — parsed, never cast — and everything needed to act on it. */
async function loadPending(taskId: string, advisorUserId: string) {
  const [advisor] = await db.select({ id: appUser.id, role: appUser.role }).from(appUser).where(eq(appUser.id, advisorUserId)).limit(1);
  if (!advisor || advisor.role !== "advisor") return { ok: false as const, error: "Only an advisor can sign an overturn." };

  const [task] = await db.select().from(reviewTask).where(eq(reviewTask.id, taskId)).limit(1);
  if (!task || task.subjectType !== "servicing_event") return { ok: false as const, error: "That task is not a decision on a claim." };
  if (task.status === "resolved") return { ok: false as const, error: "That has already been decided." };

  const [action] = await db
    .select()
    .from(conversationAction)
    .where(and(eq(conversationAction.actionType, "appeal_overturn_proposal"), eq(conversationAction.subjectId, task.subjectId), eq(conversationAction.status, "pending")))
    .orderBy(desc(sql`rowid`))
    .limit(1);
  if (!action) return { ok: false as const, error: "There is no reversal waiting on this task." };
  const proposal = parseOverturnProposal(action.arguments);
  // A proposal that will not parse is not an empty one. Nothing is signed against a record nobody validated.
  if (!proposal) return { ok: false as const, error: "The proposal on this task could not be read, so it cannot be signed." };

  const [convo] = await db.select().from(conversation).where(eq(conversation.id, proposal.conversationId)).limit(1);
  if (!convo || !convo.policyId) return { ok: false as const, error: "The member's conversation is missing." };
  return { ok: true as const, advisor, task, action, proposal, convo, policyId: convo.policyId };
}

/** A member message an advisor edited must still read like the member's register, and cite only figures the working holds. */
function editedMemberMessage(proposal: OverturnProposal, text: string | undefined): { ok: true; text: string } | { ok: false; reason: string } {
  const t = text?.trim();
  if (!t || t === proposal.draft.memberExplanation) return { ok: true, text: proposal.draft.memberExplanation };
  const violations = memberCopyViolations(t);
  if (violations.length > 0) return { ok: false, reason: `The message to the member is not fit for them to read: ${violations.join("; ")}` };
  const observed = observedNumbers(proposal.draft, proposal.original, proposal.ledgerBeforeContested);
  const invented = numbersIn(t).filter((n) => !observed.has(n));
  if (invented.length > 0) return { ok: false, reason: `The message to the member states figure(s) ${invented.join(", ")} that appear nowhere in the working.` };
  return { ok: true, text: t };
}

async function appendAppealRow(d: AppealEventDraft, ref: string, convo: typeof conversation.$inferSelect, policyId: string, advisorUserId: string, today: string) {
  const [row] = await db
    .insert(servicingEvent)
    .values({
      externalRef: ref,
      policyId,
      kind: "appeal",
      policyMonth: d.policyMonth,
      benefitClass: d.benefitClass,
      providerTier: d.providerTier,
      geography: d.geography,
      billedAmount: d.billedAmount,
      description: d.description,
      evidenceText: d.evidenceText,
      submittedByUserId: convo.userId,
      occurredOn: today,
      outcome: d.outcome,
      reasonCode: d.reasonCode,
      planPays: d.planPays,
      memberPays: d.memberPays,
      calculation: d.calculation,
      ledgerBefore: d.ledgerBefore,
      ledgerAfter: d.ledgerAfter,
      memberExplanation: d.memberExplanation,
      brokerExplanation: d.brokerExplanation,
      confidence: d.confidence,
      uncertaintyReason: d.uncertaintyReason,
      // The person who signs it is who decided it — the system never self-signs an overturn.
      decidedBy: "advisor",
      decidedByUserId: advisorUserId,
      supersedesEventId: d.supersedes ? d.contestedEventId : null,
      appealOfEventId: d.contestedEventId,
    })
    .returning({ id: servicingEvent.id });
  return row.id;
}

/** Everything a decision changes, in one transaction: the row (if any), the task, the decision record, the proposal. */
export async function record(
  work: () => Promise<{ eventId: string | null; eventRef: string | null }>,
  after: (r: { eventId: string | null; eventRef: string | null }) => Promise<void>,
): Promise<{ eventId: string | null; eventRef: string | null }> {
  await db.run(sql`begin`);
  try {
    const written = await work();
    await after(written);
    await db.run(sql`commit`);
    return written;
  } catch (error) {
    await db.run(sql`rollback`);
    throw error;
  }
}

export const isoToday = (today?: string) => today ?? new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Confirm the reversal
// ---------------------------------------------------------------------------

export async function confirmReversal(input: { taskId: string; advisorUserId: string; note: string; memberMessage?: string; today?: string }): Promise<SignoffResult> {
  const p = await loadPending(input.taskId, input.advisorUserId);
  if (!p.ok) return fail(p.error);
  const { proposal, convo, policyId, task, action } = p;
  const note = input.note.trim();
  if (note.length < 10) return fail("Add a note for the file — what you checked before signing.");

  const message = editedMemberMessage(proposal, input.memberMessage);
  if (!message.ok) return fail(message.reason);

  // Re-adjudicate against the log AS IT STANDS NOW. Whatever the person was shown must still be what would be signed.
  const frame = await replayPolicy(policyId);
  const row = contestedRowOf(frame.stored, proposal.contestedEventId);
  const found = row ? identifyContested(row) : null;
  if (!row || !found?.ok) return fail("The decision this would reverse has changed since it was proposed, so there is nothing left to sign.");
  const redone = reAdjudicate({
    plan: frame.terms,
    events: frame.events,
    contestedId: row.id,
    patch: { field: proposal.correction.field, value: proposal.correction.to },
    original: { outcome: row.outcome, planPays: row.planPays },
  });
  if (redone.verdict !== "overturn" || redone.result.planPays !== proposal.draft.planPays || redone.result.memberPays !== proposal.draft.memberPays) {
    return fail("The record has changed since this was proposed and the numbers no longer match what you were shown. Nothing was signed.");
  }

  const draft: AppealEventDraft = { ...proposal.draft, memberExplanation: message.text };
  const state = await latestState(convo.id);

  const written = await serialised(() =>
    record(
      async () => {
        let ref = state?.eventRef ?? (await nextEventRef("appeal"));
        const [taken] = await db.select({ id: servicingEvent.id }).from(servicingEvent).where(eq(servicingEvent.externalRef, ref)).limit(1);
        if (taken) ref = await nextEventRef("appeal");
        const eventId = await appendAppealRow({ ...draft, brokerExplanation: draft.brokerExplanation.replaceAll(state?.eventRef ?? ref, ref) }, ref, convo, policyId, input.advisorUserId, isoToday(input.today));
        // The only writer of benefit_ledger: replay the log, write the projection.
        await rebuildLedger(policyId);
        // The overturn lands at the denial's position, so everything after it is refolded. Replay must still pass.
        const report = await checkReplay(policyId);
        if (!report.ok) throw new Error(`replay failed after the overturn: ${[...report.ledgerDiffs, ...report.drifted.map((d) => `${d.ref}.${d.field}`)].join("; ")}`);
        return { eventId, eventRef: ref };
      },
      async ({ eventId }) => {
        await db.update(reviewTask).set({ status: "resolved", resolvedAt: new Date(), assignedToUserId: input.advisorUserId }).where(eq(reviewTask.id, task.id));
        await db.insert(reviewDecision).values({ reviewTaskId: task.id, actorUserId: input.advisorUserId, action: "overturn", notes: note, payload: { supersedes: proposal.contestedRef, correction: { [proposal.correction.field]: proposal.correction.to }, eventId } });
        await db.update(conversationAction).set({ status: "succeeded", completedAt: new Date() }).where(eq(conversationAction.id, action.id));
      },
    ),
  );

  // What the member sees — AFTER the record, like every other write.
  const card = appealOutcomeCard(draft, frame.terms, frame.inceptionDate);
  await postAssistant(convo.id, { text: draft.memberExplanation, card });
  if (state) await writeState(convo.id, { ...state, phase: "done", committedEventId: written.eventId }, convo.userId);
  await db.update(conversation).set({ status: "completed", closedAt: new Date() }).where(eq(conversation.id, convo.id));
  if (written.eventId) await reassessAfterEvent(policyId, written.eventId);
  // Every commit site calls this; `owesPayment` alone decides whether there is anything to pay, so a
  // denial and an upheld appeal open nothing without this call site having to know that (§payouts).
  if (written.eventId) await openSettlementForEvent(policyId, written.eventId);
  return { ok: true, eventRef: written.eventRef };
}

// ---------------------------------------------------------------------------
// Uphold instead
// ---------------------------------------------------------------------------

export async function upholdInstead(input: { taskId: string; advisorUserId: string; note: string; today?: string }): Promise<SignoffResult> {
  const p = await loadPending(input.taskId, input.advisorUserId);
  if (!p.ok) return fail(p.error);
  const { proposal, convo, policyId, task, action } = p;
  const note = input.note.trim();
  if (note.length < 10) return fail("Add a note for the file — why the decision should stand.");

  const frame = await replayPolicy(policyId);
  const row = contestedRowOf(frame.stored, proposal.contestedEventId);
  const found = row ? identifyContested(row) : null;
  if (!row || !found?.ok) return fail("The decision has changed since this was proposed, so there is nothing left to uphold.");
  const state = await latestState(convo.id);
  const ref = state?.eventRef ?? (await nextEventRef("appeal"));

  // The engine's own answer to the ORIGINAL inputs, not a copy of any text: the same identity re-adjudication a turn uses.
  const original = reAdjudicate({
    plan: frame.terms,
    events: frame.events,
    contestedId: row.id,
    patch: found.contested.admissibility.turnsOn === "provider_tier" ? { field: "provider_tier", value: row.providerTier! } : { field: "benefit_class", value: row.benefitClass! },
    original: { outcome: row.outcome, planPays: row.planPays },
  }).result;
  const [pol] = await db.select({ ref: policy.externalRef, number: policy.policyNumber }).from(policy).where(eq(policy.id, policyId)).limit(1);
  const draft = buildUpheldDraft(
    { plan: frame.terms, policyRef: pol?.ref ?? pol?.number ?? "policy", inceptionDate: frame.inceptionDate, contested: row, original, evidence: proposal.evidence, declaredAtIntake: false, appealRef: ref },
    { evidenceSupplied: true },
  );
  draft.brokerExplanation = `${draft.brokerExplanation} Reversal was proposed on ${proposal.correction.field.replace(/_/g, " ")} ${proposal.correction.from} → ${proposal.correction.to}; the advisor upheld instead: ${note}`;
  draft.confidence = 0.75;

  const written = await serialised(() =>
    record(
      async () => {
        let r = ref;
        const [taken] = await db.select({ id: servicingEvent.id }).from(servicingEvent).where(eq(servicingEvent.externalRef, r)).limit(1);
        if (taken) r = await nextEventRef("appeal");
        const eventId = await appendAppealRow({ ...draft, brokerExplanation: draft.brokerExplanation.replaceAll(ref, r) }, r, convo, policyId, input.advisorUserId, isoToday(input.today));
        await rebuildLedger(policyId);
        return { eventId, eventRef: r };
      },
      async () => {
        await db.update(reviewTask).set({ status: "resolved", resolvedAt: new Date(), assignedToUserId: input.advisorUserId }).where(eq(reviewTask.id, task.id));
        await db.insert(reviewDecision).values({ reviewTaskId: task.id, actorUserId: input.advisorUserId, action: "uphold", notes: note, payload: { proposedCorrection: proposal.correction } });
        await db.update(conversationAction).set({ status: "rejected", completedAt: new Date() }).where(eq(conversationAction.id, action.id));
      },
    ),
  );

  await postAssistant(convo.id, { text: draft.memberExplanation, card: appealOutcomeCard(draft, frame.terms, frame.inceptionDate, original) });
  if (state) await writeState(convo.id, { ...state, phase: "done", committedEventId: written.eventId }, convo.userId);
  await db.update(conversation).set({ status: "completed", closedAt: new Date() }).where(eq(conversation.id, convo.id));
  if (written.eventId) await reassessAfterEvent(policyId, written.eventId);
  // Every commit site calls this; `owesPayment` alone decides whether there is anything to pay, so a
  // denial and an upheld appeal open nothing without this call site having to know that (§payouts).
  if (written.eventId) await openSettlementForEvent(policyId, written.eventId);
  return { ok: true, eventRef: written.eventRef };
}

// ---------------------------------------------------------------------------
// Ask for more evidence
// ---------------------------------------------------------------------------

export async function requestMoreEvidence(input: { taskId: string; advisorUserId: string; note: string; memberMessage?: string }): Promise<SignoffResult> {
  const p = await loadPending(input.taskId, input.advisorUserId);
  if (!p.ok) return fail(p.error);
  const { proposal, convo, task, action } = p;
  const note = input.note.trim();
  if (note.length < 10) return fail("Add a note for the file — what is missing from what was sent.");
  const state = await latestState(convo.id);
  if (!state?.appeal) return fail("The appeal's record could not be read.");

  const said = input.memberMessage?.trim();
  if (said) {
    const violations = memberCopyViolations(said);
    if (violations.length > 0) return fail(`The message to the member is not fit for them to read: ${violations.join("; ")}`);
  }

  // The kind that bore on the finding may be asked for AGAIN (a better copy), so it leaves `supplied` for this count;
  // it still counts against the two-asks-per-kind limit, which is what keeps this from being a loop.
  const appeal = structuredClone(state.appeal);
  appeal.supplied = appeal.supplied.filter((k) => k !== proposal.evidenceKind);
  appeal.pendingCorrection = null;
  const candidates = askOrderFor(proposal.contestedReason, appeal);
  if (candidates.length === 0) return fail("There is nothing further that could be asked for on this decision.");
  if (appeal.requested.length >= readLimits().evidenceRequestRounds) return fail("The member has already been asked for the allowed number of documents.");
  const kind = candidates[0];
  const info = kindInfo(proposal.contestedReason, kind)!;
  appeal.requested.push(kind);
  appeal.openRequest = kind;

  await serialised(() =>
    record(
      async () => ({ eventId: null, eventRef: null }),
      async () => {
        await db.update(reviewTask).set({ status: "resolved", resolvedAt: new Date(), assignedToUserId: input.advisorUserId }).where(eq(reviewTask.id, task.id));
        await db.insert(reviewDecision).values({ reviewTaskId: task.id, actorUserId: input.advisorUserId, action: "request_info", notes: note, payload: { asked: kind } });
        await db.update(conversationAction).set({ status: "rejected", completedAt: new Date() }).where(eq(conversationAction.id, action.id));
      },
    ),
  );

  if (said) await postAssistant(convo.id, { text: said, card: null });
  const card = evidenceRequestCard({
    contested: { title: proposal.draft.description.replace(/^Appeal — /, ""), decision: "Not covered" },
    prompt: info.ask,
    mustShow: `${info.mustShow}.`,
    round: appeal.requested.length,
  });
  await postAssistant(convo.id, { text: card.prompt, card });
  await writeState(convo.id, { ...state, phase: "collecting", appeal }, convo.userId);
  await db.update(conversation).set({ status: "awaiting_user" }).where(eq(conversation.id, convo.id));
  return { ok: true, eventRef: null };
}
