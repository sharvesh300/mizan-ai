// The chat intake script.
//
// State is not held in memory or on the conversation row. Each question the
// assistant asks is a `conversation_question` row, and the draft is REPLAYED
// from the answered ones every time — same shape as the benefit ledger being a
// projection of the event log. So a refresh, a second tab, or coming back
// tomorrow all resume exactly where the applicant left off, and the record of
// which sentence produced which field survives in `extraction`.

import type { FlagSeverity } from "@/db/schema";
import {
  classifyBenefit,
  classifyPriority,
  classifyStability,
  defaultInception,
  emptyDraft,
  isAffirmative,
  isNegative,
  parseAge,
  parseBudget,
  parseHorizonMonths,
  parseMaritalStatus,
  saysNothing,
  splitList,
  type IntakeDraft,
} from "@/lib/intake";

type Applied =
  | { ok: true; draft: IntakeDraft; valueText: string }
  | { ok: false; retry: string };

export type Step = {
  /** Stable field key, shared with `extraction.field_key`. */
  key: string;
  target: { table: string; column: string };
  /** `block` = we cannot proceed without it; others may be skipped after 2 asks. */
  severity: FlagSeverity;
  prompt: (draft: IntakeDraft) => string;
  /** Quick-reply chips offered alongside the question. */
  suggestions?: (draft: IntakeDraft) => string[];
  /** Skip when an earlier answer already settled it. */
  skip?: (draft: IntakeDraft) => boolean;
  apply: (draft: IntakeDraft, text: string) => Applied;
};

const ok = (draft: IntakeDraft, valueText: string): Applied => ({ ok: true, draft, valueText });

