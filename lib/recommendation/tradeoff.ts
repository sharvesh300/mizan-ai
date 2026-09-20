// The question nobody was asking: "the cheap plan does not do the thing you
// said you needed — which of those two do you actually want?"
//
// THE BUG THIS EXISTS FOR. An applicant declared a chronic condition and a
// need to cover it, and said their priority was the lowest premium. Those two
// are in direct conflict on this panel: the cheapest plan does not cover
// pre-existing conditions AT ALL, so `isEligible` strips it and it can never
// be shortlisted. The applicant then asked, in as many words, "can we go for
// Essential?" — and the system, having no way to say "that one is ruled out
// by something you told us", treated it as an ordinary price objection,
// rebuilt, and came back with a MORE expensive plan. Twice.
//
// No amount of re-weighting fixes that. Weights reorder eligible plans; they
// cannot admit an ineligible one. The conflict is not between two criteria,
// it is between a criterion and a HARD GATE, and the only honest move is to
// stop and ask which side of it the applicant wants to be on.
//
// Everything here is deterministic. The trade-off is detected from the
// record, the catalogue and the quotes; the question is composed from the
// plans' own figures; and each answer is bound to a fixed set of preference
// signals BEFORE the applicant ever sees it — so the answer moves the weights
// by a route that was decided in advance, not by a model's reading of free
// text. See lib/ai/graph/nodes/tradeoff.ts for the node that asks it.

import { covers, clearsInTime, waitMonths, type AssessmentRecord, type Catalogue, type PlanTerms } from "@/lib/assessment";
import { isEligible } from "./eligibility";
import type { PreferenceSignal } from "./preference";
import { isCriterionRelevant } from "./score";
import type { CriterionId, QuoteRow } from "./types";

/** Which way the applicant resolved the conflict. Deliberately two, not a scale: this is a fork, not a dial. */
export const TRADE_OFF_CHOICES = ["premium", "requirement"] as const;
export type TradeOffChoice = (typeof TRADE_OFF_CHOICES)[number];

export type TradeOff = {
  /** The cheaper plan the applicant is drawn to, and which the record rules out. */
  cheaperPlanId: string;
  cheaperPlanName: string;
  cheaperPremium: number;
  /** What is on the table instead. */
  currentPlanId: string;
  currentPlanName: string;
  currentPremium: number;
  /** In AED per year. Always positive — a trade-off with no saving is not a trade-off. */
  saving: number;
  /** What the cheaper plan fails, in the applicant's own declared terms. */
  requirement: string;
  /** True when the cheaper plan does not cover the benefit at all, as opposed to covering it after a wait. */
  notCoveredAtAll: boolean;
  /**
   * The criteria the blocked requirement actually maps onto — derived from
   * the need that blocked it, not a blanket list.
   *
   * This is deliberately narrow, and the narrowness is load-bearing. An
   * earlier version signalled every plausibly-related criterion on each
   * answer, which introduced criteria the cohort baseline had never weighted;
   * because weights are normalised to sum to 1, that DILUTED the very
   * criterion the applicant had just chosen to protect — "keep my condition
   * cover" came back with `chronic_depth` weighted LOWER than before they
   * answered. Signalling only what the requirement names keeps the answer
   * pointing where the applicant pointed it.
   */
  blockedDimensions: CriterionId[];
};

/**
 * Is there a cheaper plan that the applicant's OWN declared needs rule out?
 *
 * Only ever returns a plan that is genuinely cheaper and genuinely blocked.
 * A cheaper plan that is merely worse is not a trade-off — that is an ordinary
 * price objection, and rebuilding around it is the right response.
 *
 * `objection` is used only to PREFER a plan the applicant named ("can we go
 * for Essential?"), never to decide whether a trade-off exists. The record
 * decides that.
 */
