// The servicing graph's nodes (docs/servicing_agent_plan.md §10).
//
//   processResponse  what the member just DID — a chip, a form, "Looks right" — folded into the draft.
//                    Deterministic, and it goes through the same `record_fact` a model's call does, so both
//                    modes adjudicate the same thing.
//   agent            the loop: understand → check what is missing → ask ONE thing → confirm → adjudicate →
//                    explain. A model drives it through the tool registry when there is one; when there is
//                    none, or it fails, a deterministic driver takes over from wherever the draft stands.
//   wait             the turn ends here and the member owns the next move (an interrupt).
//   gate / commit    route a finished conversation, and decide WHAT is written (the session writes it).
//   escalate         a hand-off, and what it leaves behind.
//
// The model is injected (`decide`), never imported: this file has no `server-only`, so a script can run the
// whole graph with a scripted decider, which is how the loop and its failure paths are tested.
//
// The rule that shapes the loop: a model failure never produces a wrong number. It produces a form.

import { interrupt } from "@langchain/langgraph";
import type { ServicingStateType } from "@/lib/ai/graph/state";
import { describeServicingTools, runServicingTool, TOOL_NAMES, type ServicingToolContext, type ServicingToolResult } from "@/lib/ai/tools/servicing";
import { benefitClassOptions, factsFormCard, interpretForm, monthOfDate, type AppealEventDraft, type Correction, type EvidenceKind, type LedgerState, type ServicingCard } from "@/lib/servicing";
import { appealOutcomeCard } from "@/lib/servicing/appeal-commit";
import { ESCALATION_MEANING, type EscalationCause } from "@/lib/servicing/escalation";
import { completeness, FIELD_KEYS, kindOf, OPTIONAL_FIELDS, type FieldKey } from "@/lib/servicing/facts";
import { buildEventDraft, type Confidence, type EventDraft } from "@/lib/servicing/commit";

// ---------------------------------------------------------------------------
// Types shared with the session
// ---------------------------------------------------------------------------

/** What the member did this turn. */
export type ServicingInput =
  | { kind: "text"; text: string }
  | { kind: "chip"; fieldKey: FieldKey; value: string; label: string }
  | { kind: "conflict"; fieldKey: FieldKey; value: string; label: string }
  | { kind: "confirm" }
  | { kind: "change" }
  | { kind: "form"; values: Record<string, string> }
  /** An appeal: "I don't have this" — a real answer, which feeds the set difference of plan §5.4.3. */
  | { kind: "decline_evidence" }
  | { kind: "advisor" };

export type Decision = { thought: string; tool: string; args?: unknown };

/** The model, as the loop sees it. Production builds one from `structuredCall`; a script supplies its own. */
export type ServicingDecider = (input: { system: string; user: string }) => Promise<{ decision: Decision; servedBy: string | null; latencyMs: number }>;

export type TraceStep = { step: number; thought: string; tool: string; args: unknown; validation: string; observation: string; latencyMs: number };

export type TurnMessage = { text: string; card: ServicingCard | null };

export type Terminal =
  | { kind: "outcome"; memberExplanation: string; brokerExplanation: string; confidence: Confidence; uncertaintyReason: string | null }
  | { kind: "escalation"; cause: EscalationCause; note: string | null; memberMessage: string | null; reference: string }
  /** The appeal ends: nothing admissible remains, or the corrected re-adjudication does not help. Written at once. */
  | { kind: "appeal_upheld"; draft: AppealEventDraft }
  /** The engine would pay on the corrected input. NOT written: a person signs an overturn. */
  | { kind: "appeal_overturn"; draft: AppealEventDraft; correction: Correction; evidenceKind: EvidenceKind; ledgerBeforeContested: LedgerState; trace: TraceStep[] };

export type ServicingTurn = {
  /** Posted in order. A message with a card is rendered as the card; the text is what a preview and the transcript use. */
  messages: TurnMessage[];
  terminal: Terminal | null;
  trace: TraceStep[];
  servedBy: string | null;
  latencyMs: number;
  /** Set when a model was available and did not finish the turn; says why. */
  fellBackTo: string | null;
  modelUsed: boolean;
};

