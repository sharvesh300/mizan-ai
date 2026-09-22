// From a finished appeal to the rows that go in the log — and the proposal that waits for a signature.
//
// Pure, like commit.ts: it decides WHAT is written and the session writes it, so the mapping can be checked
// without a database, and a stored appeal is derived from the engine's result rather than typed.
//
// Two very different writes:
//
//   UPHELD      written at once, `decided_by: system`. Nothing about the ledger moves, and a fast, honest "no, and
//               here is exactly what would change it" beats a three-day wait for the same answer (§19).
//   OVERTURNED  NEVER written by the system. The log is append-only and an overturn moves money and rewrites the
//               ledger at a past point, so the system writes a PROPOSAL — the whole finished row, plus the working
//               — and a person signs it. The proposal is a `conversation_action` in `pending`; signing is what
//               appends the row (lib/servicing/signoff.ts), and nothing is shown to the member as decided until then.

import { z } from "zod";
import type { PlanTerms } from "@/lib/assessment";
import { benefitClassEnum, claimProviderTierEnum, reasonCodeEnum, type BenefitClass, type ClaimProviderTier, type EventOutcome, type ReasonCode } from "@/db/schema/enums";
import { CONFIDENCE_VALUE } from "./commit";
import { EVIDENCE_KINDS, evidenceClause, evidenceClauseBroker, type ContestedRow, type Correction, type EvidenceKind, type ReAdjudication } from "./appeal";
import { outcomeCard, type OutcomeCard } from "./cards";
import { explain } from "./explain-template";
import { nextStepFacts, type NextStepFacts } from "./next-steps";
import { ledgerToJson } from "./ledger";
import { reasonCodeLabel } from "@/lib/domain";
import type { AdjudicationResult, LedgerState } from "./types";

/** Everything the append-only row needs, minus the id and the reference the session allocates at commit. */
export type AppealEventDraft = {
  verdict: "upheld" | "overturned";
  contestedEventId: string;
  contestedRef: string;
  policyMonth: number;
  benefitClass: BenefitClass;
  providerTier: ClaimProviderTier;
  geography: "uae" | "abroad" | "unknown";
  billedAmount: number;
  description: string;
  /** What the member sent, in order, verbatim — the record of what was argued. */
  evidenceText: string;
  outcome: Extract<EventOutcome, "upheld" | "overturned">;
  reasonCode: ReasonCode;
  planPays: number | null;
  memberPays: number | null;
  calculation: string[];
  ledgerBefore: ReturnType<typeof ledgerToJson>;
  ledgerAfter: ReturnType<typeof ledgerToJson>;
  memberExplanation: string;
  brokerExplanation: string;
  confidence: number;
  uncertaintyReason: string | null;
  /** True only for an overturn: this row replaces the contested one in the ledger fold. */
  supersedes: boolean;
};

type Frame = {
  plan: PlanTerms;
  policyRef: string;
  inceptionDate: string;
  contested: ContestedRow;
  /** The contested event's result as it was adjudicated — reconstructed by the engine, never read back as text. */
  original: AdjudicationResult;
  evidence: string[];
  /** Whether the finding rests on a condition the member declared at intake. */
  declaredAtIntake: boolean;
  appealRef: string;
};

const evidenceBlock = (evidence: string[]) => (evidence.length ? evidence.map((e, i) => `Evidence ${i + 1}: ${e}`).join("\n\n") : "Evidence attached: none.");

