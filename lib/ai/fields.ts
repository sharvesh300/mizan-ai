import { z } from "zod";
import {
  benefitClassEnum,
  budgetBandEnum,
  conditionStabilityEnum,
  maritalStatusEnum,
  priorityTagEnum,
  relationshipTypeEnum,
  type BenefitClass,
  type BudgetBand,
  type ConditionStability,
  type MaritalStatus,
  type PriorityTag,
  type RelationshipType,
} from "@/db/schema";
import { saysNothing, type IntakeDraft } from "@/lib/intake";
import { STEPS } from "@/lib/intake-chat";

/**
 * Fields the database refuses to accept as `inferred` (see the
 * `no_inference_on_gated_fields` check on `extraction`). The agent may
 * normalise what the applicant said; it may never fill these from vibes.
 */
export const GATED_FIELD_KEYS = new Set([
  "person.relationship",
  "person.full_name",
  "application.age",
  "application.smoker",
  "application.budget",
  "application.policy_inception",
  "application.marital_status",
  "condition.raw_text",
  "condition.stability",
  "need.benefit_class",
  "need.horizon_months",
]);

/** Plain-language guidance the model gets for each field key. */
const GUIDANCE: Record<string, string> = {
  "person.relationship": `who the cover is for, relative to the applicant: one of ${relationshipTypeEnum.join(", ")}`,
  "person.full_name": "the full legal name of the person being covered — only asked when it is not the applicant",
  "application.age": "the subject's age in years, 18-100",
  "application.marital_status": `one of: ${maritalStatusEnum.join(", ")}`,
  "application.smoker": "true or false — do they smoke or vape",
  "application.emirate": "which emirate they live in (Dubai, Abu Dhabi, Sharjah, ...)",
  "application.budget": `rough monthly budget band, one of: ${budgetBandEnum.join(", ")}`,
  "application.treatment_outside_uae_expected": "true or false — do they expect treatment outside the UAE",
  "application.policy_inception": "the date cover should start, as YYYY-MM-DD",
  "condition.raw_text": "each existing health condition, in the subject's own words, one entry each",
  "condition.stability": `for each condition: ${conditionStabilityEnum.filter((s) => s !== "unknown").join(", ")}`,
  "need.benefit_class": `each thing they expect to need cover for; classify as ${benefitClassEnum.join(", ")} or leave null`,
  "need.horizon_months": "for each need, how many months away it is (0 = right now)",
  "priority.raw_text": `what matters most to them in a plan; tag as ${priorityTagEnum.join(", ")}`,
};

// ---------------------------------------------------------------------------
// Per-field validator — the agent path
// ---------------------------------------------------------------------------
//
// The LLM already performs the semantic step: "my daughter" → "child",
// "I don't want anything expensive" → "low". The validator's job is to check
// that the normalised value is in-range / in-enum, then write it to the draft.
//
// Rules:
//   - No English-text parsing. Input is the model's pre-normalised "value".
//   - rawSpan is provided so compound fields (conditions, needs) can store
//     the applicant's actual words as rawText.
//   - Return { ok: false, retry } to signal a value the model clearly got wrong.

type Applied =
  | { ok: true; draft: IntakeDraft; valueText: string }
  | { ok: false; retry: string };

const ok = (draft: IntakeDraft, valueText: string): Applied => ({ ok: true, draft, valueText });
const reject = (retry: string): Applied => ({ ok: false, retry });

const parseBool = (v: string): boolean | null => {
  if (/^(true|yes|1)$/i.test(v)) return true;
  if (/^(false|no|0)$/i.test(v)) return false;
  return null;
};

// Normalise budget strings: the LLM may output "not a concern" (with spaces)
// or the enum value "not_a_concern". Accept both.
const normaliseBudget = (v: string): BudgetBand | null => {
  const s = v.trim().toLowerCase().replace(/\s+/g, "_") as BudgetBand;
  return (budgetBandEnum as readonly string[]).includes(s) ? s : null;
};

