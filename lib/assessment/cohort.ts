// Which cohort this applicant belongs to.
//
// A cohort is a ROUTING label, not a verdict on a person: it says which
// questions this record raises and which plan attributes will decide it. It is
// deterministic on purpose — the same record must land in the same cohort
// every time, or the queue cannot be reasoned about — and it is broker-only
// vocabulary that never reaches the applicant.
//
// The order of the tests is the definition. A 31-year-old planning a baby is
// `maternity_planning`, not `standard_young_healthy`, because the maternity
// horizon is what will actually decide their plan; the health/age bands only
// speak for records where nothing more specific applies.
//
// Slugs match the supplied fixtures so a live assessment of P1..P5 can be read
// alongside the supplied one.

import type { AssessmentRecord } from "./types";

export type CohortAssignment = {
  cohort: string;
  /** Broker register, one line: what put them here. */
  rationale: string;
};

/** Months inside which a stated need counts as "this year's problem". */
const NEAR_TERM_MONTHS = 12;

export function assignCohort(record: AssessmentRecord): CohortAssignment {
  const conditions = record.conditions;
  // `unstable` is tested before the age bands: an unstable condition changes
  // what the record needs regardless of how old the applicant is.
  const unstable = conditions.some((c) => c.stability === "unstable");

  const maternity = record.needs.find(
    (need) =>
      need.benefitClass === "maternity" && need.horizonMonths != null && need.horizonMonths <= NEAR_TERM_MONTHS,
  );
  if (maternity) {
    return {
      cohort: "maternity_planning",
      rationale: `Maternity stated at a ${maternity.horizonMonths}-month horizon. Waiting-period arithmetic decides this record, not premium band.`,
    };
  }

  if (conditions.length > 0) {
    const summary = conditions.map((c) => c.rawText).join(", ");
    if (record.age >= 60) {
      return {
        cohort: "chronic_complex_senior",
        rationale: `Age ${record.age} with ${conditions.length} declared condition(s) (${summary}). Depth of cover and annual limit outrank premium here.`,
      };
    }
    if (unstable) {
      return {
        cohort: "chronic_unstable",
        rationale: `Declared condition(s) not described as stable (${summary}). Utilisation is unpredictable and the chronic waiting period lands differently.`,
      };
    }
    if (record.age >= 45) {
      return {
        cohort: "chronic_managed_mature",
        rationale: `Age ${record.age}, ${conditions.length} managed condition(s) (${summary}). The chronic waiting period is the axis this record turns on.`,
      };
    }
    return {
      cohort: "chronic_managed_adult",
      rationale: `Age ${record.age} with ${conditions.length} managed condition(s) (${summary}). Chronic cover matters; expected utilisation is still low.`,
    };
  }

  if (record.age < 35) {
    return {
      cohort: "standard_young_healthy",
      rationale: `Age ${record.age}, nothing declared, no near-term needs. Price-led placement.`,
    };
  }
  if (record.age < 60) {
    return {
      cohort: "standard_mid_career",
      rationale: `Age ${record.age}, nothing declared. Network access and outpatient terms decide this rather than benefit gates.`,
    };
  }
  return {
    cohort: "standard_senior_healthy",
    rationale: `Age ${record.age}, nothing declared. Healthy, but the age band carries utilisation risk the record does not yet show.`,
  };
}

/** Cohorts this build can emit, for the broker-side filter chips. */
export const COHORTS = [
  "standard_young_healthy",
  "standard_mid_career",
  "standard_senior_healthy",
  "maternity_planning",
  "chronic_managed_adult",
  "chronic_managed_mature",
  "chronic_complex_senior",
  "chronic_unstable",
] as const;
