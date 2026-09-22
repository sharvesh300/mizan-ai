// The servicing session: one member turn, from rows to rows.
//
//   load  ── the conversation, the policy, the log, the ledger, what the member declared, and the state the
//            last turn left, all from the database and all revalidated
//   run   ── the graph, once (lib/ai/servicing-graph.ts)
//   write ── what the turn produced, in the order that keeps the record honest
//
// The ORDER of the writes is the point. Nothing is shown to the member that is not already recorded: an
// outcome's event and ledger are committed BEFORE the card that tells them about it, and a card is written
// BEFORE the state that says it is open. A crash between two writes leaves a record that is behind what the
// member has seen, never ahead of it.
//
// Durable state is rows (plan §6). The graph holds one turn's thinking; the conversation's memory is the
// `servicing_state` action, appended each turn and parsed — never cast — on the way back in.
//
// Not `server-only`, so a script can drive whole conversations against a throwaway database. The one thing
// it must not import is the model, which is injected as `decide` (lib/ai/servicing-model.ts wires it).

import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  applicationCondition,
  conversation,
  conversationAction,
  extraction,
  message,
  modelRun,
  person,
  plan,
  policy,
  reviewTask,
  servicingEvent,
} from "@/db/schema";
import { runServicingTurn, type ServicingTurnResult } from "@/lib/ai/servicing-graph";
import type { ServicingDecider, ServicingInput, TurnMessage } from "@/lib/ai/graph/nodes/servicing";
import { createServicingContext, type HistoryItem, type ServicingToolContext } from "@/lib/ai/tools/servicing";
import { APPEAL_EXIT_TEXT, changedFacts, ledgerToJson, initialSessionState, interpretForm, longDate, parseSessionState, readLimits, reAdjudicate, type AppealExit, type EventDraft, type Intent, type ServicingSessionState } from "@/lib/servicing";
import { checkAppealable, contestedRowOf, openAppealFor, pendingOverturnEventIds } from "@/lib/servicing/appeal-store";
import { identifyContested } from "@/lib/servicing/appeal";
import { isServicingCard } from "@/lib/servicing/cards";
import { planRowToTerms, rebuildLedger, replayPolicy } from "@/lib/servicing/store";
import { reassessAfterEvent } from "@/lib/ai/servicing-reassess";
import { openSettlementForEvent } from "@/lib/ai/servicing-settlement";

export const PROMPT_VERSION = "servicing-v1";
/** Plan §12.2: a low-confidence adjudication that still resolved. Below every band that blocks a member. */
export const QUALITY_CHECK_PRIORITY = 40;
const PROVIDER = "internal";

export type ServicingDeps = {
  /** The model. Undefined means no model: the conversation runs on forms. */
  decide?: ServicingDecider;
  /** Overrides today's date (ISO). Only for reproducible tests. */
  today?: string;
  /** Names the provider on the model_run audit row. */
  provider?: string;
};

const todayISO = (deps: ServicingDeps) => deps.today ?? new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Serialisation of the one write that must not interleave
// ---------------------------------------------------------------------------

// The driver is synchronous, so a BEGIN … COMMIT is not interrupted by another statement — but its `await`s
// yield to the microtask queue, and two commits interleaving would share one transaction. A promise chain
// makes commits take turns. It is per process, which is the whole deployment.
let commitChain: Promise<unknown> = Promise.resolve();
export const serialised = <T>(work: () => Promise<T>): Promise<T> => {
  const run = commitChain.then(work, work);
  commitChain = run.catch(() => undefined);
  return run;
};

// ---------------------------------------------------------------------------
// Small helpers over the message log
// ---------------------------------------------------------------------------

async function nextSeq(conversationId: string): Promise<number> {
  const [row] = await db.select({ max: sql<number>`coalesce(max(${message.seq}), 0)` }).from(message).where(eq(message.conversationId, conversationId));
  return Number(row?.max ?? 0) + 1;
}

async function postInbound(conversationId: string, bodyText: string, payload: unknown = null) {
  const [row] = await db
    .insert(message)
    .values({ conversationId, seq: await nextSeq(conversationId), direction: "inbound", role: "applicant", type: "text", bodyText, payload, provider: PROVIDER, deliveryStatus: "received", providerTimestamp: new Date(), receivedAt: new Date() })
    .returning();
  await db.update(conversation).set({ lastInboundAt: new Date() }).where(eq(conversation.id, conversationId));
  return row;
}

export async function postAssistant(conversationId: string, m: TurnMessage) {
  await db.insert(message).values({
    conversationId,
    seq: await nextSeq(conversationId),
    direction: "outbound",
    role: "assistant",
    type: m.card ? "interactive" : "text",
    // A card message carries its own text; the bubble is the card. `bodyText` is what a preview and the model's
    // transcript read.
    bodyText: m.text || null,
    payload: m.card,
    provider: PROVIDER,
    deliveryStatus: "delivered",
    providerTimestamp: new Date(),
  });
  await db.update(conversation).set({ lastOutboundAt: new Date() }).where(eq(conversation.id, conversationId));
}

export async function writeState(conversationId: string, state: ServicingSessionState, userId: string | null) {
  await db.insert(conversationAction).values({
    conversationId,
    actionType: "servicing_state",
    arguments: state,
    subjectType: "conversation",
    subjectId: conversationId,
    status: "succeeded",
    actorKind: "system",
    actorUserId: userId,
    completedAt: new Date(),
  });
}

