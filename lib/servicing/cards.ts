// The card contract: everything the agent can put in front of a member (plan §13.2.4).
//
// Every agent move is one of nine cards, so the UI is a small closed set in the
// same way the agent's tools are. A card is a typed payload with a type guard,
// matching how the intake chat already does it (`isRecommendationTradeOffPayload`),
// and a tool's return value IS its payload — nothing is translated between them.
//
// Two properties this file exists to guarantee:
//
//  1. STRICT. Every schema rejects keys it does not declare. A card is what a member
//     reads, so a broker-only field (confidence, an escalation cause, a reviewer
//     note) cannot ride along on one — it is rejected, not merely ignored. That is
//     the §13.4 fence applied to the payload.
//  2. DISPLAY ONLY. What comes back from a card is never trusted as data. A chip
//     press sends WHICH chip; the server re-derives the meaning from its own row
//     (the same discipline as `answerTradeOff`). Nothing on a card is the source of
//     truth for anything.
//
// The guards are derived from the schemas, so the two cannot drift apart.

import { z } from "zod";
import {
  claimProviderTierEnum,
  eventOutcomeEnum,
  type BenefitClass,
  type EventOutcome,
  type ClaimProviderTier,
  type EventKind,
} from "@/db/schema/enums";
import { longDate, monthYear, policyMonthStart } from "./dates";
import { FIELD_KEYS, FIELD_LABEL, type Draft, type Fact, type FactSource, type FieldKey } from "./facts";
import {
  benefitClassLabel,
  benefitClassPhrase,
  figureLabels,
  providerTypeLabel,
  providerTypePlural,
} from "./labels";
import type { NextStepFacts } from "./next-steps";
import type { AdjudicationResult } from "./types";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const text = (max: number) => z.string().min(1).max(max);
const chip = z.strictObject({ label: text(60), value: text(60) });
const fieldKey = z.enum(FIELD_KEYS);
const amountOrNull = z.number().finite().nullable();
const figure = z.strictObject({ label: text(40), value: amountOrNull });

export const questionCardSchema = z.strictObject({
  kind: z.literal("servicing_question"),
  fieldKey,
  text: text(240),
  input: z.enum(["text", "amount", "date", "yes_no", "choice"]),
  /** A closed vocabulary becomes tappable chips, so the member types only when only typing will do. */
  chips: z.array(chip).max(8),
});

export const confirmCardSchema = z.strictObject({
  kind: z.literal("servicing_confirm"),
  title: text(120),
  rows: z
    .array(
      z.strictObject({
        fieldKey: z.enum([...FIELD_KEYS, "benefit_class"]),
        label: text(40),
        value: text(240),
        /** "worked_out" marks what the model derived rather than what the member said — the rows to check hardest. */
        origin: z.enum(["told_us", "on_file", "worked_out"]),
      }),
    )
    .min(1)
    .max(10),
});

export const factsFormCardSchema = z.strictObject({
  kind: z.literal("servicing_facts_form"),
  intro: text(240),
  fields: z
    .array(
      z.strictObject({
        /** `benefit_class` is not a fact: it is asked here only because, with no model, nothing else can work it out. */
        fieldKey: z.enum([...FIELD_KEYS, "benefit_class"]),
        label: text(60),
        input: z.enum(["text", "amount", "date", "yes_no", "choice"]),
        options: z.array(chip).max(8),
        required: z.boolean(),
        hint: text(160).nullable(),
        /** What is already known, so a form opened to change something starts from it — nothing is re-collected. */
        current: text(240).nullable(),
        /** Why the last answer could not be used, in words a member can act on. */
        error: text(200).nullable(),
      }),
    )
    .min(1)
    .max(7),
});

export const evidenceRequestCardSchema = z.strictObject({
  kind: z.literal("servicing_evidence_request"),
  contested: z.strictObject({ title: text(200), decision: text(160) }),
  prompt: text(300),
  /** What the document has to show — the reason code it must bear on, in words. */
  mustShow: text(300),
  /** Always true: "I don't have this" is a real action, not silence (plan §13.2.6). */
  canDecline: z.literal(true),
  round: z.number().int().min(1),
});

/**
 * The start of an appeal: what the decision turned on, and what could change it — BEFORE the member writes a word.
 * It is the admissibility table (§5.4.2) in the member's words, and the most valuable screen in the flow: it stops
 * them sending a document that cannot help and tells them which one can.
 */
