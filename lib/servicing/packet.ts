// The case packet — a QUERY, not a table (plan §8).
//
// Assembled from what already exists, so it cannot disagree with the record: the conversation, the facts and where each
// came from, the evidence and its state, what the engine attempted, every earlier decision, every appeal, any plan-fit
// review, what is still waiting on the member, and why it left the agent. BROKER ONLY: it names causes and reads the whole
// record. What the MEMBER may see of the same thing is the escalation card's "What your advisor will have" — their own
// information, and nothing else.

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { conversation, conversationAction, extraction, message, planFitReassessment, reviewDecision, reviewTask, servicingEvent, appUser } from "@/db/schema";
import { ESCALATION_MEANING, type EscalationCause } from "./escalation";
import { FIELD_LABEL, type FieldKey } from "./facts";
import { parseSessionState } from "./session-state";

export type Packet = {
  conversation: { id: string; status: string; intent: string; startedAt: Date | null } | null;
  transcript: { id: string; from: "member" | "assistant" | "advisor"; text: string; card: string | null; at: Date | null }[];
  /** Each fact, the sentence it came from, and how it was read. */
  facts: { key: string; label: string; value: string; quote: string; source: string }[];
  benefitClass: { value: string; declaredCondition: string | null; by: string } | null;
  /** An appeal's evidence and what became of each piece. */
  evidence: { text: string; verdict: string | null; kind: string | null }[];
  evidenceState: { requested: string[]; declined: string[]; supplied: string[] } | null;
  unresolved: string[];
  /** Why it left the agent, in the broker's words. */
  why: { cause: EscalationCause | null; meaning: string | null; reasons: string[] };
  callback: { window: string; phone: string; at: Date | null } | null;
  /** What was done about it, oldest first. */
  decisions: { action: string; by: string | null; notes: string | null; at: Date | null }[];
  history: { id: string; ref: string; kind: string; month: number; outcome: string | null; reasonCode: string | null; planPays: number | null; by: string | null }[];
  appeals: { ref: string; contests: string; outcome: string | null }[];
  reassessments: { verdict: string; reasoning: string }[];
};

