// What a rule is handed, and what it gives back.
//
// Both layers of assessment — record integrity and plan-constraint — produce
// the SAME shape, because both land in the same `assessment_flag` table and
// the broker reads one list. The only thing that separates them is which
// inputs they need: layer 1 reads the record alone, layer 2 needs the plan
// catalogue and the applicant's budget band. `layer` is carried on the rule,
// not the row, so the table stays exactly as the fixtures define it.
//
// Nothing here touches the database or a model. Rules are pure functions of
// (record, catalogue, context) so they can be run against the five supplied
// profiles without a server.

import type {
  BudgetBand,
  ConditionStability,
  BenefitClass,
  ConfidenceLevel,
  FlagSeverity,
  MaritalStatus,
  NetworkTier,
  ProviderTier,
  RelationshipType,
} from "@/db/schema";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The intake snapshot, flattened to what a rule actually reads. */
export type AssessmentRecord = {
  applicationId: string;
  reference: string;
  age: number;
  maritalStatus: MaritalStatus | null;
  smoker: boolean | null;
  emirate: string | null;
  budget: BudgetBand;
  /** ISO date the cover is meant to start. */
  policyInception: string;
  treatmentOutsideUaeExpected: boolean;
  subjectRelationship: RelationshipType;
  conditions: { id: string; rawText: string; conditionCode: string | null; stability: ConditionStability }[];
  needs: { id: string; rawText: string; benefitClass: BenefitClass | null; horizonMonths: number | null }[];
  priorities: { id: string; rawText: string; tag: string }[];
  providers: { id: string; providerName: string; tier: ProviderTier | null }[];
};

/**
 * A record with nothing in it.
 *
 * Only ever a placeholder: LangGraph builds every channel's default eagerly
 * when the graph is compiled, so the annotation needs a value it can construct
 * before any application exists. Every real run overwrites it with the row.
 */
export const emptyRecord = (): AssessmentRecord => ({
  applicationId: "",
  reference: "",
  age: 0,
  maritalStatus: null,
  smoker: null,
  emirate: null,
  budget: "moderate",
  policyInception: "",
  treatmentOutsideUaeExpected: false,
  subjectRelationship: "self",
  conditions: [],
  needs: [],
  priorities: [],
  providers: [],
});

/** The plan catalogue, as the rules need it. Field names match `plan`. */
export type PlanTerms = {
  id: string;
  name: string;
  annualPremium: number;
  deductible: number;
  network: NetworkTier;
  outpatientCopayPct: number;
  annualLimit: number;
  dentalOptical: "none" | "basic" | "full";
  maternityCovered: boolean;
  maternityWaitingPeriodMonths: number | null;
  maternityLimit: number | null;
  chronicCovered: boolean;
  chronicWaitingPeriodMonths: number | null;
};

export type Catalogue = {
  plans: PlanTerms[];
  /** `network_admits`, as a joinable set of "network:tier" keys. */
  admits: Set<string>;
};

export const admitsKey = (network: NetworkTier, tier: ProviderTier) => `${network}:${tier}`;

/**
 * Facts a rule needs that are not on the record itself. Passed in rather than
 * queried, so every rule stays pure and replayable.
 */
export type AssessmentContext = {
  /** ISO date treated as "now". Explicit so a replay produces the same flags. */
  today: string;
  /** Other non-terminal applications for the same person, excluding this one. */
  openApplicationsForPerson: number;
};

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type Flag = {
  /** Matches `assessment_flag.rule_code`; the supplied fixtures' vocabulary. */
  ruleCode: string;
  severity: FlagSeverity;
  /** Which declared fields this is about — drives highlighting in the record. */
  fields: string[];
  /** Broker register. Templated here; `narrate` may rewrite it, never replace it. */
  reason: string;
};

/**
 * The highest confidence an assessment may claim once this rule has fired.
 *
 * Severity says how a flag ROUTES; the floor says how sure the system is
 * allowed to sound afterwards. They are not the same judgement:
 * `chronic_wait_vs_horizon` is only a `warn` — cover is real, just delayed —
 * but it makes the placement genuinely arguable, so it caps confidence at
 * medium. A queue that shows every case at the same confidence gets
 * rubber-stamped, which is the failure this column exists to prevent.
 */
export type ConfidenceFloor = ConfidenceLevel;

export type Rule<Inputs> = {
  code: string;
  severity: FlagSeverity;
  fields: string[];
  confidenceFloor: ConfidenceFloor;
  layer: "record" | "constraint";
  /** Returns the broker-register reason when it fires, or null when it does not. */
  evaluate: (inputs: Inputs) => string | null;
};

// ---------------------------------------------------------------------------
// Budget bands
// ---------------------------------------------------------------------------

/**
 * What each stated budget band will carry, in AED per year.
 *
 * These are the ceilings the supplied reasoning already assumes — P1's "low"
 * is described as a 5,000 ceiling and P2's "moderate" as 10,000 in the
 * fixtures' own words. Declared once here because half a dozen rules compare
 * against them and a second definition would quietly change what "in budget"
 * means between two screens.
 */
export const BUDGET_CEILING: Record<BudgetBand, number> = {
  low: 5_000,
  moderate: 10_000,
  comfortable: 20_000,
  not_a_concern: Number.POSITIVE_INFINITY,
};

export const plansInBudget = (plans: PlanTerms[], budget: BudgetBand): PlanTerms[] =>
  plans.filter((plan) => plan.annualPremium <= BUDGET_CEILING[budget]);

export const cheapest = (plans: PlanTerms[]): PlanTerms | null =>
  plans.length === 0 ? null : plans.reduce((best, p) => (p.annualPremium < best.annualPremium ? p : best));

/** AED, no decimals — rule reasons are read by a person, not parsed. */
export const aed = (value: number) => `AED ${value.toLocaleString("en-AE")}`;