export const appealIntroCardSchema = z.strictObject({
  kind: z.literal("servicing_appeal_intro"),
  contested: z.strictObject({ title: text(200), monthLabel: text(60), decision: text(120) }),
  /** "the waiting period for existing conditions" — what the decision turned on, in a phrase. */
  turnedOn: text(160),
  couldChange: z.array(text(240)).min(1).max(4),
  /** Things that sound like arguments and are not, said kindly. May be empty. */
  cannotChange: z.array(text(300)).max(4),
});

export const conflictCardSchema = z.strictObject({
  kind: z.literal("servicing_conflict"),
  fieldKey,
  label: text(40),
  question: text(240),
  /** Exactly two, neither pre-selected, each naming where it came from. */
  options: z.tuple([
    z.strictObject({ value: text(120), display: text(120), source: text(60), quote: text(240) }),
    z.strictObject({ value: text(120), display: text(120), source: text(60), quote: text(240) }),
  ]),
});

const outcomeBody = {
  title: text(200),
  monthLabel: text(60),
  categoryLabel: text(60),
  outcome: z.enum(eventOutcomeEnum),
  figures: z.strictObject({ billed: figure, plan: figure, member: figure }),
  explanation: text(1200),
  /** Dated, specific things the member can do or wait for. Computed, not written. */
  nextSteps: z.array(text(240)).max(6),
  trace: z.array(text(240)).max(12),
};

export const outcomeCardSchema = z.strictObject({
  kind: z.literal("servicing_outcome"),
  eventKind: z.enum(["claim", "reimbursement", "appeal"]),
  ...outcomeBody,
  /** Whether "Appeal this decision" is offered. */
  appealable: z.boolean(),
  /**
   * Who is paid what, in one line — or null when the explanation already says so. A card that states the
   * same sentence twice (once in the prose, once as a footer) reads as a stutter, so the footer only
   * exists when it adds something.
   */
  settlement: text(240).nullable(),
});

export const estimateCardSchema = z.strictObject({
  kind: z.literal("servicing_estimate"),
  eventKind: z.literal("preauth"),
  ...outcomeBody,
  /**
   * What this is NOT: nothing has been claimed or set aside, and it moves with the ledger. Null only when the
   * explanation already says it — an estimate always carries the caveat, in one place or the other, never both.
   */
  caveat: text(300).nullable(),
});

export const escalationCardSchema = z.strictObject({
  kind: z.literal("servicing_escalation"),
  /** Shown to the member to quote on a call. Never the reason it escalated: that is the broker's. */
  reference: text(40),
  /** "What your advisor will have" — the member's own information, so showing it costs nothing. */
  summary: z.array(text(160)).min(1).max(8),
  callbackWindows: z.array(z.enum(["morning", "afternoon", "evening"])).min(1),
});

export const servicingCardSchema = z.discriminatedUnion("kind", [
  questionCardSchema,
  confirmCardSchema,
  factsFormCardSchema,
  evidenceRequestCardSchema,
  appealIntroCardSchema,
  conflictCardSchema,
  outcomeCardSchema,
  estimateCardSchema,
  escalationCardSchema,
]);

export type QuestionCard = z.infer<typeof questionCardSchema>;
export type ConfirmCard = z.infer<typeof confirmCardSchema>;
export type FactsFormCard = z.infer<typeof factsFormCardSchema>;
export type EvidenceRequestCard = z.infer<typeof evidenceRequestCardSchema>;
export type AppealIntroCard = z.infer<typeof appealIntroCardSchema>;
export type ConflictCard = z.infer<typeof conflictCardSchema>;
export type OutcomeCard = z.infer<typeof outcomeCardSchema>;
export type EstimateCard = z.infer<typeof estimateCardSchema>;
export type EscalationCard = z.infer<typeof escalationCardSchema>;
export type ServicingCard = z.infer<typeof servicingCardSchema>;
export type ServicingCardKind = ServicingCard["kind"];

// ---------------------------------------------------------------------------
// Guards — derived from the schemas
// ---------------------------------------------------------------------------

