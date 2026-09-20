// What the applicant actually wants, in the one vocabulary the scoring engine
// can act on.
//
// A preference signal's `dimension` is a `CriterionId` — the same closed set of
// 8 that `score_plans` already validates against (./types.ts), never a free
// word and never a third vocabulary alongside `BenefitClass`. That is the whole
// discipline of this file: a signal that cannot be pointed at a criterion
// cannot move a weight, so it would be dead data. If the model proposes a
// dimension that is not a criterion, or one that is not relevant to THIS
// record, the signal is dropped rather than repaired.
//
// `direction` is about IMPORTANCE, not value. Whether a criterion is
// lower-is-better or higher-is-better is already declared once, on
// `CriterionDef.direction` (./score.ts), and nothing here may contradict it:
// "I'll pay more for better cover" is `premium_cost` importance DECREASING,
// not premium going up. Reading it the other way is how a stated willingness
// to spend turns into a cheaper recommendation.

import { isCriterionRelevant } from "./score";
import { CRITERION_IDS, type CriterionId } from "./types";
import type { AssessmentRecord } from "@/lib/assessment";

export const PREFERENCE_DIRECTIONS = ["increase", "decrease"] as const;
export type PreferenceDirection = (typeof PREFERENCE_DIRECTIONS)[number];

/**
 * Where a signal came from, ordered by how much of the applicant's own words
 * are behind it. `explicit` is something they stated at intake; `clarification`
 * is an answer to the one question `clarify` is allowed to ask; `rejection` is
 * read out of why they turned a shortlist down; `inferred` is the model's read
 * of free text nobody tagged.
 */
export const PREFERENCE_SOURCES = ["explicit", "clarification", "rejection", "inferred"] as const;
export type PreferenceSource = (typeof PREFERENCE_SOURCES)[number];

/** Same shape as `ScenarioProvenance` (./types.ts), and for the same reason: a figure with no row behind it is an assertion. */
export type PreferenceEvidence = { table: string; id: string };

export type PreferenceSignal = {
  dimension: CriterionId;
  /** How much this criterion should MATTER, not which way its value should go. */
  direction: PreferenceDirection;
  /** 0..1 — how hard to push. */
  strength: number;
  /** 0..1 — how sure we are the applicant meant it. */
  confidence: number;
  source: PreferenceSource;
  reason: string;
  evidence: PreferenceEvidence | null;
};

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * The deterministic floor, per priority tag. A tagged priority moves a real
 * criterion with no model involved — `signalsFromRecord` below is what keeps
 * the weight engine working when `isAgentEnabled()` is false, exactly as
 * `fallbackRecommend` keeps the shortlist working.
 *
 * `maternity` names two criteria because it genuinely is two: the benefit has
 * to be covered at all, and the wait has to clear inside the horizon — the
 * same split `assignCohort` states in prose for `maternity_planning`.
 * `other` names none: untagged free text is exactly what the model is for.
 */
const TAG_CRITERIA: Record<string, CriterionId[]> = {
  premium: ["premium_cost"],
  network_access: ["network_access"],
  chronic_depth: ["chronic_depth"],
  maternity: ["need_coverage", "waiting_period_fit"],
  outpatient_terms: ["out_of_pocket_exposure"],
  other: [],
};

/** Deliberately moderate: a tag says the applicant raised something, not how hard they pushed on it. A model-read signal off the same words may legitimately be stronger. */
const TAGGED_STRENGTH = 0.6;
const TAGGED_CONFIDENCE = 0.8;

/**
 * Signals derivable from the record alone — no model, no I/O, no judgement.
 * Every tagged priority that maps onto a criterion relevant to this record,
 * plus the dental/optical read `score.ts` already performs on raw priority
 * text (that criterion has no tag of its own in `priorityTagEnum`).
 */