type Validator = (draft: IntakeDraft, value: string, rawSpan: string) => Applied;

const VALIDATORS: Record<string, Validator> = {
  "person.relationship": (draft, value) => {
    const rel = value.trim().toLowerCase() as RelationshipType;
    if (!(relationshipTypeEnum as readonly string[]).includes(rel)) {
      return reject(`Relationship must be one of: ${relationshipTypeEnum.join(", ")}.`);
    }
    return ok(
      { ...draft, subjectRelationship: rel, subjectFullName: rel === "self" ? null : draft.subjectFullName },
      rel,
    );
  },

  "person.full_name": (draft, value) => {
    const fullName = value.trim();
    if (fullName.length < 2) return reject("A full name of at least 2 characters is required.");
    return ok({ ...draft, subjectFullName: fullName }, fullName);
  },

  "application.age": (draft, value) => {
    const age = Number(value.trim());
    if (!Number.isFinite(age) || age < 18 || age > 100) {
      return reject("Age must be a whole number between 18 and 100.");
    }
    return ok({ ...draft, age: Math.round(age) }, String(Math.round(age)));
  },

  "application.marital_status": (draft, value) => {
    const v = value.trim().toLowerCase() as MaritalStatus;
    if (!(maritalStatusEnum as readonly string[]).includes(v)) {
      return reject(`Marital status must be one of: ${maritalStatusEnum.join(", ")}.`);
    }
    return ok({ ...draft, maritalStatus: v }, v);
  },

  "application.smoker": (draft, value) => {
    const b = parseBool(value);
    if (b === null) return reject("Smoker must be true or false.");
    return ok({ ...draft, smoker: b }, String(b));
  },

  "application.emirate": (draft, value) => {
    const emirate = value.trim();
    if (!emirate) return reject("An emirate name is required.");
    return ok({ ...draft, emirate }, emirate);
  },

  "application.budget": (draft, value) => {
    const budget = normaliseBudget(value);
    if (!budget) {
      return reject(`Budget must be one of: ${budgetBandEnum.join(", ")}.`);
    }
    return ok({ ...draft, budget }, budget);
  },

  "application.treatment_outside_uae_expected": (draft, value) => {
    const b = parseBool(value);
    if (b === null) return reject("Expected true or false for overseas treatment.");
    return ok({ ...draft, treatmentOutsideUaeExpected: b }, String(b));
  },

  "application.policy_inception": (draft, value) => {
    const v = value.trim();
    // Strictly ISO: YYYY-MM-DD. The LLM is instructed to emit this format.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return reject("Policy inception must be in YYYY-MM-DD format.");
    }
    return ok({ ...draft, policyInception: v }, v);
  },

  "condition.raw_text": (draft, value, rawSpan) => {
    // "none" / empty signals no conditions. `saysNothing` (not a narrow
    // `/^none$/i`) is load-bearing here: `replayFromExtractions`
    // (lib/ai/intake-session.ts) re-validates a "normalised" row through
    // THIS validator using the STORED valueText — which for the scripted
    // "None of these" checkbox is the sentinel "none declared", never the
    // literal word "none". An exact-match check let that sentinel fall
    // through on replay and re-added "None of these" itself as a phantom
    // condition on every later turn. Checking both the semantic value and
    // the applicant's own words catches either producer.
    const rawText = (rawSpan.trim() || value.trim());
    if (!rawText || saysNothing(value.trim()) || saysNothing(rawSpan.trim())) {
      return ok({ ...draft, conditions: [] }, "none declared");
    }
    // Idempotent: don't append a condition already on the draft.
    const already = draft.conditions.some((c) => c.rawText.toLowerCase() === rawText.toLowerCase());
    if (already) return ok(draft, rawText);
    return ok(
      { ...draft, conditions: [...draft.conditions, { rawText, stability: "unknown" as ConditionStability }] },
      rawText,
    );
  },

  "condition.stability": (draft, value) => {
    const v = value.trim().toLowerCase() as ConditionStability;
    const allowed = conditionStabilityEnum.filter((s) => s !== "unknown");
    if (!(allowed as readonly string[]).includes(v)) {
      return reject(`Condition stability must be one of: ${allowed.join(", ")}.`);
    }
    return ok(
      { ...draft, conditions: draft.conditions.map((c) => (c.stability === "unknown" ? { ...c, stability: v } : c)) },
      v,
    );
  },

  "need.benefit_class": (draft, value, rawSpan) => {
    // Empty / "none" / "nothing specific" signals no anticipated needs — same
    // `saysNothing` fix and the same reason as `condition.raw_text` above:
    // the scripted "Nothing specific" checkbox replays through here as the
    // sentinel valueText "none stated", not the literal words.
    const rawText = (rawSpan.trim() || value.trim());
    if (!rawText || saysNothing(value.trim()) || saysNothing(rawSpan.trim())) {
      return ok({ ...draft, needs: [] }, "none stated");
    }
    const benefitClass = (benefitClassEnum as readonly string[]).includes(value.trim().toLowerCase())
      ? (value.trim().toLowerCase() as BenefitClass)
      : null;
    // Idempotent on rawText.
    const already = draft.needs.some((n) => n.rawText.toLowerCase() === rawText.toLowerCase());
    if (already) return ok(draft, rawText);
    return ok(
      { ...draft, needs: [...draft.needs, { rawText, benefitClass, horizonMonths: null }] },
      rawText,
    );
  },

  "need.horizon_months": (draft, value) => {
    const months = Number(value.trim());
    if (!Number.isFinite(months) || months < 0) {
      return reject("Need horizon must be a non-negative number of months.");
    }
    const m = Math.round(months);
    return ok(
      { ...draft, needs: draft.needs.map((n) => (n.horizonMonths == null ? { ...n, horizonMonths: m } : n)) },
      String(m),
    );
  },

  "priority.raw_text": (draft, value, rawSpan) => {
    const rawText = (rawSpan.trim() || value.trim());
    if (!rawText) return ok({ ...draft, priorities: [] }, "none stated");
    const tag = (priorityTagEnum as readonly string[]).includes(value.trim().toLowerCase())
      ? (value.trim().toLowerCase() as PriorityTag)
      : ("other" as PriorityTag);
    const already = draft.priorities.some((p) => p.rawText.toLowerCase() === rawText.toLowerCase());
    if (already) return ok(draft, rawText);
    return ok(
      { ...draft, priorities: [...draft.priorities, { rawText, tag }] },
      rawText,
    );
  },
};