/** What the session must write for a finished turn. The graph decides; the session writes. */
export type CommitPlan =
  | { kind: "commit"; event: EventDraft; conversationStatus: "completed" }
  | { kind: "appeal_upheld"; draft: AppealEventDraft; conversationStatus: "completed" }
  | {
      /** Waits for a signature: nothing is appended to the log until a person confirms it. */
      kind: "appeal_overturn";
      draft: AppealEventDraft;
      correction: Correction;
      evidenceKind: EvidenceKind;
      ledgerBeforeContested: LedgerState;
      evidence: string[];
      trace: TraceStep[];
      priorityScore: number;
      conversationStatus: "awaiting_review";
    }
  | {
      kind: "escalate";
      cause: EscalationCause;
      /** Present when the case was adjudicated to `insufficient_data`: the event that records it. */
      event: EventDraft | null;
      reason: string;
      priorityScore: number;
      conversationStatus: "escalated";
    };

// ---------------------------------------------------------------------------
// processResponse — the member's act, folded into the draft
// ---------------------------------------------------------------------------

/** A chip or form value arrives as text; the closed vocabulary decides what it means. */
function coerce(key: FieldKey, raw: string): string | number | boolean {
  if (key === "amount") return Number(raw);
  if (key === "paid_by_member") return raw === "yes" || raw === "true";
  return raw;
}

export function processResponse(state: ServicingStateType): Partial<ServicingStateType> {
  const ctx = state.ctx!;
  const input = state.input;
  const formErrors: ServicingStateType["formErrors"] = {};
  const notes: string[] = [];
  let changing = state.changing;

  switch (input.kind) {
    case "chip": {
      const r = runServicingTool(ctx, "record_fact", { field_key: input.fieldKey, value: coerce(input.fieldKey, input.value), basis: "stated", quote: input.label });
      if (!r.ok) notes.push(`chip ${input.fieldKey}: ${r.error}`);
      break;
    }
    case "conflict": {
      const r = runServicingTool(ctx, "record_fact", { field_key: input.fieldKey, value: coerce(input.fieldKey, input.value), basis: "stated", quote: input.label, resolves_conflict: true });
      if (!r.ok) notes.push(`conflict ${input.fieldKey}: ${r.error}`);
      break;
    }
    case "confirm": {
      ctx.draft.confirmed = true;
      ctx.awaitingConfirmation = false;
      changing = false;
      break;
    }
    case "change": {
      ctx.draft.confirmed = false;
      ctx.awaitingConfirmation = false;
      changing = true;
      break;
    }
    case "form": {
      const reading = interpretForm(input.values, {
        intent: ctx.draft.intent,
        inceptionDate: ctx.policy.inceptionDate,
        today: ctx.today,
        declaredConditions: ctx.applicant.conditions.map((c) => c.name),
      });
      Object.assign(formErrors, reading.errors);
      changing = false;
      for (const e of reading.entries) {
        const r = runServicingTool(ctx, "record_fact", { field_key: e.key, value: e.value, basis: "stated", quote: e.quote });
        if (!r.ok) {
          formErrors[e.key] = "I couldn't use that — please check it and try again.";
          notes.push(`form ${e.key}: ${r.error}`);
        }
      }
      if (reading.benefitClass) {
        const r = runServicingTool(ctx, "classify_benefit", {
          benefit_class: reading.benefitClass.value,
          ...(reading.benefitClass.declaredCondition ? { declared_condition: reading.benefitClass.declaredCondition } : {}),
        });
        if (r.ok && ctx.draft.benefitClass) ctx.draft.benefitClass.by = "member";
        else if (!r.ok) {
          formErrors.benefit_class = "I couldn't use that — please choose again.";
          notes.push(`form benefit_class: ${r.error}`);
        }
      }
      break;
    }
    case "text":
    case "advisor":
      break;
  }
  return { ctx, formErrors, notes, changing };
}

// ---------------------------------------------------------------------------
// agent — the model's loop, and the driver that never fails
// ---------------------------------------------------------------------------

/** Tools whose card means "the member owns the next move". */
export const INTERRUPTING = new Set(["ask_member", "flag_conflict", "confirm_details", "request_evidence"]);
export const MAX_SAME_ERROR = 3;