export function signalsFromRecord(record: AssessmentRecord): PreferenceSignal[] {
  const signals: PreferenceSignal[] = [];

  for (const priority of record.priorities) {
    const criteria = TAG_CRITERIA[priority.tag] ?? [];
    for (const dimension of criteria) {
      if (!isCriterionRelevant(dimension, record)) continue;
      signals.push({
        dimension,
        direction: "increase",
        strength: TAGGED_STRENGTH,
        confidence: TAGGED_CONFIDENCE,
        source: "explicit",
        reason: `Stated priority: "${priority.rawText}"`,
        evidence: { table: "application_priority", id: priority.id },
      });
    }

    // The one criterion with no tag behind it — `isCriterionRelevant`
    // ("dental_optical") reads the same words, so reading them here keeps the
    // two in step instead of having a criterion nothing can ever signal.
    if (/dental|optical/i.test(priority.rawText) && isCriterionRelevant("dental_optical", record)) {
      signals.push({
        dimension: "dental_optical",
        direction: "increase",
        strength: TAGGED_STRENGTH,
        confidence: TAGGED_CONFIDENCE,
        source: "explicit",
        reason: `Stated priority: "${priority.rawText}"`,
        evidence: { table: "application_priority", id: priority.id },
      });
    }
  }

  return dedupe(signals);
}

/**
 * Drop anything a signal cannot legally be, rather than repairing it: an
 * unknown dimension, one irrelevant to this record, a direction outside the
 * pair, a strength or confidence outside 0..1. Returns the survivors and the
 * reason each casualty was dropped — the caller puts those in the trace, so a
 * model that keeps proposing `"coverage"` is visible rather than silently
 * ignored.
 */
export function validateSignals(
  candidates: unknown[],
  record: AssessmentRecord,
): { signals: PreferenceSignal[]; dropped: string[] } {
  const signals: PreferenceSignal[] = [];
  const dropped: string[] = [];

  for (const candidate of candidates) {
    if (candidate == null || typeof candidate !== "object") {
      dropped.push("not an object");
      continue;
    }
    const c = candidate as Record<string, unknown>;

    if (!(CRITERION_IDS as readonly string[]).includes(String(c.dimension))) {
      dropped.push(`unknown dimension "${String(c.dimension)}" — not one of the ${CRITERION_IDS.length} criteria`);
      continue;
    }
    const dimension = c.dimension as CriterionId;
    if (!isCriterionRelevant(dimension, record)) {
      dropped.push(`dimension "${dimension}" is not relevant to this record`);
      continue;
    }
    if (!(PREFERENCE_DIRECTIONS as readonly string[]).includes(String(c.direction))) {
      dropped.push(`dimension "${dimension}": unknown direction "${String(c.direction)}"`);
      continue;
    }
    const strength = Number(c.strength);
    const confidence = Number(c.confidence);
    if (!Number.isFinite(strength) || !Number.isFinite(confidence)) {
      dropped.push(`dimension "${dimension}": strength/confidence must be numbers`);
      continue;
    }
    const source = (PREFERENCE_SOURCES as readonly string[]).includes(String(c.source))
      ? (c.source as PreferenceSource)
      : "inferred";

    signals.push({
      dimension,
      direction: c.direction as PreferenceDirection,
      strength: clamp01(strength),
      confidence: clamp01(confidence),
      source,
      reason: typeof c.reason === "string" && c.reason.trim().length > 0 ? c.reason.trim() : "no reason given",
      evidence: null,
    });
  }

  return { signals: dedupe(signals), dropped };
}

/**
 * Later groups win over earlier ones on a tie — call it as
 * `mergeSignals(loadedFromDb, extractedThisRound)` so a fresh, more confident
 * reading replaces the stored one rather than stacking on top of it.
 */
export function mergeSignals(...groups: PreferenceSignal[][]): PreferenceSignal[] {
  return dedupe(groups.flat());
}

/**
 * One signal per (dimension, direction, source, evidence) — a re-extraction
 * that produces the same claim twice must not count twice, because
 * `calculateDynamicWeights` sums over signals and repetition would otherwise
 * read as emphasis.
 */
function dedupe(signals: PreferenceSignal[]): PreferenceSignal[] {
  const seen = new Map<string, PreferenceSignal>();
  for (const s of signals) {
    const key = `${s.dimension}::${s.direction}::${s.source}::${s.evidence?.id ?? ""}`;
    const existing = seen.get(key);
    // Keep the more confident of a duplicate pair, then the stronger.
    if (!existing || s.confidence > existing.confidence || (s.confidence === existing.confidence && s.strength > existing.strength)) {
      seen.set(key, s);
    }
  }
  return [...seen.values()];
}
