// The acceptance table — docs/servicing_agent_plan.md §14 — as data.
//
// One definition, shared by the pure check (check-servicing.ts) and the
// database check (check-ledger.ts), so the two cannot quietly disagree about
// what "right" is. These are the four fields the brief compares across
// submissions (outcome, plan_pays, member_pays, reason_code), plus each policy's
// final ledger.
import type { LedgerState } from "@/lib/servicing";

export type Expected = { outcome: string; planPays: number | null; memberPays: number | null; reasonCode: string };
const row = (outcome: string, planPays: number | null, memberPays: number | null, reasonCode: string): Expected => ({
  outcome,
  planPays,
  memberPays,
  reasonCode,
});

export const EXPECTED: Record<string, Expected> = {
  "CLM-1": row("covered", 1190, 2010, "covered"),
  "CLM-6": row("covered", 1260, 540, "covered"),
  "PRE-1": row("approved_with_limit", 25000, 15000, "covered"),
  "CLM-2": row("covered", 25000, 15000, "covered"),
  "CLM-7": row("denied", 0, 3000, "sublimit_exhausted"),
  "CLM-3": row("denied", 0, 2800, "waiting_period_not_elapsed"),
  "APP-1": row("upheld", 0, 2800, "waiting_period_not_elapsed"),
  "CLM-8": row("covered", 1680, 920, "covered"),
  "CLM-4": row("denied", 0, 6000, "provider_out_of_network"),
  "APP-2": row("overturned", 4400, 1600, "covered"),
  "PRE-2": row("covered", 22400, 5600, "covered"),
  "CLM-5": row("covered", 162000, 18000, "covered"),
  "CLM-9": row("insufficient_data", null, null, "insufficient_data"),
};

const led = (deductibleMet: number, annualPaid: number, maternity = 0): LedgerState => ({
  deductibleMet,
  annualPaid,
  sublimitUsed: { maternity, dental_optical: 0 },
});

/** Keyed by profile (P1..P5); the policy is `POL-<profile>`. */
export const EXPECTED_LEDGER: Record<string, LedgerState> = {
  P1: led(1500, 2450),
  P2: led(0, 25000, 25000),
  P3: led(500, 1680),
  P4: led(500, 4400),
  P5: led(0, 162000),
};

/**
 * The calculation traces of the two events that used to be hand-typed, pinned
 * verbatim. The trace is part of the record (spec §2b: "keep it") and the seed
 * now regenerates it, so a change to the engine's wording is a change to what
 * is stored — it should fail here first.
 */
export const EXPECTED_TRACE: Record<string, string[]> = {
  "CLM-1": [
    "deductible applied 1500 (remaining was 1500)",
    "after deductible 1700",
    "co-pay 30% of 1700 = 510",
    "plan pays 1190, member pays 1500 + 510 = 2010",
  ],
  "CLM-6": ["deductible applied 0 (remaining was 0)", "co-pay 30% of 1800 = 540", "plan pays 1260, member pays 540"],
};