export const cardText = (card: ServicingCard): string => {
  switch (card.kind) {
    case "servicing_question":
      return card.text;
    case "servicing_confirm":
      return card.title;
    case "servicing_conflict":
      return card.question;
    case "servicing_facts_form":
      return card.intro;
    case "servicing_evidence_request":
      return card.prompt;
    case "servicing_appeal_intro":
      return `You're appealing: ${card.contested.title}. This decision turned on ${card.turnedOn}.`;
    case "servicing_outcome":
    case "servicing_estimate":
      return card.explanation;
    case "servicing_escalation":
      return "Your case is with an advisor.";
  }
};

export const summarise = (r: ServicingToolResult): string => (r.ok ? JSON.stringify(r.data).slice(0, 700) : `ERROR: ${r.error}`);

function systemPrompt(ctx: ServicingToolContext): string {
  const tools = describeServicingTools(ctx);
  return [
    "You are the claims assistant for one health-insurance member, helping with ONE request: a claim or reimbursement for treatment that has happened, or a pre-authorization (\"is this planned treatment covered, and what will it cost me?\").",
    "You are NEVER given plan documents. You have tools; they answer specific questions and they do all the arithmetic. You supply NO numbers of your own — every amount, date and limit you mention must come from a tool's observation.",
    "",
    "TOOLS (call exactly one per turn):",
    ...TOOL_NAMES.map((name) => `- ${name}: ${tools[name]}`),
    "",
    "HOW A CONVERSATION GOES",
    "1. When the member gives details, record EVERY fact they gave with record_fact, quoting their exact words. Give dates as YYYY-MM-DD. A date said as \"last Friday\" is basis \"inferred\".",
    "2. Then call list_missing_facts. If something is missing, ask_member for the ONE most useful missing thing. Never ask for something already known, and never for something derivable (the benefit class, the network, the policy month).",
    "3. The kind of provider is asked with ask_member (it becomes tappable choices). Never guess a provider type from a name.",
    "4. When nothing is missing: read_applicant_record, classify_benefit (an existing condition ONLY if the member declared it), then confirm_details, then STOP and wait — the member must confirm before anything is computed.",
    "5. After the member confirms, call adjudicate, then propose_outcome. If adjudicate returns insufficient_data, call escalate with cause insufficient_data and a member_message instead.",
    "",
    "RULES",
    "- Members read what you write. No internal vocabulary (cohort, risk, flag, review, priority, confidence, override, escalate), no reason codes, no reference numbers, and never promise a time.",
    "- Call ONE tool per turn. If a tool refuses, read why and correct it; the same refusal repeated ends your turn.",
    "- The member and the broker read DIFFERENT explanations: the member's is the verdict, what it costs them, why, and what to do next; the broker's says which policy and event, when, and what it implies.",
    "",
    "ANSWER FORMAT",
    'Return ONE JSON object, nothing else: {"thought": "...", "tool": "...", "args": {...}}',
    "No code fences, no commentary outside the JSON object, and NO <tool_call> tags or other function-calling wrapper — this API does not use one. The tool name and its arguments go inside the JSON object's own \"tool\" and \"args\" fields, exactly as shown above.",
  ].join("\n");
}

function openingLines(ctx: ServicingToolContext, state: ServicingStateType): string[] {
  const lines = [
    `Today is ${ctx.today}. Policy ${ctx.policy.ref} on the ${ctx.plan.name} plan, incepted ${ctx.policy.inceptionDate}; the current policy month is ${monthOfDate(ctx.policy.inceptionDate, ctx.today)}.`,
    `The member's request: ${ctx.draft.intent === "preauth" ? "a pre-authorization (a PLANNED treatment: is it covered, and what would it cost them)" : "a claim or reimbursement for treatment that has ALREADY happened"}.`,
    "Conversation so far:\n" + (state.transcript.length ? state.transcript.map((t) => `${t.role === "member" ? "Member" : "You"}: ${t.text}`).join("\n") : "(nothing yet)"),
  ];
  const what: Record<string, string> = {
    text: "The member just wrote the last message above. Record any facts in it before asking anything.",
    chip: "The member just answered your question by tapping a choice; it is already recorded. Decide what is next.",
    conflict: "The member just settled a disagreement between two values; it is recorded. Decide what is next.",
    confirm: "The member just confirmed the details are right. You may adjudicate now.",
    form: "The member just filled in a form; it is recorded. Decide what is next.",
    change: "The member asked to change something.",
    decline_evidence: "The member said they do not have the document.",
    advisor: "The member asked for a person.",
  };
  lines.push(what[state.input.kind]);
  return lines;
}

