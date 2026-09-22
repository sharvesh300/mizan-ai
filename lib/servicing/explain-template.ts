// Deterministic explanations, in two registers.
//
// The seed needs prose for thirteen events (only two ever had any), and a
// member whose model call has just failed still needs to be told what happened.
// Both are answered by writing the prose once from the FACTS — the engine's
// result and the dated next steps — with no model in the loop. The agent's
// `explain` (phase 4) improves on this wording; it does not replace the
// guarantee that some correct, audience-appropriate explanation always exists.
//
// The two registers are written separately, never filtered from one another
// (spec §4b):
//   member  verdict → why → what it costs → what to do next; no internal vocabulary
//   broker  which policy, which event, when, what it implies for fit or renewal
//
// Every number and date below comes from `input` or `nextStepFacts` — nothing is
// typed in — so the trace, the figures and the prose cannot disagree.

import type { PlanTerms } from "@/lib/assessment";
import { waitMonths } from "@/lib/assessment";
import type { BenefitClass, ClaimProviderTier, EventKind, Geography, ReasonCode } from "@/db/schema/enums";
import { longDate, monthYear, policyMonthStart } from "./dates";
import {
  benefitClassCovered,
  benefitClassPhrase,
  eventKindWord,
  providerTypeLabel,
  providerTypePlural,
} from "./labels";
import { EVIDENCE_THAT_COULD_CHANGE, nextStepFacts } from "./next-steps";
import type { AdjudicationResult } from "./types";

export type ExplainInput = {
  kind: EventKind;
  eventRef: string;
  policyRef: string;
  plan: PlanTerms;
  inceptionDate: string;
  policyMonth: number;
  benefitClass: BenefitClass;
  providerTier: ClaimProviderTier;
  geography: Geography;
  /** Billed amount, or the estimate for a pre-authorization. */
  amount: number;
  /** For an appeal: the finding being contested (upheld) or the re-adjudication (overturned). */
  result: AdjudicationResult;
  /** Set only when `kind` is `appeal`. */
  appeal?: {
    appealRef: string;
    contestedRef: string;
    contestedReason: ReasonCode;
    verdict: "upheld" | "overturned";
    evidenceSupplied: boolean;
    /** The condition was on the applicant's own intake record. */
    declaredAtIntake?: boolean;
    /** One clause, in the member's words, saying what the evidence showed. */
    evidenceSummary?: string;
    /** The same finding, written for the broker — never the member's clause reused, which speaks to "you". */
    evidenceSummaryBroker?: string;
    correction?: { field: string; from: string; to: string };
  };
  /** Earlier payable events on this policy, in order. Names what consumed a cap, for the broker. */
  priorPayable?: { ref: string; month: number; benefitClass: BenefitClass; planPays: number }[];
  /** Earlier denials still standing. Lets the broker text say a claim paid once a wait cleared. */
  priorDenied?: { ref: string; month: number; benefitClass: BenefitClass; reasonCode: ReasonCode }[];
};

export type Explanation = { member: string; broker: string };

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

const cents = (n: number) => Math.round(n * 100) / 100;
const num = (n: number) =>
  Number.isInteger(n) ? n.toLocaleString("en") : n.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const aed = (n: number) => `AED ${num(n)}`;
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** Broker shorthand for a class. The member never sees these. */
const brokerClass: Record<BenefitClass, string> = {
  general: "general",
  maternity: "maternity",
  chronic_preexisting: "chronic / pre-existing",
  dental_optical: "dental / optical",
};

// ---------------------------------------------------------------------------

export function explain(input: ExplainInput): Explanation {
  if (input.kind === "appeal") return explainAppeal(input);
  const { result } = input;
  if (result.outcome === "insufficient_data") return undecidable(input);
  if (result.reasonCode === "covered") return payable(input);
  return denied(input);
}