export async function getPacket(input: { policyId: string; conversationId: string | null; eventId: string | null }): Promise<Packet> {
  const { policyId, conversationId, eventId } = input;
  const [convo] = conversationId ? await db.select().from(conversation).where(eq(conversation.id, conversationId)).limit(1) : [null];

  const messages = conversationId ? await db.select().from(message).where(eq(message.conversationId, conversationId)).orderBy(asc(message.seq)) : [];
  const [stateRow] = conversationId
    ? await db.select({ arguments: conversationAction.arguments }).from(conversationAction).where(and(eq(conversationAction.conversationId, conversationId), eq(conversationAction.actionType, "servicing_state"))).orderBy(desc(sql`rowid`)).limit(1)
    : [];
  const state = stateRow ? parseSessionState(stateRow.arguments) : null;

  // The facts as the draft holds them NOW, each with its sentence — falling back to what was extracted, for a case whose state is gone.
  const facts: Packet["facts"] = [];
  if (state) {
    for (const [key, f] of Object.entries(state.draft.facts)) {
      if (f) facts.push({ key, label: FIELD_LABEL[key as FieldKey] ?? key, value: String(f.value), quote: f.quote, source: f.source === "stated" ? "said by the member" : f.source === "inferred" ? "read by the agent — member confirms" : f.source === "record" ? "from their file" : "from a document" });
    }
  } else if (conversationId) {
    const rows = await db.select().from(extraction).where(eq(extraction.conversationId, conversationId)).orderBy(asc(extraction.createdAt));
    for (const r of rows) facts.push({ key: r.fieldKey, label: r.fieldKey.replace(/^servicing\./, ""), value: r.valueText ?? "", quote: r.rawSpan, source: r.method });
  }

  const a = state?.appeal ?? null;
  const unresolved: string[] = [];
  if (state) {
    if (state.openQuestion) unresolved.push(`A question about ${FIELD_LABEL[state.openQuestion]} is waiting on the member.`);
    if (state.awaitingConfirmation) unresolved.push("The member has not yet confirmed the details shown to them.");
    for (const c of state.draft.conflicts.filter((x) => !x.resolved)) unresolved.push(`Two sources disagree about ${FIELD_LABEL[c.fieldKey]}.`);
    if (a?.openRequest) unresolved.push(`A ${a.openRequest.replace(/_/g, " ")} is being asked of the member.`);
  }

  // Why it left the agent: the cause (a broker's fact, kept as a row) and the task's own words.
  const actions = conversationId ? await db.select().from(conversationAction).where(eq(conversationAction.conversationId, conversationId)).orderBy(asc(conversationAction.createdAt)) : [];
  const esc = actions.find((x) => x.actionType === "escalated");
  const cause = (esc?.arguments as { cause?: EscalationCause } | null)?.cause ?? null;
  const cb = actions.find((x) => x.actionType === "callback_requested");
  const tasks = await db.select().from(reviewTask).where(sql`(${reviewTask.subjectType} = 'conversation' and ${reviewTask.subjectId} = ${conversationId ?? ""}) or (${reviewTask.subjectType} = 'servicing_event' and ${reviewTask.subjectId} = ${eventId ?? ""})`);
  const event = eventId ? (await db.select().from(servicingEvent).where(eq(servicingEvent.id, eventId)).limit(1))[0] : null;
  const reasons = [...tasks.map((t) => t.reason), ...(event?.uncertaintyReason ? [event.uncertaintyReason] : [])];

  const decisions = tasks.length
    ? await db
        .select({ action: reviewDecision.action, notes: reviewDecision.notes, at: reviewDecision.decidedAt, by: appUser.fullName })
        .from(reviewDecision)
        .leftJoin(appUser, eq(reviewDecision.actorUserId, appUser.id))
        .where(sql`${reviewDecision.reviewTaskId} in (${sql.join(tasks.map((t) => sql`${t.id}`), sql`, `)})`)
        .orderBy(asc(reviewDecision.decidedAt))
    : [];

  const log = await db.select().from(servicingEvent).where(eq(servicingEvent.policyId, policyId)).orderBy(sql`rowid`);
  // `createdAt` is unix SECONDS and two reassessments from the same request can tie on it — `rowid` is write
  // order and never ties, the same fix as `log` just above.
  const reass = await db.select().from(planFitReassessment).where(eq(planFitReassessment.policyId, policyId)).orderBy(desc(sql`rowid`));
  const refOf = new Map(log.map((r) => [r.id, r.externalRef ?? r.id.slice(0, 8)]));

  return {
    conversation: convo ? { id: convo.id, status: convo.status, intent: state?.intent ?? "claim", startedAt: convo.startedAt } : null,
    transcript: messages
      .filter((m) => m.bodyText || m.payload)
      .map((m) => ({ id: m.id, from: m.role === "applicant" ? ("member" as const) : m.role === "advisor" ? ("advisor" as const) : ("assistant" as const), text: m.bodyText ?? "", card: m.payload && typeof m.payload === "object" && "kind" in m.payload ? String((m.payload as { kind: unknown }).kind) : null, at: m.providerTimestamp ?? null })),
    facts,
    benefitClass: state?.draft.benefitClass ?? null,
    evidence: (a?.evidence ?? []).map((text, i) => {
      const found = a!.assessments.find((x) => x.evidenceIndex === i);
      return { text, verdict: found?.verdict ?? null, kind: found && found.kind !== "none" ? found.kind : null };
    }),
    evidenceState: a ? { requested: a.requested, declined: a.declined, supplied: a.supplied } : null,
    unresolved,
    why: { cause, meaning: cause ? ESCALATION_MEANING[cause] : null, reasons },
    callback: cb ? { window: String((cb.arguments as { window?: string } | null)?.window ?? ""), phone: String((cb.arguments as { phone?: string } | null)?.phone ?? ""), at: cb.completedAt ?? cb.createdAt ?? null } : null,
    decisions: decisions.map((d) => ({ action: d.action, by: d.by, notes: d.notes, at: d.at })),
    history: log.map((r) => ({ id: r.id, ref: r.externalRef ?? r.id.slice(0, 8), kind: r.kind, month: r.policyMonth, outcome: r.outcome, reasonCode: r.reasonCode, planPays: r.planPays === null ? null : Number(r.planPays), by: r.decidedBy })),
    appeals: log.filter((r) => r.kind === "appeal").map((r) => ({ ref: r.externalRef ?? r.id.slice(0, 8), contests: r.appealOfEventId ? (refOf.get(r.appealOfEventId) ?? "") : "", outcome: r.outcome })),
    reassessments: reass.map((r) => ({ verdict: r.verdict, reasoning: r.brokerReasoning })),
  };
}
