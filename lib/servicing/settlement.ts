// What the plan owes, and whether it has actually been paid (§payouts) — pure, no DB, no model.
//
// The engine decides the AMOUNT; a person decides WHEN it leaves. That seam is the same one the rest of this
// system is built on, one step further along: adjudication says what is owed, the ledger projects it, and this
// says whether the money moved. Nothing here may ever influence the first two — a settlement is a fact about
// cash, not about cover, so `replay()` neither reads it nor is changed by it.

import type { EventKind, EventOutcome, SettlementStatus } from "@/db/schema/enums";

/** The part of a decided event this module needs — structural, so it is testable without a database row. */
export type DecidedEvent = {
  kind: EventKind;
  outcome: EventOutcome | null;
  planPays: number | null;
  /** Set when a later row replaced this one (an overturn, an advisor's own decision). */
  supersededByEventId?: string | null;
};

/** Who the money goes to. Derived, never stored: a reimbursement is by definition one the member already paid. */
export type Payee = "member" | "provider";

export const payeeOf = (event: Pick<DecidedEvent, "kind">): Payee => (event.kind === "reimbursement" ? "member" : "provider");

/**
 * Does this decided event owe a payout?
 *
 * Four conditions, and each one is load-bearing:
 *  - a PRE-AUTHORIZATION never does. It is a forecast; nothing has been claimed and nothing is owed.
 *  - a denial never does, and neither does a case the plan could not decide: there is no amount.
 *  - `approved_with_limit` DOES. A claim clipped by a sublimit still owes what the plan agreed to pay.
 *  - a row a later one REPLACED never does, or an overturned denial would be paid alongside its own correction.
 *
 * `planPays > 0` is checked last and separately: a covered claim that consumed the whole deductible can settle
 * to zero, and a payout for nothing is not a payout.
 */
export function owesPayment(event: DecidedEvent): boolean {
  if (event.supersededByEventId) return false;
  if (event.kind !== "claim" && event.kind !== "reimbursement") return false;
  if (event.outcome !== "covered" && event.outcome !== "approved_with_limit") return false;
  return (event.planPays ?? 0) > 0;
}

/**
 * The two verbs, as state transitions. Approving a payment and making it are different acts — so the record can
 * answer "was this authorised?" and "did the money leave?" separately, which one combined flag cannot.
 */
export const canApprove = (status: SettlementStatus): boolean => status === "awaiting_approval";
export const canMarkPaid = (status: SettlementStatus): boolean => status === "approved";

/** Why a verb was refused, in the broker's register — the advisor reads this, so it says what is true now. */
export function refusalFor(verb: "approve" | "mark_paid", status: SettlementStatus): string | null {
  if (verb === "approve") {
    if (status === "approved") return "This payment is already approved — it is waiting to be marked paid.";
    if (status === "paid") return "This payment has already been made.";
    return null;
  }
  if (status === "awaiting_approval") return "This payment has not been approved yet — approve it first.";
  if (status === "paid") return "This payment has already been marked paid.";
  return null;
}

/** What a MEMBER reads about where their money is. No reference, no advisor name, no internal vocabulary. */
export const memberSettlementLine = (status: SettlementStatus, paidOn: string | null): string => {
  if (status === "paid") return paidOn ? `Paid on ${paidOn}.` : "Paid.";
  if (status === "approved") return "Payment approved — it is on its way.";
  return "Payment is being arranged.";
};