export const isServicingCard = (payload: unknown): payload is ServicingCard => servicingCardSchema.safeParse(payload).success;
export const isQuestionCard = (p: unknown): p is QuestionCard => questionCardSchema.safeParse(p).success;
export const isConfirmCard = (p: unknown): p is ConfirmCard => confirmCardSchema.safeParse(p).success;
export const isFactsFormCard = (p: unknown): p is FactsFormCard => factsFormCardSchema.safeParse(p).success;
export const isEvidenceRequestCard = (p: unknown): p is EvidenceRequestCard => evidenceRequestCardSchema.safeParse(p).success;
export const isAppealIntroCard = (p: unknown): p is AppealIntroCard => appealIntroCardSchema.safeParse(p).success;
export const isConflictCard = (p: unknown): p is ConflictCard => conflictCardSchema.safeParse(p).success;
export const isOutcomeCard = (p: unknown): p is OutcomeCard => outcomeCardSchema.safeParse(p).success;
export const isEstimateCard = (p: unknown): p is EstimateCard => estimateCardSchema.safeParse(p).success;
export const isEscalationCard = (p: unknown): p is EscalationCard => escalationCardSchema.safeParse(p).success;

// ---------------------------------------------------------------------------
// Builders — deterministic assembly, so a tool cannot hand the UI a shape it invented
// ---------------------------------------------------------------------------