export const STEPS: Step[] = [
  {
    key: "application.age",
    target: { table: "application", column: "age" },
    severity: "block",
    prompt: () => "To get started — how old are you?",
    apply: (draft, text) => {
      const age = parseAge(text);
      if (age == null) return { ok: false, retry: "I need an age between 18 and 100. What should I put down?" };
      return ok({ ...draft, age }, String(age));
    },
  },
  {
    key: "application.marital_status",
    target: { table: "application", column: "marital_status" },
    severity: "warn",
    prompt: () => "And your marital status?",
    suggestions: () => ["Single", "Married", "Divorced", "Widowed"],
    apply: (draft, text) => {
      const maritalStatus = parseMaritalStatus(text);
      if (maritalStatus == null) return { ok: false, retry: "Single, married, divorced or widowed?" };
      return ok({ ...draft, maritalStatus }, maritalStatus);
    },
  },
  {
    key: "application.smoker",
    target: { table: "application", column: "smoker" },
    severity: "warn",
    prompt: () => "Do you smoke?",
    suggestions: () => ["No", "Yes"],
    apply: (draft, text) => {
      if (isAffirmative(text)) return ok({ ...draft, smoker: true }, "true");
      if (isNegative(text)) return ok({ ...draft, smoker: false }, "false");
      return { ok: false, retry: "Just a yes or no is fine." };
    },
  },
  {
    key: "application.emirate",
    target: { table: "application", column: "emirate" },
    severity: "warn",
    prompt: () => "Which emirate do you live in?",
    suggestions: () => ["Dubai", "Abu Dhabi", "Sharjah"],
    apply: (draft, text) => ok({ ...draft, emirate: text.trim() }, text.trim()),
  },
  {
    key: "application.budget",
    target: { table: "application", column: "budget" },
    severity: "block",
    prompt: () =>
      "How would you describe your budget for premiums — low, moderate, comfortable, or not really a concern?",
    suggestions: () => ["Low", "Moderate", "Comfortable", "Not a concern"],
    apply: (draft, text) => {
      const budget = parseBudget(text);
      if (budget == null)
        return { ok: false, retry: "Pick whichever is closest: low, moderate, comfortable, or not a concern." };
      return ok({ ...draft, budget }, budget);
    },
  },
  {
    key: "condition.raw_text",
    target: { table: "application_condition", column: "raw_text" },
    severity: "block",
    prompt: () =>
      "Any health conditions we should know about — anything ongoing, or that you take medication for? If there are none, just say no.",
    suggestions: () => ["None", "Type 2 diabetes, managed", "High blood pressure"],
    apply: (draft, text) => {
      if (saysNothing(text)) return ok({ ...draft, conditions: [] }, "none declared");
      const conditions = splitList(text).map((rawText) => ({
        rawText,
        stability: classifyStability(rawText.length < 40 ? text : rawText),
      }));
      if (conditions.length === 0) return { ok: false, retry: "Sorry — could you list them for me, or say none?" };
      return ok({ ...draft, conditions }, conditions.map((c) => c.rawText).join("; "));
    },
  },
  {
    key: "condition.stability",
    target: { table: "application_condition", column: "stability" },
    severity: "review",
    // Only worth asking when the first answer did not already say so.
    skip: (draft) => draft.conditions.length === 0 || draft.conditions.every((c) => c.stability !== "unknown"),
    prompt: (draft) =>
      draft.conditions.length === 1
        ? `Is your ${draft.conditions[0].rawText.toLowerCase()} well managed at the moment?`
        : "Are those conditions well managed at the moment?",
    suggestions: () => ["Yes, managed", "Not at the moment"],
    apply: (draft, text) => {
      const stability = isAffirmative(text) ? "managed" : isNegative(text) ? "unstable" : classifyStability(text);
      if (stability === "unknown") return { ok: false, retry: "Roughly — are they under control, or not right now?" };
      return ok(
        {
          ...draft,
          conditions: draft.conditions.map((c) => (c.stability === "unknown" ? { ...c, stability } : c)),
        },
        stability,
      );
    },
  },
  {
    key: "need.benefit_class",
    target: { table: "application_need", column: "raw_text" },
    severity: "block",
    prompt: () =>
      "Is there anything you already know you'll need cover for soon — maternity, an ongoing condition, a planned procedure? Say no if not.",
    suggestions: () => ["No", "Maternity within a year", "Ongoing diabetes care"],
    apply: (draft, text) => {
      if (saysNothing(text)) return ok({ ...draft, needs: [] }, "none stated");
      const needs = splitList(text).map((rawText) => ({
        rawText,
        benefitClass: classifyBenefit(rawText),
        horizonMonths: parseHorizonMonths(rawText) ?? parseHorizonMonths(text),
      }));
      return ok({ ...draft, needs }, needs.map((n) => n.rawText).join("; "));
    },
  },
  {
    key: "need.horizon_months",
    target: { table: "application_need", column: "horizon_months" },
    // Blocking on purpose. A waiting period can only be judged against a
    // horizon; without one we cannot tell cover that helps from cover that
    // does not, which is the whole point of the recommendation.
    severity: "block",
    skip: (draft) => draft.needs.length === 0 || draft.needs.every((n) => n.horizonMonths != null),
    prompt: () => "Roughly how far away is that — in months?",
    suggestions: () => ["Within 3 months", "6 months", "12 months"],
    apply: (draft, text) => {
      const horizonMonths = parseHorizonMonths(text);
      if (horizonMonths == null) return { ok: false, retry: "A rough number of months is plenty — 3, 6, 12?" };
      return ok(
        {
          ...draft,
          needs: draft.needs.map((n) => (n.horizonMonths == null ? { ...n, horizonMonths } : n)),
        },
        String(horizonMonths),
      );
    },
  },
  {
    key: "priority.raw_text",
    target: { table: "application_priority", column: "raw_text" },
    severity: "warn",
    prompt: () => "What matters most to you in a plan? Cost, hospital access, cover for an existing condition?",
    suggestions: () => ["Lowest premium", "Good hospital access", "Cover for my condition"],
    apply: (draft, text) => {
      if (saysNothing(text)) return ok({ ...draft, priorities: [] }, "none stated");
      const priorities = splitList(text).map((rawText) => ({ rawText, tag: classifyPriority(rawText) }));
      return ok({ ...draft, priorities }, priorities.map((p) => `${p.rawText} [${p.tag}]`).join("; "));
    },
  },
  {
    key: "application.treatment_outside_uae_expected",
    target: { table: "application", column: "treatment_outside_uae_expected" },
    severity: "warn",
    prompt: () => "Last couple of things. Do you expect to get any treatment outside the UAE?",
    suggestions: () => ["No", "Yes, sometimes"],
    apply: (draft, text) => {
      if (isAffirmative(text)) return ok({ ...draft, treatmentOutsideUaeExpected: true }, "true");
      if (isNegative(text)) return ok({ ...draft, treatmentOutsideUaeExpected: false }, "false");
      return { ok: false, retry: "Yes or no — it only affects which plans we compare." };
    },
  },
  {
    key: "application.policy_inception",
    target: { table: "application", column: "policy_inception" },
    severity: "block",
    prompt: () => `When would you like cover to start? ${dateLabel(defaultInception())} works if you have no preference.`,
    suggestions: () => [dateLabel(defaultInception())],
    apply: (draft, text) => {
      const policyInception = parseDate(text);
      if (policyInception == null) return { ok: false, retry: "A date like 2026-04-01 or '1 April 2026' works." };
      return ok({ ...draft, policyInception }, policyInception);
    },
  },
];

