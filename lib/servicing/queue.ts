// What the broker's queue and dashboard know about servicing work — BROKER ONLY, and not `server-only`, so the checks can drive it.
//
// `servicingSubjects` hydrates a review task's subject: who, which policy, which event — and, for a reversal waiting on a
// signature, the arithmetic to sign it on. `getStraightThrough` is the number that measures the goal (plan §13.3.5).

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { confidenceBand } from "@/lib/domain";
import { claimSettlement, conversation, conversationAction, message, person, plan, planFitReassessment, policy, reviewDecision, reviewTask, servicingEvent } from "@/db/schema";
import { parseOverturnProposal, type OverturnProposal } from "./appeal-commit";
import { conversationForEvent } from "./appeal-store";
import { ESCALATION_MEANING, type EscalationCause } from "./escalation";
import { payeeOf } from "./settlement";

/**
 * What a servicing task is ABOUT, for the queue row: who, which policy, which event — and, for a reversal waiting on a
 * signature, the arithmetic to sign it on (plan §13.3.1: "an overturn moves money, so its row expands inline to show
 * `denied 0/6,000 → covered 4,400/1,600`, one click but only after seeing the arithmetic").
 *
 * BROKER ONLY: it reads the whole record. Phase 6 adds the escalation and undecidable rows' own extras; a task of a kind
 * not hydrated here still gets its who/what, so it is never a bare row.
 */