export type FieldSpec = {
  key: string;
  severity: (typeof STEPS)[number]["severity"];
  table: string;
  column: string;
  guidance: string;
  /** The scripted question, used verbatim when the model is unavailable. */
  fallbackPrompt: (draft: IntakeDraft) => string;
  suggestions?: (draft: IntakeDraft) => string[];
  /**
   * True for the applicant's own profile fields (`person.*`, `application.*`)
   * — structured, regulated attributes the app already has a settled way of
   * asking. The model's wording for these is discarded in favour of
   * `fallbackPrompt`; tailoring is reserved for the conversational fields
   * (conditions, needs, priorities) where it actually helps.
   */
  scriptedWording: boolean;
  /**
   * Validate the LLM's pre-normalised value and apply it to the draft.
   *
   * Input (`value`) is the model's "value" field — already normalised,
   * e.g. "child", "20", "low", "managed". This function does NOT parse
   * freeform English; it only checks in-range / in-enum membership and
   * writes to the draft.
   *
   * `rawSpan` is the applicant's exact words. Compound fields (conditions,
   * needs, priorities) store it as `rawText` on the draft entry.
   */
  validate: Validator;
};

const FALLBACK_VALIDATOR: Validator = (_draft, _value, _rawSpan) =>
  reject("No validator registered for this field — value was not accepted.");

