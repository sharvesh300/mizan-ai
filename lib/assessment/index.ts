// Assessment, end to end, with nothing in it that touches a database or a
// model. Given a record and the catalogue, `assess()` returns the cohort, the
// flags that fired, how sure the system is allowed to sound, and whether a
// person has to look at it before anything is priced.
//
// This is where the model is NOT. Severity, routing and confidence are the
// decisions where a confident wrong answer is most expensive, so they are
// arithmetic over declared rules that can be read, replayed and argued with.
// The `narrate` node may later rewrite a flag's wording for the broker — it
// may never change which flags fired or what they mean.

import type { ConfidenceLevel } from "@/db/schema";
import { assignCohort, type CohortAssignment } from "./cohort";
import { evaluateConstraintRules } from "./constraint-rules";
import { evaluateRecordRules } from "./record-rules";
import type { AssessmentContext, AssessmentRecord, Catalogue, Flag } from "./types";

export * from "./types";
export { assignCohort, COHORTS, type CohortAssignment } from "./cohort";
export { covers, waitMonths, clearsInTime, readNeeds } from "./constraint-rules";

/** What happens next to the application, decided by the flags alone. */
export type Gate = "blocked" | "needs_review" | "auto";

export type Assessment = {
  cohort: CohortAssignment;
  /** Record-integrity flags first, then constraint flags — worst severity first within each. */
  flags: (Flag & { layer: "record" | "constraint" })[];
  confidence: ConfidenceLevel;
  /** Null when confidence is high. Otherwise: what makes this one a judgement call. */
  uncertaintyReason: string | null;
  gate: Gate;
  /** Queue ordering key, 0..100. */
  priorityScore: number;
  /** One line for the worklist row — why this is in front of a person. */
  queueReason: string;
};

const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = { high: 3, medium: 2, low: 1 };
const SEVERITY_RANK = { block: 0, review: 1, warn: 2 } as const;

/** First sentence of a reason, for the one-line queue summary. */
const firstSentence = (text: string) => text.split(/(?<=\.)\s/)[0] ?? text;

/**
 * One rule that fired, paired with the rule that fired it.
 *
 * Nodes pass these around rather than bare flags, because the verdict is
 * computed from the RULE (its confidence floor, its severity) while the
 * broker reads the FLAG (its reason, which `narrate` may rewrite). Separating
 * them is what stops a prettier sentence from changing a routing decision.
 */
export type Fired = { rule: { code: string; confidenceFloor: ConfidenceLevel; layer: "record" | "constraint" }; flag: Flag };

export type Verdict = Omit<Assessment, "cohort">;

/**
 * Everything that follows from the flags: what the broker sees first, how sure
 * the system is allowed to sound, whether a person must look, and where it
 * sits in the queue. Pure arithmetic over the rules that fired — deliberately
 * separate from `assess` so the graph can run it AFTER the narration node,
 * on the same fired rules with better wording.
 */
export function verdict(fired: Fired[], record: AssessmentRecord): Verdict {
  const flags = fired
    .map(({ rule, flag }) => ({ ...flag, layer: rule.layer }))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  // Confidence is the FLOOR of every rule that fired, never an average. One
  // genuinely arguable flag makes the whole assessment arguable, and averaging
  // it against three tidy ones is how a queue ends up looking uniformly
  // settled when it is not.
  const floor = fired.reduce<ConfidenceLevel>(
    (lowest, { rule }) =>
      CONFIDENCE_RANK[rule.confidenceFloor] < CONFIDENCE_RANK[lowest] ? rule.confidenceFloor : lowest,
    "high",
  );

  const blocks = flags.filter((f) => f.severity === "block");
  const reviews = flags.filter((f) => f.severity === "review");
  const warns = flags.filter((f) => f.severity === "warn");

  const gate: Gate =
    blocks.length > 0 ? "blocked" : reviews.length > 0 || floor === "low" ? "needs_review" : "auto";

  const nearTerm = record.needs.some((n) => n.horizonMonths != null && n.horizonMonths <= 12);
  const priorityScore = Math.min(
    100,
    40 + 25 * blocks.length + 15 * reviews.length + 5 * warns.length + (nearTerm ? 10 : 0),
  );

  // The rule that set the floor is the one that explains the doubt.
  const deciding = fired.find(({ rule }) => rule.confidenceFloor === floor);
  const uncertaintyReason =
    floor === "high" || !deciding
      ? null
      : `${deciding.rule.code}: ${firstSentence(deciding.flag.reason)} Confidence is capped at ${floor} by that alone.`;

  const queueReason =
    flags.length === 0
      ? "New application, nothing flagged"
      : flags.map((f) => firstSentence(f.reason)).join(" · ");

  return {
    flags,
    confidence: floor,
    uncertaintyReason,
    gate,
    priorityScore,
    queueReason,
  };
}

/**
 * The whole of assessment in one call, with no model in it anywhere.
 *
 * The graph (lib/ai/graph.ts) runs the same three pieces as separate nodes so
 * a narration step can sit between them; this is the version the fixture check
 * and any caller that just wants the answer uses.
 */
export function assess(input: {
  record: AssessmentRecord;
  catalogue: Catalogue;
  context: AssessmentContext;
}): Assessment {
  const { record, catalogue, context } = input;
  const fired: Fired[] = [
    ...evaluateRecordRules({ record, context }),
    ...evaluateConstraintRules({ record, catalogue }),
  ];
  return { cohort: assignCohort(record), ...verdict(fired, record) };
}
