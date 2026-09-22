// From a finished conversation to the row that goes in the log.
//
// Pure: it decides WHAT is written, and the session writes it. Keeping the mapping here means it can be
// checked against the acceptance table without a database, and means a stored event is derived from the
// engine's result rather than typed — the same rule the seed follows.

import type { BenefitClass, ClaimProviderTier, EventKind, EventOutcome, Geography, ReasonCode } from "@/db/schema/enums";
import { kindOf } from "./facts";
import { ledgerToJson } from "./ledger";
import type { ServicingToolContext } from "@/lib/ai/tools/servicing";

export type Confidence = "high" | "medium" | "low";

/** Bands match `confidenceBand` (lib/domain.ts): ≥0.9 high, ≥0.6 medium, else low. */
export const CONFIDENCE_VALUE: Record<Confidence, number> = { high: 0.95, medium: 0.75, low: 0.45 };

export type EventDraft = {
  kind: EventKind;
  policyMonth: number;
  benefitClass: BenefitClass;
  providerTier: ClaimProviderTier;
  geography: Geography;
  billedAmount: number | null;
  estimatedAmount: number | null;
  description: string;
  occurredOn: string;
  outcome: EventOutcome;
  reasonCode: ReasonCode;
  planPays: number | null;
  memberPays: number | null;
  calculation: string[];
  ledgerBefore: ReturnType<typeof ledgerToJson>;
  ledgerAfter: ReturnType<typeof ledgerToJson>;
  memberExplanation: string;
  brokerExplanation: string;
  confidence: number | null;
  uncertaintyReason: string | null;
};

const UNDECIDABLE =
  "The plan defines no geographic scope and the provider could not be placed in a network tier — this cannot be decided from the plan data.";

/**
 * The event this conversation produced. `terminal` carries what the agent (or the deterministic driver) proposed;
 * every amount and every trace line comes from the engine's result held on the context.
 */
export function buildEventDraft(
  ctx: ServicingToolContext,
  terminal: { memberExplanation: string; brokerExplanation: string; confidence: Confidence | null; uncertaintyReason: string | null },
): EventDraft {
  const r = ctx.result;
  if (!r) throw new Error("nothing was adjudicated — there is no event to write");
  const kind = kindOf(ctx.draft);
  const treatment = String(ctx.draft.facts.treatment?.value ?? "");
  const provider = ctx.draft.facts.provider_name?.value;
  const undecidable = r.outcome === "insufficient_data";

  return {
    kind,
    policyMonth: r.input.policyMonth,
    benefitClass: r.input.benefitClass,
    providerTier: r.input.providerTier,
    geography: r.input.geography,
    billedAmount: kind === "preauth" ? null : r.input.amount,
    estimatedAmount: kind === "preauth" ? r.input.amount : null,
    description: provider ? `${treatment} · ${provider}` : treatment,
    occurredOn: kind === "preauth" || typeof ctx.draft.facts.treatment_date?.value !== "string" ? ctx.today : String(ctx.draft.facts.treatment_date.value),
    outcome: r.outcome,
    reasonCode: r.reasonCode,
    planPays: r.planPays,
    memberPays: r.memberPays,
    calculation: r.calculation,
    ledgerBefore: ledgerToJson(r.ledgerBefore),
    ledgerAfter: ledgerToJson(r.ledgerAfter),
    memberExplanation: terminal.memberExplanation,
    brokerExplanation: terminal.brokerExplanation,
    // The undecidable case carries no confidence at all: it is the absence of an answer, not a weak one.
    confidence: undecidable || terminal.confidence === null ? null : CONFIDENCE_VALUE[terminal.confidence],
    uncertaintyReason: undecidable ? UNDECIDABLE : terminal.uncertaintyReason,
  };
}