export const FIELDS: FieldSpec[] = STEPS.map((step) => ({
  key: step.key,
  severity: step.severity,
  table: step.target.table,
  column: step.target.column,
  guidance: GUIDANCE[step.key] ?? step.key,
  fallbackPrompt: step.prompt,
  suggestions: step.suggestions,
  scriptedWording: step.key.startsWith("person.") || step.key.startsWith("application."),
  validate: VALIDATORS[step.key] ?? FALLBACK_VALIDATOR,
}));

export const fieldByKey = (key: string) => FIELDS.find((f) => f.key === key);

/** `block` first — an application cannot be created without those. */
const SEVERITY_ORDER = { block: 0, review: 1, warn: 2 } as const;

/**
 * Which field keys the draft still has nothing for, hardest-blocking first.
 * Deterministic on purpose: the model decides how to ask, never whether a
 * required field can be waved through.
 */
export function missingFields(draft: IntakeDraft, settled: Set<string>): FieldSpec[] {
  const has: Record<string, boolean> = {
    "person.relationship": draft.subjectRelationship != null,
    // Not missing once we know it's the applicant — there is nothing more to name.
    "person.full_name": draft.subjectRelationship === "self" || Boolean(draft.subjectFullName),
    "application.age": draft.age != null,
    "application.marital_status": draft.maritalStatus != null,
    "application.smoker": draft.smoker != null,
    "application.emirate": Boolean(draft.emirate),
    "application.budget": draft.budget != null,
    "application.treatment_outside_uae_expected": settled.has("application.treatment_outside_uae_expected"),
    "application.policy_inception": Boolean(draft.policyInception),
    "condition.raw_text": settled.has("condition.raw_text") || draft.conditions.length > 0,
    // Only a real gap once conditions exist and one is still unclassified.
    "condition.stability":
      draft.conditions.length === 0 || draft.conditions.every((c) => c.stability !== "unknown"),
    "need.benefit_class": draft.needs.length === 0 || draft.needs.every((n) => n.benefitClass != null),
    "need.horizon_months": draft.needs.length === 0 || draft.needs.every((n) => n.horizonMonths != null),
    "priority.raw_text": settled.has("priority.raw_text") || draft.priorities.length > 0,
  };

  return FIELDS.filter((field) => !(has[field.key] ?? false) && !settled.has(field.key)).sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}

/** The catalogue the extraction prompt renders. */
export const fieldCatalogue = () => FIELDS.map((f) => `- ${f.key} (${f.severity}): ${f.guidance}`).join("\n");

// ---------------------------------------------------------------------------
// How each field is put to the applicant
// ---------------------------------------------------------------------------

/**
 * The control a field is answered with, and the options it offers.
 *
 * The model picks wording; the CONTROL is decided here. A small free model
 * asked to choose both will offer a budget band as a number box one run and a
 * checkbox list the next — and every option below is written to survive the
 * deterministic parser it feeds ("More than 12 months" parses, "More than a
 * year" does not). Changing a label means re-checking `apply` in
 * lib/intake-chat.ts.
 */
export const CONTROL_KINDS = ["radio", "multi", "text", "number", "date"] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

type ControlSpec = {
  control: ControlKind;
  choices?: string[];
  placeholder?: string;
  /** Bounds for `number`, so the box itself states what the parser will accept. */
  min?: number;
  max?: number;
  /**
   * True when the deterministic parser only understands these exact options.
   * The model may reword the QUESTION for these, never the answers — an
   * improvised budget band is a value `parseBudget` cannot read.
   */
  fixed?: boolean;
};

