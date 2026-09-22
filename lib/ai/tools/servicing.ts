// The servicing agent's tool registry (docs/servicing_agent_plan.md §4).
//
// The contract is the recommendation registry's (lib/ai/tools/plans.ts), applied to
// claims: the model is never handed the corpus, never supplies a number it
// invented, and every argument is a closed vocabulary validated HERE, before the
// tool runs. A failed call comes back as a structured `{ ok: false, error }` the
// agent can read and correct from — never a thrown exception, never silence.
//
// What makes this registry different is what it refuses, because each refusal is a
// rule the plan states and this is where it becomes true:
//
//   one question at a time         ask_member rejects a second while one is open
//   re-collect nothing             ask_member rejects a field that is already known,
//                                  and hands back the value
//   the member's words             record_fact needs a quote that is verbatim from the
//                                  member, and an amount that appears in it
//   a reading is not a fact        an INFERRED fact must be confirmed by the member
//                                  before adjudicate will run
//   no invented money              adjudicate takes NO amount argument — it reads the
//                                  validated draft — and propose_outcome may only cite
//                                  figures an observation produced
//   an honest confidence           insufficient_data cannot claim confidence; anything
//                                  short of high must say why
//   causes are true                escalate refuses a cause the state does not justify
//
// Deliberately not `server-only`, like the rest of lib/servicing: the harness that
// drives these tools runs from a script.
//
// Not here yet, by design: `request_evidence`, `assess_evidence`, `propose_correction`.
// They are the appeal loop (plan §5.4, phase 5) and need its admissibility table; a
// tool that validates against a table that does not exist is a stub, and a stub in a
// registry the model can call is worse than an absence.

import { z } from "zod";
import { covers, waitMonths, type PlanTerms } from "@/lib/assessment";
import {
  benefitClassEnum,
  claimProviderTierEnum,
  type BenefitClass,
  type ClaimProviderTier,
  type EventKind,
  type EventOutcome,
  type PolicyStatus,
  type ReasonCode,
} from "@/db/schema/enums";
import {
  NETWORK_ADMITS,
  adjudicate,
  explain,
  monthOfDate,
  nextStepFacts,
  providerTypeLabel,
  type AdjudicationInput,
  type AdjudicationResult,
  type Explanation,
  type LedgerState,
  type Limits,
  type NextStepFacts,
} from "@/lib/servicing";
import {
  conflictCard,
  confirmCard,
  escalationCard,
  estimateCard,
  outcomeCard,
  questionCard,
  type ServicingCard,
} from "@/lib/servicing/cards";
import { INTERNAL_REF, memberCopyViolations } from "@/lib/servicing/copy-rules";
import { ESCALATION_CAUSES, ESCALATION_MEANING, type EscalationCause } from "@/lib/servicing/escalation";
import { runAppealTool, type AppealCtx } from "./appeal";
import {
  FACT_VALUE,
  FIELD_KEYS,
  completeness,
  fieldsFor,
  hasOpenConflict,
  kindOf,
  numbersIn,
  observedNumbers,
  toAdjudicationInput,
  type Draft,
  type FieldKey,
} from "@/lib/servicing/facts";

// ---------------------------------------------------------------------------
// Context — what a tool call can see, and the state it may change
// ---------------------------------------------------------------------------

/** One prior event, reduced to what the agent may reason from. */
export type HistoryItem = {
  ref: string;
  kind: EventKind;
  policyMonth: number;
  benefitClass: BenefitClass | null;
  outcome: EventOutcome | null;
  reasonCode: ReasonCode | null;
  planPays: number | null;
  memberPays: number | null;
  /** The event this one supersedes. A superseded event no longer counts. */
  supersedes: string | null;
  description: string | null;
};

export type ServicingToolContext = {
  policy: { id: string; ref: string; inceptionDate: string; status: PolicyStatus };
  plan: PlanTerms;
  catalogue: PlanTerms[];
  /** The ledger as it stands NOW — projected from the log, never adjusted by a tool. */
  ledger: LedgerState;
  history: HistoryItem[];
  /** What the member already told us at intake — so it is never asked again. */
  applicant: { conditions: { name: string; stability: string }[] };
  /** ISO date. Injected, so a scripted conversation is reproducible. */
  today: string;
  /** The reference this event will carry (CLM-…), for the broker's prose. */
  eventRef: string;
  limits: Limits;

  // --- session state. In the running system this is rebuilt from rows every turn (plan §6) ---
  draft: Draft;
  /** What the member has actually said, verbatim, in order. A quote must be a span of one of these. */
  memberMessages: string[];
  /** The field a question is currently waiting on, or null. One at a time. */
  openQuestion: FieldKey | null;
  /** The confirm card is on screen and the member has not answered yet. */
  awaitingConfirmation: boolean;
  /**
   * The member picked "Not sure" for the provider type. A legitimate answer, so it is a STATE rather than an
   * error: no tier is guessed, the agent asks for the provider's name once, and if that does not settle it the
   * case goes to a person (`clarification_limit`).
   */
  providerUnsure: boolean;
  clarificationCount: number;
  result: (AdjudicationResult & { input: AdjudicationInput; facts: NextStepFacts; template: Explanation }) | null;
  proposed: { confidence: "high" | "medium" | "low"; uncertaintyReason: string | null } | null;

  // --- state the later phases fill in. False/zero until then, so the causes they justify stay unreachable ---
  evidenceRequestCount: number;
  overturnReady: boolean;
  reassessmentRecommendsChange: boolean;
  /** Set while the conversation is an appeal (plan §5.4): the registry is then lib/ai/tools/appeal.ts, not this file. */
  appeal: AppealCtx | null;
};

