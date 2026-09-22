// The database side of the engine: load a policy's event log, and the ONLY code
// that writes `benefit_ledger`.
//
// The log is the source of truth (spec §2b); the ledger is a projection of it.
// Everything that changes a ledger goes through `rebuildLedger`, which replays
// the log and writes the result — never `deductible_met += x` at a call site.
// `checkReplay` is the other direction: replay from scratch and compare with
// what is stored, so a ledger that has drifted from its history says so.
//
// Not `server-only`: the seed script calls it under Bun, outside Next.

import { eq, getTableColumns, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { benefitLedger, plan, policy, servicingEvent } from "@/db/schema";
import type { PlanTerms } from "@/lib/assessment";
import { compareLedgers, emptyLedger } from "./ledger";
import { effectPositions, replay } from "./replay";
import type { LedgerState, Replay, ReplayEvent } from "./types";

type StoredEvent = typeof servicingEvent.$inferSelect;

/**
 * The log, in submission order.
 *
 * `servicing_event` has no sequence column, and the log is append-only, so the order rows were WRITTEN is
 * the order: SQLite's rowid, which only ever grows. It is deliberately NOT `created_at`. The supplied
 * scenario runs a full policy year, so seeded events for months 9-11 carry dates in the future, and a claim
 * submitted today would sort before them by timestamp and replay against the wrong ledger. (Phase 2 ordered
 * by `created_at` first; the first real write in phase 4 is what exposed it.) `VACUUM` may renumber rowids
 * but preserves their relative order, which is all this needs; a real `seq` column would be a migration
 * against every existing database.
 */
async function loadLog(policyId: string): Promise<{ stored: StoredEvent[]; events: ReplayEvent[] }> {
  const stored = await db
    .select(getTableColumns(servicingEvent))
    .from(servicingEvent)
    .where(eq(servicingEvent.policyId, policyId))
    .orderBy(sql`rowid`);

  const events: ReplayEvent[] = stored.map((row, index) => ({
    id: row.id,
    seq: index + 1,
    kind: row.kind,
    policyMonth: row.policyMonth,
    benefitClass: row.benefitClass,
    providerTier: row.providerTier,
    geography: row.geography,
    amount: row.kind === "preauth" ? row.estimatedAmount : row.billedAmount,
    // The log records no per-event policy status, so replay treats every event as
    // submitted against an active policy. A lapse will need a column, not a guess.
    supersedesId: row.supersedesEventId,
    // An advisor's "not covered" on a case the plan could not decide: a person's word, worth zero (see ReplayEvent).
    handDenial: row.decidedBy === "advisor" && row.kind !== "appeal" && row.outcome === "denied" && row.supersedesEventId !== null,
  }));
  return { stored, events };
}

async function loadPolicy(policyId: string): Promise<{ terms: PlanTerms; inceptionDate: string }> {
  const [row] = await db
    .select({ plan, inceptionDate: policy.inceptionDate })
    .from(policy)
    .innerJoin(plan, eq(policy.planId, plan.id))
    .where(eq(policy.id, policyId))
    .limit(1);
  if (!row) throw new Error(`policy ${policyId} not found`);
  return { inceptionDate: row.inceptionDate, terms: planRowToTerms(row.plan) };
}

/** A `plan` row as the engine reads it. */
export function planRowToTerms(p: typeof plan.$inferSelect): PlanTerms {
  return {
    id: p.id,
    name: p.name,
    annualPremium: p.annualPremium,
    deductible: p.deductible,
    network: p.network,
    outpatientCopayPct: p.outpatientCopayPct,
    annualLimit: p.annualLimit,
    dentalOptical: p.dentalOptical,
    maternityCovered: p.maternityCovered,
    maternityWaitingPeriodMonths: p.maternityWaitingPeriodMonths,
    maternityLimit: p.maternityLimit,
    chronicCovered: p.chronicCovered,
    chronicWaitingPeriodMonths: p.chronicWaitingPeriodMonths,
  };
}

/** Replay a policy's whole history. Reads only; writes nothing. */
export async function replayPolicy(policyId: string): Promise<Replay & { terms: PlanTerms; inceptionDate: string; stored: StoredEvent[]; events: ReplayEvent[] }> {
  const [{ stored, events }, { terms, inceptionDate }] = await Promise.all([loadLog(policyId), loadPolicy(policyId)]);
  return { ...replay(terms, events), terms, inceptionDate, stored, events };
}

/**
 * Replay the log and write the projection. The only writer of `benefit_ledger`.
 * Call it after appending an event; never adjust the ledger row directly.
 */
export async function rebuildLedger(policyId: string): Promise<Replay> {
  const { events } = await loadLog(policyId);
  const { terms } = await loadPolicy(policyId);
  const result = replay(terms, events);

  // The last event that actually moved the ledger — a denial or a forecast did not.
  const moved = [...result.steps].reverse().find((s) => JSON.stringify(s.result.ledgerBefore) !== JSON.stringify(s.result.ledgerAfter));
  const values = {
    deductibleMet: result.ledger.deductibleMet,
    annualPaid: result.ledger.annualPaid,
    sublimitUsed: result.ledger.sublimitUsed,
    lastEventId: moved ? moved.event.id : null,
    rebuiltAt: new Date(),
  };
  await db
    .insert(benefitLedger)
    .values({ policyId, ...values })
    .onConflictDoUpdate({ target: benefitLedger.policyId, set: values });
  return result;
}

// ---------------------------------------------------------------------------
// The replay check
// ---------------------------------------------------------------------------

export type EventDrift = { ref: string; field: string; stored: unknown; replayed: unknown };

export type ReplayReport = {
  policyId: string;
  /** The stored ledger equals the replayed one, and no stored event disagrees with its replay unexplained. */
  ok: boolean;
  ledgerDiffs: string[];
  /** A stored event whose replay disagrees and nothing explains it: the log and the engine have drifted. */
  drifted: EventDrift[];
  /**
   * A stored event whose replay legitimately differs: an overturn was filed AFTER it but lands BEFORE it
   * (spec §2, rule 3), so it now sees a different ledger than the one it recorded. An explanation, not a bug.
   */
  restated: EventDrift[];
  /** When the stored ledger row was last rebuilt from the log. */
  ledgerRebuiltAt: Date | null;
};

const near = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 0.005);