export async function servicingSubjects(tasks: { task: typeof reviewTask.$inferSelect }[]) {
  const eventTasks = tasks.filter(({ task }) => task.subjectType === "servicing_event");
  const convoTasks = tasks.filter(({ task }) => task.subjectType === "conversation");
  const reassessTasks = tasks.filter(({ task }) => task.subjectType === "reassessment");
  const settlementTasks = tasks.filter(({ task }) => task.subjectType === "settlement");
  const out = new Map<string, ServicingSubject>();
  if (eventTasks.length === 0 && convoTasks.length === 0 && reassessTasks.length === 0 && settlementTasks.length === 0) return out;

  const eventRows = eventTasks.length
    ? await db
        .select({ event: servicingEvent, policyRef: policy.externalRef, policyNumber: policy.policyNumber, personName: person.fullName })
        .from(servicingEvent)
        .innerJoin(policy, eq(servicingEvent.policyId, policy.id))
        .innerJoin(person, eq(policy.personId, person.id))
        .where(inArray(servicingEvent.id, eventTasks.map(({ task }) => task.subjectId)))
    : [];
  const byEvent = new Map(eventRows.map((r) => [r.event.id, r]));

  // A reversal waiting on a signature, by the decision it would replace.
  const pending = await db
    .select({ id: conversationAction.id, args: conversationAction.arguments })
    .from(conversationAction)
    .where(and(eq(conversationAction.actionType, "appeal_overturn_proposal"), eq(conversationAction.status, "pending")));
  const proposals = new Map<string, OverturnProposal>();
  for (const p of pending) {
    const parsed = parseOverturnProposal(p.args);
    if (parsed) proposals.set(parsed.contestedEventId, parsed);
  }

  // Why each hand-off happened, and whether the member asked for a call — kept as rows, counted here.
  const actions = await db
    .select({ conversationId: conversationAction.conversationId, type: conversationAction.actionType, args: conversationAction.arguments })
    .from(conversationAction)
    .where(inArray(conversationAction.actionType, ["escalated", "callback_requested"]));
  const causeOf = new Map<string, EscalationCause>();
  const callbackOf = new Map<string, { window: string; phone: string }>();
  for (const a of actions) {
    const args = (a.args ?? {}) as Record<string, unknown>;
    if (a.type === "escalated" && typeof args.cause === "string") causeOf.set(a.conversationId, args.cause as EscalationCause);
    if (a.type === "callback_requested") callbackOf.set(a.conversationId, { window: String(args.window ?? ""), phone: String(args.phone ?? "") });
  }
  const called = new Set(
    (await db.select({ taskId: reviewDecision.reviewTaskId }).from(reviewDecision).where(eq(reviewDecision.action, "called"))).map((r) => r.taskId),
  );

  /** Did the member write last? Then the advisor is the one waiting — and the row says so. */
  const memberRepliedIn = async (conversationId: string | null) => {
    if (!conversationId) return false;
    const [last] = await db.select({ role: message.role }).from(message).where(eq(message.conversationId, conversationId)).orderBy(desc(message.seq)).limit(1);
    return last?.role === "applicant";
  };

  for (const { task } of eventTasks) {
    const r = byEvent.get(task.subjectId);
    if (!r) continue;
    const proposal = proposals.get(r.event.id) ?? null;
    const convoId = await conversationForEvent(r.event.policyId, r.event.id);
    const band = confidenceBand(r.event.confidence);
    const kind: ServicingSubject["task"] = proposal ? "overturn" : r.event.outcome === "insufficient_data" ? "undecidable" : band && band !== "high" ? "quality" : convoId && causeOf.has(convoId) ? "escalation" : "other";
    const cause = kind === "undecidable" ? ("insufficient_data" as const) : convoId ? (causeOf.get(convoId) ?? null) : null;
    const cb = convoId ? (callbackOf.get(convoId) ?? null) : null;
    out.set(task.id, {
      kind: "servicing",
      task: kind,
      group: kind === "undecidable" ? "undecidable" : kind === "quality" ? "uncertain" : kind === "escalation" ? "blocked" : "decide",
      cause,
      policyId: r.event.policyId,
      policyRef: r.policyRef ?? r.policyNumber,
      eventId: r.event.id,
      eventRef: r.event.externalRef ?? r.event.id.slice(0, 8),
      eventKind: r.event.kind,
      conversationId: convoId,
      personName: r.personName,
      amount: Number(r.event.billedAmount ?? r.event.estimatedAmount ?? 0) || null,
      confidence: kind === "quality" ? band : null,
      uncertaintyReason: kind === "quality" || kind === "undecidable" ? r.event.uncertaintyReason : cause ? sentenceCaseMeaning(cause) : null,
      callback: cb ? { ...cb, called: called.has(task.id) } : null,
      memberReplied: await memberRepliedIn(convoId),
      overturn: proposal
        ? {
            appealRef: proposal.draft.contestedRef,
            correction: proposal.correction,
            before: { outcome: proposal.original.outcome, planPays: proposal.original.planPays, memberPays: proposal.original.memberPays },
            after: { reasonCode: proposal.draft.reasonCode, planPays: proposal.draft.planPays, memberPays: proposal.draft.memberPays },
            deductible: { before: proposal.ledgerBeforeContested.deductible_met, after: proposal.draft.ledgerAfter.deductible_met },
          }
        : null,
      reassessment: null,
      settlement: null,
    });
  }

  if (convoTasks.length) {
    const convos = await db
      .select({ id: conversation.id, policyId: conversation.policyId, policyRef: policy.externalRef, policyNumber: policy.policyNumber, personName: person.fullName })
      .from(conversation)
      .innerJoin(policy, eq(conversation.policyId, policy.id))
      .innerJoin(person, eq(policy.personId, person.id))
      .where(inArray(conversation.id, convoTasks.map(({ task }) => task.subjectId)));
    const byConvo = new Map(convos.map((c) => [c.id, c]));
    for (const { task } of convoTasks) {
      const c = byConvo.get(task.subjectId);
      if (!c?.policyId) continue;
      const cause = causeOf.get(c.id) ?? null;
      const cb = callbackOf.get(c.id) ?? null;
      out.set(task.id, {
        kind: "servicing",
        task: "escalation",
        // A member is waiting on a person: it cannot move until someone acts.
        group: "blocked",
        cause,
        policyId: c.policyId,
        policyRef: c.policyRef ?? c.policyNumber,
        eventId: null,
        eventRef: null,
        eventKind: null,
        conversationId: c.id,
        personName: c.personName,
        amount: null,
        confidence: null,
        uncertaintyReason: cause ? sentenceCaseMeaning(cause) : null,
        callback: cb ? { ...cb, called: called.has(task.id) } : null,
        memberReplied: await memberRepliedIn(c.id),
        overturn: null,
        reassessment: null,
        settlement: null,
      });
    }
  }

  if (reassessTasks.length) {
    const rows = await db
      .select({ r: planFitReassessment, policyRef: policy.externalRef, policyNumber: policy.policyNumber, personName: person.fullName, currentPlanId: policy.planId })
      .from(planFitReassessment)
      .innerJoin(policy, eq(planFitReassessment.policyId, policy.id))
      .innerJoin(person, eq(policy.personId, person.id))
      .where(inArray(planFitReassessment.id, reassessTasks.map(({ task }) => task.subjectId)));
    const planIds = [...new Set(rows.flatMap((r) => [r.currentPlanId, r.r.recommendedPlanId].filter((x): x is string => x !== null)))];
    const plans = planIds.length ? await db.select({ id: plan.id, name: plan.name, annualPremium: plan.annualPremium }).from(plan).where(inArray(plan.id, planIds)) : [];
    const planById = new Map(plans.map((p) => [p.id, p]));
    const byId = new Map(rows.map((r) => [r.r.id, r]));

    for (const { task } of reassessTasks) {
      const r = byId.get(task.subjectId);
      if (!r) continue;
      const current = planById.get(r.currentPlanId);
      const recommended = r.r.recommendedPlanId ? planById.get(r.r.recommendedPlanId) : undefined;
      out.set(task.id, {
        kind: "servicing",
        task: "reassessment",
        // A judgment call the system has already worked out — the work is done, one informed click (plan §13.3.1).
        group: "decide",
        cause: "reassessment_change",
        policyId: r.r.policyId,
        policyRef: r.policyRef ?? r.policyNumber,
        eventId: null,
        eventRef: null,
        eventKind: null,
        conversationId: null,
        personName: r.personName,
        amount: null,
        confidence: null,
        uncertaintyReason: null,
        callback: null,
        memberReplied: false,
        overturn: null,
        reassessment:
          current && recommended
            ? { reassessmentId: r.r.id, currentPlanName: current.name, currentPremium: Number(current.annualPremium), recommendedPlanName: recommended.name, recommendedPremium: Number(recommended.annualPremium) }
            : null,
        settlement: null,
      });
    }
  }

  if (settlementTasks.length) {
    const rows = await db
      .select({ s: claimSettlement, event: servicingEvent, policyRef: policy.externalRef, policyNumber: policy.policyNumber, personName: person.fullName })
      .from(claimSettlement)
      .innerJoin(servicingEvent, eq(claimSettlement.servicingEventId, servicingEvent.id))
      .innerJoin(policy, eq(claimSettlement.policyId, policy.id))
      .innerJoin(person, eq(policy.personId, person.id))
      .where(inArray(claimSettlement.id, settlementTasks.map(({ task }) => task.subjectId)));
    const byId = new Map(rows.map((r) => [r.s.id, r]));

    for (const { task } of settlementTasks) {
      const r = byId.get(task.subjectId);
      if (!r) continue;
      out.set(task.id, {
        kind: "servicing",
        task: "settlement",
        // The amount is already computed and the decision already made: this is one informed click, twice.
        group: "decide",
        cause: null,
        policyId: r.s.policyId,
        policyRef: r.policyRef ?? r.policyNumber,
        eventId: r.event.id,
        eventRef: r.event.externalRef ?? r.event.id.slice(0, 8),
        eventKind: r.event.kind,
        conversationId: null,
        personName: r.personName,
        amount: Number(r.s.amount),
        confidence: null,
        uncertaintyReason: null,
        callback: null,
        memberReplied: false,
        overturn: null,
        reassessment: null,
        settlement: { settlementId: r.s.id, status: r.s.status, amount: Number(r.s.amount), payee: payeeOf(r.event) },
      });
    }
  }
  return out;
}

