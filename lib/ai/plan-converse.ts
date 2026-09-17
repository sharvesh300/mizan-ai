// Free-text Q&A about an already-shortlisted panel,
// answered through the SAME tool registry the recommendation agent used to
// build it (lib/ai/tools/plans.ts), in READ-ONLY mode: every tool except
// `propose_shortlist`. Nothing reachable from here writes a new shortlist —
// only `pickPlan`/`rejectShortlist` (app/applications/new/actions.ts) do
// that, and only off an explicit button or the `intent` this module hands
// back to the session (lib/ai/plan-chat-session.ts) to act on. The model
// never calls either directly.

import "server-only";
import { z } from "zod";
import { isAgentEnabled, structuredCall } from "@/lib/ai/openrouter";
import { describeTools, runTool, TOOL_NAMES, type ToolContext, type ToolName, type ToolResult } from "@/lib/ai/tools/plans";

export const PLAN_CONVERSE_PROMPT_VERSION = "plan-converse-v1";

/** A question needs a couple of lookups at most — this is Q&A over an existing shortlist, not building one. */
const MAX_TOOL_CALLS = 4;

const READ_ONLY_TOOLS = TOOL_NAMES.filter((name) => name !== "propose_shortlist") as Exclude<ToolName, "propose_shortlist">[];

const stepSchema = z.object({
  thought: z.string().catch(""),
  tool: z.string(),
  args: z.unknown().optional(),
});

const INTENTS = ["none", "choose_plan", "reject_shortlist", "escalate"] as const;
export type PlanConverseIntent = (typeof INTENTS)[number];

const answerSchema = z.object({
  reply: z.string().min(1),
  intent: z.enum(INTENTS),
  planId: z.string().optional(),
  reason: z.string().optional(),
});

export type PlanConverseTraceStep = {
  step: number;
  thought: string;
  tool: string;
  args: unknown;
  validation: string;
  observationSummary: string;
};

export type PlanConverseResult = {
  reply: string;
  intent: PlanConverseIntent;
  planId: string | null;
  reason: string | null;
  trace: PlanConverseTraceStep[];
  servedBy: string | null;
  latencyMs: number;
  /** True when the model's own reply failed the citation check and was swapped for the recommendation's own vetted wording. */
  citationFailed: boolean;
};

export type PlanConverseInput = {
  ctx: ToolContext;
  question: string;
  /** Prior turns in this sub-thread, oldest first — conversational memory without re-deriving anything. */
  history: { role: "applicant" | "assistant"; text: string }[];
  /** The live recommendation as it stands — already citation-checked once by `verify`, so it doubles as the deterministic fallback source. */
  recommended: { planId: string; name: string };
  memberReasoning: string;
  quotes: { planId: string; name: string; annualPremium: number }[];
};

const summarise = (result: ToolResult): string => (result.ok ? JSON.stringify(result.data).slice(0, 600) : `ERROR: ${result.error}`);
const numbersIn = (text: string): string[] => [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, ""));

function answerToolDescription(): string {
  return '{ reply: string, intent: "none"|"choose_plan"|"reject_shortlist"|"escalate", planId?: string, reason?: string } — TERMINAL, ends the turn. `reply` is what the applicant reads: every figure in it must come from an observation you actually received this conversation, or from the plan panel already summarised below. `intent` is "choose_plan" ONLY if they clearly said which plan they want (give its planId); "reject_shortlist" ONLY if they said none of the panel works (give a short reason); "escalate" if they are asking for something a person has to handle; otherwise "none".';
}

function systemPrompt(input: PlanConverseInput): string {
  const descriptions = describeTools(input.ctx);
  const panel = input.quotes.map((q) => `${q.planId} (${q.name}): ${q.annualPremium} AED/year${q.planId === input.recommended.planId ? " — the recommended plan" : ""}`).join("; ");
  return [
    "You are answering an applicant's question about the health insurance plan panel they have already been shown. You are NOT building a new shortlist — one already exists.",
    `The panel, already priced: ${panel}.`,
    `What they were told about the recommended plan: ${input.memberReasoning}`,
    "",
    "You are never given the plan corpus directly. You have READ-ONLY tools that answer specific questions about specific plans — call one only if the applicant's question needs a fact you do not already have above. Do not guess.",
    "You supply NO numbers of your own beyond what is already summarised above or what a tool just told you.",
    "",
    "TOOLS (call exactly one per turn):",
    ...READ_ONLY_TOOLS.map((name) => `- ${name}: ${descriptions[name]}`),
    `- answer: ${answerToolDescription()}`,
    "",
    "RULES",
    "- Every tool argument must be a value that tool actually accepts — one of the exact ids or enum members spelled out above.",
    "- Call `answer` as soon as you can respond — most questions need zero or one lookup, not several.",
    "- Never call propose_shortlist or any tool not listed above.",
    "",
    "ANSWER FORMAT",
    'Return ONE JSON object, nothing else: {"thought": "...", "tool": "...", "args": {...}}',
    "No code fences, no commentary outside the JSON object.",
  ].join("\n");
}