/** The denial stands. The row is the record that it was looked at again; the ledger does not move. */
export function buildUpheldDraft(f: Frame, opts: { evidenceSupplied: boolean; note?: string }): AppealEventDraft {
  const c = f.contested;
  const text = explain({
    kind: "appeal",
    eventRef: f.appealRef,
    policyRef: f.policyRef,
    plan: f.plan,
    inceptionDate: f.inceptionDate,
    policyMonth: c.policyMonth,
    benefitClass: c.benefitClass!,
    providerTier: c.providerTier!,
    geography: c.geography,
    amount: c.amount!,
    result: f.original,
    appeal: {
      appealRef: f.appealRef,
      contestedRef: c.ref,
      contestedReason: c.reasonCode!,
      verdict: "upheld",
      evidenceSupplied: opts.evidenceSupplied,
      declaredAtIntake: f.declaredAtIntake,
    },
  });
  const judgement = f.declaredAtIntake && c.reasonCode === "waiting_period_not_elapsed";
  return {
    verdict: "upheld",
    contestedEventId: c.id,
    contestedRef: c.ref,
    policyMonth: c.policyMonth,
    benefitClass: c.benefitClass!,
    providerTier: c.providerTier!,
    geography: c.geography,
    billedAmount: c.amount!,
    description: `Appeal — ${c.description ?? c.ref}`,
    evidenceText: evidenceBlock(f.evidence),
    outcome: "upheld",
    reasonCode: c.reasonCode!,
    planPays: f.original.planPays,
    memberPays: f.original.memberPays,
    // Shown to the member too: reason and wording, never a reference or an enum.
    calculation: [
      `appeal against the earlier decision: ${reasonCodeLabel[c.reasonCode!]}`,
      opts.evidenceSupplied ? "the evidence supplied does not change that finding" : "no evidence was attached",
      ...(opts.note ? [opts.note] : []),
      `the decision stands — plan pays ${f.original.planPays}, member pays ${f.original.memberPays}`,
    ],
    ledgerBefore: ledgerToJson(f.original.ledgerBefore),
    ledgerAfter: ledgerToJson(f.original.ledgerBefore),
    memberExplanation: text.member,
    brokerExplanation: text.broker,
    // An upheld appeal that rested on reading a declared condition against the member's own account is a close
    // call worth a look — the same call the supplied APP-1 carries. Anything else is as settled as arithmetic is.
    confidence: judgement ? 0.65 : CONFIDENCE_VALUE.medium,
    uncertaintyReason: judgement
      ? "Upheld with no admissible evidence. The finding rests on reading a condition the applicant declared at intake against their own account — arguable enough to be worth a look."
      : null,
    supersedes: false,
  };
}

/** The reversal, computed and waiting for a signature. */
export function buildOverturnDraft(f: Frame, redone: ReAdjudication, correction: Correction, kind: EvidenceKind): AppealEventDraft {
  const c = f.contested;
  const r = redone.result;
  const patchedClass = (correction.field === "benefit_class" ? correction.to : c.benefitClass) as BenefitClass;
  const patchedTier = (correction.field === "provider_tier" ? correction.to : c.providerTier) as ClaimProviderTier;
  const text = explain({
    kind: "appeal",
    eventRef: f.appealRef,
    policyRef: f.policyRef,
    plan: f.plan,
    inceptionDate: f.inceptionDate,
    policyMonth: c.policyMonth,
    benefitClass: patchedClass,
    providerTier: patchedTier,
    geography: c.geography,
    amount: c.amount!,
    result: r,
    appeal: {
      appealRef: f.appealRef,
      contestedRef: c.ref,
      contestedReason: c.reasonCode!,
      verdict: "overturned",
      evidenceSupplied: true,
      evidenceSummary: evidenceClause(correction),
      evidenceSummaryBroker: evidenceClauseBroker(correction, kind),
      correction: { field: correction.field.replace(/_/g, " "), from: correction.from, to: correction.to },
    },
  });
  return {
    verdict: "overturned",
    contestedEventId: c.id,
    contestedRef: c.ref,
    policyMonth: c.policyMonth,
    benefitClass: patchedClass,
    providerTier: patchedTier,
    geography: c.geography,
    billedAmount: c.amount!,
    description: `Appeal — ${c.description ?? c.ref}`,
    evidenceText: evidenceBlock(f.evidence),
    outcome: "overturned",
    reasonCode: r.reasonCode,
    planPays: r.planPays,
    memberPays: r.memberPays,
    calculation: [
      `appeal against the earlier decision: ${reasonCodeLabel[c.reasonCode!]}`,
      `${correction.field.replace(/_/g, " ")} corrected from ${correction.from.replace(/_/g, " ")} to ${correction.to.replace(/_/g, " ")} on the evidence supplied`,
      ...r.calculation,
    ],
    ledgerBefore: ledgerToJson(r.ledgerBefore),
    ledgerAfter: ledgerToJson(r.ledgerAfter),
    memberExplanation: text.member,
    brokerExplanation: text.broker,
    confidence: 0.7,
    uncertaintyReason: "Overturned on a correction proposed from evidence that arrived as text, so a person confirms the document reads as described.",
    supersedes: true,
  };
}

