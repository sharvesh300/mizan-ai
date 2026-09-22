// The case page's data — BROKER ONLY (plan §13.3.2).
//
// One event, with everything a broker reads to make a decision or to check one: the finding, what the member was told
// (verbatim), the working, the chain of decisions it belongs to, and — when a reversal is waiting on a signature — the
// proposal and the arithmetic to sign it on. Reads only. It returns the WHOLE record, so nothing here may be imported by a
// member component; the member surface is one screen and a member gets a 404 on the page this feeds.

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { appUser, conversation, conversationAction, person, policy, reviewTask, servicingEvent } from "@/db/schema";
import { askOrderFor } from "@/lib/ai/tools/appeal";
import { parseOverturnProposal, type OverturnProposal } from "./appeal-commit";
import { readLimits } from "./limits";
import { parseSessionState } from "./session-state";
import { adjudicateAt } from "./appeal";
import { providerTypeLabel } from "./labels";
import { checkReplay, replayPolicy, type EventDrift } from "./store";
import { providerTierEnum } from "@/db/schema/enums";

type Stored = typeof servicingEvent.$inferSelect;

export type ChainLink = {
  id: string;
  ref: string;
  kind: Stored["kind"];
  outcome: Stored["outcome"];
  reasonCode: Stored["reasonCode"];
  policyMonth: number;
  planPays: number | null;
  memberPays: number | null;
  decidedBy: Stored["decidedBy"];
  decidedByName: string | null;
  /** How this row relates to the one before it in the chain. */
  relation: "original" | "appeals" | "supersedes";
  current: boolean;
};

export type EventCase = {
  policy: { id: string; ref: string; number: string; inceptionDate: string; status: string; planName: string };
  subject: { id: string; fullName: string };
  event: Stored;
  ref: string;
  decidedByName: string | null;
  /** Every decision this one is connected to, in the order they were written. Never collapsed: the denial happened, and both stay. */
  chain: ChainLink[];
  supersededBy: { ref: string; kind: "appeal" | "advisor" } | null;
  restated: EventDrift[];
  /** The open task on this event, if a person is being asked for something. */
  task: { id: string; reason: string; priorityScore: number; status: string } | null;
  /** A reversal computed and waiting for a signature — present only while it waits. */
  proposal: OverturnProposal | null;
  /** The member's conversation this came from, if it did. */
  conversationId: string | null;
  /** Whether "Ask for more evidence" would have anything to ask for — read from the appeal's own state, not guessed. */
  canAskMore: boolean;
};

export async function getEventCase(policyId: string, eventId: string): Promise<EventCase | null> {
  const frame = await replayPolicy(policyId);
  const event = frame.stored.find((r) => r.id === eventId);
  if (!event) return null;

  const [meta] = await db
    .select({ policy, subjectId: person.id, subjectName: person.fullName })
    .from(policy)
    .innerJoin(person, eq(policy.personId, person.id))
    .where(eq(policy.id, policyId))
    .limit(1);
  if (!meta) return null;

  const users = await db.select({ id: appUser.id, name: appUser.fullName }).from(appUser);
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const refOf = (r: Stored) => r.externalRef ?? r.id.slice(0, 8);

  // The connected component of the supersession / appeal graph containing this event.
  const linked = new Set<string>([eventId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of frame.stored) {
      const targets = [r.supersedesEventId, r.appealOfEventId].filter((id): id is string => id !== null);
      const connected = linked.has(r.id) || targets.some((id) => linked.has(id));
      if (!connected) continue;
      for (const id of [r.id, ...targets]) {
        if (!linked.has(id)) {
          linked.add(id);
          grew = true;
        }
      }
    }
  }
  const chain: ChainLink[] = frame.stored
    .filter((r) => linked.has(r.id))
    .map((r) => ({
      id: r.id,
      ref: refOf(r),
      kind: r.kind,
      outcome: r.outcome,
      reasonCode: r.reasonCode,
      policyMonth: r.policyMonth,
      planPays: r.planPays === null ? null : Number(r.planPays),
      memberPays: r.memberPays === null ? null : Number(r.memberPays),
      decidedBy: r.decidedBy,
      decidedByName: r.decidedByUserId ? (nameOf.get(r.decidedByUserId) ?? null) : null,
      relation: r.supersedesEventId ? ("supersedes" as const) : r.appealOfEventId ? ("appeals" as const) : ("original" as const),
      current: r.id === eventId,
    }));

  const report = await checkReplay(policyId);
  const [task] = await db
    .select()
    .from(reviewTask)
    .where(and(eq(reviewTask.subjectType, "servicing_event"), eq(reviewTask.subjectId, eventId), eq(reviewTask.status, "open")))
    .orderBy(desc(reviewTask.priorityScore))
    .limit(1);
  const [pending] = await db
    .select({ args: conversationAction.arguments })
    .from(conversationAction)
    .where(and(eq(conversationAction.actionType, "appeal_overturn_proposal"), eq(conversationAction.subjectId, eventId), eq(conversationAction.status, "pending")))
    .limit(1);
  const proposal = pending ? parseOverturnProposal(pending.args) : null;

  // "Ask for more evidence" is only offered when there is something admissible left to ask — counting a better copy of what
  // bore on the finding, which the sign-off allows. Read from the appeal's own state, so the button and the verb agree.
  let canAskMore = false;
  if (proposal) {
    const [row] = await db
      .select({ arguments: conversationAction.arguments })
      .from(conversationAction)
      .where(and(eq(conversationAction.conversationId, proposal.conversationId), eq(conversationAction.actionType, "servicing_state")))
      .orderBy(desc(sql`rowid`))
      .limit(1);
    const appeal = row ? parseSessionState(row.arguments)?.appeal : null;
    if (appeal) {
      const next = askOrderFor(proposal.contestedReason, { ...appeal, supplied: appeal.supplied.filter((k) => k !== proposal.evidenceKind) });
      canAskMore = next.length > 0 && appeal.requested.length < readLimits().evidenceRequestRounds;
    }
  }

  return {
    policy: { id: meta.policy.id, ref: meta.policy.externalRef ?? meta.policy.policyNumber, number: meta.policy.policyNumber, inceptionDate: meta.policy.inceptionDate, status: meta.policy.status, planName: frame.terms.name },
    subject: { id: meta.subjectId, fullName: meta.subjectName },
    event,
    ref: refOf(event),
    decidedByName: event.decidedByUserId ? (nameOf.get(event.decidedByUserId) ?? null) : null,
    chain,
    supersededBy: (() => {
      const s = frame.stored.find((r) => r.supersedesEventId === eventId);
      return s ? { ref: refOf(s), kind: s.kind === "appeal" ? ("appeal" as const) : ("advisor" as const) } : null;
    })(),
    restated: report.restated.filter((d) => d.ref === refOf(event)),
    task: task ? { id: task.id, reason: task.reason, priorityScore: task.priorityScore, status: task.status } : null,
    proposal,
    conversationId: proposal?.conversationId ?? null,
    canAskMore,
  };
}

