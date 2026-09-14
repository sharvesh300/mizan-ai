// `validate` — is this record internally coherent?
//
// The first thing that happens to an application once it exists. It reads the
// record and nothing else: no plans, no prices, no cohort. A need with no time
// horizon, an inception date already in the past, two open applications for
// one person — the failures that only show up when you look at the whole
// record at once, which a field-at-a-time parser structurally cannot do.
//
// No model. These are gates, and `need_horizon_missing` is a `block`: it stops
// the application until a person resolves it, because every waiting-period
// test downstream compares a plan's wait to a number that is not there.

import "server-only";
import { evaluateRecordRules } from "@/lib/assessment/record-rules";
import type { AssessmentStateType } from "@/lib/ai/graph/state";

export function validate(state: AssessmentStateType): Partial<AssessmentStateType> {
  return {
    fired: evaluateRecordRules({ record: state.record, context: state.context }),
  };
}
