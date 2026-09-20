// Two readings of the record that were being left on the table, both applied
// where the record is BUILT rather than where it is stored.
//
// Nothing here writes a row. `application_condition` and
// `application_priority` keep exactly what the applicant said, in their words;
// these functions are how the rest of the system reads them. That is the same
// discipline the confidence decay in lib/ai/recommendation-session.ts follows,
// and it is what lets both fixes apply to records that were captured months
// ago without a migration or a backfill.
//
// -------------------------------------------------------------------------
// 1. A DECLARED CONDITION IMPLIES A NEED TO COVER IT
//
// `isEligible` (lib/recommendation/eligibility.ts) is
// `record.needs.every(...)`. On a record with no needs that is vacuously
// true, so EVERY plan was eligible for an applicant with a declared chronic
// condition — including the one that states, in its own terms, that it does
// not cover pre-existing conditions at all.
//
// The consequences all came from that one empty array, and they compounded:
//
//   - the cheapest plan was never actually ruled out, so nothing downstream
//     could tell the applicant it was unavailable to them — only argue that
//     it was unwise, which is a much weaker thing to say and invited exactly
//     the "but I want the cheap one" loop it produced;
//   - `need_coverage` and `waiting_period_fit` were permanently IRRELEVANT
//     (`isCriterionRelevant` gates both on `needs`), so the scoring engine
//     had no criterion meaning "this has to be covered";
//   - `detectTradeOff` (lib/recommendation/tradeoff.ts) looks for a cheaper
//     plan that is BLOCKED, so it never fired, and the one question that
//     would have settled the conversation was never asked.
//
// Measured on the development database when this was written: 11 of the 15
// applications carrying a declared condition had no chronic need row, and
// therefore no ineligible plan.
//
// A declared condition is a FACT about the applicant. "It should be covered"
// is a reading of that fact — but it is the only reading that makes sense of
// why they told us, and it is what the assessment layer already assumes
// everywhere else (`assignCohort` puts them in a chronic cohort, the chronic
// rules fire, `chronic_depth` becomes relevant). The implicit need just makes
// that assumption legible to the one gate that was still missing it.
//
// -------------------------------------------------------------------------
// 2. A COMMA-JOINED PRIORITY IS SEVERAL PRIORITIES
//
// Intake stores what the applicant said, and free-text capture routinely puts
// several priorities in one row: "Good hospital access, Low co-pay or
// deductible", tagged `other` because no single tag fits two things. That tag
// is what `signalsFromRecord` reads, and `TAG_CRITERIA.other` is empty — so a
// record whose priorities were captured that way produced NO deterministic
// signals at all, and the weight engine ran entirely on model inference, with
// nothing to fall back on when the model read the applicant the wrong way.

import type { AssessmentRecord } from "./types";

/**
 * The id prefix every derived need carries.
 *
 * Deliberately not a UUID: these ids are handed to the agent as a closed
 * vocabulary (`check_need_against_plans`'s `needId`), they are written into
 * signal provenance, and they appear in traces. Anything reading one should
 * be able to tell at a glance that it points at an inference and not at a row
 * the applicant filled in.
 */
export const DERIVED_NEED_PREFIX = "derived:condition:";

export const isDerivedNeedId = (id: string): boolean => id.startsWith(DERIVED_NEED_PREFIX);

/**
 * Add the implicit "cover my declared condition" need, when the applicant has
 * a condition on file and nothing on the record already says so.
 *
 * Deliberately conservative in two ways:
 *
 *   - ONE derived need, not one per condition. The question every gate
 *     actually asks is "does this plan cover pre-existing conditions", which
 *     is a single yes/no against the benefit class, not a per-diagnosis test.
 *     Deriving three needs for three conditions would triple-count the same
 *     fact in `need_coverage`'s raw value, which counts needs served.
 *   - `horizonMonths` stays NULL. The applicant declared a condition, not a
 *     timeline, and a horizon is a claim about when cover has to start that
 *     nobody made. Eligibility (`covers`) and `need_coverage` both work
 *     without one; `waiting_period_fit` stays irrelevant unless a real
 *     horizon was actually stated, which is the honest outcome — a plan that
 *     covers the condition after a wait is a SCORING question, not an
 *     eligibility one, and that split is exactly right here.
 */
export function deriveImplicitNeeds(record: AssessmentRecord): AssessmentRecord["needs"] {
  if (record.conditions.length === 0) return record.needs;
  if (record.needs.some((need) => need.benefitClass === "chronic_preexisting")) return record.needs;

  const named = record.conditions.map((c) => c.rawText).join(", ");
  return [
    ...record.needs,
    {
      id: `${DERIVED_NEED_PREFIX}chronic`,
      rawText: `Cover for a declared pre-existing condition (${named})`,
      benefitClass: "chronic_preexisting",
      horizonMonths: null,
    },
  ];
}

/** Keyword -> tag, most specific first. A priority naming both a co-pay and a network is split before this ever runs, so the first match per fragment is the right one. */
const TAG_PATTERNS: { tag: string; pattern: RegExp }[] = [
  { tag: "maternity", pattern: /matern|pregnan|baby|birth|delivery/i },
  { tag: "chronic_depth", pattern: /chronic|pre-?existing|existing condition|ongoing condition|my condition/i },
  { tag: "outpatient_terms", pattern: /co-?pay|deductible|out[- ]of[- ]pocket|excess|outpatient/i },
  { tag: "network_access", pattern: /hospital|network|clinic|doctor|gp|specialist|access|provider/i },
  { tag: "premium", pattern: /premium|price|cost|cheap|afford|budget|monthly|yearly|annual cost|value/i },
];

/**
 * Split comma/semicolon/"and"-joined priorities into one entry each, and tag
 * every fragment on its own words.
 *
 * A fragment's ORIGINAL tag wins when it is something other than `other` —
 * an applicant who picked a tagged option from the questionnaire has already
 * told us what it is, and re-deriving it from prose would be second-guessing
 * a stated answer with a regex. This only fills in what was never tagged.
 *
 * Ids stay traceable to the row they came from (`<rowId>#0`, `<rowId>#1`), so
 * a signal's provenance still points at something real.
 */
export function splitPriorities(priorities: AssessmentRecord["priorities"]): AssessmentRecord["priorities"] {
  const out: AssessmentRecord["priorities"] = [];

  for (const priority of priorities) {
    const fragments = priority.rawText
      .split(/\s*[,;]\s*|\s+and\s+/i)
      .map((f) => f.trim())
      .filter((f) => f.length > 0);

    // Nothing to split, or splitting produced only noise — keep the row as it
    // stands rather than inventing a shape for it.
    if (fragments.length <= 1) {
      out.push(priority);
      continue;
    }

    fragments.forEach((rawText, index) => {
      const derived = TAG_PATTERNS.find((t) => t.pattern.test(rawText))?.tag;
      out.push({
        id: `${priority.id}#${index}`,
        rawText,
        tag: priority.tag !== "other" ? priority.tag : (derived ?? "other"),
      });
    });
  }

  return out;
}

/**
 * Both readings, applied together. The one place either is used — call it
 * wherever an `AssessmentRecord` is assembled from rows, and nowhere else, so
 * there is exactly one answer to "what does this record mean".
 */
export function deriveRecord(record: AssessmentRecord): AssessmentRecord {
  return {
    ...record,
    needs: deriveImplicitNeeds(record),
    priorities: splitPriorities(record.priorities),
  };
}
