// `narrate` — the only place a model touches an assessment, and it may only
// change words.
//
// The templated reasons the rules produce are accurate and slightly robotic:
// they name the plan, the wait and the horizon, but they do not say what that
// combination means for THIS applicant. A broker working a queue under time
// pressure reads the first line and decides whether to open the record, so the
// first line is worth writing properly.
//
// WHAT IT CANNOT DO: fire a flag, drop one, change a severity, change a
// cohort, or move an application. It is handed the rules that already fired
// and returns wording for those codes and no others — anything it invents is
// discarded here rather than being persisted and argued with later. If the
// call fails, or there is no API key at all, every templated reason stands and
// the assessment is unchanged. That is why the node has no error path back
// into the graph: there is nothing it can break.

import "server-only";
import { z } from "zod";
import { isAgentEnabled, structuredCall } from "@/lib/ai/openrouter";
import type { AssessmentStateType } from "@/lib/ai/graph/state";
import { aed, BUDGET_CEILING, plansInBudget } from "@/lib/assessment";

/** Bumped whenever the prompt below changes, so `model_run` rows stay comparable. */
export const ASSESSMENT_PROMPT_VERSION = "assess-v1";

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
    // The templated reasons are already correct and complete. A failed
    // narration costs the broker a blunter sentence, never a missing flag.
    console.error("[assessment] narration failed", error);
    return {};
  }

  // Only codes that actually fired. Anything else the model returned is a
  // flag it made up, and a made-up flag in a broker's queue is worse than a
  // plain one.
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
