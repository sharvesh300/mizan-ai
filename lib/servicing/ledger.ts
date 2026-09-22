// Ledger state helpers. The ledger is a PROJECTION of the event log
// (servicing_spec.md §2b) — nothing here increments a stored counter; a
// LedgerState is only ever produced by adjudicate() (one event) or replay()
// (a whole history). See replay.ts.

import type { LedgerState } from "./types";

export const emptyLedger = (): LedgerState => ({
  deductibleMet: 0,
  annualPaid: 0,
  sublimitUsed: { maternity: 0, dental_optical: 0 },
});

export const cloneLedger = (ledger: LedgerState): LedgerState => ({
  deductibleMet: ledger.deductibleMet,
  annualPaid: ledger.annualPaid,
  sublimitUsed: { ...ledger.sublimitUsed },
});

/**
 * Field-by-field differences, empty when the two ledgers are identical.
 * Reported as lines so a drifted ledger says WHICH number drifted instead of
 * just that something did.
 */
export function compareLedgers(stored: LedgerState, replayed: LedgerState): string[] {
  const diffs: string[] = [];
  if (stored.deductibleMet !== replayed.deductibleMet) {
    diffs.push(`deductible_met: stored ${stored.deductibleMet}, replayed ${replayed.deductibleMet}`);
  }
  if (stored.annualPaid !== replayed.annualPaid) {
    diffs.push(`annual_paid: stored ${stored.annualPaid}, replayed ${replayed.annualPaid}`);
  }
  const keys = new Set([...Object.keys(stored.sublimitUsed), ...Object.keys(replayed.sublimitUsed)]);
  for (const key of [...keys].sort()) {
    const a = stored.sublimitUsed[key] ?? 0;
    const b = replayed.sublimitUsed[key] ?? 0;
    if (a !== b) diffs.push(`sublimit_used.${key}: stored ${a}, replayed ${b}`);
  }
  return diffs;
}

/** The snake_case form the spec (§2b) and the stored history records use for ledger snapshots. */
export const ledgerToJson = (l: LedgerState) => ({
  deductible_met: l.deductibleMet,
  annual_paid: l.annualPaid,
  sublimit_used: l.sublimitUsed,
});
