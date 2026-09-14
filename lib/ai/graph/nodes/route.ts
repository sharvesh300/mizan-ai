// `route` — where this application goes, and how sure the system is allowed
// to sound about it.
//
// Three decisions, all arithmetic over the rules that fired:
//
//   CONFIDENCE is the floor of every rule, never an average. One genuinely
//   arguable flag makes the whole assessment arguable; averaging it against
//   three tidy ones is exactly how a queue ends up looking uniformly settled
//   when it is not.
//
//   THE GATE is severity-driven. A `block` stops the application. A `review`,
//   or low confidence on its own, puts it in front of a person. Warnings are
//   recorded on the broker's record and advance.
//
//   PRIORITY orders the queue by what makes a case hard and time-sensitive —
//   blocks, then reviews, then a near-term need — not by arrival time. A
//   maternity horizon inside the year genuinely cannot wait three days for a
//   callback; a healthy 26-year-old's price-led placement can.
//
// The model has no vote in any of it. It may only have improved the wording
// `route` reads, and `verdict` is computed from the RULES, not the sentences.

import "server-only";
import { verdict } from "@/lib/assessment";
import type { AssessmentStateType } from "@/lib/ai/graph/state";

export function route(state: AssessmentStateType): Partial<AssessmentStateType> {
  const computed = verdict(state.fired, state.record);

  return {
    verdict: {
      ...computed,
      // The model's line is a better first impression when it wrote one; the
      // templated join is the fallback and says the same thing less well.
      queueReason: state.queueLine ?? computed.queueReason,
    },
  };
}

/** Does a person have to look at this before it is priced? */
export function gated(state: AssessmentStateType): "gate" | "clear" {
  return state.verdict && state.verdict.gate !== "auto" ? "gate" : "clear";
}
