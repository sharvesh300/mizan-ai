// The recommendation agent's tool registry.
//
// The model is never handed the plan corpus and never supplies a number it
// invented — every tool argument is a closed vocabulary (a plan id that exists
// in the catalogue, a benefit class from the enum, a scenario id from the 5
// declared scenarios, a criterion id from the 8 declared criteria) validated
// HERE, before the tool runs, against the vocabulary table the architecture
// doc lays out. A validation failure comes back to the agent as a structured
// `ToolResult` it can read and act on — never a thrown exception, and never
// silence.
//
// Each tool is a thin wrapper over lib/assessment (coverage/network/needs) or
// lib/recommendation (cost, scoring) — nothing here re-derives arithmetic that
// already exists there.

import "server-only";
import { z } from "zod";
import { admitsKey, clearsInTime, covers, waitMonths, type AssessmentRecord, type Catalogue } from "@/lib/assessment";
import {
  buildScenario,
  estimateAnnualCost,
  isEligible,
  isScenarioSelectable,
  scorePlans,
  COST_SCENARIO_IDS,
  CRITERION_IDS,
} from "@/lib/recommendation";
import { benefitClassEnum, type BenefitClass, type ConfidenceLevel, type FlagSeverity } from "@/db/schema";

export type Flag = { ruleCode: string; severity: FlagSeverity; reason: string };

/** One prior round's outcome — read by `previous_rounds`, written in lib/ai/recommendation-session.ts. */
export type PreviousRound = { round: number; rejectedPlanIds: string[]; reason: string };

export type ToolContext = {
  applicationId: string;
  record: AssessmentRecord;
  catalogue: Catalogue;
  cohort: string;
  flags: Flag[];
  previousRounds: PreviousRound[];
};

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

