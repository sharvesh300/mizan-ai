// All nodes for the assessment graph: validate, classify, narrate, route, gate.
//
//   ASSESSMENT (the application now exists)
//     validate ──> classify ──> narrate ──> route ──┬──> gate (interrupt: an advisor owns it)
//                                                   └──> END  (clean — advance to quoting)
//
// Validation and classification evaluate deterministic rules; narration lets
// an LLM refine the wording for the broker without altering rules or severities;
// route and gate determine human-review status and priority.

import "server-only";
import { z } from "zod";
import { interrupt } from "@langchain/langgraph";
import { isAgentEnabled, structuredCall } from "@/lib/ai/openrouter";
import type { AssessmentStateType } from "@/lib/ai/graph/state";
import {
  aed,
  assignCohort,
  BUDGET_CEILING,
  plansInBudget,
  verdict,
} from "@/lib/assessment";
import { evaluateConstraintRules } from "@/lib/assessment/constraint-rules";
import { evaluateRecordRules } from "@/lib/assessment/record-rules";

/** Bumped whenever the prompt below changes, so `model_run` rows stay comparable. */
export const ASSESSMENT_PROMPT_VERSION = "assess-v1";

/**
 * `validate` — is this record internally coherent?
 * Evaluates record-level integrity rules deterministically.
 */
export function validate(state: AssessmentStateType): Partial<AssessmentStateType> {
  return {
    fired: evaluateRecordRules({ record: state.record, context: state.context }),
  };
}

/**
 * `classify` — assign cohort and evaluate plan constraint rules.
 * Deterministic arithmetic over the declared needs and panel coverage.
 */
export function classify(state: AssessmentStateType): Partial<AssessmentStateType> {
  const constraint = evaluateConstraintRules({ record: state.record, catalogue: state.catalogue });

  return {
    cohort: assignCohort(state.record),
    fired: [...state.fired, ...constraint],
  };
}

const narrationSchema = z.object({
  flags: z
    .preprocess((val) => (Array.isArray(val) ? val : []), z.array(z.unknown()))
    .transform((items) => {
      const valid: { ruleCode: string; reason: string }[] = [];
      for (const item of items) {
        const parsed = z
          .object({ ruleCode: z.string(), reason: z.string() })
          .safeParse(item);
        if (parsed.success && parsed.data.reason.trim().length > 0) valid.push(parsed.data);
      }
      return valid;
    }),
  queueLine: z.string().catch(""),
});

const SYSTEM = `You are writing the internal note a health insurance broker reads before deciding whether to approve a system recommendation. You are NOT writing to the applicant — this is operational vocabulary and they never see it.

HOW YOU WRITE
- Plainly, to a colleague who knows the plans. No hedging, no "it is important to note", no restating the rule name.
- Two sentences per flag at most. The first says what the tension actually is; the second says what the broker has to decide about it.
- Every number you use must come from the material given to you. Never invent a premium, a waiting period, a limit or a date.
- Never recommend a plan, promise cover, or say the application should be approved or declined. That is the broker's call and you are briefing them, not making it.
- Never describe the applicant as a risk, a burden, or a cost. Describe the situation, not the person.

WHAT YOU ARE DOING
You are given the flags a deterministic rule engine has already raised, each with a factual reason. Rewrite each reason so it reads as a broker's note. You may not add flags, remove flags, or change what a flag means — only how it reads. If a reason is already as good as it gets, return it unchanged.

Also write "queueLine": ONE line, under 20 words, that tells a broker scanning a worklist why this record is in front of them. No applicant name.

ANSWER FORMAT
Return ONE JSON object, nothing else. No code fences, no commentary.
{"flags": [{"ruleCode": "...", "reason": "..."}], "queueLine": "..."}`;

/**
 * `narrate` — the only place a model touches an assessment, and it may only change words.
 */
