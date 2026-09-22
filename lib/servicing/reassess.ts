// Plan-fit reassessment — from the event log, not the counters (plan §5.5).
//
// Reassessment runs after every ledger-mutating event and reads the log the same way replay does: it takes
// `replay()`'s own steps, which are already authoritative for what happened and in what order, rather than a
// second reading of the stored columns that could drift from them. The one thing replay leaves out — an
// UPHELD appeal, which has no ledger effect and so produces no step — is passed in separately, because an
// appeal that was looked at and upheld is still part of the record a member should be able to see cited.
//
// The split here is the one this whole system already uses: a DETERMINISTIC feature extraction and verdict
// (this file), and a DETERMINISTIC prose template (reassess-template.ts) that may only cite what the features
// produced. There is no model in this loop — the same discipline `commit.ts` and `appeal-commit.ts` already
// apply to every other terminal explanation in the system, for the same reason: a plan-fit verdict is exactly
// as much a place a wrong number must never appear as a claim's own arithmetic is.

import type { PlanTerms } from "@/lib/assessment";
import type { BenefitClass, EventOutcome, ReasonCode } from "@/db/schema/enums";
import { replay } from "./replay";
import type { Replay, ReplayEvent, ReplayStep } from "./types";

// ---------------------------------------------------------------------------
// What a reassessment may cite
// ---------------------------------------------------------------------------

/** One event, as reassessment is allowed to reason about and cite it. */
export type ReassessEvent = {
  id: string;
  ref: string;
  description: string | null;
  policyMonth: number;
};

export type Citable = ReassessEvent & { outcome: EventOutcome | null; reasonCode: ReasonCode | null; benefitClass: BenefitClass | null; planPays: number | null; memberPays: number | null; billedAmount: number | null };

/** An appeal attempt — cited even when it moved nothing (an upheld appeal has no replay step). */
export type AppealAttempt = ReassessEvent & { contestsRef: string; verdict: "upheld" | "overturned"; reasonCode: ReasonCode };

// ---------------------------------------------------------------------------
// Features — what a reassessment is allowed to reason from
// ---------------------------------------------------------------------------

export type FitFeatures = {
  /** Standing denials (post-fold: an overturned one is gone), grouped by reason code. */
  denialsByReasonCode: Partial<Record<ReasonCode, Citable[]>>;
  /** Reason codes denied two or more times, standing. */
  repeatedDenialReasons: ReasonCode[];
  /** A sublimit or the annual limit was hit or clipped. */
  capsHit: { benefitClass: BenefitClass; event: Citable }[];
  /** A waiting-period denial, later followed by a paid claim of the same benefit class. */
  waitingPeriodsCleared: { benefitClass: BenefitClass; denied: Citable; laterPaid: Citable }[];
  /** Standing denials for being out of network. */
  outOfNetworkEpisodes: Citable[];
  /** Appeals filed, upheld or overturned — cited even when the appeal itself moved no money. */
  appealAttempts: AppealAttempt[];
  /** memberPays / billed, over standing events with an amount. Null when nothing has an amount yet. */
  memberShareRatio: number | null;
  premiumVsPaid: { premium: number; planPaid: number; memberPaid: number };
  /** Every standing event, oldest first — the full citable set, for prose that wants to name "your first claim" etc. */
  standing: Citable[];
};

const isDenial = (o: EventOutcome | null) => o === "denied";
const hasAmount = (c: Citable) => c.billedAmount !== null;

/**
 * `replay()`'s own steps ARE the standing set already — `effectOrder` drops a superseded row before adjudicating
 * it, so an appeal-corrected denial is simply absent, the same way the ledger itself never saw it. Nothing here
 * re-derives that.
 */
