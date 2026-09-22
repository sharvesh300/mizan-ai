// What a servicing conversation can know — a closed set — and what it needs.
//
// The agent decides WHICH gap to close next; it does not decide what the gaps are.
// That is this table (plan §5.1). A required field is deterministic because it
// decides whether the loop continues at all; choosing between two missing fields is
// the agent's call, and it has to justify the choice.
//
// Every fact carries where it came from, because that is what makes the confirm
// card honest: a fact the member STATED is theirs; a fact the model INFERRED is a
// reading, and the member is asked to check it before any money is computed.
//
// Pure, and free of `server-only`, like everything in lib/servicing.

import { z } from "zod";
import { claimProviderTierEnum, type BenefitClass, type EventKind } from "@/db/schema/enums";
import { isRealDate, monthOfDate } from "./dates";
import type { AdjudicationInput } from "./types";

export const FIELD_KEYS = ["treatment", "treatment_date", "provider_type", "provider_name", "amount", "paid_by_member"] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

/** What the member is asking for. Claim and reimbursement are one entry point; "have you already paid?" is a fact. */
export type Intent = "preauth" | "claim";

export const FIELD_LABEL: Record<FieldKey, string> = {
  treatment: "Treatment",
  treatment_date: "When",
  provider_type: "Provider",
  provider_name: "Provider's name",
  amount: "Amount",
  paid_by_member: "Paid",
};

/**
 * Required per intent. A pre-authorization is about a FUTURE treatment, so it has no date to
 * ask for (it is forecast against today), and nothing has been paid yet.
 */
export const REQUIRED_FIELDS: Record<Intent, readonly FieldKey[]> = {
  preauth: ["treatment", "provider_type", "amount"],
  claim: ["treatment", "treatment_date", "provider_type", "amount", "paid_by_member"],
};

/** Worth having for the record, never worth blocking on. */
export const OPTIONAL_FIELDS: Record<Intent, readonly FieldKey[]> = {
  preauth: ["provider_name"],
  claim: ["provider_name"],
};

export const fieldsFor = (intent: Intent): FieldKey[] => [...REQUIRED_FIELDS[intent], ...OPTIONAL_FIELDS[intent]];

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** What a fact's value may be, per field. A closed vocabulary where one exists. */
export const FACT_VALUE: Record<FieldKey, z.ZodType<string | number | boolean>> = {
  treatment: z.string().trim().min(3).max(200),
  treatment_date: z.string().refine(isRealDate, { message: "must be a real calendar date, YYYY-MM-DD" }),
  provider_type: z.enum(claimProviderTierEnum),
  provider_name: z.string().trim().min(2).max(120),
  amount: z.number().finite().positive().max(10_000_000),
  paid_by_member: z.boolean(),
};

/**
 * Where a fact came from.
 *  stated    the member said it, and the quote contains it (checkable)
 *  inferred  the model derived it from what was said ("last week" → a date); the member confirms it
 *  record    loaded from the member's own file by the system, never asserted by the model
 *  document  read out of evidence the member supplied (phase 5)
 */
export type FactSource = "stated" | "inferred" | "record" | "document";

export type Fact = { value: string | number | boolean; source: FactSource; quote: string };

export type Conflict = {
  fieldKey: FieldKey;
  a: Fact;
  b: Fact;
  resolved: boolean;
};

export type Draft = {
  intent: Intent;
  facts: Partial<Record<FieldKey, Fact>>;
  /**
   * Set by `classify_benefit` (by: "agent") or by the member picking from a list in the no-model form (by:
   * "member"). `declaredCondition` is required — and checked — for the chronic class. WHO chose matters: the
   * confirm card marks an agent's reading "worked out — please check", and a member's own pick is theirs.
   */
  benefitClass: { value: BenefitClass; declaredCondition: string | null; by: "agent" | "member" } | null;
  conflicts: Conflict[];
  /** The member has looked at the confirm card and said it is right. Any later change clears it. */
  confirmed: boolean;
};

