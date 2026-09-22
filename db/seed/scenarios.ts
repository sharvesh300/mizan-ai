// A fake conversation harness for the servicing tool registry.
//
// Scripted members, and a scripted "agent" that issues REAL tool calls against the
// REAL registry. What the model will one day decide, a script decides here — but
// every call goes through `runServicingTool`, so every validation, every refusal
// and every card comes from the production code, not from a mock of it.
//
// Two jobs:
//   1. It is the test bed: check-servicing-tools.ts runs every scenario and asserts
//      the outcomes match the acceptance table, and drives the registry with bad
//      input at each stage of a conversation.
//   2. It is the card gallery's source of truth. The cards in the dev gallery are
//      not hand-drawn fixtures; they are what the tools actually returned, so the
//      gallery cannot show a shape the tools cannot produce.
//
// The session's part is simulated by `session` hooks (a member tapping "Looks
// right"). That is the one thing a tool cannot do, because it is the member's act.
//
// Dev/test only. Nothing in a production path imports this.
import fixtures from "./fixtures.json";
import { buildServicingSeed, logForProfile, toPlanTerms } from "./servicing";
import { createServicingContext, runServicingTool, type HistoryItem, type ServicingToolContext, type ServicingToolResult } from "@/lib/ai/tools/servicing";
import { emptyDraft, factsFormCard, questionCard, readLimits, replay, type Draft, type Intent, type ServicingCard } from "@/lib/servicing";
import type { BenefitClass, EventKind, EventOutcome, ReasonCode } from "@/db/schema/enums";

/* eslint-disable @typescript-eslint/no-explicit-any */
const fx = fixtures as any;

export type ScenarioSpec = {
  id: string;
  title: string;
  description: string;
  profile: string;
  intent: Intent;
  today: string;
  eventRef: string;
  /** Events already on the policy when this conversation starts, by reference. */
  historyRefs: string[];
  /** A fact the SYSTEM already holds (a document, the member's file), so a conflict can arise. */
  seed?: (draft: Draft) => void;
};

export type Turn = {
  say?: string;
  tool: string;
  args?: unknown | ((ctx: ServicingToolContext) => unknown);
  /** What the session does before the agent's next call — the member's act, not a tool. */
  session?: (ctx: ServicingToolContext) => void;
  expect?: "ok" | "error";
  /** A label for the gallery when this call returns a card. */
  cardLabel?: string;
};

export type StepRecord = { say: string | null; tool: string; args: unknown; result: ServicingToolResult };
export type ScenarioRun = { spec: ScenarioSpec; steps: StepRecord[]; cards: { label: string | null; card: ServicingCard }[]; ctx: ServicingToolContext };

// ---------------------------------------------------------------------------

/** A declared condition, as the member would say it: "type_2_diabetes" → "type 2 diabetes". */
const conditionName = (code: string) => code.replace(/_/g, " ");

export function scenarioContext(spec: ScenarioSpec): ServicingToolContext {
  const policy = fx.policy.find((p: any) => p.external_ref === `POL-${spec.profile}`);
  const plans = fx.plan.map(toPlanTerms);
  const plan = plans.find((p: any) => p.id === policy.plan_id)!;
  const rows = buildServicingSeed(fx).events;
  const refOfId = new Map(rows.map((r) => [r.id!, r.externalRef!]));

  const history: HistoryItem[] = rows
    .filter((r) => spec.historyRefs.includes(r.externalRef!))
    .map((r) => ({
      ref: r.externalRef!,
      kind: r.kind as EventKind,
      policyMonth: r.policyMonth,
      benefitClass: (r.benefitClass ?? null) as BenefitClass | null,
      outcome: (r.outcome ?? null) as EventOutcome | null,
      reasonCode: (r.reasonCode ?? null) as ReasonCode | null,
      planPays: r.planPays == null ? null : Number(r.planPays),
      memberPays: r.memberPays == null ? null : Number(r.memberPays),
      supersedes: r.supersedesEventId ? (refOfId.get(r.supersedesEventId) ?? null) : null,
      description: r.description ?? null,
    }));

  // The ledger is a projection of that history — replayed, never typed.
  const ledger = replay(
    plan,
    logForProfile(spec.profile).filter((e) => spec.historyRefs.includes(e.id)),
  ).ledger;

  const person = fx.person.find((p: any) => p.external_ref === spec.profile);
  const application = fx.application.find((a: any) => a.person_id === person.id);
  const conditions = fx.application_condition
    .filter((c: any) => c.application_id === application.id && c.declared_at_intake)
    .map((c: any) => ({ name: conditionName(c.condition_code), stability: c.stability as string }));

  const draft = emptyDraft(spec.intent);
  spec.seed?.(draft);

  return createServicingContext({
    policy: { id: policy.id, ref: policy.external_ref, inceptionDate: policy.inception_date, status: "active" },
    plan,
    catalogue: plans,
    ledger,
    history,
    applicant: { conditions },
    today: spec.today,
    eventRef: spec.eventRef,
    limits: readLimits({}),
    draft,
  });
}

