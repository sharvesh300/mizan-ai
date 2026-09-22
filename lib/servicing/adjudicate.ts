// Adjudication — servicing_spec.md §4, the only place in the system where a
// claim amount is computed.
//
// Pre-authorization, claim and reimbursement all come through this one
// function; a pre-auth is `dryRun: true` and nothing else. Reimbursement is a
// claim whose settlement direction differs, which is a matter of how the
// result is described to the member, not of the arithmetic.
//
// Pure: same input, same output, no I/O. The agent may decide WHEN to call
// this and WHAT the event is; it can never supply a number that ends up in
// the result. Every amount below comes from plan terms, the ledger, and the
// one amount on the event.

import { covers, waitMonths } from "@/lib/assessment";
import type { BenefitClass, ReasonCode } from "@/db/schema/enums";
import { benefitClassPhrase, providerTypeLabel } from "./labels";
import { cloneLedger } from "./ledger";
import { admitsTier } from "./network";
import type { AdjudicationInput, AdjudicationResult, ClippedBy } from "./types";

/** Money is AED to two decimals; round at every step a fraction can appear. */
const cents = (n: number): number => Math.round(n * 100) / 100;
const fmt = (n: number): string => String(cents(n));

/** Only maternity carries a sublimit (spec §3). dental_optical is tier-based, not capped. */
const sublimitOf = (input: AdjudicationInput): number | null => {
  if (input.benefitClass !== "maternity") return null;
  // Past the `covers` gate a maternity plan must state its limit; the plan
  // table enforces it with a CHECK. Reaching here without one is corrupt data,
  // and guessing a number for it is exactly what this system refuses to do.
  if (input.plan.maternityLimit === null) {
    throw new Error(`${input.plan.id} covers maternity but states no maternity limit`);
  }
  return input.plan.maternityLimit;
};

function validate(input: AdjudicationInput): void {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new RangeError(`amount must be a positive number, got ${input.amount}`);
  }
  if (!Number.isInteger(input.policyMonth) || input.policyMonth < 0) {
    throw new RangeError(`policyMonth must be a whole number of months from 0, got ${input.policyMonth}`);
  }
}