function facts(i: ExplainInput) {
  return nextStepFacts({
    plan: i.plan,
    kind: i.kind,
    benefitClass: i.benefitClass,
    providerTier: i.providerTier,
    policyMonth: i.policyMonth,
    inceptionDate: i.inceptionDate,
    result: i.result,
  });
}

/** What the plan would have paid with no cap on it — needed to say how much a cap took. */
function uncappedPlanPays(i: ExplainInput): number {
  const afterDeductible = cents(i.amount - i.result.deductibleApplied);
  return cents(afterDeductible - cents((afterDeductible * i.plan.outpatientCopayPct) / 100));
}

// ---------------------------------------------------------------------------
// Payable: a claim or reimbursement that pays, or a pre-authorization estimate
// ---------------------------------------------------------------------------

function payable(i: ExplainInput): Explanation {
  const { plan, result: r } = i;
  const f = facts(i);
  const planPays = r.planPays ?? 0;
  const memberPays = r.memberPays ?? 0;
  const forecast = i.kind === "preauth";
  const phrase = benefitClassPhrase[i.benefitClass];
  const pct = plan.outpatientCopayPct;
  const deductibleAfter = r.ledgerAfter.deductibleMet;

  // ---- member ----
  const member: string[] = [forecast ? "This is an estimate, not a decision." : "This is covered."];

  if (r.deductibleApplied > 0 && planPays === 0 && cents(i.amount - r.deductibleApplied) === 0) {
    member.push(
      `All of this goes towards your yearly deductible, so the plan pays nothing on it yet — but it counts: your deductible is now ${aed(deductibleAfter)} of ${aed(plan.deductible)}.`,
    );
  } else if (r.deductibleApplied > 0) {
    member.push(`The first ${aed(r.deductibleApplied)} goes towards your yearly deductible, then your ${pct}% share applies to the rest.`);
  } else if (plan.deductible === 0) {
    member.push(`Your plan has no deductible, so only your ${pct}% share applies.`);
  } else {
    member.push(`Your deductible was already met this year, so only your ${pct}% share applies.`);
  }

  if (r.clippedBy === "sublimit" && f.limit) {
    member.push(
      `Your plan's ${phrase} benefit is limited to ${aed(f.limit.cap)} a year, which caps what it can pay: it would have paid ${aed(uncappedPlanPays(i))}, so it ${forecast ? "would pay" : "pays"} ${aed(planPays)}.`,
    );
  } else if (r.clippedBy === "annual_limit" && f.limit) {
    member.push(
      `Your annual limit of ${aed(f.limit.cap)} caps what the plan can pay: it would have paid ${aed(uncappedPlanPays(i))}, so it ${forecast ? "would pay" : "pays"} ${aed(planPays)}.`,
    );
  }

  if (forecast) member.push(`If this goes ahead as planned, the plan would pay about ${aed(planPays)} and you would pay about ${aed(memberPays)}.`);
  else if (i.kind === "reimbursement") member.push(`The plan pays ${aed(planPays)} back to you, and your cost is ${aed(memberPays)}.`);
  else member.push(`The plan pays ${aed(planPays)} and you pay ${aed(memberPays)}.`);

  if (forecast) {
    member.push("Nothing has been claimed or set aside. This is based on what you've used so far, so it changes if other claims are paid first.");
  } else {
    if (f.deductibleNowMet) member.push("Your deductible is now met for the year, so later claims skip that step.");
    if (r.clippedBy === "sublimit" && f.limit) {
      member.push(`This benefit is now fully used for the policy year; ${phrase} costs before ${longDate(f.limit.resetsOn)} fall to you.`);
    }
    member.push(
      i.kind === "reimbursement"
        ? "The plan's share is paid back to you rather than to the provider."
        : "The plan settles its share with the provider; the rest is yours to pay them.",
    );
  }

  // ---- broker ----
  const cls = brokerClass[i.benefitClass];
  const broker: string[] = [
    `${i.policyRef} ${i.eventRef} (${eventKindWord[i.kind]}, month ${i.policyMonth}): ${cls} at ${providerTypeLabel[i.providerTier].toLowerCase()}, ${forecast ? "estimated" : "billed"} ${aed(i.amount)}.`,
    forecast ? `Forecast only — no ledger write. Plan would pay ${aed(planPays)}, member ${aed(memberPays)}.` : `Plan paid ${aed(planPays)}, member ${aed(memberPays)}.`,
  ];
  if (r.deductibleApplied > 0) {
    broker.push(`Deductible ${aed(r.deductibleApplied)} applied (${aed(deductibleAfter)} of ${aed(plan.deductible)} ${forecast ? "would be met" : "met"}).`);
  } else if (plan.deductible > 0) {
    broker.push("Deductible already met.");
  }
  if (!forecast) broker.push(`Annual paid now ${num(r.ledgerAfter.annualPaid)} of ${num(plan.annualLimit)}.`);

  if (r.clippedBy === "sublimit" && f.limit) {
    broker.push(
      `The ${num(f.limit.cap)} ${cls} cap ${forecast ? "would be" : "was"} the binding constraint, not the co-pay or the network — worth raising at renewal.`,
    );
  } else if (r.clippedBy === "annual_limit") {
    broker.push(`The annual limit ${forecast ? "would be" : "was"} the binding constraint on this event.`);
  }
  const waited = !forecast ? (i.priorDenied ?? []).find((d) => d.benefitClass === i.benefitClass && d.reasonCode === "waiting_period_not_elapsed") : undefined;
  if (waited) {
    broker.push(
      `First ${cls} claim to pay since the ${waitMonths(plan, i.benefitClass)}-month wait cleared; ${waited.ref} was denied for it at month ${waited.month} — the tradeoff came due and resolved as expected.`,
    );
  } else if (!(r.clippedBy) && !forecast && r.deductibleApplied > 0 && memberPays / i.amount > 0.5) {
    broker.push(
      `Member share of ${Math.round((memberPays / i.amount) * 100)}% on this claim is mostly the yearly deductible — expected on ${plan.name}'s terms, not a fit signal on its own.`,
    );
  }

  return { member: member.join(" "), broker: broker.join(" ") };
}