// ---------------------------------------------------------------------------
// The proposal — what waits for a signature
// ---------------------------------------------------------------------------

const ledgerJson = z.strictObject({ deductible_met: z.number(), annual_paid: z.number(), sublimit_used: z.record(z.string(), z.number()) });

const draftSchema = z.strictObject({
  verdict: z.enum(["upheld", "overturned"]),
  contestedEventId: z.string(),
  contestedRef: z.string(),
  policyMonth: z.number().int(),
  benefitClass: z.enum(benefitClassEnum),
  providerTier: z.enum(claimProviderTierEnum),
  geography: z.enum(["uae", "abroad", "unknown"]),
  billedAmount: z.number(),
  description: z.string(),
  evidenceText: z.string(),
  outcome: z.enum(["upheld", "overturned"]),
  reasonCode: z.enum(reasonCodeEnum),
  planPays: z.number().nullable(),
  memberPays: z.number().nullable(),
  calculation: z.array(z.string()),
  ledgerBefore: ledgerJson,
  ledgerAfter: ledgerJson,
  memberExplanation: z.string(),
  brokerExplanation: z.string(),
  confidence: z.number(),
  uncertaintyReason: z.string().nullable(),
  supersedes: z.boolean(),
});

export const overturnProposalSchema = z.strictObject({
  version: z.literal(1),
  conversationId: z.string(),
  contestedEventId: z.string(),
  contestedRef: z.string(),
  contestedReason: z.enum(reasonCodeEnum),
  evidenceKind: z.enum(EVIDENCE_KINDS),
  correction: z.strictObject({ field: z.enum(["provider_tier", "benefit_class"]), from: z.string(), to: z.string(), quote: z.string(), evidenceIndex: z.number().int() }),
  evidence: z.array(z.string()),
  /** What the decision was, and what it would become — the two lines a signature is made on. */
  original: z.strictObject({ outcome: z.string().nullable(), planPays: z.number().nullable(), memberPays: z.number().nullable() }),
  ledgerBeforeContested: ledgerJson,
  draft: draftSchema,
  /** The agent's path, step by step — the "Working" tab. Kept whole: it is the audit of how the proposal came about. */
  trace: z.array(z.strictObject({ step: z.number(), thought: z.string(), tool: z.string(), args: z.unknown().optional(), validation: z.string(), observation: z.string(), latencyMs: z.number() })),
  proposedAt: z.string(),
});
export type OverturnProposal = z.infer<typeof overturnProposalSchema>;

export const parseOverturnProposal = (raw: unknown): OverturnProposal | null => {
  const parsed = overturnProposalSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

export const ledgerJsonOf = (l: LedgerState) => ledgerToJson(l);

const NO_FACTS: NextStepFacts = { waitingPeriod: null, admittedProviders: null, limit: null, deductibleNowMet: false, appealable: false };

/**
 * What the member reads when an appeal ends — the same card for both outcomes, from the stored row's own numbers.
 * An upheld appeal also carries the dated next steps of the finding it left standing ("the wait ends on …"); a
 * reversal's explanation already says what changed.
 */
export function appealOutcomeCard(draft: AppealEventDraft, plan: PlanTerms, inceptionDate: string, original?: AdjudicationResult): OutcomeCard {
  const facts =
    original && draft.verdict === "upheld"
      ? nextStepFacts({ plan, kind: "appeal", benefitClass: draft.benefitClass, providerTier: draft.providerTier, policyMonth: draft.policyMonth, inceptionDate, result: original })
      : NO_FACTS;
  return outcomeCard({
    kind: "appeal",
    outcome: draft.outcome,
    title: draft.description.replace(/^Appeal — /, ""),
    policyMonth: draft.policyMonth,
    inceptionDate,
    benefitClass: draft.benefitClass,
    amount: draft.billedAmount,
    result: { outcome: draft.outcome, planPays: draft.planPays, memberPays: draft.memberPays, calculation: draft.calculation },
    explanation: draft.memberExplanation,
    facts,
    trace: draft.calculation,
  });
}
