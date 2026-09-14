// Layer 2 · constraint — what this record asks for that the panel, at this
// budget, cannot actually give.
//
// "Covered" is not the question. A benefit sitting behind a waiting period the
// applicant cannot wait out is not cover in any way that helps them, and that
// distinction is the whole of this file. It turns on ONE property of the need:
//
//   EVENT needs (maternity) happen on a date inside the horizon. A waiting
//   period that has not cleared by then is an exclusion wearing a yes.
//
//   CONTINUOUS needs (chronic management, routine outpatient) have no
//   deadline. A waiting period delays the benefit; the applicant self-funds
//   the gap and the cover is real afterwards. That is a tradeoff to be told
//   about, not a plan that fails them.
//
// The same 6-month wait is therefore a `warn` for P3's managed diabetes and
// would be a `review` for a dated procedure. Rule codes are the supplied
// fixtures' vocabulary — a live assessment of P1..P5 has to be readable
// alongside the supplied one.

import type { BenefitClass, ProviderTier } from "@/db/schema";
import {
  admitsKey,
  aed,
  BUDGET_CEILING,
  cheapest,
  plansInBudget,
  type AssessmentRecord,
  type Catalogue,
  type Flag,
  type PlanTerms,
  type Rule,
} from "./types";

type Inputs = { record: AssessmentRecord; catalogue: Catalogue };

// ---------------------------------------------------------------------------
// Reading a plan against one need
// ---------------------------------------------------------------------------

/** Needs with a date attached. Everything else is treated as continuous. */
const EVENT_CLASSES: BenefitClass[] = ["maternity"];

export const covers = (plan: PlanTerms, benefitClass: BenefitClass): boolean => {
  switch (benefitClass) {
    case "maternity":
      return plan.maternityCovered;
    case "chronic_preexisting":
      return plan.chronicCovered;
    case "dental_optical":
      return plan.dentalOptical !== "none";
    case "general":
      return true;
  }
};

export const waitMonths = (plan: PlanTerms, benefitClass: BenefitClass): number => {
  switch (benefitClass) {
    case "maternity":
      return plan.maternityWaitingPeriodMonths ?? 0;
    case "chronic_preexisting":
      return plan.chronicWaitingPeriodMonths ?? 0;
    default:
      return 0;
  }
};

/**
 * Does this plan's wait clear in time?
 *
 * Event needs need it to clear STRICTLY before the horizon — a 12-month wait
 * against a 12-month horizon means the benefit starts the day the applicant
 * stopped needing it. Continuous needs only need it to be no longer than the
 * horizon, so a 0-month wait against a 0-month horizon passes.
 */
export const clearsInTime = (plan: PlanTerms, benefitClass: BenefitClass, horizonMonths: number): boolean => {
  const wait = waitMonths(plan, benefitClass);
  return EVENT_CLASSES.includes(benefitClass) ? wait < horizonMonths : wait <= horizonMonths;
};

const usable = (plan: PlanTerms, benefitClass: BenefitClass, horizonMonths: number) =>
  covers(plan, benefitClass) && clearsInTime(plan, benefitClass, horizonMonths);

export type NeedVerdict = {
  need: AssessmentRecord["needs"][number];
  benefitClass: BenefitClass;
  horizonMonths: number;
  isEvent: boolean;
  /** In-budget plans that cover the class at all, cheapest first. */
  coveringInBudget: PlanTerms[];
  /** In-budget plans that cover it AND clear the wait in time. */
  usableInBudget: PlanTerms[];
  /** Plans above the budget ceiling that would clear it. */
  usableAboveBudget: PlanTerms[];
  /** Any plan on the panel that covers the class, at any price. */
  coveringAnywhere: PlanTerms[];
};

/**
 * Read every need against the catalogue once. Rules below filter these
 * verdicts rather than re-deriving them, so a need can only fire ONE of
 * "excluded at this budget" / "nothing on the panel" / "delayed" — three rows
 * saying the same thing three ways is noise in a queue built to be scanned.
 */
export function readNeeds(record: AssessmentRecord, catalogue: Catalogue): NeedVerdict[] {
  const inBudget = plansInBudget(catalogue.plans, record.budget);
  const byPrice = (a: PlanTerms, b: PlanTerms) => a.annualPremium - b.annualPremium;

  return record.needs.flatMap((need) => {
    // Unclassified needs and missing horizons are layer 1's business; there is
    // nothing here to compare them against.
    if (need.benefitClass == null || need.horizonMonths == null) return [];
    const benefitClass = need.benefitClass;
    const horizonMonths = need.horizonMonths;

    return [
      {
        need,
        benefitClass,
        horizonMonths,
        isEvent: EVENT_CLASSES.includes(benefitClass),
        coveringInBudget: inBudget.filter((p) => covers(p, benefitClass)).sort(byPrice),
        usableInBudget: inBudget.filter((p) => usable(p, benefitClass, horizonMonths)).sort(byPrice),
        usableAboveBudget: catalogue.plans
          .filter((p) => p.annualPremium > BUDGET_CEILING[record.budget])
          .filter((p) => usable(p, benefitClass, horizonMonths))
          .sort(byPrice),
        coveringAnywhere: catalogue.plans.filter((p) => covers(p, benefitClass)).sort(byPrice),
      },
    ];
  });
}