export function detectTradeOff(input: {
  record: AssessmentRecord;
  catalogue: Catalogue;
  quotes: QuoteRow[];
  /** The plan currently on the table — what they are objecting to. */
  currentPlanId: string | null;
  objection: string;
}): TradeOff | null {
  const { record, catalogue, quotes, currentPlanId, objection } = input;
  if (!currentPlanId) return null;

  const current = catalogue.plans.find((p) => p.id === currentPlanId);
  if (!current) return null;
  const currentPremium = quotes.find((q) => q.planId === current.id)?.annualPremium ?? current.annualPremium;

  const blocked = catalogue.plans.filter((plan) => {
    const premium = quotes.find((q) => q.planId === plan.id)?.annualPremium ?? plan.annualPremium;
    return plan.id !== current.id && premium < currentPremium && !isEligible(plan, record);
  });
  if (blocked.length === 0) return null;

  // Prefer the one they actually named; otherwise the cheapest of them, which
  // is the one the saving argument is strongest for.
  const lower = objection.toLowerCase();
  const named = blocked.find((plan) => lower.includes(plan.name.toLowerCase()) || lower.includes(plan.id.toLowerCase()));
  const cheaper =
    named ??
    [...blocked].sort(
      (a, b) =>
        (quotes.find((q) => q.planId === a.id)?.annualPremium ?? a.annualPremium) -
        (quotes.find((q) => q.planId === b.id)?.annualPremium ?? b.annualPremium),
    )[0];

  const cheaperPremium = quotes.find((q) => q.planId === cheaper.id)?.annualPremium ?? cheaper.annualPremium;
  const blockedNeed = firstBlockedNeed(cheaper, record);
  if (!blockedNeed) return null;

  return {
    cheaperPlanId: cheaper.id,
    cheaperPlanName: cheaper.name,
    cheaperPremium,
    currentPlanId: current.id,
    currentPlanName: current.name,
    currentPremium,
    saving: currentPremium - cheaperPremium,
    requirement: blockedNeed.requirement,
    notCoveredAtAll: blockedNeed.notCoveredAtAll,
    blockedDimensions: blockedNeed.dimensions.filter((id) => isCriterionRelevant(id, record)),
  };
}

/** The declared need this plan fails, phrased from the record rather than from the plan's marketing. */
function firstBlockedNeed(
  plan: PlanTerms,
  record: AssessmentRecord,
): { requirement: string; notCoveredAtAll: boolean; dimensions: CriterionId[] } | null {
  for (const need of record.needs) {
    if (need.benefitClass == null) continue;

    // The benefit is not covered at all — this is about whether the plan
    // serves the need, which is `need_coverage`, plus the depth criterion for
    // the benefit class when there is one.
    if (!covers(plan, need.benefitClass)) {
      return {
        requirement: phrase(need.benefitClass),
        notCoveredAtAll: true,
        dimensions: need.benefitClass === "chronic_preexisting" ? ["need_coverage", "chronic_depth"] : ["need_coverage"],
      };
    }

    // Covered, but not in time — that is `waiting_period_fit` specifically,
    // and nothing else. The plan does serve the need, just not soon enough.
    if (need.horizonMonths != null && !clearsInTime(plan, need.benefitClass, need.horizonMonths)) {
      return {
        requirement: `${phrase(need.benefitClass)} within ${need.horizonMonths} months (this plan waits ${waitMonths(plan, need.benefitClass)})`,
        notCoveredAtAll: false,
        dimensions: ["waiting_period_fit"],
      };
    }
  }
  return null;
}

const phrase = (benefitClass: string): string =>
  benefitClass === "chronic_preexisting"
    ? "cover for the condition you've already told us about"
    : benefitClass === "maternity"
      ? "maternity cover"
      : benefitClass === "dental_optical"
        ? "dental and optical cover"
        : "cover for what you said you needed";

/**
 * The question, composed from the two plans' own figures.
 *
 * No model writes this, which is the point: every number in it is a plan term
 * the catalogue already holds, so it needs no citation check and cannot drift
 * into a promise nobody can keep. It is also not a sales pitch — both sides
 * are stated at their real cost, including the one that costs us more.
 */
