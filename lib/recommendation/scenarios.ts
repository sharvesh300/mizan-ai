// The 5 cost scenarios the agent may name, and nothing it may invent.
//
// `estimate_annual_cost` takes a `scenarioId` from this closed list and
// nothing else — no visit count, no amount, no assumption typed by the model.
// Four baskets are fixed constants; the fifth is assembled server-side from the
// applicant's own declared needs, and the tool returns what it was built from
// so the provenance sits in the trace next to the number it produced.
//
// The two unit costs below are a declared modelling assumption, not a fact —
// the brief wants premiums flat and no loading, so these exist purely to make
// plans comparable on out-of-pocket exposure. They are rendered in the broker
// view next to every figure they produce, the same discipline `narrate.ts`
// applies to flag wording: nothing hidden, nothing invented.

import type { AssessmentRecord } from "@/lib/assessment";
import type { CostBasket, CostScenario, CostScenarioId } from "./types";

export const CONSTANTS_VERSION = "scenarios-v1";

/** AED. A declared assumption, not a fact — shown wherever it drives a figure. */
export const OUTPATIENT_VISIT_COST = 350;
/** AED. Same discipline. */
export const INPATIENT_ADMISSION_COST = 18_000;

const emptyBasket = (): CostBasket => ({
  outpatientVisits: 0,
  inpatientAdmissions: 0,
  benefitClasses: [],
  maternityEvent: false,
});

const FIXED_BASKETS: Record<Exclude<CostScenarioId, "CUSTOM_FROM_APPLICANT">, CostBasket> = {
  LOW_OUTPATIENT: { ...emptyBasket(), outpatientVisits: 3 },
  MEDIUM_OUTPATIENT: { ...emptyBasket(), outpatientVisits: 8 },
  HIGH_OUTPATIENT: { ...emptyBasket(), outpatientVisits: 18, benefitClasses: ["chronic_preexisting"] },
  EXPECTED_INPATIENT: { ...emptyBasket(), outpatientVisits: 8, inpatientAdmissions: 1 },
};

/**
 * Whether the agent may select this scenario for this record.
 *
 * `HIGH_OUTPATIENT` implies a chronic condition is actually declared —
 * otherwise the scenario is asserting a fact the record does not contain.
 * `CUSTOM_FROM_APPLICANT` needs at least one need with both a benefit class
 * and a horizon to build a basket from; without one there is nothing to derive.
 */
export function isScenarioSelectable(id: CostScenarioId, record: AssessmentRecord): boolean {
  if (id === "HIGH_OUTPATIENT") return record.conditions.length > 0;
  if (id === "CUSTOM_FROM_APPLICANT") {
    return record.needs.some((need) => need.benefitClass != null && need.horizonMonths != null);
  }
  return true;
}

/**
 * Build the scenario. Throws if the scenario is not selectable for this
 * record — callers (the tool layer) turn that into a structured error the
 * agent can act on, per the vocabulary-validation table.
 */
export function buildScenario(id: CostScenarioId, record: AssessmentRecord): CostScenario {
  if (!isScenarioSelectable(id, record)) {
    throw new Error(`scenario "${id}" is not selectable for this record`);
  }

  if (id !== "CUSTOM_FROM_APPLICANT") {
    return { id, basket: FIXED_BASKETS[id], derivedFrom: [], constantsVersion: CONSTANTS_VERSION };
  }

  const eligible = record.needs.filter((need) => need.benefitClass != null && need.horizonMonths != null);
  const maternityEvent = eligible.some((need) => need.benefitClass === "maternity");

  return {
    id,
    basket: {
      outpatientVisits: 8,
      inpatientAdmissions: maternityEvent ? 1 : 0,
      benefitClasses: [...new Set(eligible.map((need) => need.benefitClass!))],
      maternityEvent,
    },
    derivedFrom: eligible.map((need) => ({
      table: "application_need",
      id: need.id,
      benefitClass: need.benefitClass,
      horizonMonths: need.horizonMonths,
    })),
    constantsVersion: CONSTANTS_VERSION,
  };
}
