// The appeal tools (plan §5.4). While a conversation is an appeal, THESE are the registry: the agent is not
// handed the claim tools, and cannot ask the member a claim question or adjudicate a new event.
//
// What the agent may do here is exactly what the plan says it may:
//   - judge whether a piece of evidence BEARS ON the contested finding (`assess_evidence`),
//   - choose which admissible kind of evidence to ask for next (`request_evidence`),
//   - propose ONE correction to the ONE input the finding turns on (`propose_correction`).
// Everything else is arithmetic or a lookup. The agent cannot decide a claim is now payable: `propose_correction`
// hands its patch to the engine, and the engine's answer — better, identical or worse — is what happens. "Uphold"
// is never chosen; it is what results when no admissible evidence remains or the re-adjudication does not help.
//
// Every argument is validated against `lib/servicing/appeal.ts` before anything runs, and a refusal names what
// was sent and what would have worked — so a well-written paragraph with no admissible evidence behind it gets a
// considered "no", and a badly written one with a licence attached wins. That ordering is structural.
//
// Deliberately not `server-only`, like the rest of the registry.

import { z } from "zod";
import type { ReasonCode } from "@/db/schema/enums";
import type { AdjudicationResult, ReplayEvent } from "@/lib/servicing";
import {
  ADMISSIBILITY,
  EVIDENCE_KINDS,
  buildOverturnDraft,
  buildUpheldDraft,
  escalationCard,
  evidenceRequestCard,
  kindInfo,
  kindMarkerProblem,
  reAdjudicate,
  remainingKinds,
  validateCorrection,
  type AppealEventDraft,
  type AppealState,
  type Contested,
  type Correction,
  type EvidenceKind,
  type LedgerState,
} from "@/lib/servicing";
import { ESCALATION_CAUSES, ESCALATION_MEANING, type EscalationCause } from "@/lib/servicing/escalation";
import { memberCopyViolations } from "@/lib/servicing/copy-rules";
import { numbersIn, observedNumbers } from "@/lib/servicing/facts";
import type { ServicingCard } from "@/lib/servicing/cards";
import type { ServicingToolContext, ServicingToolResult } from "./servicing";

export const APPEAL_TOOL_NAMES = ["read_appeal", "read_applicant_record", "assess_evidence", "request_evidence", "propose_correction", "conclude_appeal", "escalate"] as const;
export type AppealToolName = (typeof APPEAL_TOOL_NAMES)[number];

/** What an appeal's tools may see and change. Rebuilt from rows every turn (plan §6). */
export type AppealCtx = {
  /** Mutated by the tools and persisted by the session. */
  state: AppealState;
  contested: Contested;
  /** The policy's whole log, for re-adjudication at the original ledger position. */
  events: ReplayEvent[];
  /** The contested finding as it was adjudicated, reconstructed by the engine — never read back from text. */
  original: AdjudicationResult;
  declaredAtIntake: boolean;
  /** The reference the appeal will carry (APP-…), reserved when the conversation opened. */
  appealRef: string;
  /** Set by the tool that ends the appeal. */
  result:
    | { kind: "upheld"; draft: AppealEventDraft }
    | { kind: "overturn"; draft: AppealEventDraft; correction: Correction; evidenceKind: EvidenceKind; ledgerBeforeContested: LedgerState }
    | null;
};

const err = (message: string): ServicingToolResult => ({ ok: false, error: message });
const ok = (data: unknown, extra: { card?: ServicingCard; terminal?: "outcome" | "escalation" | "appeal_upheld" | "appeal_overturn" } = {}): ServicingToolResult => ({ ok: true, data, ...extra });

const issues = (error: z.ZodError, args?: unknown): string =>
  error.issues
    .map((i) => {
      let cur: unknown = args;
      for (const key of i.path) cur = cur && typeof cur === "object" ? (cur as Record<PropertyKey, unknown>)[key] : undefined;
      const path = i.path.join(".") || "(root)";
      return cur !== undefined ? `${path}: ${i.message} (you sent: ${JSON.stringify(cur)})` : `${path}: ${i.message}`;
    })
    .join("; ");

const squash = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

/** What can still be asked, in the order to ask: least-asked first, then the table's own order (most likely first). */
export function askOrderFor(reason: ReasonCode, state: Pick<AppealState, "supplied" | "declined" | "requested">): EvidenceKind[] {
  const remaining = remainingKinds(reason, { supplied: state.supplied, declined: state.declined, requested: state.requested });
  const table = ADMISSIBILITY[reason]?.kinds.map((k) => k.kind) ?? [];
  const asked = (k: EvidenceKind) => state.requested.filter((x) => x === k).length;
  return [...remaining].sort((x, y) => asked(x) - asked(y) || table.indexOf(x) - table.indexOf(y));
}