export const emptyDraft = (intent: Intent): Draft => ({ intent, facts: {}, benefitClass: null, conflicts: [], confirmed: false });

/** Kind is resolved by a fact, not chosen by the agent: paid → reimbursement, otherwise claim. */
export function kindOf(draft: Draft): EventKind {
  if (draft.intent === "preauth") return "preauth";
  return draft.facts.paid_by_member?.value === true ? "reimbursement" : "claim";
}

/** An unresolved conflict on a field means the field is not known — it is disputed. */
export const hasOpenConflict = (draft: Draft, key: FieldKey): boolean => draft.conflicts.some((c) => c.fieldKey === key && !c.resolved);

export type Completeness = {
  missing: FieldKey[];
  optionalMissing: FieldKey[];
  openConflicts: FieldKey[];
  benefitClassSet: boolean;
  /** Everything needed to show the member the confirm card. */
  readyToConfirm: boolean;
  /** …and the member has said it is right. */
  readyToAdjudicate: boolean;
};

export function completeness(draft: Draft): Completeness {
  const known = (key: FieldKey) => draft.facts[key] !== undefined && !hasOpenConflict(draft, key);
  const missing = REQUIRED_FIELDS[draft.intent].filter((key) => !known(key));
  const optionalMissing = OPTIONAL_FIELDS[draft.intent].filter((key) => !known(key));
  const openConflicts = draft.conflicts.filter((c) => !c.resolved).map((c) => c.fieldKey);
  const benefitClassSet = draft.benefitClass !== null;
  const readyToConfirm = missing.length === 0 && openConflicts.length === 0 && benefitClassSet;
  return { missing, optionalMissing, openConflicts, benefitClassSet, readyToConfirm, readyToAdjudicate: readyToConfirm && draft.confirmed };
}

// ---------------------------------------------------------------------------
// From a draft to an adjudication — the only place the two meet
// ---------------------------------------------------------------------------

export type AdjudicationFrame = Pick<AdjudicationInput, "plan" | "ledger" | "policyStatus">;

/**
 * Build the engine's input from what the conversation established. Every value comes from a
 * validated fact or from the policy; the model supplies none of them directly, which is what
 * keeps a number it made up out of the arithmetic. Throws if the draft is not ready.
 */
export function toAdjudicationInput(draft: Draft, frame: AdjudicationFrame, timing: { inceptionDate: string; currentPolicyMonth: number }): AdjudicationInput {
  const c = completeness(draft);
  if (!c.readyToConfirm) throw new Error("the draft is not complete");
  const tier = draft.facts.provider_type!.value as (typeof claimProviderTierEnum)[number];
  const date = draft.facts.treatment_date?.value;
  return {
    ...frame,
    // A pre-authorization has no date: it is a forecast against today.
    policyMonth: draft.intent === "preauth" || typeof date !== "string" ? timing.currentPolicyMonth : monthOfDate(timing.inceptionDate, date),
    benefitClass: draft.benefitClass!.value,
    providerTier: tier,
    // Outside the UAE is not a tier. It is the one answer the plan data cannot decide (spec §4).
    geography: tier === "unknown_foreign" ? "abroad" : "uae",
    amount: draft.facts.amount!.value as number,
    dryRun: draft.intent === "preauth",
  };
}

// ---------------------------------------------------------------------------
// Numbers a piece of prose is allowed to contain
// ---------------------------------------------------------------------------

/** Every figure in a string, as numbers. "AED 1,190" → 1190; "1 July 2026" → 1, 2026. */
export function numbersIn(text: string): number[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, "")));
}

/** Every figure appearing anywhere in a JSON-able value — the set a piece of prose may cite. */
export function observedNumbers(...values: unknown[]): Set<number> {
  const out = new Set<number>();
  const visit = (v: unknown): void => {
    if (typeof v === "number" && Number.isFinite(v)) out.add(v);
    else if (typeof v === "string") for (const n of numbersIn(v)) out.add(n);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  values.forEach(visit);
  return out;
}