export async function narrate(state: AssessmentStateType): Promise<Partial<AssessmentStateType>> {
  if (!isAgentEnabled() || state.fired.length === 0) return {};

  const { record, catalogue } = state;
  const affordable = plansInBudget(catalogue.plans, record.budget);

  const user = [
    `Applicant: age ${record.age}, ${record.maritalStatus ?? "marital status unstated"}, ${
      record.smoker == null ? "smoker status unstated" : record.smoker ? "smoker" : "non-smoker"
    }, ${record.emirate ?? "emirate unstated"}. Budget band "${record.budget}" (up to ${aed(
      BUDGET_CEILING[record.budget],
    )}). Cover from ${record.policyInception}.`,
    `Cohort: ${state.cohort?.cohort ?? "unassigned"} — ${state.cohort?.rationale ?? ""}`,
    record.conditions.length
      ? `Declared conditions: ${record.conditions.map((c) => `${c.rawText} (${c.stability})`).join(", ")}`
      : "Declared conditions: none",
    record.needs.length
      ? `Stated needs: ${record.needs
          .map(
            (n) =>
              `${n.rawText} [${n.benefitClass ?? "unclassified"}, ${
                n.horizonMonths == null ? "no horizon given" : `${n.horizonMonths} months away`
              }]`,
          )
          .join("; ")}`
      : "Stated needs: none",
    record.providers.length
      ? `Providers they expect to use: ${record.providers.map((p) => `${p.providerName} (${p.tier ?? "tier unknown"})`).join(", ")}`
      : "Providers they expect to use: none named",
    "",
    `Plans on the panel: ${catalogue.plans
      .map(
        (p) =>
          `${p.name} ${aed(p.annualPremium)}, ${p.network} network, deductible ${aed(p.deductible)}, outpatient co-pay ${p.outpatientCopayPct}%, maternity ${
            p.maternityCovered ? `covered after ${p.maternityWaitingPeriodMonths}m up to ${aed(p.maternityLimit ?? 0)}` : "not covered"
          }, chronic ${p.chronicCovered ? `covered after ${p.chronicWaitingPeriodMonths}m` : "not covered"}`,
      )
      .join(" | ")}`,
    `Inside their budget: ${affordable.map((p) => p.name).join(", ") || "nothing"}`,
    "",
    "Flags to rewrite:",
    ...state.fired.map(
      ({ rule, flag }) => `- ${rule.code} (${flag.severity}): ${flag.reason}`,
    ),
  ].join("\n");

  let result;
  try {
    result = await structuredCall({ system: SYSTEM, user, schema: narrationSchema, temperature: 0.3 });
  } catch (error) {
    console.error("[assessment] narration failed", error);
    return {};
  }

  const byCode = new Map(result.value.flags.map((f) => [f.ruleCode, f.reason.trim()]));
  const narrated: string[] = [];
  const fired = state.fired.map((entry) => {
    const rewritten = byCode.get(entry.rule.code);
    if (!rewritten) return entry;
    narrated.push(entry.rule.code);
    return { ...entry, flag: { ...entry.flag, reason: rewritten } };
  });

  return {
    fired,
    narrated,
    queueLine: result.value.queueLine.trim() || null,
    servedBy: result.servedBy,
    latencyMs: result.latencyMs,
  };
}

/**
 * `route` — where this application goes, and how sure the system is allowed to sound about it.
 */
export function route(state: AssessmentStateType): Partial<AssessmentStateType> {
  const computed = verdict(state.fired, state.record);

  return {
    verdict: {
      ...computed,
      queueReason: state.queueLine ?? computed.queueReason,
    },
  };
}

/** Does a person have to look at this before it is priced? */
export function gated(state: AssessmentStateType): "gate" | "clear" {
  return state.verdict && state.verdict.gate !== "auto" ? "gate" : "clear";
}

/**
 * `gate` — hand the application to a human and stop via LangGraph interrupt().
 */
export function gate(state: AssessmentStateType): Partial<AssessmentStateType> {
  interrupt({
    applicationId: state.record.applicationId,
    reason: state.verdict?.queueReason,
    priorityScore: state.verdict?.priorityScore,
    gate: state.verdict?.gate,
  });

  return {};
}