const CONTROLS: Record<string, ControlSpec> = {
  "person.relationship": {
    control: "radio",
    choices: ["Myself", "My spouse", "My child", "My parent", "Someone else"],
    fixed: true,
  },
  "person.full_name": { control: "text", placeholder: "e.g. Fatima Al Suwaidi" },
  // 18-100 is what `parseAge` accepts; saying so on the control keeps the
  // applicant from submitting a child's age into the policyholder's field.
  "application.age": { control: "number", placeholder: "e.g. 34", min: 18, max: 100 },
  "application.marital_status": {
    control: "radio",
    choices: ["Single", "Married", "Divorced", "Widowed"],
    fixed: true,
  },
  "application.smoker": { control: "radio", choices: ["No", "Yes"], fixed: true },
  "application.emirate": {
    control: "radio",
    choices: ["Dubai", "Abu Dhabi", "Sharjah", "Ajman", "Ras Al Khaimah", "Fujairah", "Umm Al Quwain"],
  },
  "application.budget": {
    control: "radio",
    choices: ["Low", "Moderate", "Comfortable", "Not a concern"],
    fixed: true,
  },
  "application.treatment_outside_uae_expected": {
    control: "radio",
    choices: ["No", "Yes, sometimes"],
    fixed: true,
  },
  "application.policy_inception": { control: "date" },
  "condition.raw_text": {
    control: "multi",
    choices: [
      "None of these",
      "Diabetes",
      "High blood pressure",
      "Asthma",
      "High cholesterol",
      "Thyroid condition",
      "A heart condition",
    ],
  },
  "condition.stability": {
    control: "radio",
    choices: ["Well managed", "Not under control right now"],
    fixed: true,
  },
  "need.benefit_class": {
    control: "multi",
    choices: [
      "Nothing specific",
      "Maternity",
      "Care for an ongoing condition",
      "Dental or optical",
      "A planned procedure",
    ],
  },
  "need.horizon_months": {
    control: "radio",
    choices: ["Within 3 months", "About 6 months", "About 12 months", "More than 12 months"],
    fixed: true,
  },
  "priority.raw_text": {
    control: "multi",
    choices: [
      "Lowest premium",
      "Good hospital access",
      "Cover for an existing condition",
      "Maternity cover",
      "Low co-pay or deductible",
    ],
  },
};

export const controlFor = (fieldKey: string): ControlSpec => CONTROLS[fieldKey] ?? { control: "text" };

/** Short human label for a field, used when writing answers into the transcript. */
const LABELS: Record<string, string> = {
  "person.relationship": "Applying for",
  "person.full_name": "Full name",
  "application.age": "Age",
  "application.marital_status": "Marital status",
  "application.smoker": "Smoker",
  "application.emirate": "Emirate",
  "application.budget": "Budget",
  "application.treatment_outside_uae_expected": "Treatment outside the UAE",
  "application.policy_inception": "Cover starts",
  "condition.raw_text": "Conditions",
  "condition.stability": "Condition control",
  "need.benefit_class": "Expecting to need",
  "need.horizon_months": "How soon",
  "priority.raw_text": "What matters most",
};

export const labelForField = (fieldKey: string) => LABELS[fieldKey] ?? fieldKey;

/**
 * Which intake fields an assessment flag is actually about.
 *
 * `assessment_flag.fields` names things in the rules' vocabulary
 * ("near_term_needs"), and the questionnaire asks in the intake vocabulary
 * ("need.horizon_months"). This is the join between them, so an advisor
 * clicking "ask for more" on a flagged record gets the right boxes ticked
 * without having to know either vocabulary.
 *
 * Anything with no intake question behind it — expected providers, the person
 * row — maps to nothing on purpose: offering to ask for something the
 * questionnaire cannot collect would be a dead end.
 */
