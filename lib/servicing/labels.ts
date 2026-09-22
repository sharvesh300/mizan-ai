// Member-language names for the engine's vocabulary.
//
// The engine speaks in closed enums (`chronic_preexisting`,
// `top_tier_private_hospital`). Those are correct, and they are not words a
// member should read about their own care. Kept here, next to the engine and
// free of any UI import, so the template prose, the cards and the seed all use
// the same wording.

import type { BenefitClass, ClaimProviderTier, EventKind } from "@/db/schema/enums";

/** A label — "what kind of treatment was this". */
export const benefitClassLabel: Record<BenefitClass, string> = {
  general: "Routine treatment",
  maternity: "Maternity",
  chronic_preexisting: "An existing condition",
  dental_optical: "Dental & optical",
};

/** The same, mid-sentence. */
export const benefitClassPhrase: Record<BenefitClass, string> = {
  general: "routine treatment",
  maternity: "maternity care",
  chronic_preexisting: "existing conditions",
  dental_optical: "dental and optical care",
};

/**
 * The provider tier in plain words. The tier names are a network-admission
 * vocabulary; "Premium private hospital" is a thing a member can point at, and
 * `in_network_clinic` is not (whether it is in the network is the plan's
 * finding, not a property of the clinic).
 */
export const providerTypeLabel: Record<ClaimProviderTier, string> = {
  in_network_clinic: "Clinic",
  general_hospital: "General hospital",
  private_hospital: "Private hospital",
  top_tier_private_hospital: "Top-tier private hospital",
  premium_private_hospital: "Premium private hospital",
  unknown_foreign: "Outside the UAE",
};

/** What becomes covered once a waiting period ends: "from that date, {this} is covered". */
export const benefitClassCovered: Record<BenefitClass, string> = {
  general: "routine treatment",
  maternity: "maternity care",
  chronic_preexisting: "treatment for existing conditions",
  dental_optical: "dental and optical care",
};

/** The tier as a plural, for "your plan covers clinics, general hospitals and …". */
export const providerTypePlural: Record<ClaimProviderTier, string> = {
  in_network_clinic: "clinics",
  general_hospital: "general hospitals",
  private_hospital: "private hospitals",
  top_tier_private_hospital: "top-tier private hospitals",
  premium_private_hospital: "premium private hospitals",
  unknown_foreign: "providers outside the UAE",
};

export const eventKindWord: Record<EventKind, string> = {
  claim: "claim",
  preauth: "pre-authorization",
  reimbursement: "reimbursement",
  appeal: "appeal",
};

/** What the three figures on an outcome are called, per kind of event. The arithmetic is identical; the sentence is not. */
export const figureLabels: Record<EventKind, [billed: string, plan: string, member: string]> = {
  claim: ["Billed", "Plan pays", "You pay"],
  preauth: ["Estimated cost", "Plan would pay", "You would pay"],
  reimbursement: ["You paid", "Plan pays you back", "Your cost"],
  appeal: ["Billed", "Plan pays", "You pay"],
};
