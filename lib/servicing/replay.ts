// Replay — the ledger rebuilt from the event log (servicing_spec.md §2b).
//
// THE EVENT LOG IS THE SOURCE OF TRUTH; the ledger is a projection of it. The
// projection is produced by RE-RUNNING the engine over each event's inputs, in
// effect order, from an empty ledger. It is not produced by summing the stored
// `plan_pays`, and it does not read the `ledger_before`/`ledger_after`
// snapshots on each row, for two reasons that both bite:
//
//   1. The log does not record the deductible each event consumed, and it
//      cannot be recovered from `plan_pays` alone once a cap has clipped it.
//   2. Those snapshots go stale. An overturned appeal writes to the ledger at
//      the point of the ORIGINAL event (spec §2, rule 3), so every event after
//      it now sees a different ledger than the one it stored. A fold over
//      snapshots would faithfully reproduce the stale numbers.
//
// Re-running the engine also gives the drift check for free: compare what the
// replay decides against what each row says it decided. The one legitimate
// difference is an event after a mid-history overturn, which is restated, not
// drifted; the caller distinguishes them.

import type { PlanTerms } from "@/lib/assessment";
import { adjudicate } from "./adjudicate";
import { cloneLedger, emptyLedger } from "./ledger";
import type { LedgerState, Replay, ReplayEvent, ReplayStep } from "./types";

/**
 * The events that take part in the replay, in the order they take effect.
 *
 *  - A superseded event drops out: the denial happened and stays on the record,
 *    but it no longer counts in the fold.
 *  - An appeal that supersedes nothing (an upheld appeal) has no effect on the
 *    ledger and takes no part.
 *  - The event that supersedes another takes the superseded event's place in
 *    the order — the overturn lands where the denial was, not where the appeal
 *    was filed. That is rule 3 of the spec, and it is why a month-9
 *    pre-authorization forecasts against a deductible that an appeal at
 *    month 7 already met.
 *
 * Order is `seq` (submission order), never `policyMonth`; see ReplayEvent.
 */
function index(events: ReplayEvent[]) {
  const byId = new Map<string, ReplayEvent>();
  for (const event of events) {
    if (byId.has(event.id)) throw new Error(`duplicate event id ${event.id}`);
    byId.set(event.id, event);
  }

  const superseded = new Set<string>();
  for (const event of events) {
    if (!event.supersedesId) continue;
    if (!byId.has(event.supersedesId)) throw new Error(`${event.id} supersedes ${event.supersedesId}, which is not in the log`);
    superseded.add(event.supersedesId);
  }

  /** Where an event sits: the seq of the first event in its supersession chain. */
  const positionOf = (event: ReplayEvent): number => {
    const seen = new Set<string>();
    let cursor = event;
    while (cursor.supersedesId) {
      if (seen.has(cursor.id)) throw new Error(`supersession cycle through ${cursor.id}`);
      seen.add(cursor.id);
      cursor = byId.get(cursor.supersedesId)!;
    }
    return cursor.seq;
  };

  // Resolve every position BEFORE filtering. A cycle puts all of its members in
  // `superseded`, so filtering first would drop them all without ever asking
  // where they sit — an unresolvable history silently becoming an empty one.
  const position = new Map(events.map((event) => [event.id, positionOf(event)]));
  return { superseded, position };
}

/** Where each event sits in effect order (see `effectOrder`). Throws on a dangling or cyclic supersession. */
export const effectPositions = (events: ReplayEvent[]): Map<string, number> => index(events).position;

export function effectOrder(events: ReplayEvent[]): ReplayEvent[] {
  const { superseded, position } = index(events);
  return events
    .filter((event) => !superseded.has(event.id))
    .filter((event) => event.kind !== "appeal" || event.supersedesId)
    .sort((a, b) => position.get(a.id)! - position.get(b.id)! || a.seq - b.seq);
}

/** Re-run the engine over the log, in effect order, from an empty ledger. */
export function replay(plan: PlanTerms, events: ReplayEvent[]): Replay {
  let ledger: LedgerState = emptyLedger();
  const steps: ReplayStep[] = [];

  for (const event of effectOrder(events)) {
    if (event.benefitClass === null || event.providerTier === null || event.amount === null) {
      throw new Error(`${event.id} takes part in the replay but is missing its benefit class, provider tier or amount`);
    }
    if (event.handDenial) {
      const amount = event.amount;
      steps.push({
        event,
        result: {
          outcome: "denied",
          reasonCode: "benefit_excluded",
          planPays: 0,
          memberPays: amount,
          deductibleApplied: 0,
          clippedBy: null,
          calculation: ["decided by an advisor: not covered", "nothing is paid and nothing is consumed from the ledger"],
          ledgerBefore: cloneLedger(ledger),
          ledgerAfter: cloneLedger(ledger),
        },
      });
      continue;
    }
    const dryRun = event.kind === "preauth";
    const result = adjudicate({
      plan,
      ledger,
      policyStatus: event.policyStatus ?? "active",
      policyMonth: event.policyMonth,
      benefitClass: event.benefitClass,
      providerTier: event.providerTier,
      geography: event.geography ?? "uae",
      amount: event.amount,
      dryRun,
    });
    steps.push({ event, result });
    // A pre-authorization reads the ledger and never writes it; the engine
    // already returns `ledgerAfter` unchanged for a dry run, so this is the
    // one line that would have to be wrong for a forecast to leak.
    if (!dryRun) ledger = result.ledgerAfter;
  }

  return { ledger: cloneLedger(ledger), steps };
}

/** The ledger a policy's history projects to. */
export const project = (plan: PlanTerms, events: ReplayEvent[]): LedgerState => replay(plan, events).ledger;