const sentenceCaseMeaning = (cause: EscalationCause) => {
  const m = ESCALATION_MEANING[cause];
  return m.charAt(0).toUpperCase() + m.slice(1);
};

export type ServicingSubject = {
  kind: "servicing";
  /** What sort of thing this is. `overturn`: a reversal waiting on a signature. `escalation`: a hand-off with no claim of its own. */
  task: "overturn" | "undecidable" | "quality" | "escalation" | "reassessment" | "settlement" | "other";
  /** Where it sits in the queue (plan §13.3.1): by what KIND of attention it wants. */
  group: "undecidable" | "blocked" | "uncertain" | "decide";
  /** Why the case left the agent — a broker's fact, never a member's. */
  cause: EscalationCause | null;
  policyId: string;
  policyRef: string;
  eventId: string | null;
  eventRef: string | null;
  eventKind: "claim" | "preauth" | "reimbursement" | "appeal" | null;
  conversationId: string | null;
  personName: string;
  amount: number | null;
  /** Banded, and only for a quality check. */
  confidence: ReturnType<typeof confidenceBand>;
  uncertaintyReason: string | null;
  callback: { window: string; phone: string; called: boolean } | null;
  /** The member wrote last: the advisor is the one being waited on. */
  memberReplied: boolean;
  overturn: {
    appealRef: string;
    correction: { field: string; from: string; to: string; quote: string };
    before: { outcome: string | null; planPays: number | null; memberPays: number | null };
    after: { reasonCode: string; planPays: number | null; memberPays: number | null };
    deductible: { before: number; after: number };
  } | null;
  /** Only for `task: "settlement"` — the payout, and how far along it is. */
  settlement: {
    settlementId: string;
    status: "awaiting_approval" | "approved" | "paid";
    amount: number;
    payee: "member" | "provider";
  } | null;
  /** Only for `task: "reassessment"` with a `recommend_change` verdict — the switch the row asks a person to sign on. */
  reassessment: {
    reassessmentId: string;
    currentPlanName: string;
    currentPremium: number;
    recommendedPlanName: string;
    recommendedPremium: number;
  } | null;
};