/** An event need is served at this budget only if something clears in time. */
const shortAtBudget = (v: NeedVerdict) =>
  v.isEvent ? v.usableInBudget.length === 0 : v.coveringInBudget.length === 0;

const months = (n: number) => (n === 0 ? "immediately" : `in ~${n} month${n === 1 ? "" : "s"}`);

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export const CONSTRAINT_RULES: Rule<Inputs>[] = [
  {
    code: "budget_below_cheapest_plan",
    severity: "block",
    fields: ["budget"],
    confidenceFloor: "low",
    layer: "constraint",
    evaluate: ({ record, catalogue }) => {
      const floor = cheapest(catalogue.plans);
      if (!floor || BUDGET_CEILING[record.budget] >= floor.annualPremium) return null;
      return `Stated budget band "${record.budget}" tops out at ${aed(
        BUDGET_CEILING[record.budget],
      )}; the cheapest plan on the panel is ${floor.name} at ${aed(
        floor.annualPremium,
      )}. Nothing can be quoted inside the band as stated.`;
    },
  },
  {
    // The P2 shape: the benefit exists on the panel and would work — one
    // budget band up. This is a decision about money, and it is the
    // applicant's to make, which is exactly why it goes to a person.
    code: "need_class_excluded_at_budget",
    severity: "review",
    fields: ["near_term_needs", "budget"],
    confidenceFloor: "low",
    layer: "constraint",
    evaluate: ({ record, catalogue }) => {
      const hit = readNeeds(record, catalogue).filter((v) => shortAtBudget(v) && v.usableAboveBudget.length > 0);
      if (hit.length === 0) return null;

      return hit
        .map((v) => {
          const rescue = v.usableAboveBudget[0];
          const blocked = v.coveringInBudget[0];
          const blockedNote = blocked
            ? `${blocked.name} covers it but behind a ${waitMonths(blocked, v.benefitClass)}-month wait, which does not clear inside the ${v.horizonMonths}-month horizon`
            : `no plan inside the band covers it at all`;
          return `"${v.need.rawText}" needed ${months(v.horizonMonths)}: ${blockedNote}. The only plan that does clear is ${rescue.name} at ${aed(
            rescue.annualPremium,
          )}, one band above the stated ${record.budget} budget (${aed(BUDGET_CEILING[record.budget])}).`;
        })
        .join(" ");
    },
  },
  {
    // Nothing on the panel serves this, at any price. Not a budget decision —
    // a coverage one, and the applicant has to be told before they buy.
    code: "need_class_unavailable",
    severity: "review",
    fields: ["near_term_needs"],
    confidenceFloor: "low",
    layer: "constraint",
    evaluate: ({ record, catalogue }) => {
      const hit = readNeeds(record, catalogue).filter((v) => shortAtBudget(v) && v.usableAboveBudget.length === 0);
      if (hit.length === 0) return null;

      return hit
        .map((v) => {
          if (v.coveringAnywhere.length === 0) {
            return `"${v.need.rawText}" (${v.benefitClass.replace(/_/g, " ")}) is not covered by any plan on the panel.`;
          }
          const best = v.coveringAnywhere[0];
          return `"${v.need.rawText}" is needed ${months(v.horizonMonths)}, and the shortest waiting period on the panel is ${waitMonths(
            best,
            v.benefitClass,
          )} months (${best.name}). No plan pays for it inside that horizon at any price.`;
        })
        .join(" ");
    },
  },
  {
    // The P3 shape. Cover is real; it just does not start on day one. A warn,
    // not a review — but it caps confidence, because "buy it and self-fund six
    // months" is a conversation, not an arithmetic result.
    code: "chronic_wait_vs_horizon",
    severity: "warn",
    fields: ["near_term_needs"],
    confidenceFloor: "medium",
    layer: "constraint",
    evaluate: ({ record, catalogue }) => {
      const hit = readNeeds(record, catalogue).filter(
        (v) =>
          v.benefitClass === "chronic_preexisting" &&
          v.coveringInBudget.length > 0 &&
          v.usableInBudget.length === 0,
      );
      if (hit.length === 0) return null;

      const conditions = record.conditions.length;
      return hit
        .map((v) => {
          const plan = v.coveringInBudget[0];
          return `${conditions > 0 ? `${conditions} declared condition(s) and a ` : "A "}${v.horizonMonths}-month stated horizon on "${v.need.rawText}", against ${plan.name}'s ${waitMonths(
            plan,
            v.benefitClass,
          )}-month chronic wait. Cover is real but not immediate — confirm the applicant understands the first ${waitMonths(
            plan,
            v.benefitClass,
          )} months are self-funded.`;
        })
        .join(" ");
    },
  },
  {
    // Fires only when the provider actually CONSTRAINS the choice: it forces a
    // more expensive plan than the record would otherwise land on. With a
    // not_a_concern budget it constrains nothing, which is why P5's named
    // private hospital is not a flag and P4's top-tier one is.
    code: "expected_provider_above_network",
    severity: "review",
    fields: ["expected_providers"],
    confidenceFloor: "medium",
    layer: "constraint",
    evaluate: ({ record, catalogue }) => {
      if (record.budget === "not_a_concern") return null;
      const inBudget = plansInBudget(catalogue.plans, record.budget).sort(
        (a, b) => a.annualPremium - b.annualPremium,
      );
      const floor = inBudget[0];
      if (!floor) return null;

      const hit = record.providers
        .filter((p): p is typeof p & { tier: ProviderTier } => p.tier != null)
        .map((p) => ({
          provider: p,
          admitting: inBudget.filter((plan) => catalogue.admits.has(admitsKey(plan.network, p.tier))),
        }))
        .filter(({ admitting }) => admitting.length > 0 && admitting[0].id !== floor.id);

      if (hit.length === 0) return null;
      return hit
        .map(
          ({ provider, admitting }) =>
            `${provider.providerName} sits at ${provider.tier.replace(/_/g, " ")}; ${floor.name}'s ${floor.network} network does not admit that tier. The cheapest plan that does is ${admitting[0].name} at ${aed(
              admitting[0].annualPremium,
            )}, so the named provider — not the health record — is what sets the floor on price.`,
        )
        .join(" ");
    },
  },
  {
    code: "expected_provider_unavailable",
    severity: "review",
    fields: ["expected_providers"],
    confidenceFloor: "low",
    layer: "constraint",
    evaluate: ({ record, catalogue }) => {
      const hit = record.providers
        .filter((p): p is typeof p & { tier: ProviderTier } => p.tier != null)
        .filter((p) => !catalogue.plans.some((plan) => catalogue.admits.has(admitsKey(plan.network, p.tier))));
      if (hit.length === 0) return null;
      return `${hit
        .map((p) => `${p.providerName} (${p.tier.replace(/_/g, " ")})`)
        .join(", ")} is not admitted by any network on the panel. The applicant expects to be treated somewhere no plan we sell will pay for.`;
    },
  },
  {
    code: "expected_provider_tier_unknown",
    severity: "warn",
    fields: ["expected_providers"],
    confidenceFloor: "high",
    layer: "constraint",
    evaluate: ({ record }) => {
      const unknown = record.providers.filter((p) => p.tier == null);
      if (unknown.length === 0) return null;
      return `${unknown
        .map((p) => p.providerName)
        .join(", ")}: provider tier unknown, so the network gate cannot be tested against it.`;
    },
  },
  {
    // THE undefined case in the supplied data. Flagged at intake so the
    // broker knows before a claim returns insufficient_data at settlement.
    code: "treatment_outside_uae_expected",
    severity: "warn",
    fields: ["treatment_outside_uae_expected"],
    confidenceFloor: "medium",
    layer: "constraint",
    evaluate: ({ record }) =>
      record.treatmentOutsideUaeExpected
        ? "Applicant expects some treatment outside the UAE. Geographic scope is undefined in the plan wording — expect insufficient_data at claim time."
        : null,
  },
  {
    code: "high_expected_utilisation",
    severity: "warn",
    fields: ["age", "conditions"],
    confidenceFloor: "medium",
    layer: "constraint",
    evaluate: ({ record }) => {
      if (record.age < 60 || record.conditions.length === 0) return null;
      return `Age ${record.age} with ${record.conditions.length} declared condition(s) (${record.conditions
        .map((c) => c.rawText)
        .join(", ")}). Expected utilisation sits well above the cohort baseline — annual limit and network depth matter more here than premium.`;
    },
  },
];

export function evaluateConstraintRules(inputs: Inputs): { rule: Rule<Inputs>; flag: Flag }[] {
  return CONSTRAINT_RULES.flatMap((rule) => {
    const reason = rule.evaluate(inputs);
    return reason ? [{ rule, flag: { ruleCode: rule.code, severity: rule.severity, fields: rule.fields, reason } }] : [];
  });
}