export const askOrder = (a: Pick<AppealCtx, "contested" | "state">): EvidenceKind[] => askOrderFor(a.contested.reason, a.state);

const appealOf = (ctx: ServicingToolContext): AppealCtx => {
  if (!ctx.appeal) throw new Error("an appeal tool ran in a conversation that is not an appeal");
  return ctx.appeal;
};

const frame = (ctx: ServicingToolContext, a: AppealCtx) => ({
  plan: ctx.plan,
  policyRef: ctx.policy.ref,
  inceptionDate: ctx.policy.inceptionDate,
  contested: a.contested.row,
  original: a.original,
  evidence: a.state.evidence,
  declaredAtIntake: a.declaredAtIntake,
  appealRef: a.appealRef,
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function readAppeal(ctx: ServicingToolContext): ServicingToolResult {
  const a = appealOf(ctx);
  const adm = a.contested.admissibility;
  return ok({
    contested: {
      ref: a.contested.row.ref,
      what: a.contested.row.description,
      policyMonth: a.contested.row.policyMonth,
      amount: a.contested.row.amount,
      reasonCode: a.contested.reason,
      turnsOn: adm.turnsOn,
      decisionTurnedOn: adm.decisionTurnedOn,
      recordedAs: { benefitClass: a.contested.row.benefitClass, providerTier: a.contested.row.providerTier },
    },
    admissibleEvidence: adm.kinds.map((k) => ({ kind: k.kind, mustShow: k.mustShow, correctsField: k.corrects })),
    notAdmissible: adm.notAdmissible,
    declaredAtIntake: a.declaredAtIntake ? ctx.applicant.conditions.map((c) => c.name) : [],
    evidence: a.state.evidence.map((text, index) => ({ index, text: text.slice(0, 600), assessed: a.state.assessments.some((x) => x.evidenceIndex === index) })),
    assessments: a.state.assessments,
    supplied: a.state.supplied,
    declined: a.state.declined,
    requested: a.state.requested,
    stillPossible: askOrder(a),
    requestsLeft: Math.max(ctx.limits.evidenceRequestRounds - a.state.requested.length, 0),
    note: "an assertion about what happened is not evidence: only a document that shows one of admissibleEvidence can bear on this finding",
  });
}

function readApplicantRecord(ctx: ServicingToolContext): ServicingToolResult {
  return ok({ declaredConditions: ctx.applicant.conditions, note: "these are already on file — never ask the member for them again" });
}

// ---------------------------------------------------------------------------
// assess_evidence — the agent judges relevance; the table bounds it
// ---------------------------------------------------------------------------

const assessSchema = z.strictObject({
  evidence_index: z.number().int().min(0),
  verdict: z.enum(["bears_on", "does_not_bear_on"]),
  kind: z.union([z.enum(EVIDENCE_KINDS), z.literal("none")]),
  /** Verbatim from the evidence: the words that show it. Required when it bears on the finding. */
  quote: z.string().trim().max(400).optional(),
  why: z.string().trim().min(20).max(400),
});

function assessEvidence(ctx: ServicingToolContext, args: unknown): ServicingToolResult {
  const a = appealOf(ctx);
  const parsed = assessSchema.safeParse(args);
  if (!parsed.success) return err(issues(parsed.error, args));
  const { evidence_index: index, verdict, kind, quote, why } = parsed.data;
  const text = a.state.evidence[index];
  if (text === undefined) return err(`there is no evidence ${index} — the member has sent ${a.state.evidence.length} piece(s), numbered from 0`);
  if (a.state.assessments.some((x) => x.evidenceIndex === index)) return err(`evidence ${index} is already assessed — assess the next piece, or move on`);

  const adm = a.contested.admissibility;
  if (verdict === "does_not_bear_on") {
    if (kind !== "none") return err(`a piece of evidence that does not bear on the finding has kind "none", not "${kind}"`);
    a.state.assessments.push({ evidenceIndex: index, verdict, kind: "none", quote: null, why });
  } else {
    if (kind === "none") return err(`bears_on needs the kind of evidence it is — one of [${adm.kinds.map((k) => k.kind).join(", ")}]`);
    const info = kindInfo(a.contested.reason, kind);
    if (!info) {
      return err(
        `"${kind}" is not evidence that can bear on this finding. Only [${adm.kinds.map((k) => `${k.kind} (${k.mustShow})`).join("; ")}] can. ` +
          `Not admissible: ${adm.notAdmissible.join(" ")} A description of what happened is not a document — if that is all this is, the verdict is does_not_bear_on`,
      );
    }
    if (!quote) return err(`bears_on needs a quote — the words of the evidence that show ${info.mustShow}`);
    if (squash(quote).length < 12 || !squash(text).includes(squash(quote))) {
      return err(`quote "${quote}" is not a span of evidence ${index} — quote the words that show it, verbatim`);
    }
    const lacks = kindMarkerProblem(kind, text, quote);
    if (lacks) return err(`${lacks}. If that is all this is, the verdict is does_not_bear_on`);
    a.state.assessments.push({ evidenceIndex: index, verdict, kind, quote, why });
    if (!a.state.supplied.includes(kind)) a.state.supplied.push(kind);
    a.state.pendingCorrection = kind;
    a.state.openRequest = null;
    return ok({
      verdict,
      kind,
      next: info.corrects
        ? `call propose_correction: field must be "${info.corrects}" (the only input this finding turns on), value from that field's vocabulary, quote verbatim from the evidence`
        : `this evidence is real, but it corrects no input the engine holds for this event — call escalate with cause correction_needs_review`,
    });
  }

  // Not admissible evidence. What is left to ask is a set difference, not a feeling.
  const remaining = askOrder(a);
  if (remaining.length === 0) return conclude(ctx, "no admissible evidence is left to ask for");
  return ok({ verdict, kind: "none", remaining, requestsLeft: Math.max(ctx.limits.evidenceRequestRounds - a.state.requested.length, 0), next: `call request_evidence with kind one of [${remaining.join(", ")}]` });
}

// ---------------------------------------------------------------------------
// request_evidence — one item, by name, from what can still exist
// ---------------------------------------------------------------------------

const requestSchema = z.strictObject({ kind: z.enum(EVIDENCE_KINDS) });

function requestEvidence(ctx: ServicingToolContext, args: unknown): ServicingToolResult {
  const a = appealOf(ctx);
  const parsed = requestSchema.safeParse(args);
  if (!parsed.success) return err(issues(parsed.error, args));
  const remaining = askOrder(a);
  if (remaining.length === 0) return err("nothing admissible is left to ask for — the appeal is upheld now (conclude_appeal). Asking again would be theatre");
  if (a.state.requested.length >= ctx.limits.evidenceRequestRounds) {
    return err(`the limit of ${ctx.limits.evidenceRequestRounds} evidence requests is reached — call escalate with cause evidence_limit rather than asking again`);
  }
  if (a.state.openRequest !== null) return err("an evidence request is already waiting on the member");
  const kind = parsed.data.kind;
  if (!remaining.includes(kind)) {
    return err(`"${kind}" cannot be requested: it is either not evidence that could change this finding, or it was supplied, declined or already asked twice. What can still be asked: [${remaining.join(", ")}]`);
  }
  const info = kindInfo(a.contested.reason, kind)!;
  a.state.requested.push(kind);
  a.state.openRequest = kind;
  ctx.evidenceRequestCount = a.state.requested.length;
  const card = evidenceRequestCard({
    contested: { title: a.contested.row.description ?? a.contested.row.ref, decision: `Not covered — ${a.contested.admissibility.decisionTurnedOn}` },
    prompt: info.ask,
    mustShow: `${info.mustShow}.`,
    round: a.state.requested.length,
  });
  return ok({ requested: kind, round: a.state.requested.length, waiting: "the member to send it, or to say they don't have it" }, { card });
}

// ---------------------------------------------------------------------------
// propose_correction — ONE field; then the engine decides
// ---------------------------------------------------------------------------

const correctionSchema = z.strictObject({
  evidence_index: z.number().int().min(0),
  kind: z.enum(EVIDENCE_KINDS),
  field: z.string().min(1).max(40),
  value: z.string().min(1).max(60),
  quote: z.string().trim().min(1).max(400),
});

function proposeCorrection(ctx: ServicingToolContext, args: unknown): ServicingToolResult {
  const a = appealOf(ctx);
  const parsed = correctionSchema.safeParse(args);
  if (!parsed.success) return err(issues(parsed.error, args));
  const { evidence_index: index, kind, field, value, quote } = parsed.data;

  const assessed = a.state.assessments.find((x) => x.evidenceIndex === index && x.verdict === "bears_on" && x.kind === kind);
  if (!assessed) return err(`evidence ${index} has not been assessed as bearing on this finding as "${kind}" — call assess_evidence first. A correction needs an assessment behind it`);

  const checked = validateCorrection(a.contested, kind, { field, value, quote }, a.state.evidence);
  if (!checked.ok) return err(checked.error);
  const correction = checked.correction;

  const orig = a.contested.row;
  const redone = reAdjudicate({
    plan: ctx.plan,
    events: a.events,
    contestedId: orig.id,
    patch: { field: correction.field, value: correction.to },
    policyStatus: ctx.policy.status,
    original: { outcome: orig.outcome, planPays: orig.planPays },
  });
  a.state.pendingCorrection = null;

  const summary = {
    corrected: { field: correction.field, from: correction.from, to: correction.to },
    before: { outcome: orig.outcome, planPays: orig.planPays, memberPays: orig.memberPays },
    after: { outcome: redone.result.outcome, reasonCode: redone.result.reasonCode, planPays: redone.result.planPays, memberPays: redone.result.memberPays },
    ledgerBeforeContested: redone.ledgerBefore,
    verdict: redone.verdict,
    calculation: redone.result.calculation,
  };

  if (redone.verdict === "overturn") {
    const draft = buildOverturnDraft(frame(ctx, a), redone, correction, kind);
    a.result = { kind: "overturn", draft, correction, evidenceKind: kind, ledgerBeforeContested: redone.ledgerBefore };
    return ok({ ...summary, next: "the engine would pay this claim on the corrected input. It is not final: a person signs an overturn" }, { terminal: "appeal_overturn" });
  }

  // Identical, or WORSE for the member — the never-worse rule: an appeal can never cost a member money. The
  // original stands and the appeal closes, and the member is told the evidence was looked at.
  const draft = buildUpheldDraft(frame(ctx, a), { evidenceSupplied: true });
  const why =
    redone.verdict === "uphold_worse"
      ? `Evidence bore on the finding (${correction.field.replace(/_/g, " ")} ${correction.from} → ${correction.to}), but re-adjudicating would have left the member worse off, so the original stands (never-worse rule).`
      : redone.verdict === "uphold_undecidable"
        ? `Evidence bore on the finding (${correction.field.replace(/_/g, " ")} ${correction.from} → ${correction.to}), but the corrected input cannot be decided from the plan terms, so the original stands.`
        : `Evidence bore on the finding (${correction.field.replace(/_/g, " ")} ${correction.from} → ${correction.to}), and re-adjudicating gives the same result.`;
  draft.brokerExplanation = `${draft.brokerExplanation} ${why}`;
  a.result = { kind: "upheld", draft };
  return ok({ ...summary, next: "the decision stands — the appeal closes" }, { terminal: "appeal_upheld" });
}

// ---------------------------------------------------------------------------
// conclude_appeal — the uphold that follows from an empty set
// ---------------------------------------------------------------------------

/** Ends the appeal as upheld. Only legal when nothing admissible is left to ask for: it is a consequence, not a choice. */
function conclude(ctx: ServicingToolContext, reason: string): ServicingToolResult {
  const a = appealOf(ctx);
  const draft = buildUpheldDraft(frame(ctx, a), { evidenceSupplied: a.state.evidence.length > 0 });
  a.result = { kind: "upheld", draft };
  return ok({ upheld: true, because: reason, remaining: [] }, { terminal: "appeal_upheld" });
}

function concludeAppeal(ctx: ServicingToolContext, args: unknown): ServicingToolResult {
  const a = appealOf(ctx);
  const parsed = z.strictObject({}).safeParse(args ?? {});
  if (!parsed.success) return err("conclude_appeal takes no arguments");
  const remaining = askOrder(a);
  if (remaining.length > 0) return err(`cannot conclude: admissible evidence can still be asked for — [${remaining.join(", ")}]. Call request_evidence`);
  if (a.state.pendingCorrection) return err("evidence bore on the finding and a correction is pending — call propose_correction (or escalate)");
  if (a.state.openRequest !== null) return err("an evidence request is waiting on the member");
  return conclude(ctx, "no admissible evidence is left to ask for");
}

// ---------------------------------------------------------------------------
// escalate — a cause is only ever true
// ---------------------------------------------------------------------------

const escalateSchema = z.strictObject({
  cause: z.enum(ESCALATION_CAUSES),
  note: z.string().trim().max(300).optional(),
  member_message: z.string().trim().min(40).max(1200).optional(),
});

function justified(ctx: ServicingToolContext): Record<EscalationCause, boolean> {
  const a = appealOf(ctx);
  const noCorrectionPossible = a.state.assessments.some((x) => x.verdict === "bears_on" && x.kind !== "none" && kindInfo(a.contested.reason, x.kind)?.corrects === null);
  return {
    insufficient_data: false,
    unresolved_conflict: false,
    clarification_limit: false,
    evidence_limit: askOrder(a).length > 0 && a.state.requested.length >= ctx.limits.evidenceRequestRounds,
    appeal_overturn: false,
    correction_needs_review: noCorrectionPossible,
    reassessment_change: false,
    model_failure: true,
    member_requested: true,
  };
}

function escalateAppeal(ctx: ServicingToolContext, args: unknown): ServicingToolResult {
  const a = appealOf(ctx);
  const parsed = escalateSchema.safeParse(args);
  if (!parsed.success) return err(issues(parsed.error, args));
  const { cause, note, member_message } = parsed.data;
  const j = justified(ctx);
  if (!j[cause]) {
    const valid = ESCALATION_CAUSES.filter((x) => j[x]);
    return err(`cannot escalate as ${cause} (${ESCALATION_MEANING[cause]}) — the state does not show it. Causes that hold right now: [${valid.join(", ")}]`);
  }
  if (member_message) {
    const violations = memberCopyViolations(member_message);
    if (violations.length > 0) return err(`member_message is not fit for a member to read: ${violations.join("; ")}`);
    const observed = observedNumbers(ctx.ledger, ctx.policy.inceptionDate, ctx.today, a.contested.row.amount, a.contested.row.policyMonth);
    const invented = numbersIn(member_message).filter((n) => !observed.has(n));
    if (invented.length > 0) return err(`figure(s) ${invented.join(", ")} appear in member_message but in no observation`);
  }
  const summary = [
    `Your appeal of: ${a.contested.row.description ?? a.contested.row.ref}`,
    a.state.evidence.length ? `What you've sent so far (${a.state.evidence.length})` : "Your request to have this looked at again",
    "What we could and couldn't work out from your plan",
    "Your conversation with us, so nothing needs repeating",
  ];
  return ok({ cause, note: note ?? null, memberMessage: member_message ?? null, reference: a.appealRef }, { card: escalationCard(a.appealRef, summary), terminal: "escalation" });
}

// ---------------------------------------------------------------------------
// Dispatch and descriptions
// ---------------------------------------------------------------------------

export function runAppealTool(ctx: ServicingToolContext, name: string, args: unknown): ServicingToolResult {
  const a = appealOf(ctx);
  if (a.result !== null) return err("the appeal has already reached its end — no further tool calls");
  switch (name as AppealToolName) {
    case "read_appeal":
      return readAppeal(ctx);
    case "read_applicant_record":
      return readApplicantRecord(ctx);
    case "assess_evidence":
      return assessEvidence(ctx, args);
    case "request_evidence":
      return requestEvidence(ctx, args);
    case "propose_correction":
      return proposeCorrection(ctx, args);
    case "conclude_appeal":
      return concludeAppeal(ctx, args);
    case "escalate":
      return escalateAppeal(ctx, args);
    default:
      return err(`unknown tool "${name}" — in an appeal the valid tools are: ${APPEAL_TOOL_NAMES.join(", ")}`);
  }
}

export function describeAppealTools(ctx: ServicingToolContext): Record<AppealToolName, string> {
  const a = appealOf(ctx);
  const adm = a.contested.admissibility;
  const kinds = adm.kinds.map((k) => k.kind).join(", ");
  const causes = ESCALATION_CAUSES.join(", ");
  return {
    read_appeal: "no args — the contested finding, what it turns on, which evidence could change it (and which cannot), what the member has sent, and what can still be asked for",
    read_applicant_record: "no args — what the member declared at intake. NEVER ask for it again",
    assess_evidence: `{ evidence_index, verdict: bears_on|does_not_bear_on, kind, quote?, why } — kind one of [${kinds}] when bears_on, or "none" when not. A DESCRIPTION of what happened is not evidence: it does not bear on the finding. bears_on needs a verbatim quote of the words that show it`,
    request_evidence: `{ kind } — kind one of [${askOrder(a).join(", ") || "(nothing left)"}]. Asks the member for ONE document, by name. You cannot request a kind outside that list`,
    propose_correction: `{ evidence_index, kind, field, value, quote } — after assess_evidence said bears_on. field MUST be "${adm.turnsOn}" (the only input this finding turns on; the amount, date and month can never be corrected by an appeal). value from that field's vocabulary and different from what is recorded. quote verbatim from the evidence. The ENGINE then re-adjudicates: you never decide the outcome`,
    conclude_appeal: "no args — ends the appeal as upheld. Only when no admissible evidence is left to ask for",
    escalate: `{ cause, note?, member_message? } — TERMINAL. cause one of [${causes}], and only one the state actually justifies`,
  };
}