export async function checkReplay(policyId: string): Promise<ReplayReport> {
  const { steps, ledger: replayed, stored } = await replayPolicy(policyId);
  const [ledgerRow] = await db.select().from(benefitLedger).where(eq(benefitLedger.policyId, policyId)).limit(1);

  const storedLedger: LedgerState | null = ledgerRow
    ? {
        deductibleMet: Number(ledgerRow.deductibleMet),
        annualPaid: Number(ledgerRow.annualPaid),
        sublimitUsed: ledgerRow.sublimitUsed ?? {},
      }
    : null;
  const ledgerDiffs = storedLedger ? compareLedgers(storedLedger, replayed) : compareLedgers(emptyLedger(), replayed).concat("no ledger row is stored for this policy");

  const byId = new Map(stored.map((row) => [row.id, row]));
  const position = effectPositions(
    stored.map((row, i) => ({
      id: row.id,
      seq: i + 1,
      kind: row.kind,
      policyMonth: row.policyMonth,
      benefitClass: row.benefitClass,
      providerTier: row.providerTier,
      amount: null,
      supersedesId: row.supersedesEventId,
    })),
  );

  const seqOf = new Map(stored.map((row, i) => [row.id, i + 1]));
  const overturns = stored.filter((row) => row.supersedesEventId);

  const drifted: EventDrift[] = [];
  const restated: EventDrift[] = [];
  for (const { event, result } of steps) {
    const row = byId.get(event.id)!;
    const ref = row.externalRef ?? row.id;
    // An overturn row's stored outcome is `overturned`; the engine's word for the same thing is `covered`.
    const expectedOutcome = row.outcome === "overturned" ? "covered" : row.outcome;
    const found: EventDrift[] = [];
    if (expectedOutcome !== result.outcome) found.push({ ref, field: "outcome", stored: row.outcome, replayed: result.outcome });
    if (row.reasonCode !== result.reasonCode) found.push({ ref, field: "reason_code", stored: row.reasonCode, replayed: result.reasonCode });
    if (!near(row.planPays === null ? null : Number(row.planPays), result.planPays)) found.push({ ref, field: "plan_pays", stored: row.planPays, replayed: result.planPays });
    if (!near(row.memberPays === null ? null : Number(row.memberPays), result.memberPays)) found.push({ ref, field: "member_pays", stored: row.memberPays, replayed: result.memberPays });
    if (found.length === 0) continue;

    const explained = overturns.some((o) => (seqOf.get(o.id) ?? 0) > (seqOf.get(row.id) ?? 0) && (position.get(o.id) ?? Infinity) < (position.get(row.id) ?? -Infinity));
    (explained ? restated : drifted).push(...found);
  }

  return {
    policyId,
    ok: ledgerDiffs.length === 0 && drifted.length === 0,
    ledgerDiffs,
    drifted,
    restated,
    ledgerRebuiltAt: ledgerRow?.rebuiltAt ?? null,
  };
}

/** Throws with the field-level diff when a policy's ledger or history has drifted. */
export async function assertReplayable(policyId: string): Promise<void> {
  const report = await checkReplay(policyId);
  if (report.ok) return;
  const lines = [...report.ledgerDiffs, ...report.drifted.map((d) => `${d.ref} ${d.field}: stored ${d.stored}, replayed ${d.replayed}`)];
  throw new Error(`policy ${policyId} is not replayable:\n  ${lines.join("\n  ")}`);
}