export function adjudicate(input: AdjudicationInput): AdjudicationResult {
  validate(input);
  const { plan, ledger, amount, benefitClass, providerTier } = input;
  const before = cloneLedger(ledger);

  const decided = (reasonCode: ReasonCode, calculation: string[]): AdjudicationResult => ({
    outcome: "denied",
    reasonCode,
    planPays: 0,
    memberPays: cents(amount),
    deductibleApplied: 0,
    clippedBy: null,
    calculation: [...calculation, `plan pays 0, member pays ${fmt(amount)}`],
    ledgerBefore: before,
    ledgerAfter: cloneLedger(before),
  });

  // 0. Geographic scope. The plan data defines none, so a treatment outside
  //    the UAE — or at a provider the tier vocabulary cannot place — cannot be
  //    denied (that would invent a rule) or paid (that would invent another).
  //    Not a low-confidence answer: no answer. Nulls, not zeros.
  if (input.geography !== "uae" || providerTier === "unknown_foreign") {
    return {
      outcome: "insufficient_data",
      reasonCode: "insufficient_data",
      planPays: null,
      memberPays: null,
      deductibleApplied: 0,
      clippedBy: null,
      // The trace is shown to the member as well as the broker (spec §4b), so it is written in
      // words a member can read: no enum tokens, and no workflow vocabulary.
      calculation: [
        input.geography === "uae"
          ? "treatment location: the provider could not be placed in a network tier"
          : "treatment location: outside the UAE",
        "the plan terms define no geographic scope, so this cannot be decided from them",
        "no amount computed — a person needs to look at it, and no rule has been invented",
      ],
      ledgerBefore: before,
      ledgerAfter: cloneLedger(before),
    };
  }

  // 1. Policy active?
  if (input.policyStatus !== "active") {
    return decided("policy_not_active", [`policy is ${input.policyStatus}, not active`]);
  }

  // 2. Benefit covered by the plan at all?
  if (!covers(plan, benefitClass)) {
    return decided("benefit_excluded", [`${plan.name} does not cover ${benefitClassPhrase[benefitClass]}`]);
  }

  // 3. Waiting period elapsed? Month 0 is inception, so an N-month wait clears at month N.
  const wait = waitMonths(plan, benefitClass as BenefitClass);
  if (input.policyMonth < wait) {
    return decided("waiting_period_not_elapsed", [
      `the waiting period for ${benefitClassPhrase[benefitClass]} is ${wait} months; policy month ${input.policyMonth} is before it clears`,
    ]);
  }

  // 4. Provider tier in the plan's network? A gate, not a discount.
  if (!admitsTier(plan.network, providerTier)) {
    return decided("provider_out_of_network", [
      `a ${providerTypeLabel[providerTier].toLowerCase()} is not admitted by the ${plan.network} network (${plan.name})`,
    ]);
  }

  // 5. Sublimit already exhausted?
  const sublimit = sublimitOf(input);
  const sublimitUsed = ledger.sublimitUsed[benefitClass] ?? 0;
  if (sublimit !== null && sublimitUsed >= sublimit) {
    return decided("sublimit_exhausted", [`the ${benefitClassPhrase[benefitClass]} limit of ${fmt(sublimit)} is already fully used (${fmt(sublimitUsed)})`]);
  }

  // 6. Annual limit already reached?
  if (ledger.annualPaid >= plan.annualLimit) {
    return decided("annual_limit_reached", [
      `annual limit ${fmt(plan.annualLimit)} already reached (${fmt(ledger.annualPaid)} paid)`,
    ]);
  }

  // From here the claim is payable — in full or in part.
  const calculation: string[] = [];

  // 7. Remaining deductible comes off first, before any co-pay.
  const deductibleRemaining = Math.max(plan.deductible - ledger.deductibleMet, 0);
  const deductibleApplied = cents(Math.min(deductibleRemaining, amount));
  const afterDeductible = cents(amount - deductibleApplied);
  calculation.push(`deductible applied ${fmt(deductibleApplied)} (remaining was ${fmt(deductibleRemaining)})`);
  if (deductibleApplied > 0) calculation.push(`after deductible ${fmt(afterDeductible)}`);

  // 8. Co-pay on the remainder — inpatient and outpatient alike.
  const copay = cents((afterDeductible * plan.outpatientCopayPct) / 100);
  let planPays = cents(afterDeductible - copay);
  calculation.push(`co-pay ${plan.outpatientCopayPct}% of ${fmt(afterDeductible)} = ${fmt(copay)}`);

  // 9. Cap plan payment at the remaining sublimit. Sublimits cap what the plan
  //    PAYS, and only after the co-pay — never the billed amount.
  let clippedBy: ClippedBy | null = null;
  if (sublimit !== null) {
    const remaining = Math.max(sublimit - sublimitUsed, 0);
    if (planPays > remaining) {
      calculation.push(`plan payment capped at the remaining ${benefitClassPhrase[benefitClass]} limit of ${fmt(remaining)} (was ${fmt(planPays)})`);
      planPays = cents(remaining);
      clippedBy = "sublimit";
    }
  }

  // 10. Cap plan payment at the remaining annual limit.
  const annualRemaining = Math.max(plan.annualLimit - ledger.annualPaid, 0);
  if (planPays > annualRemaining) {
    calculation.push(`plan payment capped at remaining annual limit ${fmt(annualRemaining)} (was ${fmt(planPays)})`);
    planPays = cents(annualRemaining);
    clippedBy = "annual_limit";
  }

  // 11. What the member owes is everything the plan does not.
  const memberPays = cents(amount - planPays);
  const owed = [deductibleApplied, copay, cents(afterDeductible - copay - planPays)].filter((part) => part > 0);
  calculation.push(
    owed.length > 1
      ? `plan pays ${fmt(planPays)}, member pays ${owed.map(fmt).join(" + ")} = ${fmt(memberPays)}`
      : `plan pays ${fmt(planPays)}, member pays ${fmt(memberPays)}`,
  );

  // 12. Project onto the ledger — unless this is a forecast. A dry run reads the
  //     ledger and leaves it exactly as it found it.
  const after = cloneLedger(before);
  if (!input.dryRun) {
    after.deductibleMet = cents(after.deductibleMet + deductibleApplied);
    after.annualPaid = cents(after.annualPaid + planPays);
    if (sublimit !== null) {
      after.sublimitUsed[benefitClass] = cents((after.sublimitUsed[benefitClass] ?? 0) + planPays);
    }
  }

  return {
    // "Approved with limit" is a pre-auth outcome: the plan will pay, but a cap
    // clipped it. A CLAIM capped the same way is still `covered`, because the
    // reason code means "payable, in full or in part" (spec §5).
    outcome: input.dryRun && clippedBy !== null ? "approved_with_limit" : "covered",
    reasonCode: "covered",
    planPays,
    memberPays,
    deductibleApplied,
    clippedBy,
    calculation,
    ledgerBefore: before,
    ledgerAfter: after,
  };
}