const squash = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const aed = (n: number) => `AED ${Number.isInteger(n) ? n.toLocaleString("en") : n.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The chips for a closed vocabulary. "Not sure" is a real answer: it is handled, not guessed around. */
const PROVIDER_CHIPS = [
  ...claimProviderTierEnum.map((t) => ({ label: providerTypeLabel[t], value: t as string })),
  { label: "Not sure", value: "unsure" },
];
const YES_NO_CHIPS = [
  { label: "Yes, I've paid", value: "yes" },
  { label: "No, not yet", value: "no" },
];

const INPUT_FOR: Record<FieldKey, QuestionCard["input"]> = {
  treatment: "text",
  treatment_date: "date",
  provider_type: "choice",
  provider_name: "text",
  amount: "amount",
  paid_by_member: "yes_no",
};

const chipsFor = (key: FieldKey) => (key === "provider_type" ? PROVIDER_CHIPS : key === "paid_by_member" ? YES_NO_CHIPS : []);

export const questionCard = (key: FieldKey, questionText: string): QuestionCard =>
  questionCardSchema.parse({ kind: "servicing_question", fieldKey: key, text: questionText, input: INPUT_FOR[key], chips: chipsFor(key) });

type FormKey = FieldKey | "benefit_class";

/**
 * What kind of treatment this is, as a list — for the no-model form, where nothing else can work it out.
 * A declared condition is offered by name, in the member's own words from their application, so picking it
 * re-collects nothing. Values are `general` / `maternity` / `dental_optical` / `chronic:<condition>`.
 */
export function benefitClassOptions(declaredConditions: string[]): { label: string; value: string }[] {
  return [
    ...declaredConditions.map((name) => ({ label: `An existing condition — my ${name}`, value: `chronic:${name}` })),
    { label: benefitClassLabel.general, value: "general" },
    { label: benefitClassLabel.maternity, value: "maternity" },
    { label: benefitClassLabel.dental_optical, value: "dental_optical" },
  ].slice(0, 8);
}

/**
 * The form the no-model mode shows in place of a sentence: exactly the missing fields, nothing else (plan
 * §13.2.4). Opened to CHANGE something it lists every field with its current value, so nothing is retyped.
 */
export function factsFormCard(
  missing: FieldKey[],
  optional: FieldKey[] = [],
  opts: {
    intro?: string;
    benefitClassOptions?: { label: string; value: string }[];
    current?: Partial<Record<FormKey, string>>;
    errors?: Partial<Record<FormKey, string>>;
  } = {},
): FactsFormCard {
  const one = (key: FormKey, required: boolean) => ({
    fieldKey: key,
    label: key === "benefit_class" ? "What kind of treatment is it?" : FIELD_LABEL[key],
    input: key === "benefit_class" ? ("choice" as const) : INPUT_FOR[key],
    options: key === "benefit_class" ? (opts.benefitClassOptions ?? []) : chipsFor(key).filter((c) => c.value !== "unsure"),
    required,
    hint: key === "amount" ? "The total in AED" : key === "treatment_date" ? "The day of the treatment" : null,
    current: opts.current?.[key] ?? null,
    error: opts.errors?.[key] ?? null,
  });
  return factsFormCardSchema.parse({
    kind: "servicing_facts_form",
    intro: opts.intro ?? "I only need the details below. Everything else I already have.",
    fields: [
      ...missing.map((k) => one(k, true)),
      ...(opts.benefitClassOptions ? [one("benefit_class", true)] : []),
      ...optional.map((k) => one(k, false)),
    ],
  });
}

const ORIGIN: Record<FactSource, "told_us" | "on_file" | "worked_out"> = {
  stated: "told_us",
  inferred: "worked_out",
  record: "on_file",
  document: "told_us",
};

/** A fact, as a member would read it back. */
function displayFact(key: FieldKey, fact: Fact, inceptionDate: string): string {
  switch (key) {
    case "treatment_date":
      return longDate(String(fact.value));
    case "provider_type":
      return providerTypeLabel[fact.value as ClaimProviderTier] ?? String(fact.value);
    case "amount":
      return aed(Number(fact.value));
    case "paid_by_member":
      return fact.value === true ? "Yes — you paid the provider" : "Not yet — the plan settles with the provider";
    default:
      void inceptionDate;
      return String(fact.value);
  }
}

/**
 * "Here's what I've got — is it right?" — the model's reading meeting the member's knowledge, BEFORE any
 * money is computed. Every row is something the agent extracted or inferred; "worked_out" rows are the
 * ones the member should check hardest.
 */
export function confirmCard(draft: Draft, inceptionDate: string): ConfirmCard {
  const rows: ConfirmCard["rows"] = [];
  const order: FieldKey[] = ["treatment", "treatment_date", "provider_type", "provider_name", "amount", "paid_by_member"];
  for (const key of order) {
    const fact = draft.facts[key];
    if (!fact) continue;
    rows.push({ fieldKey: key, label: FIELD_LABEL[key], value: displayFact(key, fact, inceptionDate), origin: ORIGIN[fact.source] });
  }
  if (draft.benefitClass) {
    const c = draft.benefitClass;
    rows.push({
      fieldKey: "benefit_class",
      label: "Counts as",
      // An existing condition names the condition — the member's own words from their application, which is
      // also the visible proof that nothing they already told us is asked for again.
      value: c.declaredCondition ? `${benefitClassLabel[c.value]} — your ${c.declaredCondition}` : benefitClassLabel[c.value],
      // What the member picked from a list is theirs; what the agent read out of a description is the reading to check.
      origin: c.by === "member" ? "told_us" : "worked_out",
    });
  }
  return confirmCardSchema.parse({ kind: "servicing_confirm", title: "Here's what I've got — is it right?", rows });
}

/**
 * The dated, specific things a finding leaves the member able to do — from `nextStepFacts`, never typed.
 *
 * Only the ones the explanation has NOT already said. The prose written for a member usually carries the
 * date (the template's does, and a model's should); repeating it as a bullet underneath is a stutter in
 * different words, which no sentence-level comparison can see. So each line is keyed on the figure that
 * makes it specific — a date, a list — and dropped when the explanation already contains that figure.
 */
export function nextStepLines(facts: NextStepFacts, benefitClass: BenefitClass, explanation = ""): string[] {
  const said = squash(explanation);
  const lines: string[] = [];
  const add = (line: string, needle: string) => {
    if (!said.includes(squash(needle))) lines.push(line);
  };
  if (facts.waitingPeriod) {
    const date = longDate(facts.waitingPeriod.clearsOn);
    add(`The waiting period ends on ${date}; from that date this is covered under your plan's normal terms.`, date);
  }
  if (facts.admittedProviders) {
    const covered = list(facts.admittedProviders.map((t) => providerTypePlural[t]));
    add(`Your plan covers ${covered}.`, covered);
  }
  if (facts.limit) {
    const what = facts.limit.kind === "maternity" ? `Your ${benefitClassPhrase[benefitClass]} benefit` : "Your annual limit";
    const date = longDate(facts.limit.resetsOn);
    add(`${what} starts again on ${date}.`, date);
  }
  if (facts.deductibleNowMet) add("Your deductible is now met for the year, so later claims skip that step.", "deductible is now met");
  return lines;
}

type OutcomeInput = {
  kind: EventKind;
  /** An appeal's card says what happened to the APPEAL (upheld / overturned), not what the arithmetic returned. */
  outcome?: EventOutcome;
  /** The working, when it is not the engine result's own (an appeal's carries the appeal's steps). */
  trace?: string[];
  title: string;
  policyMonth: number;
  inceptionDate: string;
  benefitClass: BenefitClass;
  amount: number;
  /** Only what a card shows of the engine's answer — an appeal's card is built from the stored row, not a live result. */
  result: Pick<AdjudicationResult, "outcome" | "planPays" | "memberPays" | "calculation">;
  explanation: string;
  facts: NextStepFacts;
};