export function runScenario(spec: ScenarioSpec, turns: Turn[]): ScenarioRun {
  const ctx = scenarioContext(spec);
  const steps: StepRecord[] = [];
  const cards: ScenarioRun["cards"] = [];
  for (const turn of turns) {
    if (turn.say) ctx.memberMessages.push(turn.say);
    turn.session?.(ctx);
    const args = typeof turn.args === "function" ? (turn.args as (c: ServicingToolContext) => unknown)(ctx) : turn.args;
    const result = runServicingTool(ctx, turn.tool, args);
    steps.push({ say: turn.say ?? null, tool: turn.tool, args, result });
    if (result.ok && result.card) cards.push({ label: turn.cardLabel ?? null, card: result.card });
  }
  return { spec, steps, cards, ctx };
}

/** The member tapped "Looks right". The one step in every conversation a tool cannot take. */
const memberConfirms = (ctx: ServicingToolContext) => {
  ctx.draft.confirmed = true;
  ctx.awaitingConfirmation = false;
};

/** Prose for the outcome, straight from the engine's deterministic template — which must survive the tool's own checks. */
const templateOutcome = (confidence: "high" | "medium" | "low" = "high") => (ctx: ServicingToolContext) => ({
  member_explanation: ctx.result!.template.member,
  broker_explanation: ctx.result!.template.broker,
  confidence,
});

// ---------------------------------------------------------------------------
// The scenarios — each is one of the supplied events, met the way a member would
// ---------------------------------------------------------------------------

const p1Claim = (paid: boolean): { spec: ScenarioSpec; turns: Turn[] } => ({
  spec: {
    id: paid ? "reimbursement-clm6" : "claim-clm6",
    title: paid ? "Reimbursement — the member already paid" : "Claim — the ledger is wired in",
    description: paid
      ? "CLM-6 as a reimbursement: same arithmetic, and the sentence flips to \"the plan pays you back\"."
      : "CLM-6 (P1). The member gives four facts in one sentence; the agent asks for the two that are missing, and only those.",
    profile: "P1",
    intent: "claim",
    today: "2026-09-20",
    eventRef: "CLM-6",
    historyRefs: ["CLM-1"],
  },
  turns: [
    { tool: "read_policy" },
    { tool: "read_ledger" },
    { say: "I had physiotherapy for my wrist at Al Noor Clinic on 4 September. It cost 1,800.", tool: "record_fact", args: { field_key: "treatment", value: "Physiotherapy for my wrist", basis: "stated", quote: "physiotherapy for my wrist" } },
    { tool: "record_fact", args: { field_key: "treatment_date", value: "2026-09-04", basis: "stated", quote: "4 September" } },
    { tool: "record_fact", args: { field_key: "provider_name", value: "Al Noor Clinic", basis: "stated", quote: "Al Noor Clinic" } },
    { tool: "record_fact", args: { field_key: "amount", value: 1800, basis: "stated", quote: "1,800" } },
    { tool: "list_missing_facts" },
    { tool: "ask_member", args: { field_key: "provider_type", question: "What kind of place is Al Noor Clinic?" }, cardLabel: "Question — a closed vocabulary becomes chips" },
    { say: "Clinic", tool: "record_fact", args: { field_key: "provider_type", value: "in_network_clinic", basis: "stated", quote: "Clinic" } },
    { tool: "ask_member", args: { field_key: "paid_by_member", question: "Have you already paid Al Noor Clinic?" }, cardLabel: "Question — yes / no" },
    paid
      ? { say: "Yes, I've paid", tool: "record_fact", args: { field_key: "paid_by_member", value: true, basis: "stated", quote: "Yes, I've paid" } }
      : { say: "No, not yet", tool: "record_fact", args: { field_key: "paid_by_member", value: false, basis: "stated", quote: "No, not yet" } },
    { tool: "classify_benefit", args: { benefit_class: "general" } },
    { tool: "confirm_details", cardLabel: "Confirm — before any money is computed" },
    { tool: "adjudicate", session: memberConfirms },
    { tool: "propose_outcome", args: templateOutcome(), cardLabel: paid ? "Outcome — reimbursement" : "Outcome — covered" },
  ],
});

