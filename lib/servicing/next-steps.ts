// What a finding leaves the member able to do — computed, not written.
//
// A denial that ends at "not covered" has failed the member. What turns it into
// something they can act on is a date ("the wait ends on 1 July"), a list ("your
// plan admits these provider types") or a route ("you can appeal"). Those are
// FACTS about the plan and the ledger, so they are derived here, deterministically,
// and handed to whatever writes the prose. The agent that later improves the
// wording is given these and may not invent a date of its own — the same rule
// every figure in this system already follows.

import type { PlanTerms } from "@/lib/assessment";
import { waitMonths } from "@/lib/assessment";
import type { BenefitClass, ClaimProviderTier, EventKind, ProviderTier, ReasonCode } from "@/db/schema/enums";
import { policyYearEndsOn, waitClearsOn } from "./dates";
import { NETWORK_ADMITS } from "./network";
import type { AdjudicationResult } from "./types";

export type NextStepFacts = {
  /** Set for `waiting_period_not_elapsed`: when the wait ends. */
  waitingPeriod: { benefitClass: BenefitClass; months: number; clearsOn: string } | null;
  /** Set for `provider_out_of_network`: the provider types the plan does admit. */
  admittedProviders: readonly ProviderTier[] | null;
  /** Set for `sublimit_exhausted` / `annual_limit_reached`, and when a payment was capped. */
  limit: { kind: "maternity" | "annual"; cap: number; used: number; resetsOn: string } | null;
  /** True when THIS event is the one that finished the deductible. */
  deductibleNowMet: boolean;
  /** Whether the member can appeal this finding at all (plan §5.4.1). */
  appealable: boolean;
};

/**
 * The findings an appeal can argue against. `covered` has no adverse finding;
 * `insufficient_data` is already with a person; `policy_not_active` would turn
 * on billing, which is out of scope. A pre-authorization is a forecast, not a
 * decision, so there is nothing to appeal.
 */
const APPEALABLE: ReadonlySet<ReasonCode> = new Set([
  "waiting_period_not_elapsed",
  "provider_out_of_network",
  "sublimit_exhausted",
  "annual_limit_reached",
  "benefit_excluded",
]);

export function nextStepFacts(input: {
  plan: PlanTerms;
  kind: EventKind;
  benefitClass: BenefitClass;
  providerTier: ClaimProviderTier;
  policyMonth: number;
  inceptionDate: string;
  result: AdjudicationResult;
}): NextStepFacts {
  const { plan, result, benefitClass, policyMonth, inceptionDate } = input;
  const after = result.ledgerAfter;

  let limit: NextStepFacts["limit"] = null;
  if (result.reasonCode === "sublimit_exhausted" || result.clippedBy === "sublimit") {
    limit = {
      kind: "maternity",
      cap: plan.maternityLimit ?? 0,
      used: result.reasonCode === "sublimit_exhausted" ? result.ledgerBefore.sublimitUsed[benefitClass] ?? 0 : after.sublimitUsed[benefitClass] ?? 0,
      resetsOn: policyYearEndsOn(inceptionDate, policyMonth),
    };
  } else if (result.reasonCode === "annual_limit_reached" || result.clippedBy === "annual_limit") {
    limit = {
      kind: "annual",
      cap: plan.annualLimit,
      used: result.reasonCode === "annual_limit_reached" ? result.ledgerBefore.annualPaid : after.annualPaid,
      resetsOn: policyYearEndsOn(inceptionDate, policyMonth),
    };
  }

  const wait = waitMonths(plan, benefitClass);
  return {
    waitingPeriod:
      result.reasonCode === "waiting_period_not_elapsed"
        ? { benefitClass, months: wait, clearsOn: waitClearsOn(inceptionDate, wait) }
        : null,
    admittedProviders: result.reasonCode === "provider_out_of_network" ? NETWORK_ADMITS[plan.network] : null,
    limit,
    deductibleNowMet:
      result.reasonCode === "covered" &&
      result.deductibleApplied > 0 &&
      result.ledgerBefore.deductibleMet < plan.deductible &&
      after.deductibleMet >= plan.deductible,
    appealable: input.kind !== "preauth" && input.kind !== "appeal" && APPEALABLE.has(result.reasonCode),
  };
}

/**
 * What could change each finding, in the member's words — the member-language
 * half of the admissibility table (docs/servicing_agent_plan.md §5.4.2). Phase
 * 5's `appeal.ts` adds the machine half (which input each code turns on) and
 * imports these, so the two cannot describe different evidence.
 *
 * Deliberately narrow. What is NOT here matters as much: cost, urgency, and a
 * different description of the same facts are not evidence, and the appeal
 * screen says so.
 */
export const EVIDENCE_THAT_COULD_CHANGE: Partial<Record<ReasonCode, readonly string[]>> = {
  waiting_period_not_elapsed: [
    "A record showing the condition was first diagnosed after your policy started",
    "Proof that you had health cover before this policy began",
  ],
  provider_out_of_network: ["A licence or registration showing the provider is registered under a different network tier"],
  sublimit_exhausted: ["Proof that an earlier claim counted against this limit was a different kind of treatment"],
  annual_limit_reached: ["Proof that an earlier claim counted against this limit was recorded incorrectly"],
  benefit_excluded: ["A record showing this treatment belongs to a benefit your plan does cover"],
};