/**
 * What the engine says for each tier an advisor could treat an undecidable provider as — so "Cover it" is chosen with the
 * money in front of them, and the advisor never types an amount. Null unless the event is one the plan could not decide.
 */
export async function undecidablePreview(policyId: string, eventId: string): Promise<{ tier: string; label: string; outcome: string; planPays: number | null; memberPays: number | null }[] | null> {
  const frame = await replayPolicy(policyId);
  const row = frame.stored.find((r) => r.id === eventId);
  if (!row || row.outcome !== "insufficient_data" || frame.stored.some((r) => r.supersedesEventId === eventId)) return null;
  if (row.kind !== "claim" && row.kind !== "reimbursement") return null;
  return providerTierEnum.map((tier) => {
    const { result } = adjudicateAt({ plan: frame.terms, events: frame.events, eventId, overrides: { providerTier: tier, geography: "uae" } });
    return { tier, label: providerTypeLabel[tier], outcome: result.outcome, planPays: result.planPays, memberPays: result.memberPays };
  });
}

/** The people an advisor can hand a case to. */
export async function listColleagues(exceptUserId: string): Promise<{ id: string; name: string }[]> {
  const users = await db.select({ id: appUser.id, name: appUser.fullName, role: appUser.role }).from(appUser);
  return users.filter((u) => u.role === "advisor" && u.id !== exceptUserId).map((u) => ({ id: u.id, name: u.name }));
}

export type ConversationCase = {
  policy: { id: string; ref: string; planName: string };
  subject: { fullName: string };
  conversation: { id: string; status: string };
  task: { id: string; reason: string; priorityScore: number; status: string } | null;
};

/** A hand-off with no claim of its own — the member asked for a person, or the agent stopped — is a case in its own right. */
export async function getConversationCase(policyId: string, conversationId: string): Promise<ConversationCase | null> {
  const [row] = await db
    .select({ convo: conversation, policy, name: person.fullName, planId: policy.planId })
    .from(conversation)
    .innerJoin(policy, eq(conversation.policyId, policy.id))
    .innerJoin(person, eq(policy.personId, person.id))
    .where(and(eq(conversation.id, conversationId), eq(conversation.policyId, policyId), eq(conversation.purpose, "servicing")))
    .limit(1);
  if (!row) return null;
  const frame = await replayPolicy(policyId);
  const [task] = await db
    .select()
    .from(reviewTask)
    .where(and(eq(reviewTask.subjectType, "conversation"), eq(reviewTask.subjectId, conversationId), sql`${reviewTask.status} <> 'resolved'`))
    .limit(1);
  return {
    policy: { id: policyId, ref: row.policy.externalRef ?? row.policy.policyNumber, planName: frame.terms.name },
    subject: { fullName: row.name },
    conversation: { id: conversationId, status: row.convo.status },
    task: task ? { id: task.id, reason: task.reason, priorityScore: task.priorityScore, status: task.status } : null,
  };
}