export type ServicingToolResult =
  | { ok: true; data: unknown; card?: ServicingCard; /** This call ends the agent's turn. */ terminal?: "outcome" | "escalation" | "appeal_upheld" | "appeal_overturn" }
  | { ok: false; error: string };

export const TOOL_NAMES = [
  "read_policy",
  "read_ledger",
  "read_event_history",
  "read_applicant_record",
  "get_plan_terms",
  "check_network_admission",
  "record_fact",
  "classify_benefit",
  "list_missing_facts",
  "ask_member",
  "flag_conflict",
  "confirm_details",
  "adjudicate",
  "propose_outcome",
  "escalate",
] as const;
export type ServicingToolName = (typeof TOOL_NAMES)[number];

const err = (message: string): ServicingToolResult => ({ ok: false, error: message });
const ok = (data: unknown, extra: { card?: ServicingCard; terminal?: "outcome" | "escalation" | "appeal_upheld" | "appeal_overturn" } = {}): ServicingToolResult => ({ ok: true, data, ...extra });

/**
 * Zod strips the received value off `issue` by default, so it is walked back out of
 * the raw `args` — the point is to hand the agent the value it sent next to the
 * vocabulary it should have used, so a bad guess is correctable on the next turn.
 */
function valueAtPath(args: unknown, path: PropertyKey[]): unknown {
  let cur = args;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

const issuesToMessage = (error: z.ZodError, args?: unknown): string =>
  error.issues
    .map((i) => {
      const received = args !== undefined ? valueAtPath(args, i.path) : undefined;
      const path = i.path.join(".") || "(root)";
      return received !== undefined ? `${path}: ${i.message} (you sent: ${JSON.stringify(received)})` : `${path}: ${i.message}`;
    })
    .join("; ");

// ---------------------------------------------------------------------------
// Derived from context
// ---------------------------------------------------------------------------

const currentPolicyMonth = (ctx: ServicingToolContext): number => monthOfDate(ctx.policy.inceptionDate, ctx.today);

const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Events that still count: a superseded denial is on the record but no longer in the fold. */
function liveHistory(ctx: ServicingToolContext): HistoryItem[] {
  const superseded = new Set(ctx.history.map((h) => h.supersedes).filter(Boolean));
  return ctx.history.filter((h) => !superseded.has(h.ref));
}

const KIND_OF: Record<string, string> = { preauth: "pre-authorization", claim: "claim", reimbursement: "reimbursement" };

// ---------------------------------------------------------------------------
// Reads — each returns a slice, never a dump
// ---------------------------------------------------------------------------

function readPolicy(ctx: ServicingToolContext): ServicingToolResult {
  return ok({
    policyRef: ctx.policy.ref,
    status: ctx.policy.status,
    inceptionDate: ctx.policy.inceptionDate,
    today: ctx.today,
    currentPolicyMonth: currentPolicyMonth(ctx),
    plan: { id: ctx.plan.id, name: ctx.plan.name, network: ctx.plan.network },
    intent: ctx.draft.intent,
  });
}

function readLedger(ctx: ServicingToolContext): ServicingToolResult {
  const { plan, ledger } = ctx;
  return ok({
    deductible: { total: plan.deductible, met: ledger.deductibleMet, remaining: Math.max(plan.deductible - ledger.deductibleMet, 0) },
    annual: { limit: plan.annualLimit, paid: ledger.annualPaid, remaining: Math.max(plan.annualLimit - ledger.annualPaid, 0) },
    ...(plan.maternityCovered && plan.maternityLimit !== null
      ? { maternity: { limit: plan.maternityLimit, used: ledger.sublimitUsed.maternity ?? 0, remaining: Math.max(plan.maternityLimit - (ledger.sublimitUsed.maternity ?? 0), 0) } }
      : {}),
  });
}

const historySchema = z.strictObject({ benefit_class: z.enum(benefitClassEnum).optional() });

function readEventHistory(ctx: ServicingToolContext, args: unknown): ServicingToolResult {
  const parsed = historySchema.safeParse(args ?? {});
  if (!parsed.success) return err(issuesToMessage(parsed.error, args));
  const items = liveHistory(ctx).filter((h) => !parsed.data.benefit_class || h.benefitClass === parsed.data.benefit_class);
  return ok({ events: items, note: "superseded events are omitted: they remain on the record but no longer count" });
}

function readApplicantRecord(ctx: ServicingToolContext): ServicingToolResult {
  return ok({
    declaredConditions: ctx.applicant.conditions,
    note: "these are already on file — never ask the member for them again",
  });
}

function getPlanTerms(ctx: ServicingToolContext, args: unknown): ServicingToolResult {
  const ids = ctx.catalogue.map((p) => p.id);
  const parsed = z.strictObject({ plan_id: z.enum(ids as [string, ...string[]]) }).safeParse(args);
  if (!parsed.success) return err(issuesToMessage(parsed.error, args));
  const p = ctx.catalogue.find((x) => x.id === parsed.data.plan_id)!;
  return ok({
    id: p.id,
    name: p.name,
    annualPremium: p.annualPremium,
    deductible: p.deductible,
    outpatientCopayPct: p.outpatientCopayPct,
    annualLimit: p.annualLimit,
    network: p.network,
    maternity: { covered: p.maternityCovered, waitMonths: p.maternityWaitingPeriodMonths, limit: p.maternityLimit },
    chronic_preexisting: { covered: p.chronicCovered, waitMonths: p.chronicWaitingPeriodMonths },
    dental_optical: p.dentalOptical,
  });
}

function checkNetworkAdmission(ctx: ServicingToolContext, args: unknown): ServicingToolResult {
  const parsed = z.strictObject({ provider_type: z.enum(claimProviderTierEnum) }).safeParse(args);
  if (!parsed.success) return err(issuesToMessage(parsed.error, args));
  const tier = parsed.data.provider_type;
  if (tier === "unknown_foreign") {
    return ok({
      providerType: tier,
      admitted: null,
      reason: "outside the UAE the plan terms define no geographic scope, so this cannot be decided from them — adjudicate will return insufficient_data",
    });
  }
  const admitted = (NETWORK_ADMITS[ctx.plan.network] as readonly string[]).includes(tier);
  return ok({ providerType: tier, admitted, network: ctx.plan.network, admittedTypes: NETWORK_ADMITS[ctx.plan.network] });
}

// ---------------------------------------------------------------------------
// record_fact — extract, validate, update. The only way a fact enters the draft.
// ---------------------------------------------------------------------------

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const recordFactSchema = z.strictObject({
  field_key: z.enum(FIELD_KEYS),
  value: z.union([z.string(), z.number(), z.boolean()]),
  /** stated = the quote contains it; inferred = derived from the quote, and the member will be asked to check it. */
  basis: z.enum(["stated", "inferred"]),
  /** Verbatim from something the member said. */
  quote: z.string().min(1).max(300),
  resolves_conflict: z.boolean().optional(),
});

/** Does the member's own quote actually contain the value the agent says they stated? */
function statedProblem(key: FieldKey, value: string | number | boolean, quote: string): string | null {
  const q = normalise(quote);
  switch (key) {
    case "amount":
      return numbersIn(quote).includes(Number(value)) ? null : `the amount ${value} does not appear in the quote "${quote}" — if the member gave it in words, use basis "inferred"`;
    case "provider_type":
      return q.includes(normalise(providerTypeLabel[value as ClaimProviderTier] ?? String(value))) || q.includes(String(value).replace(/_/g, " "))
        ? null
        : `the quote "${quote}" does not name a ${providerTypeLabel[value as ClaimProviderTier] ?? value} — use basis "inferred", or ask with the chips`;
    case "provider_name":
      return q.includes(normalise(String(value))) ? null : `the provider name "${value}" is not in the quote "${quote}"`;
    case "treatment_date": {
      // A date typed as 2026-09-04 (a date input, or a member who writes ISO) states itself.
      if (q.includes(String(value))) return null;
      const day = Number(String(value).slice(8, 10));
      const monthName = MONTH_NAMES[Number(String(value).slice(5, 7)) - 1];
      return numbersIn(quote).includes(day) && q.includes(monthName.slice(0, 3)) ? null : `the quote "${quote}" does not state ${value} as a day and a month — a relative date ("last week") is basis "inferred"`;
    }
    default:
      return null;
  }
}

function recordFact(ctx: ServicingToolContext, args: unknown): ServicingToolResult {
  const parsed = recordFactSchema.safeParse(args);
  if (!parsed.success) return err(issuesToMessage(parsed.error, args));
  const { field_key: key, value, basis, quote, resolves_conflict } = parsed.data;
  const draft = ctx.draft;

  if (!fieldsFor(draft.intent).includes(key)) {
    return err(`${key} does not apply to a ${KIND_OF[draft.intent === "claim" ? "claim" : "preauth"]} — the fields that do: ${fieldsFor(draft.intent).join(", ")}`);
  }
  if (key === "provider_type" && value === "unsure") {
    const spokenNow = ctx.memberMessages.map(normalise);
    if (!spokenNow.some((m) => m.includes(normalise(quote)))) return err(`quote "${quote}" is not a verbatim span of anything the member has said`);
    ctx.providerUnsure = true;
    if (ctx.openQuestion === "provider_type") ctx.openQuestion = null;
    return ok({
      status: "unsure",
      recorded: false,
      next: 'no provider type was recorded — never guess a tier. Ask for provider_name once (ask_member, field_key provider_name). If that does not settle the type, call escalate with cause clarification_limit',
      ...state(ctx),
    });
  }

  const valueOk = FACT_VALUE[key].safeParse(value);
  if (!valueOk.success) return err(`${key}: ${issuesToMessage(valueOk.error, { value })}`);
  const v = valueOk.data;

  // Range checks that need the policy, not just the type.
  if (key === "treatment_date") {
    if (String(v) > ctx.today) return err(`${v} is in the future (today is ${ctx.today}) — a treatment that has not happened yet is a pre-authorization, not a claim`);
    try {
      monthOfDate(ctx.policy.inceptionDate, String(v));
    } catch {
      return err(`${v} is before the policy incepted on ${ctx.policy.inceptionDate} — nothing before inception can be claimed`);
    }
  }

  // The member's own words: verbatim, or it did not come from them.
  const spoken = ctx.memberMessages.map(normalise);
  if (!spoken.some((m) => m.includes(normalise(quote)))) {
    return err(`quote "${quote}" is not a verbatim span of anything the member has said — quote their actual words`);
  }
  if (basis === "stated") {
    const problem = statedProblem(key, v, quote);
    if (problem) return err(problem);
  }
  const fact = { value: v, source: basis, quote } as const;

  const open = draft.conflicts.find((c) => c.fieldKey === key && !c.resolved);
  const existing = draft.facts[key];
  const changed = () => {
    if (key === "provider_type") ctx.providerUnsure = false;
    draft.confirmed = false;
    ctx.awaitingConfirmation = false;
    // What the treatment IS decides what class it belongs to: a new description needs re-classifying.
    if (key === "treatment") draft.benefitClass = null;
    if (ctx.openQuestion === key) ctx.openQuestion = null;
  };

  if (resolves_conflict) {
    if (!open) return err(`there is no open conflict on ${key} to resolve`);
    if (String(v) !== String(open.a.value) && String(v) !== String(open.b.value)) {
      return err(`a conflict is resolved by choosing one of its two values (${open.a.value} or ${open.b.value}), not by a third — you sent ${v}`);
    }
    draft.facts[key] = { ...fact, source: "stated" };
    open.resolved = true;
    changed();
    return ok({ status: "conflict_resolved", field: key, value: v, ...state(ctx) });
  }

  if (existing && String(existing.value) === String(v)) return ok({ status: "unchanged", field: key, value: v, ...state(ctx) });

  if (existing) {
    // Facts from the member's own file or a document are not overwritten by a sentence: they are DISPUTED.
    // The agent must ask which is right (plan §5.3), never silently choose.
    if (existing.source === "record" || existing.source === "document") {
      draft.conflicts.push({ fieldKey: key, a: existing, b: { ...fact }, resolved: false });
      ctx.draft.confirmed = false;
      return ok({
        status: "conflict",
        field: key,
        values: [existing.value, v],
        next: `two sources disagree on ${key}. Call flag_conflict with field_key "${key}" — do not choose one`,
        ...state(ctx),
      });
    }
    // The member correcting themselves replaces what they said before.
    draft.facts[key] = { ...fact };
    changed();
    return ok({ status: "updated", field: key, was: existing.value, value: v, ...state(ctx) });
  }

  draft.facts[key] = { ...fact };
  changed();
  return ok({ status: "recorded", field: key, value: v, source: basis, ...state(ctx) });
}

/** The state an agent needs after every fact, so it never has to guess what to do next. */
function state(ctx: ServicingToolContext) {
  const c = completeness(ctx.draft);
  return { missing: c.missing, openConflicts: c.openConflicts, benefitClassSet: c.benefitClassSet, readyToConfirm: c.readyToConfirm };
}

// ---------------------------------------------------------------------------
// classify_benefit
// ---------------------------------------------------------------------------

const classifySchema = z.strictObject({
  benefit_class: z.enum(benefitClassEnum),
  /** Required for chronic_preexisting, and it must be one the member declared. */
  declared_condition: z.string().min(2).max(120).optional(),
});

function classifyBenefit(ctx: ServicingToolContext, args: unknown): ServicingToolResult {
  const parsed = classifySchema.safeParse(args);
  if (!parsed.success) return err(issuesToMessage(parsed.error, args));
  const { benefit_class: cls, declared_condition } = parsed.data;
  const draft = ctx.draft;
  if (!draft.facts.treatment) return err("record the treatment first (record_fact, field_key treatment) — there is nothing to classify yet");

  const declared = ctx.applicant.conditions.map((c) => c.name);
  let matched: string | null = null;

  if (cls === "chronic_preexisting") {
    if (declared.length === 0) {
      return err("the member declared no conditions at intake, so this cannot be chronic_preexisting — treatment for a condition that first arose after inception is general");
    }
    if (!declared_condition) return err(`chronic_preexisting must name the condition it treats, from what the member declared: [${declared.join(", ")}]`);
    matched = declared.find((d) => normalise(d) === normalise(declared_condition) || normalise(d).includes(normalise(declared_condition)) || normalise(declared_condition).includes(normalise(d))) ?? null;
    if (!matched) {
      return err(`"${declared_condition}" is not a condition the member declared. Declared: [${declared.join(", ")}]. If the treatment is for something else it is general — a condition that first arose after inception is not chronic_preexisting`);
    }
  } else if (declared_condition) {
    return err(`declared_condition only applies to chronic_preexisting — you classified this as ${cls}`);
  }

  // Re-stating the SAME classification is not a change, and must not throw away a confirmation the member has
  // already given — `record_fact` has always drawn that line (its own `changed()`), and this did not. Without it,
  // a model that re-classifies on the confirm turn silently un-confirms the draft, `confirm_details` then has
  // nothing to refuse, and the member is shown the identical card a second time.
  const previous = draft.benefitClass;
  const same = previous?.value === cls && (previous?.declaredCondition ?? null) === matched;
  draft.benefitClass = { value: cls, declaredCondition: matched, by: "agent" };
  if (!same) {
    draft.confirmed = false;
    ctx.awaitingConfirmation = false;
  }
  return ok({
    benefitClass: cls,
    declaredCondition: matched,
    planCoversIt: covers(ctx.plan, cls),
    waitMonths: waitMonths(ctx.plan, cls),
    note: same
      ? "unchanged — it was already classified that way, so the member's confirmation still stands"
      : "this is your reading — the member will be asked to confirm it before anything is computed",
    ...state(ctx),
  });
}

// ---------------------------------------------------------------------------
// list_missing_facts
// ---------------------------------------------------------------------------

function listMissingFacts(ctx: ServicingToolContext): ServicingToolResult {
  const d = ctx.draft;
  const c = completeness(d);
  return ok({
    intent: d.intent,
    kind: kindOf(d),
    known: Object.entries(d.facts).map(([field, f]) => ({ field, value: f.value, source: f.source })),
    missing: c.missing,
    optionalMissing: c.optionalMissing,
    openConflicts: c.openConflicts,
    benefitClassSet: c.benefitClassSet,
    readyToConfirm: c.readyToConfirm,
    confirmed: d.confirmed,
    openQuestion: ctx.openQuestion,
    clarificationsUsed: ctx.clarificationCount,
    clarificationsLeft: Math.max(ctx.limits.clarificationRounds - ctx.clarificationCount, 0),
    guidance:
      "Choose the ONE most useful next thing. If several are missing, ask for the one that unblocks the most. Derivable things (benefit class, geography, the policy month) are never asked.",
  });
}

// ---------------------------------------------------------------------------
// ask_member — one question, only what is missing
// ---------------------------------------------------------------------------

const askSchema = z.strictObject({
  field_key: z.enum(FIELD_KEYS),
  question: z.string().trim().min(8).max(240),
});

function askMember(ctx: ServicingToolContext, args: unknown): ServicingToolResult {
  const parsed = askSchema.safeParse(args);
  if (!parsed.success) return err(issuesToMessage(parsed.error, args));
  const { field_key: key, question } = parsed.data;
  const draft = ctx.draft;

  if (ctx.clarificationCount >= ctx.limits.clarificationRounds) {
    return err(`clarification limit reached (${ctx.limits.clarificationRounds} questions asked) — call escalate with cause clarification_limit; do not ask another`);
  }
  if (ctx.openQuestion !== null) return err(`one question at a time — a question about ${ctx.openQuestion} is still waiting on the member`);
  if (ctx.awaitingConfirmation) return err("the confirm card is on screen and the member has not answered it yet");
  if (!fieldsFor(draft.intent).includes(key)) return err(`${key} is not something this request needs — valid: ${fieldsFor(draft.intent).join(", ")}`);
  if (hasOpenConflict(draft, key)) return err(`${key} is disputed, not missing — call flag_conflict with field_key "${key}"`);

  const known = draft.facts[key];
  if (known) {
    return err(`${key} is already known: ${JSON.stringify(known.value)} (${known.source}). Never ask for what is already known — use it`);
  }

  // The question may not smuggle in a number nobody observed, or a word a member should not read.
  const allowed = observedNumbers(draft.facts, ctx.memberMessages);
  const stray = numbersIn(question).filter((n) => !allowed.has(n));
  if (stray.length > 0) return err(`the question cites ${stray.join(", ")}, which nobody stated — a question may only repeat figures the member gave`);
  const violations = memberCopyViolations(question);
  if (violations.length > 0) return err(`the question is not fit for a member to read: ${violations.join("; ")}`);
  if ((question.match(/\?/g) ?? []).length > 1) return err("ask ONE question — this contains more than one");

  ctx.openQuestion = key;
  ctx.clarificationCount += 1;
  return ok({ asked: key, clarificationsUsed: ctx.clarificationCount, waiting: "the member's answer" }, { card: questionCard(key, question) });
}

// ---------------------------------------------------------------------------
// flag_conflict — two sources, one question, neither pre-selected
// ---------------------------------------------------------------------------

function flagConflict(ctx: ServicingToolContext, args: unknown): ServicingToolResult {
  const parsed = z.strictObject({ field_key: z.enum(FIELD_KEYS) }).safeParse(args);
  if (!parsed.success) return err(issuesToMessage(parsed.error, args));
  const key = parsed.data.field_key;
  const conflict = ctx.draft.conflicts.find((c) => c.fieldKey === key && !c.resolved);
  if (!conflict) return err(`there is no open conflict on ${key} — record_fact reports one when two sources disagree`);
  if (ctx.openQuestion !== null) return err(`one question at a time — a question about ${ctx.openQuestion} is still waiting`);
  if (ctx.clarificationCount >= ctx.limits.clarificationRounds) return err("clarification limit reached — call escalate with cause unresolved_conflict or clarification_limit");
  ctx.openQuestion = key;
  ctx.clarificationCount += 1;
  return ok({ asked: `conflict:${key}`, clarificationsUsed: ctx.clarificationCount }, { card: conflictCard(conflict, ctx.policy.inceptionDate) });
}

// ---------------------------------------------------------------------------
// confirm_details — the model's reading meets the member's knowledge, before any money
// ---------------------------------------------------------------------------

function confirmDetails(ctx: ServicingToolContext): ServicingToolResult {
  const c = completeness(ctx.draft);
  if (!c.readyToConfirm) {
    return err(
      `not ready to confirm — missing: [${c.missing.join(", ")}]${c.openConflicts.length ? `; disputed: [${c.openConflicts.join(", ")}]` : ""}${c.benefitClassSet ? "" : "; benefit class not set (classify_benefit)"}`,
    );
  }
  if (ctx.awaitingConfirmation) return err("the confirm card is already on screen — wait for the member");
  // The member has already said this reading is right, and nothing has changed since: every tool that invalidates
  // a confirmation clears the flag itself (record_fact on a real change, a raised conflict, classify_benefit on a
  // real change), so `confirmed` standing means the card would be identical. Asking again is not a step forward —
  // the member reads the same card twice and concludes the system is not listening.
  if (ctx.draft.confirmed) return err("the member has already confirmed these details and nothing has changed since — call adjudicate. Do not ask the same question twice");
  if (ctx.openQuestion !== null) return err(`a question about ${ctx.openQuestion} is still waiting on the member`);
  ctx.awaitingConfirmation = true;
  return ok({ shown: "confirm", waiting: "the member to say it is right, or to change something" }, { card: confirmCard(ctx.draft, ctx.policy.inceptionDate) });
}

// ---------------------------------------------------------------------------
// adjudicate — the agent decides WHEN; the engine decides WHAT IT COSTS
// ---------------------------------------------------------------------------

function adjudicateTool(ctx: ServicingToolContext, args: unknown): ServicingToolResult {
  // No arguments, and `strict`: there is nowhere to put an amount. The money comes from the validated draft.
  const parsed = z.strictObject({}).safeParse(args ?? {});
  if (!parsed.success) return err(`adjudicate takes no arguments — the amount, date, provider and class come from the validated draft. ${issuesToMessage(parsed.error, args)}`);

  const c = completeness(ctx.draft);
  if (!c.readyToConfirm) return err(`not ready — missing: [${c.missing.join(", ")}]${c.openConflicts.length ? `; disputed: [${c.openConflicts.join(", ")}]` : ""}${c.benefitClassSet ? "" : "; benefit class not set"}`);
  if (!ctx.draft.confirmed) return err("the member has not confirmed the details yet — call confirm_details, then wait. Nothing is computed against a reading the member has not checked");

  const input = toAdjudicationInput(ctx.draft, { plan: ctx.plan, ledger: ctx.ledger, policyStatus: ctx.policy.status }, { inceptionDate: ctx.policy.inceptionDate, currentPolicyMonth: currentPolicyMonth(ctx) });
  const result = adjudicate(input);
  const kind = kindOf(ctx.draft);
  const facts = nextStepFacts({ plan: ctx.plan, kind, benefitClass: input.benefitClass, providerTier: input.providerTier, policyMonth: input.policyMonth, inceptionDate: ctx.policy.inceptionDate, result });

  const live = liveHistory(ctx);
  const template = explain({
    kind,
    eventRef: ctx.eventRef,
    policyRef: ctx.policy.ref,
    plan: ctx.plan,
    inceptionDate: ctx.policy.inceptionDate,
    policyMonth: input.policyMonth,
    benefitClass: input.benefitClass,
    providerTier: input.providerTier,
    geography: input.geography,
    amount: input.amount,
    result,
    priorPayable: live.filter((h) => h.kind !== "preauth" && (h.planPays ?? 0) > 0 && h.benefitClass).map((h) => ({ ref: h.ref, month: h.policyMonth, benefitClass: h.benefitClass!, planPays: h.planPays ?? 0 })),
    priorDenied: live.filter((h) => h.outcome === "denied" && h.benefitClass && h.reasonCode).map((h) => ({ ref: h.ref, month: h.policyMonth, benefitClass: h.benefitClass!, reasonCode: h.reasonCode! })),
  });

  ctx.result = { ...result, input, facts, template };
  return ok({
    kind,
    outcome: result.outcome,
    reasonCode: result.reasonCode,
    planPays: result.planPays,
    memberPays: result.memberPays,
    deductibleApplied: result.deductibleApplied,
    clippedBy: result.clippedBy,
    calculation: result.calculation,
    nextSteps: facts,
    templateExplanation: template,
    note: "these figures came from the engine. propose_outcome may cite only figures that appear in this observation — write the explanation from it, or improve on templateExplanation",
  });
}

// ---------------------------------------------------------------------------
// propose_outcome — TERMINAL. The explanation, checked.
// ---------------------------------------------------------------------------

const proposeSchema = z.strictObject({
  member_explanation: z.string().trim().min(40).max(1200),
  broker_explanation: z.string().trim().min(40).max(1200),
  confidence: z.enum(["high", "medium", "low"]),
  uncertainty_reason: z.string().trim().min(20).max(400).optional(),
});

function proposeOutcome(ctx: ServicingToolContext, args: unknown): ServicingToolResult {
  const parsed = proposeSchema.safeParse(args);
  if (!parsed.success) return err(issuesToMessage(parsed.error, args));
  const { member_explanation: member, broker_explanation: broker, confidence, uncertainty_reason } = parsed.data;
  const r = ctx.result;
  if (!r) return err("call adjudicate first — there is no result to explain");

  // The undecidable case is not a low-confidence answer, it is the absence of one. There is nothing to propose:
  // the only route is a person, and `escalate` is how it gets there.
  if (r.outcome === "insufficient_data") {
    return err("insufficient_data is not an answer to propose — the plan data does not decide it. Call escalate with cause insufficient_data and a member_message; a person decides");
  }
  if (confidence !== "high" && !uncertainty_reason) return err(`confidence ${confidence} needs uncertainty_reason: say, in a sentence, why this needs a person's attention`);

  const violations = memberCopyViolations(member);
  if (violations.length > 0) return err(`member_explanation is not fit for a member to read: ${violations.join("; ")}`);
  if (normalise(member) === normalise(broker)) return err("the two explanations are identical — the broker's is a different document with a different job: which policy, which event, when, what it implies");
  if (!INTERNAL_REF.test(broker)) return err(`broker_explanation must name the policy or event (${ctx.policy.ref}, ${ctx.eventRef}) — that is what makes it the broker's`);

  // Every figure must have come from an observation. This is the whole point of the design.
  const observed = observedNumbers(r.input.plan, r.input.amount, r.input.policyMonth, r, r.facts, ctx.ledger, ctx.draft.facts, ctx.policy.ref, ctx.eventRef, ctx.policy.inceptionDate, ctx.today);
  const invented = [...new Set([...numbersIn(member), ...numbersIn(broker)])].filter((n) => !observed.has(n));
  if (invented.length > 0) return err(`figure(s) ${invented.map((n) => n.toLocaleString("en")).join(", ")} appear in your explanation but in no observation — every figure must come from a tool result`);

  if (r.memberPays !== null && r.memberPays > 0 && !numbersIn(member).includes(r.memberPays)) {
    return err(`member_explanation must say what the member pays (${r.memberPays.toLocaleString("en")}) — it is the number the card shows, and the prose must agree with it`);
  }

  const kind = kindOf(ctx.draft);
  const body = {
    kind,
    title: String(ctx.draft.facts.treatment!.value),
    policyMonth: r.input.policyMonth,
    inceptionDate: ctx.policy.inceptionDate,
    benefitClass: r.input.benefitClass,
    amount: r.input.amount,
    result: r,
    explanation: member,
    facts: r.facts,
  };
  ctx.proposed = { confidence, uncertaintyReason: uncertainty_reason ?? null };
  return ok(
    { outcome: r.outcome, reasonCode: r.reasonCode, confidence, uncertaintyReason: uncertainty_reason ?? null, memberExplanation: member, brokerExplanation: broker },
    { card: kind === "preauth" ? estimateCard(body) : outcomeCard(body), terminal: "outcome" },
  );
}

// ---------------------------------------------------------------------------
// escalate — TERMINAL. A cause is only ever true.
// ---------------------------------------------------------------------------

const escalateSchema = z.strictObject({
  cause: z.enum(ESCALATION_CAUSES),
  /** For the broker's queue. Never shown to the member. */
  note: z.string().trim().max(300).optional(),
  /** What the member is told above the card — required when the plan data could not decide, so nobody lands on a card unexplained. */
  member_message: z.string().trim().min(40).max(1200).optional(),
});

/** Which causes the current state actually justifies. */
function justified(ctx: ServicingToolContext): Record<EscalationCause, boolean> {
  const c = completeness(ctx.draft);
  return {
    insufficient_data: ctx.result?.outcome === "insufficient_data",
    unresolved_conflict: c.openConflicts.length > 0 && ctx.clarificationCount >= 1,
    // Either the allowance is spent, or the member is unsure of the provider type AND has told us the
    // provider's name and it still does not place them — asking again would not help.
    clarification_limit:
      ctx.clarificationCount >= ctx.limits.clarificationRounds ||
      (ctx.providerUnsure && ctx.draft.facts.provider_name !== undefined && c.missing.includes("provider_type")),
    evidence_limit: ctx.evidenceRequestCount >= ctx.limits.evidenceRequestRounds,
    appeal_overturn: ctx.overturnReady,
    // Only an appeal can reach this, and appeals have their own tool set (lib/ai/tools/appeal.ts).
    correction_needs_review: false,
    reassessment_change: ctx.reassessmentRecommendsChange,
    model_failure: true,
    member_requested: true,
  };
}

function escalate(ctx: ServicingToolContext, args: unknown): ServicingToolResult {
  const parsed = escalateSchema.safeParse(args);
  if (!parsed.success) return err(issuesToMessage(parsed.error, args));
  const { cause, note, member_message } = parsed.data;
  const j = justified(ctx);
  if (!j[cause]) {
    const valid = ESCALATION_CAUSES.filter((x) => j[x]);
    return err(`cannot escalate as ${cause} (${ESCALATION_MEANING[cause]}) — the state does not show it. Causes that hold right now: [${valid.join(", ")}]`);
  }

  if (cause === "insufficient_data" && !member_message) {
    return err("insufficient_data needs a member_message: tell the member, in their words, that the plan terms do not decide this and that a person will look — and that nothing they sent is lost");
  }
  if (member_message) {
    const violations = memberCopyViolations(member_message);
    if (violations.length > 0) return err(`member_message is not fit for a member to read: ${violations.join("; ")}`);
    const r = ctx.result;
    const observed = observedNumbers(r?.input.plan, r?.input.amount, r?.input.policyMonth, r?.facts, ctx.ledger, ctx.draft.facts, ctx.policy.inceptionDate, ctx.today);
    const invented = numbersIn(member_message).filter((n) => !observed.has(n));
    if (invented.length > 0) return err(`figure(s) ${invented.join(", ")} appear in member_message but in no observation`);
  }

  const treatment = ctx.draft.facts.treatment?.value;
  const summary = [
    treatment ? `Your ${KIND_OF[kindOf(ctx.draft)]}: ${treatment}` : `Your ${KIND_OF[kindOf(ctx.draft)]}`,
    `The ${Object.keys(ctx.draft.facts).length} details you've given us so far`,
    "What we could and couldn't work out from your plan",
    "Your conversation with us, so nothing needs repeating",
  ];
  // The cause goes in `data` for the broker's queue — and NOT on the card, which is the member's.
  return ok({ cause, note: note ?? null, memberMessage: member_message ?? null, reference: ctx.eventRef }, { card: escalationCard(ctx.eventRef, summary), terminal: "escalation" });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export function runServicingTool(ctx: ServicingToolContext, name: string, args: unknown): ServicingToolResult {
  // An appeal has its own registry: the claim tools are not the agent's to call there.
  if (ctx.appeal) return runAppealTool(ctx, name, args);
  if (ctx.proposed !== null) return err("the turn has already ended with an outcome — no further tool calls");
  switch (name as ServicingToolName) {
    case "read_policy":
      return readPolicy(ctx);
    case "read_ledger":
      return readLedger(ctx);
    case "read_event_history":
      return readEventHistory(ctx, args);
    case "read_applicant_record":
      return readApplicantRecord(ctx);
    case "get_plan_terms":
      return getPlanTerms(ctx, args);
    case "check_network_admission":
      return checkNetworkAdmission(ctx, args);
    case "record_fact":
      return recordFact(ctx, args);
    case "classify_benefit":
      return classifyBenefit(ctx, args);
    case "list_missing_facts":
      return listMissingFacts(ctx);
    case "ask_member":
      return askMember(ctx, args);
    case "flag_conflict":
      return flagConflict(ctx, args);
    case "confirm_details":
      return confirmDetails(ctx);
    case "adjudicate":
      return adjudicateTool(ctx, args);
    case "propose_outcome":
      return proposeOutcome(ctx, args);
    case "escalate":
      return escalate(ctx, args);
    default:
      return err(`unknown tool "${name}" — valid tools: ${TOOL_NAMES.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// Descriptions — built from the live vocabulary, so the model is never told a set that differs from the validated one
// ---------------------------------------------------------------------------

export function describeServicingTools(ctx: ServicingToolContext): Record<ServicingToolName, string> {
  const fields = fieldsFor(ctx.draft.intent).join(", ");
  const tiers = claimProviderTierEnum.join(", ");
  const classes = benefitClassEnum.join(", ");
  const planIds = ctx.catalogue.map((p) => p.id).join(", ");
  const causes = ESCALATION_CAUSES.join(", ");
  const declared = ctx.applicant.conditions.map((c) => c.name);
  // Only describe the fields THIS kind of request has: telling the model about one the tool then rejects is a trap.
  const applies = new Set<string>(fieldsFor(ctx.draft.intent));
  const valueHints = [
    applies.has("treatment_date") ? "treatment_date is YYYY-MM-DD" : null,
    applies.has("amount") ? "amount is a number" : null,
    applies.has("provider_type") ? `provider_type one of [${tiers}]` : null,
    applies.has("paid_by_member") ? "paid_by_member is true/false" : null,
  ].filter((x): x is string => x !== null);
  return {
    read_policy: "no args — the policy, plan, today's date and the current policy month",
    read_ledger: "no args — what has been used (deductible, annual limit, maternity) and what remains",
    read_event_history: `{ benefit_class? } — benefit_class one of [${classes}]. Earlier events on this policy; superseded ones are omitted`,
    read_applicant_record: `no args — what the member already declared at intake${declared.length ? `: [${declared.join(", ")}]` : " (no conditions)"}. NEVER ask for these`,
    get_plan_terms: `{ plan_id } — plan_id one of [${planIds}]`,
    check_network_admission: `{ provider_type } — one of [${tiers}]`,
    record_fact: `{ field_key, value, basis, quote, resolves_conflict? } — field_key one of [${fields}]. basis is "stated" (the quote contains the value) or "inferred" (you derived it; the member will check it). quote is VERBATIM from the member. ${valueHints.join("; ")}${valueHints.length ? ". " : ""}You never compute a policy month — give the date`,
    classify_benefit: `{ benefit_class, declared_condition? } — benefit_class one of [${classes}]. chronic_preexisting REQUIRES declared_condition, and it must be one the member declared${declared.length ? `: [${declared.join(", ")}]` : " — they declared none, so it can never be chronic_preexisting"}. A condition that first arose after inception is general`,
    list_missing_facts: "no args — what is known, what is missing, what is disputed, and how many questions remain",
    ask_member: `{ field_key, question } — field_key one of the MISSING fields in [${fields}]. ONE question, under 240 characters, no figures the member did not give. Rejected if that field is already known, if a question is already open, or once the limit of ${ctx.limits.clarificationRounds} is reached`,
    flag_conflict: `{ field_key } — only when record_fact reported a conflict on that field. Asks the member which of the two values is right`,
    confirm_details: "no args — shows the member what you have understood, BEFORE any money is computed. Then wait",
    adjudicate: "no args — computes the outcome from the confirmed draft. It takes no amount: there is nowhere to put one",
    propose_outcome: `{ member_explanation, broker_explanation, confidence: high|medium|low, uncertainty_reason? } — TERMINAL. Two different documents. Every figure must appear in an observation. Anything below high needs uncertainty_reason. Refused for insufficient_data: that goes to escalate`,
    escalate: `{ cause, note?, member_message? } — TERMINAL. cause one of [${causes}], and only one the state actually justifies. note is for the broker; member_message is what the member reads (required for insufficient_data)`,
  };
}

/** A fresh, empty context for one conversation. The harness and (in phase 4) the session both start here. */
export function createServicingContext(
  input: Pick<ServicingToolContext, "policy" | "plan" | "catalogue" | "ledger" | "history" | "applicant" | "today" | "eventRef" | "limits"> & { draft: Draft },
): ServicingToolContext {
  return {
    ...input,
    memberMessages: [],
    openQuestion: null,
    awaitingConfirmation: false,
    providerUnsure: false,
    clarificationCount: 0,
    result: null,
    proposed: null,
    evidenceRequestCount: 0,
    overturnReady: false,
    reassessmentRecommendsChange: false,
    appeal: null,
  };
}
