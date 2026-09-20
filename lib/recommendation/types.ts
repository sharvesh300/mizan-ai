// What recommendation pricing and scoring are handed, and what they give back.
//
// The applicant record is exactly `AssessmentRecord` — nothing new is asked for
// to recommend a plan that was not already asked for to assess one, so this
// re-exports rather than redeclaring it. What is new here is the vocabulary the
// agent selects FROM: cost scenarios and scoring criteria, both closed enums
// validated before a tool runs (see lib/ai/tools/plans.ts).

import type { BenefitClass } from "@/db/schema";
import type { AssessmentRecord, Catalogue, PlanTerms } from "@/lib/assessment";

export type { AssessmentRecord as RecommendationRecord, Catalogue, PlanTerms };

// ---------------------------------------------------------------------------
// Cost scenarios — the agent names one, never supplies its inputs
// ---------------------------------------------------------------------------

export const COST_SCENARIO_IDS = [
  "LOW_OUTPATIENT",
  "MEDIUM_OUTPATIENT",
  "HIGH_OUTPATIENT",
  "EXPECTED_INPATIENT",
  "CUSTOM_FROM_APPLICANT",
] as const;
export type CostScenarioId = (typeof COST_SCENARIO_IDS)[number];

export type CostBasket = {
  outpatientVisits: number;
  inpatientAdmissions: number;
  benefitClasses: BenefitClass[];
  maternityEvent: boolean;
};

/** What a scenario was built from, when it is `CUSTOM_FROM_APPLICANT` — the provenance in the trace. */
export type ScenarioProvenance = { table: "application_need"; id: string; benefitClass: BenefitClass | null; horizonMonths: number | null };

export type CostScenario = {
  id: CostScenarioId;
  basket: CostBasket;
  derivedFrom: ScenarioProvenance[];
  constantsVersion: string;
};

export type CostBreakdown = {
  outpatientCost: number;
  inpatientCost: number;
  deductibleApplied: number;
  memberCopay: number;
  /** Premium + out-of-pocket exposure under this basket, for one plan. */
  total: number;
};

// ---------------------------------------------------------------------------
// Scoring criteria — the agent picks which matter and how much
// ---------------------------------------------------------------------------

export const CRITERION_IDS = [
  "premium_cost",
  "out_of_pocket_exposure",
  "need_coverage",
  "waiting_period_fit",
  "network_access",
  "chronic_depth",
  "annual_limit",
  "dental_optical",
] as const;
export type CriterionId = (typeof CRITERION_IDS)[number];

export type CriterionDirection = "lower_is_better" | "higher_is_better";

export type CriterionWeight = { criterionId: CriterionId; weight: number };

export type CriterionContribution = {
  criterionId: CriterionId;
  rawValue: number;
  normalisedValue: number;
  contribution: number;
};

export type ScoredPlan = {
  planId: string;
  weightedScore: number;
  rank: number;
  contributions: CriterionContribution[];
};

export type ScoreResult = {
  /** What the agent asked for, unchanged. */
  rawWeights: CriterionWeight[];
  /** Same criteria, weights scaled to sum to 1 — what the arithmetic actually used. */
  normalisedWeights: CriterionWeight[];
  perPlan: ScoredPlan[];
  /**
   * The basket `out_of_pocket_exposure` was measured under, and the constants
   * that priced it. Present whenever that criterion was weighted — it is the
   * one criterion whose raw value depends on an assumption rather than on a
   * plan term, so the assumption travels with the score into the trace
   * instead of being invisible inside it.
   */
  exposureScenario: { id: CostScenarioId; constantsVersion: string } | null;
};

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export type QuoteRow = {
  planId: string;
  annualPremium: number;
  eligible: boolean;
  rank: number | null;
  score: number | null;
};