export type LoopResult = { done: true; turn: Pick<ServicingTurn, "messages" | "terminal"> } | { done: false; reason: string };

export function turnFromResult(tool: string, r: Extract<ServicingToolResult, { ok: true }>, ctx: ServicingToolContext): Pick<ServicingTurn, "messages" | "terminal"> {
  if (r.terminal === "outcome") {
    const d = r.data as { memberExplanation: string; brokerExplanation: string; confidence: Confidence; uncertaintyReason: string | null };
    return {
      messages: [{ text: cardText(r.card!), card: r.card! }],
      terminal: { kind: "outcome", memberExplanation: d.memberExplanation, brokerExplanation: d.brokerExplanation, confidence: d.confidence, uncertaintyReason: d.uncertaintyReason },
    };
  }
  if (r.terminal === "escalation") {
    const d = r.data as { cause: EscalationCause; note: string | null; memberMessage: string | null; reference: string };
    return {
      messages: [...(d.memberMessage ? [{ text: d.memberMessage, card: null }] : []), { text: cardText(r.card!), card: r.card! }],
      terminal: { kind: "escalation", cause: d.cause, note: d.note, memberMessage: d.memberMessage, reference: d.reference },
    };
  }
  if (r.terminal === "appeal_upheld") {
    const a = ctx.appeal!;
    const res = a.result;
    if (res?.kind !== "upheld") throw new Error("appeal_upheld without an upheld draft");
    const card = appealOutcomeCard(res.draft, ctx.plan, ctx.policy.inceptionDate, a.original);
    return { messages: [{ text: res.draft.memberExplanation, card }], terminal: { kind: "appeal_upheld", draft: res.draft } };
  }
  if (r.terminal === "appeal_overturn") {
    const res = ctx.appeal!.result;
    if (res?.kind !== "overturn") throw new Error("appeal_overturn without an overturn draft");
    // A real interim state, with no workflow words in it. The numbers are computed and NOT shown: an overturn is not
    // a decision until it is signed, and a member told "you'll get 4,400" before that is a member promised money.
    return {
      messages: [{ text: "Your evidence changes the decision. We're finalising the numbers — you'll see them here.", card: null }],
      terminal: { kind: "appeal_overturn", draft: res.draft, correction: res.correction, evidenceKind: res.evidenceKind, ledgerBeforeContested: res.ledgerBeforeContested, trace: [] },
    };
  }
  void tool;
  return { messages: [{ text: cardText(r.card!), card: r.card! }], terminal: null };
}

async function modelLoop(ctx: ServicingToolContext, state: ServicingStateType, decide: ServicingDecider, trace: TraceStep[], acc: { servedBy: string | null; latencyMs: number }): Promise<LoopResult> {
  return runModelLoop(ctx, decide, trace, acc, { system: systemPrompt(ctx), lines: openingLines(ctx, state) });
}