const bodyOf = (i: OutcomeInput) => {
  const [billed, plan, member] = figureLabels[i.kind];
  return {
    title: i.title,
    monthLabel: `Month ${i.policyMonth} · ${monthYear(policyMonthStart(i.inceptionDate, i.policyMonth))}`,
    categoryLabel: benefitClassLabel[i.benefitClass],
    outcome: i.outcome ?? i.result.outcome,
    figures: {
      billed: { label: billed, value: i.amount },
      plan: { label: plan, value: i.result.planPays },
      member: { label: member, value: i.result.memberPays },
    },
    explanation: i.explanation,
    nextSteps: nextStepLines(i.facts, i.benefitClass, i.explanation),
    trace: i.trace ?? i.result.calculation,
  };
};

export function outcomeCard(i: OutcomeInput): OutcomeCard {
  if (i.kind === "preauth") throw new Error("a pre-authorization is an estimate card, not an outcome card");
  // A denial has nothing to settle — the plan pays nothing — so there is no footer to write. Saying "the plan
  // settles its share" under a claim the plan refused is not a redundancy, it is wrong.
  const line =
    i.kind === "appeal" || i.result.outcome === "denied" || i.result.outcome === "insufficient_data"
      ? null
      : i.kind === "reimbursement"
        ? "The plan's share is paid back to you rather than to the provider."
        : "The plan settles its share with the provider; the rest is yours to pay them.";
  return outcomeCardSchema.parse({
    kind: "servicing_outcome",
    eventKind: i.kind,
    ...bodyOf(i),
    appealable: i.facts.appealable,
    settlement: line === null || squash(i.explanation).includes(squash(line)) ? null : line,
  });
}

const ESTIMATE_CAVEAT = "Nothing has been claimed or set aside. This is based on what you've used so far, so it changes if other claims are paid first.";

export function estimateCard(i: OutcomeInput): EstimateCard {
  return estimateCardSchema.parse({
    kind: "servicing_estimate",
    eventKind: "preauth",
    ...bodyOf(i),
    caveat: squash(i.explanation).includes(squash(ESTIMATE_CAVEAT)) ? null : ESTIMATE_CAVEAT,
  });
}

export const escalationCard = (reference: string, summary: string[]): EscalationCard =>
  escalationCardSchema.parse({ kind: "servicing_escalation", reference, summary, callbackWindows: ["morning", "afternoon", "evening"] });

const SOURCE_LABEL: Record<FactSource, string> = {
  stated: "What you told me",
  inferred: "What I understood",
  record: "On your file",
  document: "Your document",
};

export function conflictCard(conflict: { fieldKey: FieldKey; a: Fact; b: Fact }, inceptionDate: string): ConflictCard {
  const side = (f: Fact) => ({
    value: String(f.value),
    display: displayFact(conflict.fieldKey, f, inceptionDate),
    source: SOURCE_LABEL[f.source],
    quote: f.quote,
  });
  return conflictCardSchema.parse({
    kind: "servicing_conflict",
    fieldKey: conflict.fieldKey,
    label: FIELD_LABEL[conflict.fieldKey],
    question: `These don't match. Which should I use for the ${FIELD_LABEL[conflict.fieldKey].toLowerCase()}?`,
    options: [side(conflict.a), side(conflict.b)],
  });
}

export const evidenceRequestCard = (input: Omit<EvidenceRequestCard, "kind" | "canDecline">): EvidenceRequestCard =>
  evidenceRequestCardSchema.parse({ kind: "servicing_evidence_request", canDecline: true, ...input });

/** The appeal's opening card, from the finding and the admissibility table — never typed by a model. */
export function appealIntroCard(input: {
  title: string;
  policyMonth: number;
  inceptionDate: string;
  decision: string;
  admissibility: { decisionTurnedOn: string; kinds: readonly { couldChange: string }[]; notAdmissible: readonly string[] };
}): AppealIntroCard {
  return appealIntroCardSchema.parse({
    kind: "servicing_appeal_intro",
    contested: { title: input.title, monthLabel: `Month ${input.policyMonth} · ${monthYear(policyMonthStart(input.inceptionDate, input.policyMonth))}`, decision: input.decision },
    turnedOn: input.admissibility.decisionTurnedOn,
    couldChange: input.admissibility.kinds.map((k) => k.couldChange),
    cannotChange: [...input.admissibility.notAdmissible],
  });
}
