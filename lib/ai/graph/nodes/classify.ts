// `classify` — which cohort, and what this record asks for that the panel
// cannot give at this budget.
//
// Classification is routing, not a verdict on a person: it says which
// questions this application raises and which plan attributes will decide it.
// Nothing here is an approve/deny gate, and none of this vocabulary is ever
// rendered to the applicant.
//
// Deterministic, and deliberately so. "Does a 12-month waiting period clear
// inside a 12-month horizon" has one right answer, and a model that is usually
// right about it is worse than arithmetic that is always right — the failure
// is silent and lands on someone's maternity cover.
//
// Appends to `fired` rather than replacing it: `validate` has already put the
// record-integrity rules there, and both layers end up in one list because the
// broker reads one list.

import "server-only";
import { assignCohort } from "@/lib/assessment/cohort";
import { evaluateConstraintRules } from "@/lib/assessment/constraint-rules";
import type { AssessmentStateType } from "@/lib/ai/graph/state";

export function classify(state: AssessmentStateType): Partial<AssessmentStateType> {
  const constraint = evaluateConstraintRules({ record: state.record, catalogue: state.catalogue });

  return {
    cohort: assignCohort(state.record),
    fired: [...state.fired, ...constraint],
  };
}