/** The bounded tool loop, for whichever registry the context carries. Shared by claims and appeals. */
export async function runModelLoop(
  ctx: ServicingToolContext,
  decide: ServicingDecider,
  trace: TraceStep[],
  acc: { servedBy: string | null; latencyMs: number },
  prompt: { system: string; lines: string[] },
): Promise<LoopResult> {
  const { system, lines } = prompt;
  const rejections = new Map<string, number>();
  const budget = ctx.limits.toolCallsPerTurn;

  for (let step = 1; step <= budget; step++) {
    const left = budget - step + 1;
    const reminder = left <= 3 ? `\n\n${left} call(s) left this turn. If you have enough, ask the member or move the conversation forward now.` : "";

    let called;
    try {
      called = await decide({ system, user: lines.join("\n\n") + reminder });
    } catch (error) {
      return { done: false, reason: `model call failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    acc.servedBy = called.servedBy ?? acc.servedBy;
    acc.latencyMs += called.latencyMs;
    const { thought, tool, args } = called.decision;

    const result = runServicingTool(ctx, tool, args);
    trace.push({ step, thought, tool, args: args ?? null, validation: result.ok ? "ok" : result.error, observation: summarise(result), latencyMs: called.latencyMs });

    if (!result.ok) {
      const key = `${tool}::${result.error}`;
      const n = (rejections.get(key) ?? 0) + 1;
      rejections.set(key, n);
      if (n >= MAX_SAME_ERROR) return { done: false, reason: `"${tool}" was refused the same way ${n} times: ${result.error}` };
      lines.push(`Step ${step}: you called "${tool}" with ${JSON.stringify(args ?? {})} — ERROR: ${result.error}. Correct it and try again.`);
      continue;
    }
    if (result.terminal || (result.card && INTERRUPTING.has(tool))) return { done: true, turn: turnFromResult(tool, result, ctx) };
    lines.push(`Step ${step}: you called "${tool}" with ${JSON.stringify(args ?? {})} — OK.\nObservation: ${summarise(result)}`);
  }
  return { done: false, reason: "tool-call budget exhausted without reaching the member" };
}

/** Everything on the form the member has already given, so nothing is retyped. */
function currentValues(ctx: ServicingToolContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FIELD_KEYS) {
    const f = ctx.draft.facts[key];
    if (!f) continue;
    out[key] = key === "paid_by_member" ? (f.value === true ? "yes" : "no") : String(f.value);
  }
  const c = ctx.draft.benefitClass;
  if (c) out.benefit_class = c.value === "chronic_preexisting" ? `chronic:${c.declaredCondition}` : c.value;
  return out;
}

const escalate = (ctx: ServicingToolContext, cause: EscalationCause, extra: { note?: string; member_message?: string } = {}) => runServicingTool(ctx, "escalate", { cause, ...extra });

/**
 * The deterministic driver: from wherever the draft stands, do the next right thing with no model at all.
 * It is the whole flow in no-model mode, and the floor under the model loop in every other mode.
 */
function driver(ctx: ServicingToolContext, state: ServicingStateType, trace: TraceStep[], lead: string | null): Pick<ServicingTurn, "messages" | "terminal"> {
  const step = (tool: string, args: unknown, r: ServicingToolResult) =>
    trace.push({ step: trace.length + 1, thought: "deterministic driver", tool, args, validation: r.ok ? "ok" : r.error, observation: summarise(r), latencyMs: 0 });
  const handOff = (reason: string): Pick<ServicingTurn, "messages" | "terminal"> => {
    // A driver that cannot proceed hands the case to a person rather than guess. The LAST RESORT must not be able
    // to fail on its own input validation: the note is cut to fit, because a hand-off refused for being too
    // wordy leaves a member with nothing to press.
    const r = escalate(ctx, "model_failure", { note: reason.slice(0, 280) });
    step("escalate", { cause: "model_failure" }, r);
    if (r.ok) return turnFromResult("escalate", r, ctx);
    // If even that is refused, never strand them: put the confirmation back in front of them so they can try again.
    ctx.draft.confirmed = false;
    const again = runServicingTool(ctx, "confirm_details", {});
    step("confirm_details", {}, again);
    return again.ok
      ? { messages: [{ text: "Something went wrong on our side — your details are saved. Please confirm them again.", card: null }, ...turnFromResult("confirm_details", again, ctx).messages], terminal: null }
      : { messages: [{ text: "Something went wrong on our side. Your details are saved — please try again in a moment.", card: null }], terminal: null };
  };

  const c = completeness(ctx.draft);
  const declared = ctx.applicant.conditions.map((x) => x.name);
  const changing = state.changing;

  // 1. Two sources disagree: ask which is right. Never choose.
  if (c.openConflicts.length > 0) {
    const r = runServicingTool(ctx, "flag_conflict", { field_key: c.openConflicts[0] });
    step("flag_conflict", { field_key: c.openConflicts[0] }, r);
    if (r.ok) return turnFromResult("flag_conflict", r, ctx);
  }

  // 2. Something is missing, the member wants to change something, or what they just sent had a problem: the
  //    question is a form. A field they got WRONG is shown again even though an older value is on file — otherwise
  //    an invalid edit would be dropped and the old details put back in front of them as if nothing was said.
  const errors = state.formErrors ?? {};
  const errorKeys = Object.keys(errors);
  const hasErrors = errorKeys.length > 0;
  if (changing || hasErrors || !c.readyToConfirm) {
    const askClass = changing || !c.benefitClassSet || errorKeys.includes("benefit_class");
    const base = changing ? (ctx.draft.intent === "preauth" ? (["treatment", "provider_type", "amount"] as FieldKey[]) : (["treatment", "treatment_date", "provider_type", "amount", "paid_by_member"] as FieldKey[])) : c.missing;
    const missing = [...new Set([...base, ...(errorKeys.filter((k) => (FIELD_KEYS as readonly string[]).includes(k)) as FieldKey[])])];
    // Changing: every optional field is offered too, filled if it is on file — not only the ones still unknown.
    const optional = changing ? (OPTIONAL_FIELDS[ctx.draft.intent] as readonly FieldKey[]).filter((k) => !missing.includes(k)) : c.optionalMissing;
    const card = factsFormCard(missing, [...optional], {
      intro: changing ? "Here's what I have. Change whatever isn't right." : hasErrors ? "A couple of things need another look." : undefined,
      benefitClassOptions: askClass ? benefitClassOptions(declared) : undefined,
      current: changing || hasErrors ? currentValues(ctx) : undefined,
      errors,
    });
    return { messages: [{ text: lead ?? card.intro, card }], terminal: null };
  }

  // 3. Everything is known, and the member has not looked at it yet.
  if (!ctx.draft.confirmed) {
    const r = runServicingTool(ctx, "confirm_details", {});
    step("confirm_details", {}, r);
    return r.ok ? turnFromResult("confirm_details", r, ctx) : handOff(r.error);
  }

  // 4. Confirmed: compute, then explain — or hand over, for the one case the plan cannot decide.
  const adj = runServicingTool(ctx, "adjudicate", {});
  step("adjudicate", {}, adj);
  if (!adj.ok || !ctx.result) return handOff(adj.ok ? "no result" : adj.error);

  if (ctx.result.outcome === "insufficient_data") {
    // The note is a headline for the queue. The full broker prose is stored on the event itself (`escalation` below).
    const args = { cause: "insufficient_data" as const, note: `${ctx.eventRef}: cannot be decided from the plan terms — no geographic scope.`, member_message: ctx.result.template.member };
    const r = escalate(ctx, "insufficient_data", { note: args.note, member_message: args.member_message });
    step("escalate", args, r);
    return r.ok ? turnFromResult("escalate", r, ctx) : handOff(r.error);
  }

  // A category the MEMBER picked from a list has not been checked against what the treatment was, and the
  // record says so: the event carries medium confidence and a reason, so it reaches a broker as a quality check.
  const memberPicked = ctx.draft.benefitClass?.by === "member";
  const confidence: Confidence = memberPicked ? "medium" : "high";
  const args = {
    member_explanation: ctx.result.template.member,
    broker_explanation: ctx.result.template.broker,
    confidence,
    ...(memberPicked ? { uncertainty_reason: "The treatment category was chosen by the member from a list and has not been checked against a description of the treatment." } : {}),
  };
  const r = runServicingTool(ctx, "propose_outcome", args);
  step("propose_outcome", { confidence }, r);
  return r.ok ? turnFromResult("propose_outcome", r, ctx) : handOff(r.error);
}

export function makeAgent(decide?: ServicingDecider) {
  return async function agent(state: ServicingStateType): Promise<Partial<ServicingStateType>> {
    const ctx = state.ctx!;
    const trace: TraceStep[] = [];
    const acc = { servedBy: null as string | null, latencyMs: 0 };

    // The member asked for a person. Nothing to decide, and nothing that needs a model.
    if (state.input.kind === "advisor") {
      const r = escalate(ctx, "member_requested", { note: "The member asked for an advisor." });
      trace.push({ step: 1, thought: "member asked for an advisor", tool: "escalate", args: { cause: "member_requested" }, validation: r.ok ? "ok" : r.error, observation: summarise(r), latencyMs: 0 });
      const t = r.ok ? turnFromResult("escalate", r, ctx) : { messages: [], terminal: null };
      return { ctx, turn: { ...t, trace, servedBy: null, latencyMs: 0, fellBackTo: null, modelUsed: false } };
    }

    /** A fresh confirmation on screen ends "changing". */
    const settled = (turn: ServicingTurn) => (turn.messages.some((m) => m.card?.kind === "servicing_confirm") ? false : state.changing);

    // "Change something" with a model: ask what, in words. Without one, the driver opens a prefilled form.
    if (decide && state.input.kind === "change") {
      const turn: ServicingTurn = { messages: [{ text: "Of course — what would you like to change?", card: null }], terminal: null, trace, servedBy: null, latencyMs: 0, fellBackTo: null, modelUsed: false };
      return { ctx, turn, changing: true };
    }

    let fellBackTo: string | null = null;
    if (decide) {
      const r = await modelLoop(ctx, state, decide, trace, acc);
      if (r.done) {
        const turn: ServicingTurn = { ...r.turn, trace, servedBy: acc.servedBy, latencyMs: acc.latencyMs, fellBackTo: null, modelUsed: true };
        return { ctx, turn, changing: settled(turn) };
      }
      fellBackTo = r.reason;
    }

    const typed = state.input.kind === "text" && state.input.text.trim() !== "";
    const t = driver(ctx, state, trace, decide ? "Let me get these a different way." : typed ? "I can't read typed messages at the moment — this form is the quickest way." : null);
    const turn: ServicingTurn = { ...t, trace, servedBy: acc.servedBy, latencyMs: acc.latencyMs, fellBackTo, modelUsed: Boolean(decide) };
    return { ctx, turn, changing: settled(turn) };
  };
}

// ---------------------------------------------------------------------------
// wait / gate / commit / escalate
// ---------------------------------------------------------------------------

/** The turn ends here: a question, a form or a confirmation is on screen and the member owns the next move. */
export function wait(state: ServicingStateType): Partial<ServicingStateType> {
  interrupt({ cards: (state.turn?.messages ?? []).filter((m) => m.card).length });
  return {};
}

/** Where a finished turn goes. Phase 4 has one destination per terminal; phases 5-7 add signatures and reassessments here. */
export function routeAfterAgent(state: ServicingStateType): "wait" | "commit" | "escalate" {
  const t = state.turn?.terminal;
  if (t?.kind === "outcome" || t?.kind === "appeal_upheld" || t?.kind === "appeal_overturn") return "commit";
  if (t?.kind === "escalation") return "escalate";
  return "wait";
}

export const gate = (state: ServicingStateType): Partial<ServicingStateType> => ({ ctx: state.ctx });

export function commit(state: ServicingStateType): Partial<ServicingStateType> {
  const t = state.turn!.terminal;
  if (t?.kind === "appeal_upheld") return { plan: { kind: "appeal_upheld", draft: t.draft, conversationStatus: "completed" } };
  if (t?.kind === "appeal_overturn") {
    return {
      plan: {
        kind: "appeal_overturn",
        draft: t.draft,
        correction: t.correction,
        evidenceKind: t.evidenceKind,
        ledgerBeforeContested: t.ledgerBeforeContested,
        evidence: state.ctx!.appeal!.state.evidence,
        trace: t.trace,
        priorityScore: PRIORITY.appeal_overturn,
        conversationStatus: "awaiting_review",
      },
    };
  }
  if (t?.kind !== "outcome") throw new Error("commit reached without an outcome");
  const event = buildEventDraft(state.ctx!, { memberExplanation: t.memberExplanation, brokerExplanation: t.brokerExplanation, confidence: t.confidence, uncertaintyReason: t.uncertaintyReason });
  return { plan: { kind: "commit", event, conversationStatus: "completed" } };
}

/** Undecidable is the top of the queue; a member who asked, or a stalled case, is next. */
const PRIORITY: Record<EscalationCause, number> = {
  insufficient_data: 100,
  appeal_overturn: 90,
  correction_needs_review: 85,
  unresolved_conflict: 80,
  clarification_limit: 80,
  evidence_limit: 80,
  model_failure: 80,
  member_requested: 80,
  reassessment_change: 60,
};

export function escalation(state: ServicingStateType): Partial<ServicingStateType> {
  const t = state.turn!.terminal;
  if (t?.kind !== "escalation") throw new Error("escalate reached without an escalation");
  const ctx = state.ctx!;
  const undecidable = ctx.result?.outcome === "insufficient_data";
  const event = undecidable
    ? buildEventDraft(ctx, { memberExplanation: t.memberMessage ?? ctx.result!.template.member, brokerExplanation: ctx.result!.template.broker, confidence: null, uncertaintyReason: null })
    : null;
  const kind = event ? kindOf(ctx.draft) : null;
  void kind;
  return {
    plan: {
      kind: "escalate",
      cause: t.cause,
      event,
      reason: `${t.reference}: ${ESCALATION_MEANING[t.cause]}.${t.note ? ` ${t.note}` : ""}`,
      priorityScore: PRIORITY[t.cause],
      conversationStatus: "escalated",
    },
  };
}