export function describeTradeOff(tradeOff: TradeOff): { question: string; options: Record<TradeOffChoice, string> } {
  const gap = `AED ${tradeOff.saving.toLocaleString("en-US")} a year less`;
  const blocker = tradeOff.notCoveredAtAll
    ? `it doesn't include ${tradeOff.requirement} at all`
    : `it doesn't give you ${tradeOff.requirement}`;

  return {
    question:
      `${tradeOff.cheaperPlanName} is AED ${tradeOff.cheaperPremium.toLocaleString("en-US")} a year — ${gap} than ${tradeOff.currentPlanName}. ` +
      `The catch is that ${blocker}, which is something you told us you needed. ` +
      `Which matters more to you here: the lower premium, or keeping that cover?`,
    options: {
      premium: `The lower premium matters more — I'd rather pay less than keep ${tradeOff.requirement}.`,
      requirement: `Keeping ${tradeOff.requirement} matters more — I'll pay the higher premium for it.`,
    },
  };
}

/**
 * What each answer DOES, decided before the question is asked.
 *
 * This is the whole reason the trade-off is worth asking: the answer is not a
 * sentiment, it is a weight change with the applicant's name on it. A
 * clarification-sourced signal carries the highest confidence the system
 * issues, because they were asked precisely this and replied.
 *
 * Note what the `premium` answer does NOT do: it does not un-declare the
 * need. A declared medical requirement is a fact on the record, and removing
 * it is an amendment to the application, not a preference. The node routes
 * that answer to a person for exactly that reason — but the signals below are
 * still written, because the applicant has told us something true about how
 * they weigh cost against cover, and that should survive the conversation.
 */
export function signalsForChoice(choice: TradeOffChoice, tradeOff: TradeOff): PreferenceSignal[] {
  const evidence = { table: "conversation_action", id: tradeOff.cheaperPlanId };
  const reason =
    choice === "premium"
      ? `Asked whether the lower premium or ${tradeOff.requirement} mattered more, and chose the premium.`
      : `Asked whether the lower premium or ${tradeOff.requirement} mattered more, and chose the cover.`;

  // Only the criteria the requirement itself names, plus premium. Anything
  // wider dilutes the answer — see `blockedDimensions` above.
  const dimensions = tradeOff.blockedDimensions;

  if (choice === "premium") {
    return [
      { dimension: "premium_cost", direction: "increase", strength: 0.9, confidence: 0.95, source: "clarification", reason, evidence },
      ...dimensions.map(
        (dimension): PreferenceSignal => ({ dimension, direction: "decrease", strength: 0.7, confidence: 0.95, source: "clarification", reason, evidence }),
      ),
    ];
  }

  return [
    ...dimensions.map(
      (dimension): PreferenceSignal => ({ dimension, direction: "increase", strength: 0.9, confidence: 0.95, source: "clarification", reason, evidence }),
    ),
    // Not a decrease to nothing: they still said they wanted the lowest
    // premium, and that is still true of every plan that clears the
    // requirement. What they rejected was buying the saving with the cover.
    { dimension: "premium_cost", direction: "decrease", strength: 0.5, confidence: 0.9, source: "clarification", reason, evidence },
  ];
}

/**
 * Read a free-text reply as one of the two choices.
 *
 * FAILS SAFE, deliberately and asymmetrically: anything ambiguous reads as
 * `requirement`. Getting this wrong in the `premium` direction means quietly
 * moving an applicant off cover for a condition they have already declared,
 * on the strength of a sentence we were not sure about. Getting it wrong the
 * other way means they pay more than they meant to for one more round and say
 * so again — which the negotiation loop is built to handle.
 */
export function readTradeOffAnswer(answer: string): TradeOffChoice {
  const text = answer.toLowerCase();

  const wantsCover = /\b(cover|coverage|condition|diabet|chronic|medical|treatment|health)\b/.test(text);
  const wantsCheap = /\b(cheap|cheaper|cheapest|premium|price|cost|budget|afford|less|lower|save|saving|essential)\b/.test(text);
  const negated = /\b(don't|dont|do not|no need|not need|without|skip|drop|forget|fine without|okay without|ok without)\b/.test(text);

  // "I don't need the condition cover" — the cover words are present but
  // negated, which is the one case where cover-words mean the opposite.
  if (wantsCover && negated && wantsCheap) return "premium";
  if (wantsCover && !negated) return "requirement";
  if (wantsCheap && !wantsCover) return "premium";
  return "requirement";
}