// ---------------------------------------------------------------------------
// The number that measures the goal — BROKER ONLY (plan §13.3.5)
// ---------------------------------------------------------------------------

export type StraightThrough = {
  /** Servicing outcomes, counted once each: a decision a person replaced is not also counted as the system's. */
  all: { total: number; straight: number };
  week: { total: number; straight: number };
  /** Why the others needed a person, by the closed cause set — so each is countable. */
  causes: { cause: EscalationCause; count: number }[];
};

/**
 * Is the agent earning its keep, and where is it still failing? Straight-through is a servicing outcome decided by the
 * SYSTEM and not left undecidable; anything a person decided, or the plan could not, or that never became an outcome because a
 * member asked for one, is not. A row a person REPLACED (a denial an appeal reversed, an undecidable claim an advisor decided)
 * is counted as the replacement, once.
 */
export async function getStraightThrough(now = new Date()): Promise<StraightThrough> {
  const rows = await db.select().from(servicingEvent);
  const replaced = new Set(rows.map((r) => r.supersedesEventId).filter((x): x is string => x !== null));
  const weekAgo = now.getTime() - 7 * 86_400_000;

  const tally = { all: { total: 0, straight: 0 }, week: { total: 0, straight: 0 } };
  const causes = new Map<EscalationCause, number>();
  const bump = (at: Date | null, straight: boolean, cause: EscalationCause | null) => {
    const inWeek = at !== null && at.getTime() >= weekAgo;
    for (const k of ["all", ...(inWeek ? (["week"] as const) : [])] as const) {
      tally[k].total += 1;
      if (straight) tally[k].straight += 1;
    }
    if (!straight && cause) causes.set(cause, (causes.get(cause) ?? 0) + 1);
  };

  for (const r of rows) {
    if (replaced.has(r.id)) continue;
    const undecided = r.outcome === "insufficient_data";
    const byPerson = r.decidedBy === "advisor";
    const cause: EscalationCause | null = undecided ? "insufficient_data" : byPerson ? (r.kind === "appeal" ? "appeal_overturn" : "insufficient_data") : null;
    bump(r.createdAt, !undecided && !byPerson, cause);
  }

  // A hand-off that never became an outcome — the member asked for a person, or the agent stopped — is a servicing outcome
  // that needed a person, and it has a cause.
  const escalations = await db.select().from(conversationAction).where(eq(conversationAction.actionType, "escalated"));
  for (const a of escalations) {
    const args = (a.arguments ?? {}) as { cause?: EscalationCause; reference?: string };
    if (!args.cause || args.cause === "insufficient_data") continue; // the undecidable claim is already counted, as its event
    bump(a.createdAt, false, args.cause);
  }
  return { all: tally.all, week: tally.week, causes: [...causes.entries()].map(([cause, count]) => ({ cause, count })).sort((a, b) => b.count - a.count) };
}
