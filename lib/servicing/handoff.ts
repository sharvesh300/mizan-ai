// What a PERSON can decide on a case the agent handed over — and what that writes (plan §13.3.2, §3.2's open item).
//
// Pure, like commit.ts: it decides WHAT is written, and lib/ai/servicing-handoff.ts writes it.
//
// Two decisions on a case the plan terms could not decide (CLM-9: treatment abroad, no geographic scope):
//
//   COVER IT      the advisor supplies the MISSING INPUT — which tier to treat the provider as — and the engine computes
//                 the money. An advisor never types an amount. The new row supersedes the undecidable one at its position,
//                 with geography `uae` and the chosen tier, so replay re-runs the engine and reproduces it: no stored
//                 number is authoritative, and the ledger folds like any other event.
//   DON'T COVER   a denial the plan rules cannot produce. No engine input reproduces "not covered" for a case the engine
//                 cannot answer, so this is the ONE row whose stored result is authoritative — and it can only ever be a
//                 zero (nothing paid, nothing consumed). Replay honours it (`handDenial`), visibly, rather than drifting.
//
// Both are decided by an advisor, so both carry `decided_by: advisor` and the advisor's id, and neither carries a
// confidence: it is a person's decision, not a system's.

import type { PlanTerms } from "@/lib/assessment";
import type { BenefitClass, ClaimProviderTier, EventKind, ProviderTier } from "@/db/schema/enums";
import type { EventDraft } from "./commit";
import { explain } from "./explain-template";
import { providerTypeLabel } from "./labels";
import { ledgerToJson } from "./ledger";
import { memberCopyViolations } from "./copy-rules";
import { numbersIn, observedNumbers } from "./facts";
import type { AdjudicationResult, LedgerState } from "./types";

/** The undecidable row, reduced to what a decision on it needs. */
export type HandSource = {
  id: string;
  ref: string;
  kind: Exclude<EventKind, "appeal" | "preauth">;
  policyMonth: number;
  benefitClass: BenefitClass;
  providerTier: ClaimProviderTier;
  geography: "uae" | "abroad" | "unknown";
  amount: number;
  description: string | null;
  occurredOn: string | null;
};

export type HandDraft = EventDraft & { supersedesEventId: string };

type Frame = { plan: PlanTerms; policyRef: string; inceptionDate: string; source: HandSource; today: string; newRef: string; advisorName: string; note: string };

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** COVER IT: the engine's answer for the tier the advisor named, in the UAE. */
export function buildCoverDraft(f: Frame, tier: ProviderTier, result: AdjudicationResult): HandDraft {
  const s = f.source;
  const text = explain({
    kind: s.kind,
    eventRef: f.newRef,
    policyRef: f.policyRef,
    plan: f.plan,
    inceptionDate: f.inceptionDate,
    policyMonth: s.policyMonth,
    benefitClass: s.benefitClass,
    providerTier: tier,
    geography: "uae",
    amount: s.amount,
    result,
  });
  const treated = `an advisor decided the plan's usual terms apply, as for a ${lower(providerTypeLabel[tier])}`;
  return {
    supersedesEventId: s.id,
    kind: s.kind,
    policyMonth: s.policyMonth,
    benefitClass: s.benefitClass,
    providerTier: tier,
    geography: "uae",
    billedAmount: s.amount,
    estimatedAmount: null,
    description: s.description ?? s.ref,
    occurredOn: s.occurredOn ?? f.today,
    outcome: result.outcome,
    reasonCode: result.reasonCode,
    planPays: result.planPays,
    memberPays: result.memberPays,
    calculation: [treated, ...result.calculation],
    ledgerBefore: ledgerToJson(result.ledgerBefore),
    ledgerAfter: ledgerToJson(result.ledgerAfter),
    memberExplanation: text.member,
    brokerExplanation: `${text.broker} ${f.policyRef} ${s.ref} was treated abroad and the plan defines no geographic scope; ${f.advisorName} decided to apply the plan terms as for a ${lower(providerTypeLabel[tier])} in the UAE. Note for the file: ${f.note}`,
    confidence: null,
    uncertaintyReason: null,
  };
}

/** DON'T COVER: nothing paid, nothing consumed. The one stored result replay takes at its word. */
export function buildDenyDraft(f: Frame, ledger: LedgerState, memberMessage: string): HandDraft {
  const s = f.source;
  return {
    supersedesEventId: s.id,
    kind: s.kind,
    policyMonth: s.policyMonth,
    benefitClass: s.benefitClass,
    providerTier: s.providerTier,
    geography: s.geography,
    billedAmount: s.amount,
    estimatedAmount: null,
    description: s.description ?? s.ref,
    occurredOn: s.occurredOn ?? f.today,
    outcome: "denied",
    reasonCode: "benefit_excluded",
    planPays: 0,
    memberPays: s.amount,
    calculation: ["an advisor decided this is not covered", "nothing is paid and nothing is counted against your limits"],
    ledgerBefore: ledgerToJson(ledger),
    ledgerAfter: ledgerToJson(ledger),
    memberExplanation: memberMessage,
    brokerExplanation: `${f.policyRef} ${s.ref} could not be decided from the plan terms (treated abroad; no geographic scope). ${f.advisorName} decided it is not covered. Nothing paid, ledger unchanged. Note for the file: ${f.note}`,
    confidence: null,
    uncertaintyReason: null,
  };
}

/** The message a member reads after a denial, drafted from the row — the advisor may edit it. */
export function defaultDenyMessage(kind: HandSource["kind"], amount: number): string {
  const aed = `AED ${amount.toLocaleString("en")}`;
  return `An advisor has looked at this and it isn't covered by your plan. ${kind === "reimbursement" ? "Your cost is" : "You'd pay"} the full ${aed}. If you'd like to talk it through, an advisor can go over it with you.`;
}

/**
 * A message a person writes to a member is held to the SAME register as anything the agent writes: no internal
 * vocabulary, no promised time, and no figure that is not on the case. The editing is the person's; the fence is not.
 */
export function checkMemberMessage(text: string, ...known: unknown[]): { ok: true; text: string } | { ok: false; reason: string } {
  const t = text.trim();
  if (t.length < 20) return { ok: false, reason: "Write a message the member can read — at least a sentence." };
  const violations = memberCopyViolations(t);
  if (violations.length > 0) return { ok: false, reason: `The message to the member is not fit for them to read: ${violations.join("; ")}` };
  const observed = observedNumbers(...known);
  const invented = numbersIn(t).filter((n) => !observed.has(n));
  if (invented.length > 0) return { ok: false, reason: `The message to the member states figure(s) ${invented.join(", ")} that appear nowhere on the case.` };
  return { ok: true, text: t };
}
