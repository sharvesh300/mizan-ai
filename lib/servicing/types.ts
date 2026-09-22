// Shapes for the servicing engine (docs/servicing_agent_plan.md §3).
//
// Everything in lib/servicing is pure: no database, no model, no `server-only`.
// That is deliberate — money is arithmetic over plan terms and a ledger, and
// arithmetic has to be runnable from a script with nothing else switched on.
// The database glue and the agent live elsewhere and call in here.

import type { PlanTerms } from "@/lib/assessment";
import type {
  BenefitClass,
  ClaimProviderTier,
  EventKind,
  EventOutcome,
  Geography,
  PolicyStatus,
  ReasonCode,
} from "@/db/schema/enums";

/**
 * What has been consumed so far. Same fields as the `benefit_ledger` columns.
 * This is DERIVED state — the event log is the source of truth (spec §2b).
 */
export type LedgerState = {
  deductibleMet: number;
  annualPaid: number;
  /** Plan payment consumed per class that carries a sublimit. Keys match the ledger template. */
  sublimitUsed: Record<string, number>;
};

/** Everything one adjudication reads. All of it is validated before it gets here. */
export type AdjudicationInput = {
  plan: PlanTerms;
  /** The ledger as it stood immediately BEFORE this event. */
  ledger: LedgerState;
  policyStatus: PolicyStatus;
  /** Whole months since inception, starting at 0. A 6-month wait clears at month 6. */
  policyMonth: number;
  benefitClass: BenefitClass;
  providerTier: ClaimProviderTier;
  geography: Geography;
  /** Billed amount, or the estimate for a pre-authorization. */
  amount: number;
  /** Pre-authorization: compute everything, move nothing. */
  dryRun: boolean;
};

/** Which cap, if any, reduced the plan's payment (steps 9 and 10). */
export type ClippedBy = "sublimit" | "annual_limit";

export type AdjudicationResult = {
  outcome: EventOutcome;
  reasonCode: ReasonCode;
  /** Null only for `insufficient_data` — the absence of an answer is not a zero. */
  planPays: number | null;
  memberPays: number | null;
  /**
   * Deductible this adjudication worked off. On a dry run it is the forecast:
   * it was used in the calculation but not consumed from the ledger.
   */
  deductibleApplied: number;
  clippedBy: ClippedBy | null;
  /** Ordered arithmetic trace. Kept verbatim on the history record (spec §2b). */
  calculation: string[];
  ledgerBefore: LedgerState;
  /** Never null. Equal to `ledgerBefore` when the event is denied, undecidable, or a dry run. */
  ledgerAfter: LedgerState;
};

/**
 * One row of the event log, reduced to the inputs an adjudication reads.
 * Replay re-runs the engine over these — it does not sum stored amounts, and
 * it does not trust the `ledger_before`/`ledger_after` snapshots on the row
 * (both go stale the moment an overturn lands mid-history; see replay.ts).
 */
export type ReplayEvent = {
  id: string;
  /**
   * Submission order within one policy. This — not `policyMonth` — is the clock:
   * each original adjudication saw the ledger as it stood at submission, and
   * `policyMonth` is an INPUT to the waiting-period gate, not a position.
   */
  seq: number;
  kind: EventKind;
  policyMonth: number;
  /** Null only on an appeal that supersedes nothing (an upheld appeal has no effect). */
  benefitClass: BenefitClass | null;
  providerTier: ClaimProviderTier | null;
  /** Defaults to `uae`. */
  geography?: Geography;
  amount: number | null;
  /** Status when the event was submitted. Defaults to `active`. */
  policyStatus?: PolicyStatus;
  /** Set on an overturned appeal: the denial it replaces in the fold (spec §2b). */
  supersedesId?: string | null;
  /**
   * A denial a PERSON decided by hand — the plan terms could not decide it, and an advisor said it is not covered. No
   * engine input reproduces "not covered" for a case the engine cannot answer, so replay does not re-run it: it takes the
   * row's own word, which is that nothing was paid and nothing was consumed. The one place a stored result is
   * authoritative (plan §3.2's open item), and a deliberate, visible one: it can only ever be a zero.
   */
  handDenial?: boolean;
};

export type ReplayStep = { event: ReplayEvent; result: AdjudicationResult };

export type Replay = {
  /** The ledger after every event that consumes has been applied, in effect order. */
  ledger: LedgerState;
  /** One entry per event that took part, in effect order — pre-authorizations included. */
  steps: ReplayStep[];
};