// ---------------------------------------------------------------------------
// Denied: one reason code, and something the member can do about it
// ---------------------------------------------------------------------------

function denied(i: ExplainInput): Explanation {
  const { plan, result: r } = i;
  const f = facts(i);
  const forecast = i.kind === "preauth";
  const phrase = benefitClassPhrase[i.benefitClass];
  const cls = brokerClass[i.benefitClass];
  const code = r.reasonCode;
  const tier = providerTypeLabel[i.providerTier];
  const wait = waitMonths(plan, i.benefitClass);
  const priorHit = [...(i.priorPayable ?? [])].reverse().find((e) => e.benefitClass === i.benefitClass);
  const monthLabel = monthYear(policyMonthStart(i.inceptionDate, i.policyMonth));

  const member: string[] = [
    code === "waiting_period_not_elapsed"
      ? forecast ? "As planned, this wouldn't be covered yet." : "This isn't covered yet."
      : forecast ? "As planned, this wouldn't be covered." : "This isn't covered.",
  ];
  let broker = "";

  switch (code) {
    case "waiting_period_not_elapsed": {
      const w = f.waitingPeriod!;
      member.push(
        `Your plan has a ${w.months}-month waiting period for ${phrase}, and this treatment falls in ${monthLabel}, before it ends. The waiting period ends on ${longDate(w.clearsOn)}; from that date, ${benefitClassCovered[i.benefitClass]} is covered under your plan's normal terms.`,
      );
      broker = `${i.policyRef} ${i.eventRef}: ${cls} at month ${i.policyMonth} denied — ${plan.name}'s ${wait}-month wait clears at month ${wait} (${longDate(w.clearsOn)}). Not a fit signal on its own: the tradeoff is behaving as sold. Ledger unchanged.`;
      break;
    }
    case "provider_out_of_network": {
      const admitted = list((f.admittedProviders ?? []).map((t) => providerTypePlural[t]));
      member.push(`A ${tier.toLowerCase()} isn't in your plan's network. Your ${plan.name} plan covers ${admitted}.`);
      broker = `${i.policyRef} ${i.eventRef}: provider tier ${i.providerTier} is outside the ${plan.network} network on ${plan.name}. One out-of-network episode is not a pattern by itself — check the tier was recorded correctly before reading it as member behaviour. Ledger unchanged.`;
      break;
    }
    case "sublimit_exhausted": {
      const l = f.limit!;
      member.push(
        `Your plan's ${phrase} benefit pays up to ${aed(l.cap)} a year, and you've used ${aed(l.used)} of it. A used-up limit doesn't pay more until your next policy year starts on ${longDate(l.resetsOn)}.`,
      );
      broker = `${i.policyRef} reached the ${num(l.cap)} ${cls} cap${priorHit ? ` at month ${priorHit.month} (${priorHit.ref})` : ""}; ${i.eventRef} at month ${i.policyMonth} is the first event past it. The cap, not the co-pay or the network, was the binding constraint — worth raising at renewal. Ledger unchanged.`;
      break;
    }
    case "annual_limit_reached": {
      const l = f.limit!;
      member.push(`You've reached your plan's annual limit of ${aed(l.cap)}. It starts again on ${longDate(l.resetsOn)}.`);
      broker = `${i.policyRef} ${i.eventRef}: annual limit of ${num(l.cap)} already reached at month ${i.policyMonth}. Ledger unchanged; review whether ${plan.name} is still the right ceiling.`;
      break;
    }
    case "benefit_excluded": {
      member.push(`Your ${plan.name} plan doesn't include ${phrase}. An advisor can talk you through your options.`);
      broker = `${i.policyRef} ${i.eventRef}: ${plan.name} excludes ${cls}. If this was a declared need, the question is the plan fit at recommendation, not the claim. Ledger unchanged.`;
      break;
    }
    default: {
      member.push("Your policy wasn't active on the date of this treatment. An advisor can talk you through what that means.");
      broker = `${i.policyRef} ${i.eventRef}: policy not active at month ${i.policyMonth}. Ledger unchanged.`;
    }
  }

  member.push(forecast ? `You would pay the full ${aed(i.amount)}.` : `You pay the full ${aed(i.amount)} for this one.`);
  if (f.appealable) member.push("If you think this decision is wrong, you can appeal it.");

  return { member: member.join(" "), broker };
}