function parseDate(text: string): string | null {
  const t = text.trim();
  if (/^(next month|asap|soon|whenever|no preference|default|that works|ok|fine|yes)/i.test(t)) {
    return defaultInception();
  }
  const iso = t.match(/\d{4}-\d{2}-\d{2}/);
  if (iso) return iso[0];
  const parsed = new Date(t);
  if (!Number.isNaN(parsed.valueOf()) && parsed.getUTCFullYear() > 2000) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

const dateLabel = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(new Date(iso));

export const stepByKey = (key: string) => STEPS.find((s) => s.key === key);

/**
 * Rebuild the draft from answered questions, in ask order. This is the only
 * place draft state comes from — there is no cached copy to drift.
 */
export function replayDraft(answers: { fieldKey: string; answerRaw: string | null }[]): IntakeDraft {
  let draft = emptyDraft();
  for (const answer of answers) {
    if (answer.answerRaw == null) continue;
    const step = stepByKey(answer.fieldKey);
    if (!step) continue;
    const result = step.apply(draft, answer.answerRaw);
    if (result.ok) draft = result.draft;
  }
  return draft;
}

/** The next question to ask, or null when the interview is complete. */
export function nextStep(draft: IntakeDraft, settledKeys: Set<string>): Step | null {
  return STEPS.find((step) => !settledKeys.has(step.key) && !(step.skip?.(draft) ?? false)) ?? null;
}

/** A plain-language recap, used as the assistant's final confirmation turn. */
export function summarise(draft: IntakeDraft): string {
  const lines = [
    `Age ${draft.age}`,
    draft.maritalStatus ? `${draft.maritalStatus}` : null,
    draft.smoker == null ? null : draft.smoker ? "smoker" : "non-smoker",
    draft.emirate ? `living in ${draft.emirate}` : null,
  ].filter(Boolean);

  const parts = [`Here's what I have: ${lines.join(", ")}.`];
  parts.push(
    draft.conditions.length > 0
      ? `Conditions: ${draft.conditions.map((c) => `${c.rawText} (${c.stability})`).join(", ")}.`
      : "No health conditions declared.",
  );
  if (draft.needs.length > 0) {
    parts.push(
      `Coming up: ${draft.needs
        .map((n) => `${n.rawText}${n.horizonMonths != null ? ` in about ${n.horizonMonths} months` : ""}`)
        .join(", ")}.`,
    );
  }
  if (draft.priorities.length > 0) {
    parts.push(`What matters to you: ${draft.priorities.map((p) => p.rawText).join(", ")}.`);
  }
  parts.push(`Budget: ${draft.budget?.replace(/_/g, " ")}. Cover starting ${dateLabel(draft.policyInception ?? defaultInception())}.`);
  return parts.join(" ");
}
