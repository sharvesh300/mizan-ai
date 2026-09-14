// Layer 1 · record integrity — what is wrong with the record itself.
//
// These are the checks intake structurally cannot make. A field parser sees
// one answer at a time and can only refuse a value it cannot read; these rules
// see the whole record at once and catch what only shows up in combination:
// a need with no horizon to compare a waiting period against, an inception
// date already in the past, the same person with two open applications.
//
// None of them look at a plan. That is layer 2's job (constraint-rules.ts) —
// keeping them apart means a catalogue change cannot alter whether a record is
// internally coherent.

import type { AssessmentContext, AssessmentRecord, Rule } from "./types";

type Inputs = { record: AssessmentRecord; context: AssessmentContext };

const list = (items: string[]) => items.join(", ");

export const RECORD_RULES: Rule<Inputs>[] = [
  {
    // BLOCK. Every waiting-period rule downstream compares a plan's wait to
    // this number. Without it there is nothing to compare, and guessing
    // "probably soon" is exactly the confident wrong answer we must not give.
    code: "need_horizon_missing",
    severity: "block",
    fields: ["near_term_needs"],
    confidenceFloor: "low",
    layer: "record",
    evaluate: ({ record }) => {
      const missing = record.needs.filter((need) => need.horizonMonths == null);
      if (missing.length === 0) return null;
      return `${missing.length} stated need(s) carry no time horizon (${list(
        missing.map((n) => `"${n.rawText}"`),
      )}). Waiting periods cannot be tested against an unknown horizon — ask before this is quoted.`;
    },
  },
  {
    code: "need_unclassified",
    severity: "review",
    fields: ["near_term_needs"],
    confidenceFloor: "medium",
    layer: "record",
    evaluate: ({ record }) => {
      const unclassified = record.needs.filter((need) => need.benefitClass == null);
      if (unclassified.length === 0) return null;
      return `Could not map ${list(unclassified.map((n) => `"${n.rawText}"`))} to a benefit class. Plan matching skips what it cannot classify, so this need is currently invisible to the comparison.`;
    },
  },
  {
    code: "condition_unstable",
    severity: "review",
    fields: ["conditions"],
    confidenceFloor: "medium",
    layer: "record",
    evaluate: ({ record }) => {
      const unstable = record.conditions.filter((c) => c.stability === "unstable");
      if (unstable.length === 0) return null;
      return `${list(unstable.map((c) => `"${c.rawText}"`))} declared as unstable. This is not a managed-chronic profile — expected utilisation and the chronic waiting period both read differently.`;
    },
  },
  {
    code: "condition_uncodable",
    severity: "warn",
    fields: ["conditions"],
    confidenceFloor: "high",
    layer: "record",
    evaluate: ({ record }) => {
      const uncoded = record.conditions.filter((c) => !c.conditionCode);
      if (uncoded.length === 0) return null;
      return `${uncoded.length} declared condition(s) carry no code (${list(
        uncoded.map((c) => `"${c.rawText}"`),
      )}). Recorded in the applicant's words only.`;
    },
  },
  {
    code: "inception_in_past",
    severity: "review",
    fields: ["policy_inception"],
    confidenceFloor: "medium",
    layer: "record",
    evaluate: ({ record, context }) =>
      record.policyInception >= context.today
        ? null
        : `Cover was asked to start ${record.policyInception}, which is before today (${context.today}). Waiting periods run from inception, so every horizon test below is measured from a date that has already passed.`,
  },
  {
    // The application carries its own declared age; the person carries the
    // relationship. A child subject with an adult age means one of the two was
    // captured against the wrong party — worth a look before anything is priced.
    code: "subject_age_mismatch",
    severity: "review",
    fields: ["age", "relationship"],
    confidenceFloor: "medium",
    layer: "record",
    evaluate: ({ record }) =>
      record.subjectRelationship === "child" && record.age >= 18
        ? `Cover is recorded as being for a child, but the declared age is ${record.age}. Either the relationship or the age belongs to the account holder rather than the subject.`
        : null,
  },
  {
    code: "duplicate_open_application",
    severity: "review",
    fields: ["person"],
    confidenceFloor: "medium",
    layer: "record",
    evaluate: ({ context }) =>
      context.openApplicationsForPerson > 0
        ? `This person already has ${context.openApplicationsForPerson} other open application(s). Two live applications for one subject will produce two recommendations and, if both are approved, two policies.`
        : null,
  },
  {
    code: "smoker_undeclared",
    severity: "warn",
    fields: ["smoker"],
    confidenceFloor: "high",
    layer: "record",
    evaluate: ({ record }) =>
      record.smoker == null
        ? "Smoker status was never answered. Nothing in the supplied plan terms prices on it, so this does not change the quote — but it is a hole in the record."
        : null,
  },
];

export function evaluateRecordRules(inputs: Inputs) {
  return RECORD_RULES.flatMap((rule) => {
    const reason = rule.evaluate(inputs);
    return reason ? [{ rule, flag: { ruleCode: rule.code, severity: rule.severity, fields: rule.fields, reason } }] : [];
  });
}