const preauth: { spec: ScenarioSpec; turns: Turn[] } = {
  spec: {
    id: "estimate-pre1",
    title: "Pre-authorization — an estimate, not a decision",
    description: "PRE-1 (P2). A forecast: it reads the ledger and moves nothing, and it says so.",
    profile: "P2",
    intent: "preauth",
    today: "2026-07-10",
    eventRef: "PRE-1",
    historyRefs: [],
  },
  turns: [
    { say: "I'm planning to deliver my baby at a private hospital. They've estimated 40,000.", tool: "record_fact", args: { field_key: "treatment", value: "Planned delivery", basis: "stated", quote: "deliver my baby" } },
    { tool: "record_fact", args: { field_key: "provider_type", value: "private_hospital", basis: "stated", quote: "private hospital" } },
    { tool: "record_fact", args: { field_key: "amount", value: 40000, basis: "stated", quote: "40,000" } },
    { tool: "classify_benefit", args: { benefit_class: "maternity" } },
    { tool: "confirm_details", cardLabel: "Confirm — a pre-authorization has no date or \"paid\" to ask" },
    { tool: "adjudicate", session: memberConfirms },
    { tool: "propose_outcome", args: templateOutcome(), cardLabel: "Estimate — approved with a limit" },
  ],
};

const denied: { spec: ScenarioSpec; turns: Turn[] } = {
  spec: {
    id: "denied-clm3",
    title: "Not covered — with a dated next step",
    description: "CLM-3 (P3). Denied on the waiting period. The card ends at a date and at an appeal, not at \"no\". The condition is one the member declared at intake, and is never asked for again.",
    profile: "P3",
    intent: "claim",
    today: "2026-05-20",
    eventRef: "CLM-3",
    historyRefs: [],
  },
  turns: [
    { tool: "read_applicant_record" },
    { say: "I saw my endocrinologist on 3 May for my diabetes review. 2,800 in total, at the clinic. I haven't paid yet.", tool: "record_fact", args: { field_key: "treatment", value: "Endocrinology review for my diabetes", basis: "stated", quote: "endocrinologist" } },
    { tool: "record_fact", args: { field_key: "treatment_date", value: "2026-05-03", basis: "stated", quote: "3 May" } },
    { tool: "record_fact", args: { field_key: "amount", value: 2800, basis: "stated", quote: "2,800" } },
    { tool: "record_fact", args: { field_key: "paid_by_member", value: false, basis: "inferred", quote: "I haven't paid yet" } },
    { tool: "ask_member", args: { field_key: "provider_type", question: "What kind of place was the clinic?" } },
    { say: "Clinic", tool: "record_fact", args: { field_key: "provider_type", value: "in_network_clinic", basis: "stated", quote: "Clinic" } },
    { tool: "classify_benefit", args: { benefit_class: "chronic_preexisting", declared_condition: "type 2 diabetes" } },
    { tool: "confirm_details", cardLabel: "Confirm — names the condition from the member's own application" },
    { tool: "adjudicate", session: memberConfirms },
    { tool: "propose_outcome", args: templateOutcome(), cardLabel: "Outcome — not covered, with a date and an appeal" },
  ],
};

const undecidable: { spec: ScenarioSpec; turns: Turn[] } = {
  spec: {
    id: "undecidable-clm9",
    title: "The edge of the plan data",
    description: "CLM-9 (P5). Treated abroad. The plan defines no geographic scope, so there is no answer to give. It is not a low-confidence answer, and the only route is a person.",
    profile: "P5",
    intent: "claim",
    today: "2026-07-15",
    eventRef: "CLM-9",
    historyRefs: ["CLM-5"],
  },
  turns: [
    { say: "I saw a cardiologist while travelling overseas on 3 July and paid 4,500 myself.", tool: "record_fact", args: { field_key: "treatment", value: "Cardiac follow-up while overseas", basis: "stated", quote: "cardiologist" } },
    { tool: "record_fact", args: { field_key: "treatment_date", value: "2026-07-03", basis: "stated", quote: "3 July" } },
    { tool: "record_fact", args: { field_key: "amount", value: 4500, basis: "stated", quote: "4,500" } },
    { tool: "record_fact", args: { field_key: "paid_by_member", value: true, basis: "stated", quote: "paid 4,500 myself" } },
    { tool: "ask_member", args: { field_key: "provider_type", question: "What kind of place was it?" } },
    { say: "Outside the UAE", tool: "record_fact", args: { field_key: "provider_type", value: "unknown_foreign", basis: "stated", quote: "Outside the UAE" } },
    { tool: "classify_benefit", args: { benefit_class: "chronic_preexisting", declared_condition: "coronary artery disease" } },
    { tool: "confirm_details" },
    { tool: "adjudicate", session: memberConfirms },
    {
      tool: "escalate",
      args: (ctx: ServicingToolContext) => ({ cause: "insufficient_data", note: "Overseas cardiac follow-up; plan defines no geographic scope.", member_message: ctx.result!.template.member }),
      cardLabel: "Escalation — reference, call, callback",
    },
  ],
};

