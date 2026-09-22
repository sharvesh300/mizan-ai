// Payouts: opening one when the plan owes money, and the two verbs a person uses on it (§payouts).
//
// Opening is automatic and best-effort — it runs after a commit, and a payout that fails to open must never take
// down the claim decision that earned it. That trade has a cost (a silently unopened payout is money nobody
// chases), so `unsettledEvents` is the reconciliation the cost buys: it finds every decided event that owes
// money and has no payout, from the LOG, so the gap is always visible rather than merely unlikely.
//
// Both verbs re-check the caller is an advisor against the row, the same discipline as `servicing-signoff.ts`
// and `servicing-reassess.ts`: a server action is a public endpoint, and "the button was hidden" is not an
// authorisation. Not `server-only` — the checks drive this against a scratch database.

import { eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { appUser, claimSettlement, reviewDecision, reviewTask, servicingEvent } from "@/db/schema";
import { canApprove, canMarkPaid, owesPayment, payeeOf, refusalFor, type Payee } from "@/lib/servicing";
import { replayPolicy } from "@/lib/servicing/store";

/**
 * Plan §12.2's bands: a payout is not a blocker and not a close call — the work is done and the amount is the
 * engine's. It sits just above a quality check (40) and below a plan-change recommendation (60), which argues
 * for a member's money rather than merely moving it.
 */
export const SETTLEMENT_PRIORITY = 50;

/** The engine's own figure for one event, from a replay — never the stored column read back. */
function owedFromReplay(frame: Awaited<ReturnType<typeof replayPolicy>>, eventId: string): number | null {
  const stored = frame.stored.find((r) => r.id === eventId);
  if (!stored) return null;
  const superseded = frame.stored.some((r) => r.supersedesEventId === eventId);
  const step = frame.steps.find((s) => s.event.id === eventId);
  // An event with no fold step moved no money (an upheld appeal). The stored row still answers `owesPayment`
  // honestly for kind and outcome; the AMOUNT only ever comes from a step.
  const planPays = step ? (step.result.planPays ?? 0) : 0;
  const owes = owesPayment({
    kind: stored.kind,
    outcome: step ? step.result.outcome : stored.outcome,
    planPays,
    supersededByEventId: superseded ? "superseded" : null,
  });
  return owes ? planPays : null;
}

/**
 * Open a payout for a freshly decided event, if it owes one. Idempotent: the unique index on
 * `servicing_event_id` means a retried commit cannot open a second payout, and this checks first anyway so the
 * common case never relies on a constraint violation.
 */
export async function openSettlementForEvent(policyId: string, eventId: string): Promise<void> {
  try {
    const [existing] = await db.select({ id: claimSettlement.id }).from(claimSettlement).where(eq(claimSettlement.servicingEventId, eventId)).limit(1);
    if (existing) return;

    const frame = await replayPolicy(policyId);
    const owed = owedFromReplay(frame, eventId);
    if (owed === null || owed <= 0) return;

    const stored = frame.stored.find((r) => r.id === eventId)!;
    const ref = stored.externalRef ?? stored.id.slice(0, 8);
    const [row] = await db.insert(claimSettlement).values({ servicingEventId: eventId, policyId, status: "awaiting_approval", amount: owed }).returning();
    await db.insert(reviewTask).values({
      subjectType: "settlement",
      subjectId: row.id,
      reason: `Payment to approve: ${ref} — the plan owes ${payeeOf(stored) === "member" ? "the member" : "the provider"} AED ${owed.toLocaleString("en")}.`,
      priorityScore: SETTLEMENT_PRIORITY,
      status: "open",
    });
  } catch (error) {
    // Best-effort by design — see the header. `unsettledEvents` is what makes this survivable.
    console.error("opening a settlement failed", policyId, eventId, error);
  }
}

export type SettlementResult = { ok: true; message: string } | { ok: false; reason: string };

/** The task, its settlement and the event it pays for — with the caller checked against the row. */
async function loadSettlementTask(taskId: string, advisorUserId: string) {
  const [advisor] = await db.select({ id: appUser.id, role: appUser.role }).from(appUser).where(eq(appUser.id, advisorUserId)).limit(1);
  if (!advisor || advisor.role !== "advisor") return { ok: false as const, error: "Only an advisor can decide this." };
  const [task] = await db.select().from(reviewTask).where(eq(reviewTask.id, taskId)).limit(1);
  if (!task || task.subjectType !== "settlement") return { ok: false as const, error: "That task is not a payment." };
  const [row] = await db.select().from(claimSettlement).where(eq(claimSettlement.id, task.subjectId)).limit(1);
  if (!row) return { ok: false as const, error: "The payment is missing." };
  return { ok: true as const, task, row };
}

/**
 * Authorise the payout. The amount is re-derived from the LOG here, not trusted from the row: between opening
 * and approving, the decision may have been overturned or replaced by an advisor, and approving yesterday's
 * figure would move the wrong money. A mismatch refuses rather than silently paying the new number — the
 * payout was opened against a decision that no longer stands, so it needs a person to look again.
 */
export async function approvePayment(input: { taskId: string; advisorUserId: string; note: string }): Promise<SettlementResult> {
  const p = await loadSettlementTask(input.taskId, input.advisorUserId);
  if (!p.ok) return { ok: false, reason: p.error };
  const refusal = refusalFor("approve", p.row.status);
  if (refusal) return { ok: false, reason: refusal };
  if (!canApprove(p.row.status)) return { ok: false, reason: "This payment cannot be approved from where it is." };

  const note = input.note.trim();
  if (note.length < 10) return { ok: false, reason: "Add a note for the file — a sentence on what you checked." };

  const frame = await replayPolicy(p.row.policyId);
  const owed = owedFromReplay(frame, p.row.servicingEventId);
  if (owed === null) return { ok: false, reason: "The decision behind this payment no longer stands — it was replaced or reversed. Nothing was paid." };
  if (Number(p.row.amount) !== owed) {
    return { ok: false, reason: `The amount has changed since this was raised: it now computes to AED ${owed.toLocaleString("en")}, not AED ${Number(p.row.amount).toLocaleString("en")}. Nothing was paid.` };
  }

  await db.update(claimSettlement).set({ status: "approved", approvedByUserId: input.advisorUserId, approvedAt: new Date() }).where(eq(claimSettlement.id, p.row.id));
  await db.update(reviewTask).set({ assignedToUserId: input.advisorUserId }).where(eq(reviewTask.id, p.task.id));
  await db.insert(reviewDecision).values({ reviewTaskId: p.task.id, actorUserId: input.advisorUserId, action: "approve_payment", notes: note });
  return { ok: true, message: "Approved. It still needs marking as paid once the money has gone." };
}

/** Record that the money actually left. This is the step that closes the task. */
export async function markPaid(input: { taskId: string; advisorUserId: string; paymentReference: string }): Promise<SettlementResult> {
  const p = await loadSettlementTask(input.taskId, input.advisorUserId);
  if (!p.ok) return { ok: false, reason: p.error };
  const refusal = refusalFor("mark_paid", p.row.status);
  if (refusal) return { ok: false, reason: refusal };
  if (!canMarkPaid(p.row.status)) return { ok: false, reason: "This payment cannot be marked paid from where it is." };

  const reference = input.paymentReference.trim();
  if (reference.length < 3) return { ok: false, reason: "Add the payment reference — it is how this is matched to the money that moved." };

  await db.update(claimSettlement).set({ status: "paid", paidByUserId: input.advisorUserId, paidAt: new Date(), paymentReference: reference }).where(eq(claimSettlement.id, p.row.id));
  await db.update(reviewTask).set({ status: "resolved", resolvedAt: new Date(), assignedToUserId: input.advisorUserId }).where(eq(reviewTask.id, p.task.id));
  await db.insert(reviewDecision).values({ reviewTaskId: p.task.id, actorUserId: input.advisorUserId, action: "mark_paid", notes: `Paid — reference ${reference}.`, payload: { paymentReference: reference } });
  return { ok: true, message: "Marked paid. The member can see it." };
}

/**
 * Reconciliation: decided events that OWE money and have no payout at all — the blind spot that opening
 * best-effort creates, made visible. BROKER ONLY. An empty list is the claim "every pound the plan owes is
 * being chased"; anything in it is a member waiting on money nobody has queued.
 */
export async function unsettledEvents(policyId: string): Promise<{ eventId: string; ref: string; amount: number; payee: Payee }[]> {
  const frame = await replayPolicy(policyId);
  const settled = new Set(
    (await db.select({ eventId: claimSettlement.servicingEventId }).from(claimSettlement).where(eq(claimSettlement.policyId, policyId))).map((r) => r.eventId),
  );
  const out: { eventId: string; ref: string; amount: number; payee: Payee }[] = [];
  for (const stored of frame.stored) {
    if (settled.has(stored.id)) continue;
    const owed = owedFromReplay(frame, stored.id);
    if (owed === null || owed <= 0) continue;
    out.push({ eventId: stored.id, ref: stored.externalRef ?? stored.id.slice(0, 8), amount: owed, payee: payeeOf(stored) });
  }
  return out;
}

/** Every payout still waiting on a person, across all policies — BROKER ONLY, for reconciliation and the queue. */
export async function outstandingSettlements() {
  return db
    .select({ settlement: claimSettlement, eventRef: servicingEvent.externalRef })
    .from(claimSettlement)
    .innerJoin(servicingEvent, eq(claimSettlement.servicingEventId, servicingEvent.id))
    .where(inArray(claimSettlement.status, ["awaiting_approval", "approved"]));
}

/** What a member may know: status and date only — never the reference, the note, or who signed it. */
export async function memberSettlementsFor(eventIds: string[]) {
  if (eventIds.length === 0) return new Map<string, { status: (typeof claimSettlement.$inferSelect)["status"]; paidAt: Date | null }>();
  const rows = await db
    .select({ eventId: claimSettlement.servicingEventId, status: claimSettlement.status, paidAt: claimSettlement.paidAt })
    .from(claimSettlement)
    .where(inArray(claimSettlement.servicingEventId, eventIds));
  return new Map(rows.map((r) => [r.eventId, { status: r.status, paidAt: r.paidAt }]));
}