export const TOOL_NAMES = [
  "read_applicant_record",
  "list_plan_summaries",
  "get_plan_terms",
  "check_need_against_plans",
  "check_network_access",
  "estimate_annual_cost",
  "previous_rounds",
  "score_plans",
  "propose_shortlist",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const err = (message: string): ToolResult => ({ ok: false, error: message });
const ok = (data: unknown): ToolResult => ({ ok: true, data });

/**
 * Zod v4 strips the received value off `issue` by default, so it is walked
 * back out of the raw `args` by `issue.path` — the point is to hand the
 * agent the value it actually sent next to the vocabulary it should have
 * used, so a bad guess is correctable on the next turn instead of just
 * "invalid" with no clue what was wrong with it.
 */
function valueAtPath(args: unknown, path: PropertyKey[]): unknown {
  let cur = args;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

const issuesToMessage = (error: z.ZodError, args?: unknown) =>
  error.issues
    .map((i) => {
      const received = args !== undefined ? valueAtPath(args, i.path) : undefined;
      const path = i.path.join(".") || "(root)";
      return received !== undefined ? `${path}: ${i.message} (you sent: ${JSON.stringify(received)})` : `${path}: ${i.message}`;
    })
    .join("; ");

// ---------------------------------------------------------------------------
// 1. read_applicant_record — re-collect nothing
// ---------------------------------------------------------------------------

function readApplicantRecord(ctx: ToolContext): ToolResult {
  return ok({ record: ctx.record, cohort: ctx.cohort, flags: ctx.flags });
}

// ---------------------------------------------------------------------------
// 2. list_plan_summaries — the entry point, tiny on purpose
// ---------------------------------------------------------------------------

function listPlanSummaries(ctx: ToolContext): ToolResult {
  return ok(
    ctx.catalogue.plans.map((p) => ({
      id: p.id,
      name: p.name,
      annualPremium: p.annualPremium,
      deductible: p.deductible,
      network: p.network,
      outpatientCopayPct: p.outpatientCopayPct,
      annualLimit: p.annualLimit,
      dentalOptical: p.dentalOptical,
    })),
  );
}

// ---------------------------------------------------------------------------
// 3. get_plan_terms — a slice, never a dump
// ---------------------------------------------------------------------------

const getPlanTermsSchema = z.object({
  planIds: z.array(z.string()).min(1),
  benefitClasses: z.array(z.enum(benefitClassEnum)).optional(),
});

function getPlanTerms(ctx: ToolContext, args: unknown): ToolResult {
  const parsed = getPlanTermsSchema.safeParse(args);
  if (!parsed.success) return err(issuesToMessage(parsed.error, args));

  const { planIds, benefitClasses } = parsed.data;
  const validIds = new Set(ctx.catalogue.plans.map((p) => p.id));
  const unknown = planIds.filter((id) => !validIds.has(id));
  if (unknown.length > 0) return err(`unknown plan id(s): ${unknown.join(", ")}`);

  const data = planIds.map((id) => {
    const plan = ctx.catalogue.plans.find((p) => p.id === id)!;
    const slices: Record<string, unknown> = {};
    for (const bc of benefitClasses ?? []) {
      if (bc === "maternity") {
        slices.maternity = { covered: plan.maternityCovered, waitMonths: plan.maternityWaitingPeriodMonths, limit: plan.maternityLimit };
      } else if (bc === "chronic_preexisting") {
        slices.chronic_preexisting = { covered: plan.chronicCovered, waitMonths: plan.chronicWaitingPeriodMonths };
      } else if (bc === "dental_optical") {
        slices.dental_optical = { tier: plan.dentalOptical };
      } else if (bc === "general") {
        slices.general = { covered: true };
      }
    }
    return {
      id: plan.id,
      name: plan.name,
      annualPremium: plan.annualPremium,
      deductible: plan.deductible,
      network: plan.network,
      outpatientCopayPct: plan.outpatientCopayPct,
      annualLimit: plan.annualLimit,
      ...slices,
    };
  });

  return ok(data);
}

// ---------------------------------------------------------------------------
// 4. check_need_against_plans — the read-past-the-yes/no tool
// ---------------------------------------------------------------------------

const checkNeedSchema = z
  .object({
    needId: z.string().optional(),
    benefitClass: z.enum(benefitClassEnum).optional(),
    horizonMonths: z.number().int().min(0).max(120).optional(),
  })
  .refine((v) => Boolean(v.needId) || (v.benefitClass != null && v.horizonMonths != null), {
    message: "supply needId, or benefitClass + horizonMonths",
  });

function checkNeedAgainstPlans(ctx: ToolContext, args: unknown): ToolResult {
  const parsed = checkNeedSchema.safeParse(args);
  if (!parsed.success) return err(issuesToMessage(parsed.error, args));

  let benefitClass: BenefitClass;
  let horizonMonths: number;
  let needId: string | null = null;

  if (parsed.data.needId) {
    const need = ctx.record.needs.find((n) => n.id === parsed.data.needId);
    if (!need) return err(`unknown need "${parsed.data.needId}" for this application`);
    if (need.benefitClass == null || need.horizonMonths == null) {
      return err(`need "${parsed.data.needId}" has no classified benefit class or horizon`);
    }
    if (parsed.data.horizonMonths != null && parsed.data.horizonMonths !== need.horizonMonths) {
      return err(`horizon disagrees with the record: need "${parsed.data.needId}"'s horizon is ${need.horizonMonths} months`);
    }
    benefitClass = need.benefitClass;
    horizonMonths = need.horizonMonths;
    needId = need.id;
  } else {
    benefitClass = parsed.data.benefitClass!;
    horizonMonths = parsed.data.horizonMonths!;
  }

  const perPlan = ctx.catalogue.plans.map((plan) => {
    const isCovered = covers(plan, benefitClass);
    const usable = isCovered && clearsInTime(plan, benefitClass, horizonMonths);
    const wait = waitMonths(plan, benefitClass);
    return {
      planId: plan.id,
      covered: isCovered,
      usable,
      waitMonths: wait,
      whyNot: isCovered
        ? usable
          ? null
          : `covered, but a ${wait}-month wait does not clear inside the ${horizonMonths}-month horizon`
        : "benefit not covered by this plan",
    };
  });

  return ok({ needId, benefitClass, horizonMonths, perPlan });
}

// ---------------------------------------------------------------------------
// 5. check_network_access — network is access, not price
// ---------------------------------------------------------------------------

const checkNetworkSchema = z.object({ planId: z.string() });

function checkNetworkAccess(ctx: ToolContext, args: unknown): ToolResult {
  const parsed = checkNetworkSchema.safeParse(args);
  if (!parsed.success) return err(issuesToMessage(parsed.error, args));

  const plan = ctx.catalogue.plans.find((p) => p.id === parsed.data.planId);
  if (!plan) return err(`unknown plan id "${parsed.data.planId}"`);

  const providers = ctx.record.providers.map((p) => {
    if (p.tier == null) return { providerName: p.providerName, tier: null, admitted: null as boolean | null, note: "tier unknown, cannot test the network gate" };
    const admitted = ctx.catalogue.admits.has(admitsKey(plan.network, p.tier));
    return {
      providerName: p.providerName,
      tier: p.tier,
      admitted,
      note: admitted ? null : `${plan.network} network does not admit ${p.tier.replace(/_/g, " ")}`,
    };
  });

  return ok({ planId: plan.id, network: plan.network, providers });
}

// ---------------------------------------------------------------------------
// 6. estimate_annual_cost — the agent names a scenario, supplies no numbers
// ---------------------------------------------------------------------------

const estimateCostSchema = z.object({ planId: z.string(), scenarioId: z.enum(COST_SCENARIO_IDS) });

function estimateAnnualCostTool(ctx: ToolContext, args: unknown): ToolResult {
  const parsed = estimateCostSchema.safeParse(args);
  if (!parsed.success) return err(issuesToMessage(parsed.error, args));

  const plan = ctx.catalogue.plans.find((p) => p.id === parsed.data.planId);
  if (!plan) return err(`unknown plan id "${parsed.data.planId}"`);
  if (!isScenarioSelectable(parsed.data.scenarioId, ctx.record)) {
    return err(`scenario "${parsed.data.scenarioId}" is not selectable for this record`);
  }

  const scenario = buildScenario(parsed.data.scenarioId, ctx.record);
  const breakdown = estimateAnnualCost(plan, scenario);

  return ok({
    planId: plan.id,
    scenarioId: scenario.id,
    basket: scenario.basket,
    derivedFrom: scenario.derivedFrom,
    constantsVersion: scenario.constantsVersion,
    breakdown,
  });
}

// ---------------------------------------------------------------------------
// 7. previous_rounds — round 2+ only, stops re-offering what was refused
// ---------------------------------------------------------------------------

function previousRoundsTool(ctx: ToolContext): ToolResult {
  return ok(ctx.previousRounds);
}

// ---------------------------------------------------------------------------
// 8. score_plans — the agent weighs, the arithmetic decides
// ---------------------------------------------------------------------------

const scorePlansSchema = z.object({
  criteria: z
    .array(z.object({ criterionId: z.enum(CRITERION_IDS), weight: z.number() }))
    .min(1),
});

function scorePlansTool(ctx: ToolContext, args: unknown): ToolResult {
  const parsed = scorePlansSchema.safeParse(args);
  if (!parsed.success) return err(issuesToMessage(parsed.error, args));

  try {
    return ok(scorePlans(ctx.catalogue.plans, ctx.record, ctx.catalogue, parsed.data.criteria));
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// 9. propose_shortlist — terminal
// ---------------------------------------------------------------------------

const proposeShortlistSchema = z.object({
  picks: z.array(z.object({ planId: z.string(), rank: z.number().int().min(1) })).min(1),
  rejections: z.array(z.object({ planId: z.string(), reason: z.string().min(1) })).default([]),
  confidence: z.enum(["high", "medium", "low"] satisfies readonly ConfidenceLevel[]),
  uncertaintyReason: z.string().optional(),
  // The two durable registers (doc §4.1). Written here, not by a separate
  // tool, because this call is where the agent commits to its final answer —
  // `verify` (lib/ai/graph/nodes/verify.ts) checks every figure in them
  // traces back to an observation the agent actually received.
  brokerReasoning: z.string().min(1),
  memberReasoning: z.string().min(1),
});

function proposeShortlist(ctx: ToolContext, args: unknown): ToolResult {
  const parsed = proposeShortlistSchema.safeParse(args);
  if (!parsed.success) return err(issuesToMessage(parsed.error, args));

  const validIds = new Set(ctx.catalogue.plans.map((p) => p.id));
  const unknown = parsed.data.picks.filter((p) => !validIds.has(p.planId));
  if (unknown.length > 0) return err(`unknown plan id(s) in picks: ${unknown.map((p) => p.planId).join(", ")}`);

  // The hard filter: a plan the record cannot actually serve is stripped here,
  // regardless of what the agent returned — the agent may discuss a ruled-out
  // plan, it may never shortlist one.
  const stripped = parsed.data.picks.filter((p) => {
    const plan = ctx.catalogue.plans.find((pl) => pl.id === p.planId)!;
    return !isEligible(plan, ctx.record);
  });
  const picks = parsed.data.picks.filter((p) => !stripped.some((s) => s.planId === p.planId));
  if (picks.length === 0) return err("every picked plan failed eligibility — nothing left to shortlist");

  return ok({
    picks,
    rejections: [
      ...parsed.data.rejections,
      ...stripped.map((s) => ({ planId: s.planId, reason: "Does not cover a benefit class this record declared a need for — stripped from the shortlist." })),
    ],
    confidence: parsed.data.confidence,
    uncertaintyReason: parsed.data.uncertaintyReason ?? null,
    brokerReasoning: parsed.data.brokerReasoning,
    memberReasoning: parsed.data.memberReasoning,
  });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export function runTool(ctx: ToolContext, name: string, args: unknown): ToolResult {
  switch (name as ToolName) {
    case "read_applicant_record":
      return readApplicantRecord(ctx);
    case "list_plan_summaries":
      return listPlanSummaries(ctx);
    case "get_plan_terms":
      return getPlanTerms(ctx, args);
    case "check_need_against_plans":
      return checkNeedAgainstPlans(ctx, args);
    case "check_network_access":
      return checkNetworkAccess(ctx, args);
    case "estimate_annual_cost":
      return estimateAnnualCostTool(ctx, args);
    case "previous_rounds":
      return previousRoundsTool(ctx);
    case "score_plans":
      return scorePlansTool(ctx, args);
    case "propose_shortlist":
      return proposeShortlist(ctx, args);
    default:
      return err(`unknown tool "${name}" — valid tools: ${TOOL_NAMES.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// Tool descriptions — one live source of the closed vocabularies
// ---------------------------------------------------------------------------

/**
 * Descriptions built from the live vocabulary tables rather than hand-written
 * prose, so a closed enum a caller must pick from is always spelled out in
 * full for THIS applicant — omitting one is exactly what left
 * `get_plan_terms`/`check_need_against_plans` unguessable to the model and
 * drove every recommendation round to a rejection-triggered fallback before
 * this was fixed.
 *
 * Shared by every prompt that exposes this registry to a model —
 * `lib/ai/graph/nodes/recommend.ts` (the full registry, building a
 * shortlist) and `lib/ai/graph/nodes/plan-converse.ts` (read-only Q&A over
 * an existing one) — so the vocabulary a model is told about can never drift
 * from the vocabulary `runTool` actually validates against.
 */
export function describeTools(ctx: ToolContext): Record<ToolName, string> {
  const benefitClasses = benefitClassEnum.join(", ");
  const needIds = ctx.record.needs.map((n) => n.id);
  const planIds = ctx.catalogue.plans.map((p) => p.id).join(", ");
  return {
    read_applicant_record: "no args — the declared record, cohort and flags",
    list_plan_summaries: "no args — the 3 plans: id, name, premium, deductible, network, copay %, annual limit, dental tier",
    get_plan_terms: `{ planIds: string[], benefitClasses?: string[] } — planIds from [${planIds}]; benefitClasses is a subset of [${benefitClasses}]. Deeper terms for named plans, only the slices you ask for.`,
    check_need_against_plans:
      needIds.length > 0
        ? `{ needId } OR { benefitClass, horizonMonths } — needId is one of this applicant's own need ids: [${needIds.join(", ")}]. benefitClass, if you supply it directly instead, is one of [${benefitClasses}]. Per plan: covered, usable, waitMonths, whyNot.`
        : `{ benefitClass, horizonMonths } — this applicant declared no needs with an id, so always supply benefitClass (one of [${benefitClasses}]) and horizonMonths directly, never needId. Per plan: covered, usable, waitMonths, whyNot.`,
    check_network_access: `{ planId } — planId from [${planIds}]. Each expected provider on the record, admitted or refused, and by which tier.`,
    estimate_annual_cost: `{ planId, scenarioId } — planId from [${planIds}]; scenarioId is ONE of: ${COST_SCENARIO_IDS.join(", ")}. No other args — the basket is built server-side and returned to you with its provenance.`,
    previous_rounds: "no args — prior shortlists this applicant already saw and rejected, and why (round 2+ only)",
    score_plans: `{ criteria: [{ criterionId, weight }] } — criterionId is one of: ${CRITERION_IDS.join(", ")}. weight 0.05-0.6, at most 5 criteria, only criteria relevant to this record.`,
    propose_shortlist: `{ picks: [{planId, rank}], rejections: [{planId, reason}], confidence: high|medium|low, uncertaintyReason?, brokerReasoning, memberReasoning } — picks/rejections planId from [${planIds}]. TERMINAL, ends the loop. Every figure in brokerReasoning/memberReasoning must come from an observation you actually received.`,
  };
}