// ---------------------------------------------------------------------------
// Undecidable: the plan says nothing — the one case that is not a low-confidence answer
// ---------------------------------------------------------------------------

function undecidable(i: ExplainInput): Explanation {
  const where = i.geography === "uae" ? "at a provider we couldn't place in a network" : "outside the UAE";
  return {
    member: `We can't work this out from your plan terms alone. Your plan doesn't say how treatment ${where} is handled, so we haven't guessed. A person needs to look at it — nothing you've sent has been lost, and you won't need to send it again.`,
    broker: `${i.policyRef} ${i.eventRef}: ${eventKindWord[i.kind]} of ${aed(i.amount)} for ${brokerClass[i.benefitClass]} treatment ${where} (provider tier unrecorded). The plan terms define no geographic scope, so no rule was applied and no amount computed. Routed to you: it needs a decision on whether, and on what terms, treatment like this is covered.`,
  };
}

// ---------------------------------------------------------------------------
// Appeals
// ---------------------------------------------------------------------------

function explainAppeal(i: ExplainInput): Explanation {
  const a = i.appeal;
  if (!a) throw new Error(`${i.eventRef} is an appeal but carries no appeal context`);
  const { plan, result: r } = i;
  const f = facts({ ...i, kind: "claim" });
  const cls = brokerClass[i.benefitClass];
  const wait = waitMonths(plan, i.benefitClass);
  const clearsOn = f.waitingPeriod?.clearsOn;

  if (a.verdict === "overturned") {
    const planPays = r.planPays ?? 0;
    const memberPays = r.memberPays ?? 0;
    const share =
      r.deductibleApplied > 0
        ? ` (your ${aed(r.deductibleApplied)} deductible, then your ${plan.outpatientCopayPct}% share)`
        : ` (your ${plan.outpatientCopayPct}% share)`;
    const member = [
      `You were right${a.evidenceSummary ? ` — ${a.evidenceSummary}` : ""}.`,
      `We've reversed the decision: the plan pays ${aed(planPays)} of the ${aed(i.amount)} billed and your share is ${aed(memberPays)}${share}.`,
      nextStepFacts({ plan, kind: "claim", benefitClass: i.benefitClass, providerTier: i.providerTier, policyMonth: i.policyMonth, inceptionDate: i.inceptionDate, result: r })
        .deductibleNowMet
        ? "Your deductible is now met for the year."
        : "",
    ].filter(Boolean);

    const broker = [
      `${i.policyRef} ${a.contestedRef} overturned on evidence${a.evidenceSummaryBroker ? `: ${a.evidenceSummaryBroker}` : ""}.`,
      a.correction ? `${upperFirst(a.correction.field)} corrected ${a.correction.from} → ${a.correction.to}.` : "",
      `Plan pays ${aed(planPays)}, member ${aed(memberPays)}; ledger rewritten at month ${i.policyMonth}, so later events forecast against the corrected ledger.`,
      a.contestedReason === "provider_out_of_network"
        ? "One out-of-network episode, and it was a recording error rather than member behaviour: no fit implication."
        : "",
    ].filter(Boolean);
    return { member: member.join(" "), broker: broker.join(" ") };
  }

  // Upheld — the member did the work and lost; they get the reason, and the way forward.
  const why: Partial<Record<ReasonCode, string>> = {
    waiting_period_not_elapsed: a.declaredAtIntake
      ? "Your application already records this condition as existing, and nothing sent shows it began after your policy started, so the waiting period applies."
      : "Nothing sent shows the condition began after your policy started, so the waiting period applies.",
    provider_out_of_network: "What you sent doesn't show the provider is registered under a different network tier, so it stays outside your plan's network.",
    sublimit_exhausted: "What you sent doesn't show an earlier claim was counted against this limit by mistake.",
    annual_limit_reached: "What you sent doesn't show an earlier claim was counted against this limit by mistake.",
    benefit_excluded: "What you sent doesn't show this treatment belongs to a benefit your plan covers.",
  };
  const changes = (EVIDENCE_THAT_COULD_CHANGE[a.contestedReason] ?? []).map(lowerFirst);
  const member = [
    a.evidenceSupplied ? "We looked again with what you sent, and the decision stands." : "We've looked at your appeal, and the decision stands.",
    why[a.contestedReason] ?? "",
    changes.length ? `What could change this: ${changes.join(", or ")}.` : "",
    a.contestedReason === "waiting_period_not_elapsed" && clearsOn
      ? `The waiting period ends on ${longDate(clearsOn)}; from that date, ${benefitClassCovered[i.benefitClass]} is covered under your plan's normal terms.`
      : "",
  ].filter(Boolean);

  const broker = [
    `${i.policyRef} ${a.appealRef} contested ${a.contestedRef} (${a.contestedReason}) at month ${i.policyMonth}: ${a.evidenceSupplied ? "evidence did not bear on the finding" : "no evidence attached"}. Upheld.`,
    a.contestedReason === "waiting_period_not_elapsed"
      ? `${a.declaredAtIntake ? "Condition was declared at intake. " : ""}${plan.name}'s ${wait}-month ${cls} wait clears at month ${wait}${clearsOn ? ` (${longDate(clearsOn)})` : ""}; not a fit signal — the tradeoff is behaving as sold.`
      : "Finding stands as adjudicated.",
    "Ledger unchanged.",
  ];
  return { member: member.join(" "), broker: broker.join(" ") };
}
