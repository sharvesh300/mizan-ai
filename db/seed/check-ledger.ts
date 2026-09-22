// The database half of the servicing checks.
//
//   bun run db/seed/check-ledger.ts
//
// Seeds a THROWAWAY database (never db/sqlite.db), then proves the property the
// brief's definition of done names: "delete it, replay the events, get the same
// numbers back" — and that a ledger or an event that has drifted from its
// history is DETECTED rather than trusted.
//
// The pure engine is checked by check-servicing.ts. This checks that what the
// engine wrote to SQLite, and what `lib/servicing/store.ts` reads back, agree
// with the acceptance table and with each other.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { EXPECTED, EXPECTED_LEDGER } from "./acceptance";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${!ok && detail ? `\n         ${detail}` : ""}`);
};

const dir = mkdtempSync(path.join(tmpdir(), "mizan-ledger-"));
// Must be set before anything imports db/client, which reads it once at load.
process.env.DATABASE_URL = path.join(dir, "check.db");

const seed = () => spawnSync(process.execPath, ["run", "db/seed/run.ts"], { env: process.env, encoding: "utf8" });

try {
  const first = seed();
  if (first.status !== 0) {
    console.error(first.stdout, first.stderr);
    process.exit(1);
  }

  const { db } = await import("@/db/client");
  const schema = await import("@/db/schema");
  const store = await import("@/lib/servicing/store");
  const { servicingEvent, benefitLedger, policy } = schema;

  const policies = await db.select().from(policy);
  const policyId = (ref: string) => policies.find((p) => p.externalRef === ref)!.id;
  const allEvents = () => db.select().from(servicingEvent);

  console.log("\nSeeded rows");
  {
    const rows = new Map((await allEvents()).map((r) => [r.externalRef!, r]));
    const wrong = Object.entries(EXPECTED).filter(([ref, want]) => {
      const r = rows.get(ref);
      if (!r) return true;
      const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
      return r.outcome !== want.outcome || n(r.planPays) !== want.planPays || n(r.memberPays) !== want.memberPays || r.reasonCode !== want.reasonCode;
    });
    check("13 events are in the database, each matching the acceptance table (read back from SQLite)", rows.size === 13 && wrong.length === 0, wrong.map(([r]) => r).join(", "));

    const ledgers = await db.select().from(benefitLedger);
    const badLedger = Object.entries(EXPECTED_LEDGER).filter(([profile, want]) => {
      const l = ledgers.find((x) => x.policyId === policyId(`POL-${profile}`));
      return !l || Number(l.deductibleMet) !== want.deductibleMet || Number(l.annualPaid) !== want.annualPaid || (l.sublimitUsed?.maternity ?? 0) !== (want.sublimitUsed.maternity ?? 0);
    });
    check("each stored ledger equals the acceptance table's final ledger", badLedger.length === 0, badLedger.map(([p]) => p).join(", "));

    const reports = await Promise.all(policies.map((p) => store.checkReplay(p.id)));
    check("every policy is replayable: the stored ledger equals a replay of its history", reports.every((r) => r.ok), JSON.stringify(reports.filter((r) => !r.ok)));
    check("nothing is flagged as restated in the seeded data (no overturn lands before a later event)", reports.every((r) => r.restated.length === 0));

    const p4 = await store.replayPolicy(policyId("POL-P4"));
    check("P4's replay has APP-2 in effect and CLM-4 superseded out of the fold", p4.steps.some((s) => s.event.id === rows.get("APP-2")!.id) && !p4.steps.some((s) => s.event.id === rows.get("CLM-4")!.id));
    const l4 = ledgers.find((l) => l.policyId === policyId("POL-P4"))!;
    check("the ledger row records the last event that moved it (APP-2 for P4, CLM-8 for P3)", l4.lastEventId === rows.get("APP-2")!.id && ledgers.find((l) => l.policyId === policyId("POL-P3"))!.lastEventId === rows.get("CLM-8")!.id);
  }

  console.log("\nA reseed is the same reseed");
  {
    const before = JSON.stringify((await allEvents()).sort((a, b) => a.id.localeCompare(b.id)));
    const again = seed();
    check("re-running the seed succeeds over an existing database (teardown gets past the append-only guards)", again.status === 0, again.stderr);
    const after = JSON.stringify((await allEvents()).sort((a, b) => a.id.localeCompare(b.id)));
    check("and produces byte-identical event rows — ids, dates, prose, trace", before === after);
  }

  console.log("\nThe log is append-only");
  {
    const anyEvent = (await allEvents())[0];
    const attempt = (fn: () => unknown) => {
      try {
        fn();
        return false;
      } catch (error) {
        // Drizzle wraps the driver's error; the trigger's own message lives on `cause`.
        return /append-only/.test(`${error} ${(error as { cause?: unknown }).cause}`);
      }
    };
    check("UPDATE on servicing_event is refused by the trigger", attempt(() => db.run(sql`update servicing_event set plan_pays = 1 where id = ${anyEvent.id}`)));
    check("DELETE on servicing_event is refused by the trigger", attempt(() => db.run(sql`delete from servicing_event where id = ${anyEvent.id}`)));
  }

  console.log("\nDelete the ledger, replay the events");
  {
    const p1 = policyId("POL-P1");
    await db.update(benefitLedger).set({ deductibleMet: 1501 }).where(eq(benefitLedger.policyId, p1));
    const drift = await store.checkReplay(p1);
    check("a ledger nudged by one dirham is detected, and the diff names the field", !drift.ok && drift.ledgerDiffs.some((d) => d.includes("deductible_met: stored 1501, replayed 1500")), JSON.stringify(drift.ledgerDiffs));
    let threw = false;
    try {
      await store.assertReplayable(p1);
    } catch (error) {
      threw = /deductible_met/.test(String(error));
    }
    check("assertReplayable throws with that diff", threw);

    await db.delete(benefitLedger);
    check("with every ledger deleted, the check says so rather than passing", (await store.checkReplay(p1)).ledgerDiffs.some((d) => d.includes("no ledger row")));
    for (const p of policies) await store.rebuildLedger(p.id);
    const ledgers = await db.select().from(benefitLedger);
    const back = Object.entries(EXPECTED_LEDGER).every(([profile, want]) => {
      const l = ledgers.find((x) => x.policyId === policyId(`POL-${profile}`));
      return !!l && Number(l.deductibleMet) === want.deductibleMet && Number(l.annualPaid) === want.annualPaid && (l.sublimitUsed?.maternity ?? 0) === (want.sublimitUsed.maternity ?? 0);
    });
    check("delete every ledger, replay the events: the same numbers come back", back);
    check("and every policy is replayable again", (await Promise.all(policies.map((p) => store.checkReplay(p.id)))).every((r) => r.ok));
  }

  console.log("\nRestated is not drifted");
  {
    // How a restatement really arises: a denial D is filed, a later claim E is filed, and THEN D is overturned.
    // The overturn writes at D's position (spec §2, rule 3), which is before E — so E was adjudicated against a
    // ledger the overturn has since changed. Order is write order, so the rows are inserted D, E, O.
    // Sized so the overturn's consumption clips E against the annual limit: D 200,000 pays 140,000; E then
    // has only 7,550 of headroom left instead of the 42,000 it was adjudicated for.
    const p1 = policyId("POL-P1");
    const base = { policyId: p1, geography: "uae" as const, benefitClass: "general" as const, setting: "outpatient" as const, decidedBy: "system" as const };
    const dId = crypto.randomUUID();
    await db.insert(servicingEvent).values({ ...base, id: dId, externalRef: "CLM-X3", kind: "claim", policyMonth: 9, providerTier: "top_tier_private_hospital", billedAmount: 200000, outcome: "denied", reasonCode: "provider_out_of_network", planPays: 0, memberPays: 200000 });
    await db.insert(servicingEvent).values({ ...base, externalRef: "CLM-X4", kind: "claim", policyMonth: 9, providerTier: "in_network_clinic", billedAmount: 60000, outcome: "covered", reasonCode: "covered", planPays: 42000, memberPays: 18000 });
    await db.insert(servicingEvent).values({ ...base, externalRef: "APP-X3", kind: "appeal", policyMonth: 9, providerTier: "in_network_clinic", billedAmount: 200000, outcome: "overturned", reasonCode: "covered", planPays: 140000, memberPays: 60000, supersedesEventId: dId, appealOfEventId: dId, decidedBy: "advisor" });
    await store.rebuildLedger(p1);
    const report = await store.checkReplay(p1);
    check("the earlier-filed claim now replays differently, and is reported as restated — not as drift", report.restated.some((d) => d.ref === "CLM-X4" && d.field === "plan_pays" && Number(d.replayed) === 7550) && report.drifted.length === 0, JSON.stringify(report));
    check("a restatement does not fail the check", report.ok);
    const replayed = await store.replayPolicy(p1);
    check("submission order is write order: the overturn sits at the denial's position and the later claim after it", replayed.steps.map((s) => s.event.id).indexOf(replayed.stored.find((r) => r.externalRef === "APP-X3")!.id) < replayed.steps.map((s) => s.event.id).indexOf(replayed.stored.find((r) => r.externalRef === "CLM-X4")!.id));
  }

  console.log("\nSubmission order is write order, not created_at");
  {
    // The seed dates months 9-11 in the FUTURE. A row written now carries an EARLIER created_at than those,
    // and must still be replayed after them. Ordering by timestamp put it first.
    const p2 = policyId("POL-P2");
    await db.insert(servicingEvent).values({ externalRef: "CLM-X5", policyId: p2, kind: "claim", policyMonth: 11, benefitClass: "general", setting: "outpatient", providerTier: "in_network_clinic", geography: "uae", billedAmount: 1000, outcome: "covered", reasonCode: "covered", planPays: 900, memberPays: 100, decidedBy: "system", createdAt: new Date("2026-01-01T00:00:00Z") });
    const { stored } = await store.replayPolicy(p2);
    const refs = stored.map((r) => r.externalRef);
    check("a row with an early created_at, written last, is last in the replay order", refs[refs.length - 1] === "CLM-X5", refs.join(","));
  }

  console.log("\nA stored event that disagrees with the engine is drift");
  {
    const p5 = policyId("POL-P5");
    await db.insert(servicingEvent).values({
      externalRef: "CLM-X1",
      policyId: p5,
      kind: "claim",
      policyMonth: 9,
      benefitClass: "general",
      setting: "outpatient",
      providerTier: "in_network_clinic",
      geography: "uae",
      billedAmount: 1000,
      outcome: "covered",
      reasonCode: "covered",
      planPays: 999, // the engine says 900 (Comprehensive: 10% co-pay)
      memberPays: 1,
      decidedBy: "system",
    });
    await store.rebuildLedger(p5);
    const report = await store.checkReplay(p5);
    check("a row whose stored amounts the engine does not reproduce fails the check, naming the event and the field", !report.ok && report.drifted.some((d) => d.ref === "CLM-X1" && d.field === "plan_pays" && Number(d.replayed) === 900), JSON.stringify(report.drifted));
    check("and the ledger itself is still right — the drift is in the log, not the projection", report.ledgerDiffs.length === 0);
  }

  console.log("\nThe seeded queue");
  {
    const tasks = await db.select().from(schema.reviewTask).where(and(eq(schema.reviewTask.subjectType, "servicing_event")));
    check("CLM-9 is an open task at the top of the priority range; APP-1's quality check is open at 40; APP-2's signature is resolved", tasks.length === 3 && tasks.filter((t) => t.status === "open" && t.priorityScore === 100).length === 1 && tasks.filter((t) => t.status === "resolved").length === 1 && tasks.filter((t) => t.status === "open" && t.priorityScore === 40).length === 1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