export async function latestState(conversationId: string): Promise<ServicingSessionState | null> {
  const [row] = await db
    .select({ arguments: conversationAction.arguments })
    .from(conversationAction)
    .where(and(eq(conversationAction.conversationId, conversationId), eq(conversationAction.actionType, "servicing_state")))
    .orderBy(desc(sql`rowid`))
    .limit(1);
  return row ? parseSessionState(row.arguments) : null;
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/** CLM-n for a claim or reimbursement (the supplied CLM-9 is a reimbursement), PRE-n for a pre-authorization. */
export async function nextEventRef(intent: Intent | "appeal"): Promise<string> {
  const prefix = intent === "preauth" ? "PRE" : intent === "appeal" ? "APP" : "CLM";
  const rows = await db.select({ ref: servicingEvent.externalRef }).from(servicingEvent).where(like(servicingEvent.externalRef, `${prefix}-%`));
  const max = rows.reduce((m, r) => Math.max(m, Number(r.ref?.slice(prefix.length + 1)) || 0), 0);
  return `${prefix}-${max + 1}`;
}

/** A declared condition, in the member's own words: the coded name when there is one, what they typed otherwise. */
const conditionName = (c: { code: string | null; raw: string }) => (c.code ? c.code.replace(/_/g, " ") : c.raw.replace(/\s*\(.*\)\s*$/, "").trim());

// ---------------------------------------------------------------------------
// Loading a turn's context — every value from a row, none from memory
// ---------------------------------------------------------------------------

/** The finding an appeal contests has changed under it (an advisor got there first): there is nothing left to argue with. */
class AppealGone extends Error {
  constructor(readonly exit: AppealExit) {
    super(`the contested decision is no longer appealable: ${exit}`);
  }
}

export type LoadedTurn = {
  convo: typeof conversation.$inferSelect;
  policyRow: typeof policy.$inferSelect;
  state: ServicingSessionState;
  ctx: ServicingToolContext;
  transcript: { role: "member" | "assistant"; text: string }[];
};

/** The member's own servicing conversation, or null. Never anyone else's. */
async function ownConversation(conversationId: string, userId: string) {
  const [convo] = await db.select().from(conversation).where(eq(conversation.id, conversationId)).limit(1);
  if (!convo || convo.purpose !== "servicing" || convo.userId !== userId || !convo.policyId) return null;
  return convo;
}

async function loadTurn(convo: typeof conversation.$inferSelect, state: ServicingSessionState, deps: ServicingDeps): Promise<LoadedTurn> {
  const [policyRow] = await db.select().from(policy).where(eq(policy.id, convo.policyId!)).limit(1);
  const plans = (await db.select().from(plan)).map(planRowToTerms);
  const planTerms = plans.find((p) => p.id === policyRow.planId)!;
  const replayed = await replayPolicy(policyRow.id);

  const refOf = new Map(replayed.stored.map((r) => [r.id, r.externalRef ?? r.id.slice(0, 8)]));
  const history: HistoryItem[] = replayed.stored.map((r) => ({
    ref: r.externalRef ?? r.id.slice(0, 8),
    kind: r.kind,
    policyMonth: r.policyMonth,
    benefitClass: r.benefitClass,
    outcome: r.outcome,
    reasonCode: r.reasonCode,
    planPays: r.planPays === null ? null : Number(r.planPays),
    memberPays: r.memberPays === null ? null : Number(r.memberPays),
    supersedes: r.supersedesEventId ? (refOf.get(r.supersedesEventId) ?? null) : null,
    description: r.description,
  }));

  // What the member declared at intake — so it is never asked again.
  const declared = await db
    .select({ code: applicationCondition.conditionCode, raw: applicationCondition.rawText, stability: applicationCondition.stability })
    .from(applicationCondition)
    .where(and(eq(applicationCondition.applicationId, policyRow.applicationId), eq(applicationCondition.declaredAtIntake, true)));

  const messages = await db.select().from(message).where(eq(message.conversationId, convo.id)).orderBy(message.seq);
  const transcript = messages
    .filter((m) => m.bodyText)
    .map((m) => ({ role: (m.role === "applicant" ? "member" : "assistant") as "member" | "assistant", text: m.bodyText! }));

  const ctx = createServicingContext({
    policy: { id: policyRow.id, ref: policyRow.externalRef ?? policyRow.policyNumber, inceptionDate: policyRow.inceptionDate, status: policyRow.status },
    plan: planTerms,
    catalogue: plans,
    ledger: replayed.ledger,
    history,
    applicant: { conditions: declared.map((c) => ({ name: conditionName(c), stability: c.stability })) },
    today: todayISO(deps),
    eventRef: state.eventRef,
    limits: readLimits(),
    // A COPY. The tools mutate the draft in place, and `changedFacts` compares it with the state this turn started
    // from — hold the same object and every fact compares equal to itself, and no provenance is ever written.
    draft: structuredClone(state.draft),
  });
  if (state.appeal) {
    // An appeal's context is rebuilt from the LOG every turn: the contested row, the whole history for re-adjudication,
    // and the finding as the engine originally decided it. Nothing about the finding is remembered from an earlier turn.
    const row = contestedRowOf(replayed.stored, state.appeal.contestedEventId, await pendingOverturnEventIds());
    const found = row ? identifyContested({ ...row, appealedBy: row.appealedBy === "pending" || row.appealedBy === null ? null : row.appealedBy }) : null;
    if (!row || !found?.ok) throw new AppealGone(found && !found.ok ? found.exit : "superseded");
    const original = reAdjudicate({
      plan: planTerms,
      events: replayed.events,
      contestedId: row.id,
      patch: found.contested.admissibility.turnsOn === "provider_tier" ? { field: "provider_tier", value: row.providerTier! } : { field: "benefit_class", value: row.benefitClass! },
      policyStatus: policyRow.status,
      original: { outcome: row.outcome, planPays: row.planPays },
    }).result;
    ctx.appeal = {
      state: structuredClone(state.appeal),
      contested: found.contested,
      events: replayed.events,
      original,
      declaredAtIntake: row.benefitClass === "chronic_preexisting" && declared.length > 0,
      appealRef: state.eventRef,
      result: null,
    };
    ctx.evidenceRequestCount = state.appeal.requested.length;
  }
  ctx.memberMessages = messages.filter((m) => m.role === "applicant" && m.bodyText).map((m) => m.bodyText!);
  ctx.openQuestion = state.openQuestion;
  ctx.awaitingConfirmation = state.awaitingConfirmation;
  ctx.providerUnsure = state.providerUnsure;
  ctx.clarificationCount = state.clarificationCount;
  return { convo, policyRow, state, ctx, transcript };
}

const stateFromContext = (ctx: ServicingToolContext, prev: ServicingSessionState, patch: Partial<Pick<ServicingSessionState, "phase" | "committedEventId" | "eventRef" | "changing">> = {}): ServicingSessionState => ({
  ...prev,
  draft: ctx.draft,
  openQuestion: ctx.openQuestion,
  awaitingConfirmation: ctx.awaitingConfirmation,
  providerUnsure: ctx.providerUnsure,
  clarificationCount: ctx.clarificationCount,
  appeal: ctx.appeal ? ctx.appeal.state : prev.appeal,
  ...patch,
});

// ---------------------------------------------------------------------------
// Opening a conversation
// ---------------------------------------------------------------------------

const OPENING: Record<Intent, string> = {
  claim: "Tell me about the treatment. I already have your plan and what you've used so far, so I'll only ask for what I'm missing.",
  preauth: "Tell me about the treatment you're planning. I already have your plan and what you've used so far, so I'll only ask for what I'm missing.",
};

export type OpenResult = { ok: true; conversationId: string } | { ok: false; reason: "not_found" } | { ok: false; reason: "not_yet_active"; inceptionDate: string };

export async function openServicing(input: { userId: string; policyId: string; intent: Intent }, deps: ServicingDeps = {}): Promise<OpenResult> {
  const [row] = await db
    .select({ policy, ownerUserId: person.ownerUserId })
    .from(policy)
    .innerJoin(person, eq(policy.personId, person.id))
    .where(eq(policy.id, input.policyId))
    .limit(1);
  // A member opens a conversation on their OWN cover. Anyone else's is simply not found.
  if (!row || row.ownerUserId !== input.userId) return { ok: false, reason: "not_found" };
  // A policy month is a count of months elapsed SINCE inception (dates.ts `monthOfDate`), and refuses a negative
  // one rather than guess — correctly, since a claim before cover starts has no policy month at all. But nothing
  // upstream of here stopped a member reaching the chat for a policy whose inception is still in the future (ISO
  // strings compare lexicographically, so a plain `<` is exact): the graph's own opening line asks for "the
  // current policy month" and throws before a single message is even read. Refuse cleanly here instead — the
  // member is told when cover starts, not shown a stack trace and a "try again" that can never succeed.
  if (todayISO(deps) < row.policy.inceptionDate) return { ok: false, reason: "not_yet_active", inceptionDate: row.policy.inceptionDate };

  const [convo] = await db
    .insert(conversation)
    .values({ channel: "web_chat", purpose: "servicing", status: "awaiting_user", userId: input.userId, personId: row.policy.personId, policyId: row.policy.id, lastOutboundAt: new Date() })
    .returning();

  const state = initialSessionState(input.intent, await nextEventRef(input.intent));
  await writeState(convo.id, state, input.userId);

  if (deps.decide) {
    // With a model, the member simply starts typing.
    await postAssistant(convo.id, { text: OPENING[input.intent], card: null });
  } else {
    // With none, free text cannot be read, so the conversation opens on the form. The same sentence, and
    // then exactly the fields that are missing.
    await postAssistant(convo.id, { text: "Let's get the details. I already have your plan and what you've used so far, so I'll only ask for what I'm missing.", card: null });
    const loaded = await loadTurn(convo, state, deps);
    const result = await runServicingTurn({ ctx: loaded.ctx, input: { kind: "text", text: "" }, transcript: loaded.transcript, changing: false });
    await persistTurn(loaded, result, { userId: input.userId, inboundId: null, deps });
  }
  return { ok: true, conversationId: convo.id };
}

// ---------------------------------------------------------------------------
// Opening an appeal
// ---------------------------------------------------------------------------

export type OpenAppealResult = { ok: true; conversationId: string; resumed: boolean } | { ok: false; reason: "not_found" | AppealExit; message: string };

/**
 * Begin an appeal of ONE decision on the member's own policy. Whether the decision can be appealed at all is read from
 * the log — never from what the member says about it — and the five things that are not appeals (§5.4.1) each refuse
 * here with a reason a member can read, before any conversation exists.
 */
export async function openAppeal(input: { userId: string; policyId: string; eventId: string }, deps: ServicingDeps = {}): Promise<OpenAppealResult> {
  const [row] = await db
    .select({ policy, ownerUserId: person.ownerUserId })
    .from(policy)
    .innerJoin(person, eq(policy.personId, person.id))
    .where(eq(policy.id, input.policyId))
    .limit(1);
  if (!row || row.ownerUserId !== input.userId) return { ok: false, reason: "not_found", message: "We couldn't find that." };

  // A second tap resumes the appeal already open on this decision. One appeal per denial.
  const existing = await openAppealFor(input.policyId, input.eventId);
  if (existing) return { ok: true, conversationId: existing, resumed: true };

  const checked = await checkAppealable(input.policyId, input.eventId);
  if (!checked.ok) return checked.exit === "not_found" ? { ok: false, reason: "not_found", message: "We couldn't find that." } : { ok: false, reason: checked.exit, message: APPEAL_EXIT_TEXT[checked.exit] };
  const { contested } = checked;

  const [convo] = await db
    .insert(conversation)
    .values({ channel: "web_chat", purpose: "servicing", status: "awaiting_user", userId: input.userId, personId: row.policy.personId, policyId: row.policy.id, lastOutboundAt: new Date() })
    .returning();

  const state: ServicingSessionState = {
    ...initialSessionState("claim", await nextEventRef("appeal"), {
      contestedEventId: contested.row.id,
      contestedRef: contested.row.ref,
      contestedReason: contested.reason,
      evidence: [],
      assessments: [],
      supplied: [],
      declined: [],
      requested: [],
      openRequest: null,
      pendingCorrection: null,
      begun: false,
    }),
    intent: "appeal",
  };
  await writeState(convo.id, state, input.userId);

  // The opening turn is deterministic in both modes: say what the decision turned on and what could change it, then
  // ask for the most likely document. No model is needed to do that, and none is asked.
  const loaded = await loadTurn(convo, state, deps);
  const result = await runServicingTurn({ ctx: loaded.ctx, input: { kind: "text", text: "" }, transcript: loaded.transcript, changing: false });
  await persistTurn(loaded, result, { userId: input.userId, inboundId: null, deps });
  return { ok: true, conversationId: convo.id, resumed: false };
}

// ---------------------------------------------------------------------------
// One member turn
// ---------------------------------------------------------------------------

export type TurnOutcome =
  | { ok: true; ignored?: false; status: "awaiting_user" | "completed" | "escalated" | "awaiting_review"; eventRef: string | null }
  | { ok: true; ignored: true }
  | { ok: false; reason: "not_found" | "closed" };

/** Is this act still an answer to something? A double-tapped chip must not become a second answer. */
function applicable(input: ServicingInput, state: ServicingSessionState): boolean {
  switch (input.kind) {
    case "chip":
      return state.openQuestion === input.fieldKey;
    case "conflict":
      return state.openQuestion === input.fieldKey && state.draft.conflicts.some((c) => c.fieldKey === input.fieldKey && !c.resolved);
    case "confirm":
    case "change":
      return state.awaitingConfirmation;
    case "decline_evidence":
      // "I don't have this" answers a request that is on screen — a second tap answers nothing.
      return state.appeal?.openRequest != null;
    default:
      return true;
  }
}

/** The member writing to their advisor. No graph, no model: a person will read it — the queue row says the member replied. */
async function writeToAdvisor(convo: typeof conversation.$inferSelect, text: string): Promise<TurnOutcome> {
  await postInbound(convo.id, text.slice(0, 4000), { kind: "servicing_answer", fieldKey: "to_advisor" });
  return { ok: true, status: "escalated", eventRef: null };
}

export async function handleServicingInput(conversationId: string, userId: string, input: ServicingInput, deps: ServicingDeps = {}): Promise<TurnOutcome> {
  const convo = await ownConversation(conversationId, userId);
  if (!convo) return { ok: false, reason: "not_found" };
  // A finished or handed-over conversation takes no more turns — except a request for a person.
  // A reversal waiting on a signature is closed to the member too: there is nothing for them to add until it is decided.
  if (convo.status === "completed") return { ok: false, reason: "closed" };
  // With an advisor: it is a HUMAN thread now. The member may write to their advisor, and asking for one again is a no-op —
  // the case is already with a person, and a second tap must not raise a second task or post the hand-off a second time.
  if (convo.status === "escalated") {
    if (input.kind === "advisor") return { ok: true, ignored: true };
    if (input.kind === "text" && input.text.trim()) return writeToAdvisor(convo, input.text.trim());
    return { ok: false, reason: "closed" };
  }
  // A reversal waiting on a signature is closed to the member too: there is nothing for them to add until it is decided.
  if (convo.status === "awaiting_review" && input.kind !== "advisor") return { ok: false, reason: "closed" };

  const state = await latestState(conversationId);
  // A state that will not parse is not an empty conversation. Refuse rather than adjudicate against a draft nobody validated.
  if (!state) return { ok: false, reason: "not_found" };
  if (!applicable(input, state)) return { ok: true, ignored: true };

  // What the member appears to have said, in the thread — and, for a form, what every later quote is checked against.
  const [policyRow] = await db.select().from(policy).where(eq(policy.id, convo.policyId!)).limit(1);
  // Defense in depth for a conversation `openServicing`'s own guard predates (or a policy edited after opening):
  // the graph's opening line asks for "the current policy month" and throws before reading a message if cover has
  // not started yet — and every retry would throw again, forever, since "today" does not move within a session.
  // Refuse cleanly and close, rather than let the generic catch below tell the member to try again.
  if (policyRow && todayISO(deps) < policyRow.inceptionDate) {
    await postAssistant(conversationId, { text: `Your cover starts on ${longDate(policyRow.inceptionDate)} — nothing can be claimed or checked before then. Please come back once it has started.`, card: null });
    await db.update(conversation).set({ status: "completed", closedAt: new Date() }).where(eq(conversation.id, conversationId));
    return { ok: true, status: "completed", eventRef: null };
  }
  let bodyText: string;
  let payload: unknown = null;
  switch (input.kind) {
    case "text":
      bodyText = input.text.trim();
      if (!bodyText) return { ok: true, ignored: true };
      break;
    case "chip":
    case "conflict":
      bodyText = input.label;
      payload = { kind: "servicing_answer", fieldKey: input.fieldKey, value: input.value };
      break;
    case "confirm":
      bodyText = "Looks right";
      payload = { kind: "servicing_answer", fieldKey: "confirm" };
      break;
    case "change":
      bodyText = "Change something";
      payload = { kind: "servicing_answer", fieldKey: "change" };
      break;
    case "advisor":
      bodyText = "I'd like to talk to an advisor.";
      payload = { kind: "servicing_answer", fieldKey: "advisor" };
      break;
    case "decline_evidence":
      bodyText = "I don't have this";
      payload = { kind: "servicing_answer", fieldKey: "decline_evidence" };
      break;
    case "form": {
      const declared = await db
        .select({ code: applicationCondition.conditionCode, raw: applicationCondition.rawText })
        .from(applicationCondition)
        .where(and(eq(applicationCondition.applicationId, policyRow.applicationId), eq(applicationCondition.declaredAtIntake, true)));
      if (state.intent === "appeal") return { ok: true, ignored: true };
      const reading = interpretForm(input.values, { intent: state.intent, inceptionDate: policyRow.inceptionDate, today: todayISO(deps), declaredConditions: declared.map(conditionName) });
      bodyText = reading.summary || "(no details given)";
      payload = { kind: "servicing_answer", fieldKey: "form" };
      break;
    }
  }

  await db.update(conversation).set({ status: "active" }).where(eq(conversation.id, conversationId));
  const inbound = await postInbound(conversationId, bodyText, payload);

  let loaded: LoadedTurn;
  try {
    loaded = await loadTurn(convo, state, deps);
  } catch (error) {
    if (!(error instanceof AppealGone)) throw error;
    // An advisor got to the decision first. Say so, and close: there is nothing left to argue with.
    await postAssistant(conversationId, { text: APPEAL_EXIT_TEXT[error.exit], card: null });
    await db.update(conversation).set({ status: "completed", closedAt: new Date() }).where(eq(conversation.id, conversationId));
    return { ok: true, status: "completed", eventRef: null };
  }
  let result: ServicingTurnResult;
  try {
    result = await runServicingTurn({ ctx: loaded.ctx, input, transcript: loaded.transcript, decide: deps.decide, changing: state.changing });
  } catch (error) {
    // Unexpected. The member's message is recorded and the state is untouched, so nothing is lost and a retry is safe.
    console.error("servicing turn failed", error);
    await postAssistant(conversationId, { text: "Something went wrong on our side. Your details are saved — please try again in a moment.", card: null });
    await db.update(conversation).set({ status: "awaiting_user" }).where(eq(conversation.id, conversationId));
    return { ok: true, status: "awaiting_user", eventRef: null };
  }
  return persistTurn(loaded, result, { userId, inboundId: inbound.id, deps });
}

// ---------------------------------------------------------------------------
// Writing what a turn produced
// ---------------------------------------------------------------------------

async function persistTurn(
  loaded: LoadedTurn,
  result: ServicingTurnResult,
  ctxInfo: { userId: string; inboundId: string | null; deps: ServicingDeps },
): Promise<TurnOutcome & { ok: true; ignored?: false }> {
  const { convo, state: prev } = loaded;
  const ctx = result.ctx!;
  const turn = result.turn!;
  const plan = result.plan;

  // 1. Provenance: which sentence became which field.
  for (const { key, fact } of changedFacts(prev.draft, ctx.draft)) {
    await db.insert(extraction).values({
      conversationId: convo.id,
      messageId: ctxInfo.inboundId,
      fieldKey: `servicing.${key}`,
      targetTable: "servicing_draft",
      targetColumn: key,
      targetRowId: convo.id,
      rawSpan: fact.quote,
      valueText: String(fact.value),
      method: fact.source === "inferred" ? "inferred" : "stated",
    });
  }

  // 2. The mechanical call, when there was one. Never the transcript itself — it is health information.
  if (turn.modelUsed) {
    await db.insert(modelRun).values({
      purpose: "servicing_agent",
      provider: ctxInfo.deps.provider ?? PROVIDER,
      modelId: turn.servedBy ?? "unknown",
      promptVersion: PROMPT_VERSION,
      request: { conversationId: convo.id, messageId: ctxInfo.inboundId },
      response: { steps: turn.trace.map((t) => ({ step: t.step, tool: t.tool, validation: t.validation, latencyMs: t.latencyMs })), fellBackTo: turn.fellBackTo },
      latencyMs: turn.latencyMs,
      status: turn.fellBackTo ? "error" : "ok",
      errorText: turn.fellBackTo,
    });
  }

  // 3. The commit — BEFORE the card that reports it. Nothing is shown that is not already recorded.
  let eventRef: string | null = null;
  let committedEventId: string | null = null;
  if (plan) {
    const written = await serialised(() => writePlan(loaded, plan, ctxInfo.userId, todayISO(ctxInfo.deps)));
    eventRef = written.eventRef;
    committedEventId = written.eventId;
    // A reference can be re-issued at commit if another conversation took it; the broker's prose must follow.
    if (written.renamedFrom && turn.terminal?.kind === "outcome") turn.terminal.brokerExplanation = turn.terminal.brokerExplanation.replaceAll(written.renamedFrom, written.eventRef!);
    if (written.renamedFrom && turn.terminal?.kind === "appeal_upheld") turn.terminal.draft.brokerExplanation = turn.terminal.draft.brokerExplanation.replaceAll(written.renamedFrom, written.eventRef!);
  }

  // 4. What the member sees.
  for (const m of turn.messages) await postAssistant(convo.id, m);

  // 5. The state, and where the conversation now stands.
  const phase = plan?.kind === "commit" || plan?.kind === "appeal_upheld" ? "done" : plan?.kind === "escalate" ? "escalated" : plan?.kind === "appeal_overturn" ? "awaiting_signoff" : "collecting";
  await writeState(convo.id, stateFromContext(ctx, prev, { phase, committedEventId: committedEventId ?? prev.committedEventId, eventRef: eventRef ?? prev.eventRef, changing: result.changing ?? false }), ctxInfo.userId);
  const status = plan?.kind === "commit" || plan?.kind === "appeal_upheld" ? "completed" : plan?.kind === "escalate" ? "escalated" : plan?.kind === "appeal_overturn" ? "awaiting_review" : "awaiting_user";
  await db.update(conversation).set({ status, ...(status === "completed" ? { closedAt: new Date() } : {}) }).where(eq(conversation.id, convo.id));

  // 6. Reassess, after the record is settled — never for a forecast (§5.5, §17: "pre-auths do not commit").
  if (committedEventId && ((plan?.kind === "commit" && plan.event.kind !== "preauth") || plan?.kind === "appeal_upheld")) {
    await reassessAfterEvent(ctx.policy.id, committedEventId);
  }

  // 7. Open a payout if this decision owes one (§payouts). `openSettlementForEvent` decides that from the LOG,
  //    not from `plan`, so a pre-authorization, a denial and an undecidable case all correctly open nothing.
  if (committedEventId) await openSettlementForEvent(ctx.policy.id, committedEventId);
  return { ok: true, status, eventRef };
}

/** The event row, the ledger it moves, and — for a hand-off — the task that puts it in front of a person. */
async function writePlan(loaded: LoadedTurn, plan: NonNullable<ServicingTurnResult["plan"]>, userId: string, today: string): Promise<{ eventId: string | null; eventRef: string | null; renamedFrom: string | null }> {
  const { convo, policyRow, state } = loaded;
  await db.run(sql`begin`);
  try {
    let eventId: string | null = null;
    let eventRef: string | null = null;
    let renamedFrom: string | null = null;

    if (plan.kind === "appeal_upheld") {
      const d = plan.draft;
      eventRef = state.eventRef;
      const [taken] = await db.select({ id: servicingEvent.id }).from(servicingEvent).where(eq(servicingEvent.externalRef, eventRef)).limit(1);
      if (taken) {
        renamedFrom = eventRef;
        eventRef = await nextEventRef("appeal");
      }
      const [row] = await db
        .insert(servicingEvent)
        .values({
          externalRef: eventRef,
          policyId: policyRow.id,
          kind: "appeal",
          policyMonth: d.policyMonth,
          benefitClass: d.benefitClass,
          providerTier: d.providerTier,
          geography: d.geography,
          billedAmount: d.billedAmount,
          description: d.description,
          evidenceText: d.evidenceText,
          submittedByUserId: userId,
          occurredOn: today,
          outcome: d.outcome,
          reasonCode: d.reasonCode,
          planPays: d.planPays,
          memberPays: d.memberPays,
          calculation: d.calculation,
          ledgerBefore: d.ledgerBefore,
          ledgerAfter: d.ledgerAfter,
          memberExplanation: d.memberExplanation,
          brokerExplanation: renamedFrom ? d.brokerExplanation.replaceAll(renamedFrom, eventRef) : d.brokerExplanation,
          confidence: d.confidence,
          uncertaintyReason: d.uncertaintyReason,
          decidedBy: "system",
          appealOfEventId: d.contestedEventId,
        })
        .returning({ id: servicingEvent.id });
      eventId = row.id;
      if (d.uncertaintyReason && d.confidence < 0.9) {
        // An upheld appeal that rested on a judgment call — APP-1 is the case: it blocks nothing, and it is not invisible.
        await db.insert(reviewTask).values({ subjectType: "servicing_event", subjectId: eventId, reason: `Quality check: ${eventRef} — ${d.uncertaintyReason}`, priorityScore: QUALITY_CHECK_PRIORITY, status: "open" });
      }
      // An upheld appeal has no effect on the fold, so this changes nothing — but the ledger only ever changes here.
      await rebuildLedger(policyRow.id);
      await db.run(sql`commit`);
      return { eventId, eventRef, renamedFrom };
    }

    if (plan.kind === "appeal_overturn") {
      // NOTHING is appended to the log: an overturn moves money and rewrites the ledger at a past point, so it takes a
      // signature. What is written is the proposal — the finished row plus the working — and the task that puts it in
      // front of a person. The contested row is still the standing decision until they sign.
      const d = plan.draft;
      const proposal = {
        version: 1 as const,
        conversationId: convo.id,
        contestedEventId: d.contestedEventId,
        contestedRef: d.contestedRef,
        contestedReason: state.appeal!.contestedReason,
        evidenceKind: plan.evidenceKind,
        correction: plan.correction,
        evidence: plan.evidence,
        original: { outcome: loaded.ctx.appeal!.contested.row.outcome, planPays: loaded.ctx.appeal!.contested.row.planPays, memberPays: loaded.ctx.appeal!.contested.row.memberPays },
        ledgerBeforeContested: ledgerToJson(plan.ledgerBeforeContested),
        draft: d,
        trace: plan.trace.map((t) => ({ step: t.step, thought: t.thought, tool: t.tool, args: t.args ?? undefined, validation: t.validation, observation: t.observation, latencyMs: t.latencyMs })),
        proposedAt: new Date().toISOString(),
      };
      await db.insert(conversationAction).values({
        conversationId: convo.id,
        actionType: "appeal_overturn_proposal",
        arguments: proposal,
        subjectType: "servicing_event",
        subjectId: d.contestedEventId,
        status: "pending",
        actorKind: "system",
        actorUserId: userId,
      });
      await db.insert(reviewTask).values({
        subjectType: "servicing_event",
        subjectId: d.contestedEventId,
        reason: `Appeal overturn ready to sign: ${d.contestedRef} reverses to a payment of AED ${(d.planPays ?? 0).toLocaleString("en")}.`,
        priorityScore: plan.priorityScore,
        status: "open",
      });
      await db.run(sql`commit`);
      return { eventId: null, eventRef: null, renamedFrom: null };
    }

    const draft: EventDraft | null = plan.event;
    if (draft) {
      eventRef = state.eventRef;
      const [taken] = await db.select({ id: servicingEvent.id }).from(servicingEvent).where(eq(servicingEvent.externalRef, eventRef)).limit(1);
      if (taken) {
        renamedFrom = eventRef;
        eventRef = await nextEventRef(draft.kind === "preauth" ? "preauth" : "claim");
      }
      const [row] = await db
        .insert(servicingEvent)
        .values({
          externalRef: eventRef,
          policyId: policyRow.id,
          kind: draft.kind,
          policyMonth: draft.policyMonth,
          benefitClass: draft.benefitClass,
          providerTier: draft.providerTier,
          geography: draft.geography,
          billedAmount: draft.billedAmount,
          estimatedAmount: draft.estimatedAmount,
          description: draft.description,
          submittedByUserId: userId,
          occurredOn: draft.occurredOn,
          outcome: draft.outcome,
          reasonCode: draft.reasonCode,
          planPays: draft.planPays,
          memberPays: draft.memberPays,
          calculation: draft.calculation,
          ledgerBefore: draft.ledgerBefore,
          ledgerAfter: draft.ledgerAfter,
          memberExplanation: draft.memberExplanation,
          brokerExplanation: renamedFrom ? draft.brokerExplanation.replaceAll(renamedFrom, eventRef) : draft.brokerExplanation,
          confidence: draft.confidence,
          uncertaintyReason: draft.uncertaintyReason,
          decidedBy: "system",
        })
        .returning({ id: servicingEvent.id });
      eventId = row.id;
      // The only writer of benefit_ledger: replay the log, write the projection.
      await rebuildLedger(policyRow.id);
    }

    // A close call that still resolved is worth a look: it goes to the queue as a QUALITY CHECK (plan §12.2, band 40), and
    // blocks nothing. A clean claim never gets here — its absence from the queue IS its confidence signal.
    if (plan.kind === "commit" && eventId && draft?.uncertaintyReason && draft.confidence !== null && draft.confidence < 0.9) {
      await db.insert(reviewTask).values({ subjectType: "servicing_event", subjectId: eventId, reason: `Quality check: ${eventRef} — ${draft.uncertaintyReason}`, priorityScore: QUALITY_CHECK_PRIORITY, status: "open" });
    }

    if (plan.kind === "escalate") {
      // The cause is a BROKER's fact and is kept where the queue and the dashboard can count it (plan §13.3.5) — never on a card.
      await db.insert(conversationAction).values({
        conversationId: convo.id,
        actionType: "escalated",
        arguments: { cause: plan.cause, reference: eventRef ?? state.eventRef },
        subjectType: "conversation",
        subjectId: convo.id,
        status: "succeeded",
        actorKind: "system",
        actorUserId: userId,
        completedAt: new Date(),
      });
      await db.insert(reviewTask).values({
        subjectType: eventId ? "servicing_event" : "conversation",
        subjectId: eventId ?? convo.id,
        reason: renamedFrom && eventRef ? plan.reason.replaceAll(renamedFrom, eventRef) : plan.reason,
        priorityScore: plan.priorityScore,
        status: "open",
      });
    }
    await db.run(sql`commit`);
    return { eventId, eventRef, renamedFrom };
  } catch (error) {
    await db.run(sql`rollback`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Callback request (the escalation card's second button)
// ---------------------------------------------------------------------------

export async function requestCallback(conversationId: string, userId: string, request: { window: "morning" | "afternoon" | "evening"; phone: string }): Promise<{ ok: boolean }> {
  const convo = await ownConversation(conversationId, userId);
  if (!convo || convo.status !== "escalated") return { ok: false };
  await db.insert(conversationAction).values({
    conversationId,
    actionType: "callback_requested",
    arguments: { window: request.window, phone: request.phone.trim() },
    subjectType: "conversation",
    subjectId: conversationId,
    status: "succeeded",
    actorKind: "applicant",
    actorUserId: userId,
    completedAt: new Date(),
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Reads for the UI
// ---------------------------------------------------------------------------

/** A member's servicing conversations on one policy that are not finished. */
export async function listOpenServicing(userId: string, policyId?: string) {
  const rows = await db
    .select({ id: conversation.id, status: conversation.status, policyId: conversation.policyId, startedAt: conversation.startedAt })
    .from(conversation)
    .where(and(eq(conversation.userId, userId), eq(conversation.purpose, "servicing"), inArray(conversation.status, ["active", "awaiting_user", "awaiting_review", "escalated"]), ...(policyId ? [eq(conversation.policyId, policyId)] : [])))
    .orderBy(desc(conversation.startedAt));
  const out = [];
  for (const r of rows) {
    const state = await latestState(r.id);
    const [last] = await db.select({ bodyText: message.bodyText }).from(message).where(and(eq(message.conversationId, r.id), eq(message.role, "applicant"))).orderBy(desc(message.seq)).limit(1);
    out.push({ ...r, intent: state?.intent ?? "claim", preview: last?.bodyText ?? null });
  }
  return out;
}

/**
 * Is anything waiting on this member? One cheap query — the root layout runs it on every page for the launcher's dot.
 * Two things wait on them: a question the agent asked (`awaiting_user`), and an advisor's reply they have not answered —
 * the last message in a case that is with a person came from the advisor (plan §13.2.7: the thread is the one place the
 * member ever has to look, and the dot is how they know to).
 */
export async function findWaitingServicing(userId: string): Promise<{ conversationId: string; policyId: string; reason: "question" | "advisor_reply"; /** The advisor message that lit the dot — so a second reply toasts again. */ messageId: string | null } | null> {
  const [row] = await db
    .select({ id: conversation.id, policyId: conversation.policyId })
    .from(conversation)
    .where(and(eq(conversation.userId, userId), eq(conversation.purpose, "servicing"), eq(conversation.status, "awaiting_user")))
    .orderBy(desc(conversation.lastOutboundAt))
    .limit(1);
  if (row?.policyId) return { conversationId: row.id, policyId: row.policyId, reason: "question", messageId: null };

  const withAdvisor = await db
    .select({ id: conversation.id, policyId: conversation.policyId })
    .from(conversation)
    .where(and(eq(conversation.userId, userId), eq(conversation.purpose, "servicing"), eq(conversation.status, "escalated")))
    .orderBy(desc(conversation.lastOutboundAt));
  for (const c of withAdvisor) {
    const [last] = await db.select({ role: message.role, id: message.id }).from(message).where(eq(message.conversationId, c.id)).orderBy(desc(message.seq)).limit(1);
    if (last?.role === "advisor" && c.policyId) return { conversationId: c.id, policyId: c.policyId, reason: "advisor_reply", messageId: last.id };
  }
  return null;
}

/** An advisor's message, in the member's own thread. Who wrote it is on the `review_decision` that caused it. */
export async function postAdvisor(conversationId: string, text: string) {
  await db.insert(message).values({
    conversationId,
    seq: await nextSeq(conversationId),
    direction: "outbound",
    role: "advisor",
    type: "text",
    bodyText: text,
    payload: null,
    provider: PROVIDER,
    deliveryStatus: "delivered",
    providerTimestamp: new Date(),
  });
  await db.update(conversation).set({ lastOutboundAt: new Date() }).where(eq(conversation.id, conversationId));
}

export type ThreadMessage = { id: string; /** Who spoke. Not a user role — the thread has no idea who is looking. */ from: "member" | "assistant" | "advisor"; text: string; card: unknown; answerKind: string | null };

/** Everything the thread renders, for a conversation the caller owns. Null when it is not theirs. */
export async function readServicingThread(conversationId: string, userId: string) {
  const convo = await ownConversation(conversationId, userId);
  if (!convo || !convo.policyId) return null;
  const rows = await db.select().from(message).where(eq(message.conversationId, conversationId)).orderBy(asc(message.seq));
  const state = await latestState(conversationId);
  const [callback] = await db.select({ id: conversationAction.id }).from(conversationAction).where(and(eq(conversationAction.conversationId, conversationId), eq(conversationAction.actionType, "callback_requested"))).limit(1);
  const messages: ThreadMessage[] = rows.map((m) => ({
    id: m.id,
    from: m.role === "applicant" ? "member" : m.role === "advisor" ? "advisor" : "assistant",
    text: m.bodyText ?? "",
    card: m.role === "applicant" ? null : m.payload,
    answerKind: m.role === "applicant" && m.payload && typeof m.payload === "object" ? ((m.payload as { fieldKey?: string }).fieldKey ?? null) : null,
  }));
  return {
    conversationId,
    policyId: convo.policyId,
    status: convo.status,
    intent: state?.intent ?? ("claim" as Intent | "appeal"),
    /** The event this conversation wrote — what an outcome card's "Appeal this decision" contests. */
    committedEventId: state?.committedEventId ?? null,
    callbackRequested: Boolean(callback),
    messages,
  };
}

export { isServicingCard };