export function extractFitFeatures(plan: PlanTerms, events: ReplayEvent[], refOf: Map<string, ReassessEvent>, appeals: AppealAttempt[]): FitFeatures {
  const { steps } = replay(plan, events);
  const cite = (step: ReplayStep): Citable => {
    const meta = refOf.get(step.event.id) ?? { id: step.event.id, ref: step.event.id.slice(0, 8), description: null, policyMonth: step.event.policyMonth };
    return { ...meta, outcome: step.result.outcome, reasonCode: step.result.reasonCode, benefitClass: step.event.benefitClass, planPays: step.result.planPays, memberPays: step.result.memberPays, billedAmount: step.event.amount };
  };
  const standing = steps.filter((s) => s.event.kind !== "preauth").map(cite);

  const denialsByReasonCode: Partial<Record<ReasonCode, Citable[]>> = {};
  for (const c of standing) {
    if (!isDenial(c.outcome) || !c.reasonCode) continue;
    (denialsByReasonCode[c.reasonCode] ??= []).push(c);
  }
  const repeatedDenialReasons = (Object.keys(denialsByReasonCode) as ReasonCode[]).filter((r) => (denialsByReasonCode[r]?.length ?? 0) >= 2);

  const capsHit = standing
    .filter((c) => c.reasonCode === "sublimit_exhausted" || c.reasonCode === "annual_limit_reached" || c.outcome === "approved_with_limit")
    .filter((c) => c.benefitClass)
    .map((c) => ({ benefitClass: c.benefitClass!, event: c }));

  const waitingPeriodsCleared: FitFeatures["waitingPeriodsCleared"] = [];
  for (const denied of standing.filter((c) => c.reasonCode === "waiting_period_not_elapsed" && c.benefitClass)) {
    const laterPaid = standing.find((c) => c !== denied && c.benefitClass === denied.benefitClass && c.policyMonth >= denied.policyMonth && (c.outcome === "covered" || c.outcome === "approved_with_limit"));
    if (laterPaid) waitingPeriodsCleared.push({ benefitClass: denied.benefitClass!, denied, laterPaid });
  }

  const outOfNetworkEpisodes = standing.filter((c) => c.reasonCode === "provider_out_of_network" && isDenial(c.outcome));

  const withAmount = standing.filter(hasAmount);
  const totalBilled = withAmount.reduce((sum, c) => sum + (c.billedAmount ?? 0), 0);
  const totalMemberPays = withAmount.reduce((sum, c) => sum + (c.memberPays ?? 0), 0);
  const totalPlanPays = withAmount.reduce((sum, c) => sum + (c.planPays ?? 0), 0);

  return {
    denialsByReasonCode,
    repeatedDenialReasons,
    capsHit,
    waitingPeriodsCleared,
    outOfNetworkEpisodes,
    appealAttempts: appeals,
    memberShareRatio: totalBilled > 0 ? totalMemberPays / totalBilled : null,
    premiumVsPaid: { premium: plan.annualPremium, planPaid: totalPlanPays, memberPaid: totalMemberPays },
    standing,
  };
}

// ---------------------------------------------------------------------------
// The verdict — deterministic, from the features
// ---------------------------------------------------------------------------

export type Verdict = { verdict: "confirm" } | { verdict: "recommend_change"; recommendedPlanId: string; reasonCodes: ReasonCode[] };

/**
 * A repeated denial is a signal only when nothing about it resolves on its own — `waiting_period_not_elapsed`
 * is excluded here (not from the feature itself, which still reports it): it is not a mismatch, it is a clock,
 * and §5.5's own worked example is a wait that cleared and then paid, which is a CONFIRM, not a reason to move.
 */
const PERSISTING: ReadonlySet<ReasonCode> = new Set(["benefit_excluded", "provider_out_of_network", "sublimit_exhausted", "annual_limit_reached"]);

/** Total cost to the member of a history on one plan, and the outcome each event lands on — by event id, not a count. */
function totalCost(plan: PlanTerms, events: ReplayEvent[]): { total: number; outcomeOf: Map<string, EventOutcome>; replay: Replay } {
  const r = replay(plan, events);
  const claims = r.steps.filter((s) => s.event.kind !== "preauth");
  const memberPaid = claims.reduce((sum, s) => sum + (s.result.memberPays ?? 0), 0);
  const outcomeOf = new Map(claims.map((s) => [s.event.id, s.result.outcome]));
  return { total: plan.annualPremium + memberPaid, outcomeOf, replay: r };
}