function forcedAnswerSystemPrompt(): string {
  return [
    "Your tool-call budget for this question is spent. Answer now, using only what you already learned in this conversation.",
    "",
    `Call answer: ${answerToolDescription()}`,
    "",
    "ANSWER FORMAT",
    'Return ONE JSON object, nothing else: {"thought": "...", "tool": "answer", "args": {...}}',
    "No code fences, no commentary outside the JSON object.",
  ].join("\n");
}

/** The fallback reply is always the recommendation's own member-facing reasoning — `verify` already citation-checked it once, so it is trustworthy prose with nothing new asserted. */
function fallbackResult(reason: string, input: PlanConverseInput, trace: PlanConverseTraceStep[], servedBy: string | null, latencyMs: number): PlanConverseResult {
  return {
    reply: input.memberReasoning || "Have a look at the plan card above — that's everything we worked out for you.",
    intent: "none",
    planId: null,
    reason,
    trace,
    servedBy,
    latencyMs,
    citationFailed: false,
  };
}

function groundedResult(
  data: z.infer<typeof answerSchema>,
  input: PlanConverseInput,
  trace: PlanConverseTraceStep[],
  servedBy: string | null,
  latencyMs: number,
): PlanConverseResult {
  const observed = new Set<string>([
    ...input.quotes.flatMap((q) => numbersIn(String(q.annualPremium))),
    ...numbersIn(input.memberReasoning),
    ...trace.flatMap((step) => (step.validation === "ok" ? numbersIn(step.observationSummary) : [])),
  ]);
  const cited = numbersIn(data.reply);
  const citationFailed = cited.some((n) => !observed.has(n));

  return {
    reply: citationFailed ? input.memberReasoning || data.reply : data.reply,
    intent: data.intent,
    planId: data.planId ?? null,
    reason: data.reason ?? null,
    trace,
    servedBy,
    latencyMs,
    citationFailed,
  };
}

export async function planConverse(input: PlanConverseInput): Promise<PlanConverseResult> {
  if (!isAgentEnabled()) return fallbackResult("no model configured", input, [], null, 0);

  const system = systemPrompt(input);
  const trace: PlanConverseTraceStep[] = [];
  let servedBy: string | null = null;
  let totalLatency = 0;
  let sameToolFailures = 0;

  const transcriptLines: string[] = [
    ...input.history.map((turn) => `${turn.role === "applicant" ? "Applicant" : "You"}: ${turn.text}`),
    `Applicant: ${input.question}`,
  ];

  for (let step = 1; step <= MAX_TOOL_CALLS; step++) {
    let called;
    try {
      called = await structuredCall({ system, user: transcriptLines.join("\n\n"), schema: stepSchema, temperature: 0.3 });
    } catch (error) {
      return fallbackResult(`model call failed: ${error instanceof Error ? error.message : String(error)}`, input, trace, servedBy, totalLatency);
    }

    servedBy = called.servedBy;
    totalLatency += called.latencyMs;
    const { thought, tool, args } = called.value;

    if (tool === "answer") {
      const parsed = answerSchema.safeParse(args);
      trace.push({
        step,
        thought,
        tool,
        args: args ?? null,
        validation: parsed.success ? "ok" : parsed.error.issues.map((i) => i.message).join("; "),
        observationSummary: parsed.success ? "answered" : "invalid answer shape",
      });
      if (parsed.success) return groundedResult(parsed.data, input, trace, servedBy, totalLatency);
      sameToolFailures += 1;
      if (sameToolFailures >= 2) return fallbackResult("answer rejected twice", input, trace, servedBy, totalLatency);
      transcriptLines.push(`Step ${step}: your "answer" call did not match the required shape. Try again with reply, intent, and (if relevant) planId/reason.`);
      continue;
    }

    const result = runTool(input.ctx, tool, args);
    trace.push({
      step,
      thought,
      tool,
      args: args ?? null,
      validation: result.ok ? "ok" : result.error,
      observationSummary: summarise(result),
    });

    if (!result.ok) {
      sameToolFailures += 1;
      if (sameToolFailures >= 2) return fallbackResult(`"${tool}" rejected: ${result.error}`, input, trace, servedBy, totalLatency);
      transcriptLines.push(`Step ${step}: you called "${tool}" with ${JSON.stringify(args ?? {})} — ERROR: ${result.error}. Try again or call answer with what you already have.`);
      continue;
    }

    sameToolFailures = 0;
    transcriptLines.push(`Step ${step}: you called "${tool}" with ${JSON.stringify(args ?? {})} — OK.\nObservation: ${summarise(result)}`);
  }

  try {
    const called = await structuredCall({ system: forcedAnswerSystemPrompt(), user: transcriptLines.join("\n\n"), schema: stepSchema, temperature: 0.3 });
    servedBy = called.servedBy;
    totalLatency += called.latencyMs;
    const parsed = answerSchema.safeParse(called.value.args);
    trace.push({
      step: MAX_TOOL_CALLS + 1,
      thought: called.value.thought,
      tool: "answer",
      args: called.value.args ?? null,
      validation: parsed.success ? "ok" : parsed.error.issues.map((i) => i.message).join("; "),
      observationSummary: parsed.success ? "answered" : "invalid answer shape",
    });
    if (parsed.success) return groundedResult(parsed.data, input, trace, servedBy, totalLatency);
  } catch {
    // Falls through
  }

  return fallbackResult("tool-call budget exhausted with no answer given", input, trace, servedBy, totalLatency);
}