const FLAG_FIELD_TO_KEYS: Record<string, string[]> = {
  near_term_needs: ["need.benefit_class", "need.horizon_months"],
  conditions: ["condition.raw_text", "condition.stability"],
  budget: ["application.budget"],
  age: ["application.age"],
  relationship: ["person.relationship"],
  smoker: ["application.smoker"],
  policy_inception: ["application.policy_inception"],
  treatment_outside_uae_expected: ["application.treatment_outside_uae_expected"],
};

export const fieldKeysForFlagFields = (names: string[]): string[] => [
  ...new Set(names.flatMap((name) => FLAG_FIELD_TO_KEYS[name] ?? [])),
];

/** Everything the questionnaire can ask for, in a stable order. */
export const askableFields = () => FIELDS.map((field) => ({ key: field.key, label: labelForField(field.key) }));

/** The outstanding fields, described for the prompt with their controls. */
export const questionCatalogue = (keys: string[]) =>
  keys
    .map((key) => {
      const field = fieldByKey(key);
      const spec = controlFor(key);
      const choices = spec.choices
        ? ` | options: ${spec.choices.join(" / ")}${spec.fixed ? " (use these exactly)" : " (you may tailor these)"}`
        : "";
      const wording = field?.scriptedWording ? ", wording fixed — leave questionText \"\"" : "";
      return `- ${key} [${field?.severity ?? "warn"}, ${spec.control}${choices}${wording}]: ${field?.guidance ?? key}`;
    })
    .join("\n");

// ---------------------------------------------------------------------------
// Structured output shapes
// ---------------------------------------------------------------------------

/**
 * One extracted value. `rawSpan` must be the applicant's own words — it is
 * written to `extraction.raw_span`, which is what an advisor reads when they
 * want to know where a field came from.
 */
const toPlainString = z.unknown().transform((v) => (v == null ? "" : String(v).trim()));

export const extractedValueSchema = z.object({
  fieldKey: z.string(),
  value: toPlainString.describe("the normalised value, as plain text"),
  rawSpan: toPlainString.describe("the exact words the applicant used"),
  confidence: z.coerce.number().min(0).max(1).catch(0.8),
  inferred: z.coerce.boolean().catch(false).describe("true if this is a guess rather than something they said"),
});

export const proposedQuestionSchema = z.object({
  fieldKey: z.string(),
  questionText: z.string().catch("").describe("the question itself, under 20 words, no preamble"),
  helpText: z.string().catch("").describe("optional one-line clarification, or empty"),
  control: z.enum(CONTROL_KINDS).catch("text"),
  options: z.array(z.string()).max(8).catch([]),
});

/**
 * One turn, one call.
 *
 * Reading the message, replying to it and deciding what to ask next are the
 * same act of understanding — splitting them into two calls made the reply
 * ignorant of the questions underneath it, and doubled the latency on free
 * models that are already slow.
 *
 * We parse elements safely so a small model outputting a number (e.g. age: 20)
 * or fumbling an optional field does not discard the rest of the extracted
 * values in the turn.
 */
export const turnSchema = z.object({
  reply: z.string().catch("").describe("what you say back — warm, specific, 1-2 sentences"),
  values: z
    .preprocess((val) => (Array.isArray(val) ? val : []), z.array(z.unknown()))
    .transform((items) => {
      const valid: z.infer<typeof extractedValueSchema>[] = [];
      for (const item of items) {
        const parsed = extractedValueSchema.safeParse(item);
        if (parsed.success) valid.push(parsed.data);
      }
      return valid;
    }),
  questions: z
    .preprocess((val) => (Array.isArray(val) ? val : []), z.array(z.unknown()))
    .transform((items) => {
      const valid: z.infer<typeof proposedQuestionSchema>[] = [];
      for (const item of items) {
        const parsed = proposedQuestionSchema.safeParse(item);
        if (parsed.success) valid.push(parsed.data);
      }
      return valid.slice(0, 6);
    }),
});

export type ExtractedValue = z.infer<typeof extractedValueSchema>;
export type ProposedQuestion = z.infer<typeof proposedQuestionSchema>;