/**
 * `recommend_change` only when a persisting reason was denied twice or more AND a real alternative in the
 * catalogue would PAY every one of those specific events — not merely deny them for a different reason (a
 * plan that excludes a condition outright and one whose wait for it has not yet elapsed both deny the same
 * claim; only the second is progress, and it is not the answer here) — for no more than the member is paying
 * now. Anything short of that is `confirm` — a plan working as sold is not a signal, however close a call it
 * looks.
 */
export function computeVerdict(features: FitFeatures, currentPlan: PlanTerms, catalogue: PlanTerms[], events: ReplayEvent[]): Verdict {
  const persisting = features.repeatedDenialReasons.filter((r) => PERSISTING.has(r));
  if (persisting.length === 0) return { verdict: "confirm" };
  const deniedEventIds = persisting.flatMap((r) => (features.denialsByReasonCode[r] ?? []).map((c) => c.id));

  const current = totalCost(currentPlan, events);
  let best: { plan: PlanTerms; total: number } | null = null;
  for (const candidate of catalogue) {
    if (candidate.id === currentPlan.id) continue;
    const c = totalCost(candidate, events);
    const resolvesAll = deniedEventIds.every((id) => c.outcomeOf.get(id) !== "denied" && c.outcomeOf.get(id) !== "insufficient_data");
    if (!resolvesAll || c.total > current.total) continue;
    if (!best || c.total < best.total) best = { plan: candidate, total: c.total };
  }
  if (!best) return { verdict: "confirm" };
  return { verdict: "recommend_change", recommendedPlanId: best.plan.id, reasonCodes: persisting };
}

// ---------------------------------------------------------------------------
// The hindsight table — "had you been on this plan from the start" (§13.3.4, stretch)
// ---------------------------------------------------------------------------

export type HindsightRow = {
  planId: string;
  planName: string;
  premium: number;
  memberPaid: number;
  total: number;
  claimsRefused: number;
  claimsTotal: number;
  /** False when a benefit class this history actually used is one this plan does not cover at all. */
  coversWhatWasDeclared: boolean;
  current: boolean;
};

/** Every benefit class this history actually needed, general excluded (nothing to "declare" about routine care). */
function declaredClasses(events: ReplayEvent[]): BenefitClass[] {
  return [...new Set(events.map((e) => e.benefitClass).filter((c): c is BenefitClass => c !== null && c !== "general"))];
}

const covers = (plan: PlanTerms, benefitClass: BenefitClass): boolean => {
  if (benefitClass === "maternity") return plan.maternityCovered;
  if (benefitClass === "chronic_preexisting") return plan.chronicCovered;
  if (benefitClass === "dental_optical") return plan.dentalOptical !== "none";
  return true;
};

/** "Had you been on this plan from the start" — the same history, replayed against every catalogue plan. */
export function buildHindsightTable(catalogue: PlanTerms[], currentPlanId: string, events: ReplayEvent[]): HindsightRow[] {
  const needs = declaredClasses(events);
  return catalogue.map((p) => {
    const r = replay(p, events);
    const claims = r.steps.filter((s) => s.event.kind !== "preauth");
    const memberPaid = claims.reduce((sum, s) => sum + (s.result.memberPays ?? 0), 0);
    return {
      planId: p.id,
      planName: p.name,
      premium: p.annualPremium,
      memberPaid,
      total: p.annualPremium + memberPaid,
      claimsRefused: claims.filter((s) => s.result.outcome === "denied").length,
      claimsTotal: claims.length,
      coversWhatWasDeclared: needs.every((c) => covers(p, c)),
      current: p.id === currentPlanId,
    };
  });
}