const conflict: { spec: ScenarioSpec; turns: Turn[] } = {
  spec: {
    id: "conflict-date",
    title: "Two sources disagree",
    description: "The invoice says 10 September; the member says the 4th. The agent does not choose: it puts both in front of the member, neither pre-selected.",
    profile: "P1",
    intent: "claim",
    today: "2026-09-20",
    eventRef: "CLM-6",
    historyRefs: ["CLM-1"],
    seed: (draft) => {
      draft.facts.treatment_date = { value: "2026-09-10", source: "document", quote: "Invoice: date of treatment 10 September 2026" };
    },
  },
  turns: [
    { say: "The physio was on 4 September.", tool: "record_fact", args: { field_key: "treatment_date", value: "2026-09-04", basis: "stated", quote: "4 September" } },
    { tool: "flag_conflict", args: { field_key: "treatment_date" }, cardLabel: "Conflict — both sources named, neither chosen" },
    { say: "4 September", tool: "record_fact", args: { field_key: "treatment_date", value: "2026-09-04", basis: "stated", quote: "4 September", resolves_conflict: true } },
  ],
};

const inferred: { spec: ScenarioSpec; turns: Turn[] } = {
  spec: {
    id: "confirm-inferred",
    title: "A reading the member should check",
    description: "\"Last Friday\" is a reading, not a fact. The date row is marked as worked out, so the member checks it hardest.",
    profile: "P1",
    intent: "claim",
    today: "2026-09-20",
    eventRef: "CLM-6",
    historyRefs: ["CLM-1"],
  },
  turns: [
    { say: "Physio for my wrist last Friday at a clinic, 1,800. I haven't paid yet.", tool: "record_fact", args: { field_key: "treatment", value: "Physiotherapy for my wrist", basis: "stated", quote: "Physio for my wrist" } },
    { tool: "record_fact", args: { field_key: "treatment_date", value: "2026-09-18", basis: "inferred", quote: "last Friday" } },
    { tool: "record_fact", args: { field_key: "provider_type", value: "in_network_clinic", basis: "inferred", quote: "at a clinic" } },
    { tool: "record_fact", args: { field_key: "amount", value: 1800, basis: "stated", quote: "1,800" } },
    { tool: "record_fact", args: { field_key: "paid_by_member", value: false, basis: "inferred", quote: "I haven't paid yet" } },
    { tool: "classify_benefit", args: { benefit_class: "general" } },
    { tool: "confirm_details", cardLabel: "Confirm — \"worked out\" rows are what to check" },
  ],
};

export const SCENARIOS = [p1Claim(false), p1Claim(true), preauth, denied, undecidable, conflict, inferred];

export const runAll = (): ScenarioRun[] => SCENARIOS.map((s) => runScenario(s.spec, s.turns));

// ---------------------------------------------------------------------------
// Cards that no tool in this phase produces
// ---------------------------------------------------------------------------

/** The no-model mode: the agent's question as a form (plan §13.2.4). Built from the same missing-fact list a tool returns. */
export function factsFormFixture(): ServicingCard {
  const ctx = scenarioContext(SCENARIOS[0].spec);
  ctx.memberMessages.push("physiotherapy for my wrist");
  runServicingTool(ctx, "record_fact", { field_key: "treatment", value: "Physiotherapy for my wrist", basis: "stated", quote: "physiotherapy for my wrist" });
  const missing = runServicingTool(ctx, "list_missing_facts", {});
  if (!missing.ok) throw new Error(missing.error);
  const d = missing.data as { missing: any[]; optionalMissing: any[] };
  return factsFormCard(d.missing, d.optionalMissing);
}

/** Every card, grouped, for the gallery. */
export function galleryCards(): { group: string; label: string; note: string; card: ServicingCard }[] {
  const out: { group: string; label: string; note: string; card: ServicingCard }[] = [];
  for (const run of runAll()) {
    // Only cards a scenario chose to label are worth a place in the gallery; the rest are repeats of a shape already shown.
    for (const c of run.cards) if (c.label) out.push({ group: run.spec.title, label: c.label, note: run.spec.description, card: c.card });
  }
  out.push({ group: "No-model mode", label: "Facts form — the agent's question as a form", note: "With no key, or a failed turn, the question renders as exactly the missing fields. Same thread; it always works.", card: factsFormFixture() });
  out.push({ group: "Free-text questions", label: "Question — an amount", note: "Only what needs typing is typed: an amount, a date and a description are inputs; everything else is a chip.", card: questionCard("amount", "How much was it in total?") });
  out.push({ group: "Free-text questions", label: "Question — a date", note: "Only what needs typing is typed: an amount, a date and a description are inputs; everything else is a chip.", card: questionCard("treatment_date", "What day was the treatment?") });
  return out;
}
