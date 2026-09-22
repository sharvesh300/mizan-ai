// The database side of an appeal: which rows of the log are appealable, and the frame an appeal turn runs in.
//
// Not `server-only`, like store.ts — the checks drive it from a script. Reads only: everything an appeal WRITES goes
// through the session (an upheld appeal) or the sign-off (an overturn), and the ledger only ever changes through
// `rebuildLedger`.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { conversation, conversationAction } from "@/db/schema";
import { identifyContested, type AppealExit, type Contested, type ContestedRow } from "./appeal";
import { parseSessionState } from "./session-state";
import { replayPolicy } from "./store";

type Frame = Awaited<ReturnType<typeof replayPolicy>>;
type Stored = Frame["stored"][number];

/** A stored row, reduced to what an appeal needs to know about the finding it would contest. */
export function contestedRowOf(stored: Stored[], id: string, pendingOverturns: ReadonlySet<string> = new Set()): ContestedRow | null {
  const row = stored.find((r) => r.id === id);
  if (!row) return null;
  return {
    id: row.id,
    ref: row.externalRef ?? row.id.slice(0, 8),
    kind: row.kind,
    policyMonth: row.policyMonth,
    outcome: row.outcome,
    reasonCode: row.reasonCode,
    benefitClass: row.benefitClass,
    providerTier: row.providerTier,
    geography: row.geography,
    amount: row.kind === "preauth" ? (row.estimatedAmount === null ? null : Number(row.estimatedAmount)) : row.billedAmount === null ? null : Number(row.billedAmount),
    planPays: row.planPays === null ? null : Number(row.planPays),
    memberPays: row.memberPays === null ? null : Number(row.memberPays),
    description: row.description,
    decidedBy: row.decidedBy,
    supersededBy: stored.find((r) => r.supersedesEventId === row.id)?.id ?? null,
    // An overturn proposal waiting on a signature counts as an appeal already made: one appeal per denial.
    appealedBy: stored.find((r) => r.kind === "appeal" && r.appealOfEventId === row.id)?.id ?? (pendingOverturns.has(row.id) ? "pending" : null),
  };
}

/** Events with an overturn proposal waiting for a signature, on any policy. */
export async function pendingOverturnEventIds(): Promise<Set<string>> {
  const rows = await db
    .select({ args: conversationAction.arguments })
    .from(conversationAction)
    .where(and(eq(conversationAction.actionType, "appeal_overturn_proposal"), eq(conversationAction.status, "pending")));
  const ids = new Set<string>();
  for (const r of rows) {
    const id = (r.args as { contestedEventId?: unknown } | null)?.contestedEventId;
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

/** An appeal conversation already open on this event — so a second tap resumes it rather than starting another. */
export async function openAppealFor(policyId: string, eventId: string): Promise<string | null> {
  const open = await db
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.policyId, policyId), eq(conversation.purpose, "servicing"), inArray(conversation.status, ["active", "awaiting_user", "awaiting_review"])));
  for (const c of open) {
    const [row] = await db
      .select({ arguments: conversationAction.arguments })
      .from(conversationAction)
      .where(and(eq(conversationAction.conversationId, c.id), eq(conversationAction.actionType, "servicing_state")))
      .orderBy(desc(sql`rowid`))
      .limit(1);
    const state = row ? parseSessionState(row.arguments) : null;
    if (state?.appeal?.contestedEventId === eventId) return c.id;
  }
  return null;
}

export type AppealCheck = { ok: true; contested: Contested; frame: Frame } | { ok: false; exit: AppealExit | "not_found" };

/** Is this event appealable right now? Read from the log, never from what the member says about it. */
export async function checkAppealable(policyId: string, eventId: string): Promise<AppealCheck> {
  const frame = await replayPolicy(policyId);
  const row = contestedRowOf(frame.stored, eventId, await pendingOverturnEventIds());
  if (!row) return { ok: false, exit: "not_found" };
  const found = identifyContested(row);
  return found.ok ? { ok: true, contested: found.contested, frame } : { ok: false, exit: found.exit };
}

/** The ids of every event on this policy a member could appeal — for the buttons. Ids only: nothing else about a row leaves this file. */
export async function listAppealableEventIds(policyId: string): Promise<Set<string>> {
  const frame = await replayPolicy(policyId);
  const pending = await pendingOverturnEventIds();
  const out = new Set<string>();
  for (const r of frame.stored) {
    const row = contestedRowOf(frame.stored, r.id, pending);
    if (row && identifyContested(row).ok) out.add(r.id);
  }
  return out;
}

/**
 * The member's conversation an event came out of, if it came out of one. The log has no conversation id (a seeded event
 * has none), so this asks the conversations: whichever servicing conversation on the policy committed this event.
 */
export async function conversationForEvent(policyId: string, eventId: string): Promise<string | null> {
  const convos = await db.select({ id: conversation.id }).from(conversation).where(and(eq(conversation.policyId, policyId), eq(conversation.purpose, "servicing")));
  for (const c of convos) {
    const [row] = await db
      .select({ arguments: conversationAction.arguments })
      .from(conversationAction)
      .where(and(eq(conversationAction.conversationId, c.id), eq(conversationAction.actionType, "servicing_state")))
      .orderBy(desc(sql`rowid`))
      .limit(1);
    const state = row ? parseSessionState(row.arguments) : null;
    if (state?.committedEventId === eventId) return c.id;
  }
  return null;
}
