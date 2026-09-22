// Run the thirteen supplied servicing events through the engine and compare
// the result to the acceptance table in docs/servicing_agent_plan.md §14.
//
//   bun run db/seed/check-servicing.ts
//
// Outputs are compared on the four fields the brief grades — outcome,
// plan_pays, member_pays, reason_code — plus each policy's final ledger. Reads
// the supplied JSON directly: no database, no model, no server. Exits 1 on any
// mismatch, so it can gate a change.
//
// Beyond the table it asserts the properties the design rests on: that the
// ledger is actually wired in (order changes the answer), that an overturn
// lands at the ORIGINAL event's position, that a pre-authorization never moves
// the ledger, that `insufficient_data` is reachable only for the one undefined
// case, and — over a few thousand generated histories — that the arithmetic
// invariants hold.
import hackathon from "@/docs/hackathon_data.json";
import fixtures from "@/db/seed/fixtures.json";
import type { PlanTerms } from "@/lib/assessment";
import {
  NETWORK_ADMITS,
  addMonths,
  adjudicate,
  compareLedgers,
  effectOrder,
  emptyLedger,
  longDate,
  nextStepFacts,
  policyYearEndsOn,
  readLimits,
  replay,
  type AdjudicationResult,
  type LedgerState,
  type ReplayEvent,
} from "@/lib/servicing";
import { INTERNAL_REF, MEMBER_BANNED, TIME_PROMISES } from "@/lib/servicing/copy-rules";
import { EXPECTED, EXPECTED_LEDGER, EXPECTED_TRACE, type Expected } from "./acceptance";
import { buildServicingSeed, logForProfile as logFor, profilesInOrder } from "./servicing";
import { benefitClassEnum, claimProviderTierEnum, reasonCodeEnum, type BenefitClass, type ClaimProviderTier } from "@/db/schema/enums";

/* eslint-disable @typescript-eslint/no-explicit-any */
const data = hackathon as any;
const fx = fixtures as any;

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${!ok && detail ? `\n         ${detail}` : ""}`);
};
const cents = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// The supplied plans, in the shape the engine reads
// ---------------------------------------------------------------------------

const toPlan = (p: any): PlanTerms => ({
  id: p.id,
  name: p.name,
  annualPremium: p.annual_premium,
  deductible: p.deductible,
  network: p.network,
  outpatientCopayPct: p.outpatient_copay_pct,
  annualLimit: p.annual_limit,
  dentalOptical: p.dental_optical,
  maternityCovered: p.maternity.covered,
  maternityWaitingPeriodMonths: p.maternity.waiting_period_months ?? null,
  maternityLimit: p.maternity.limit ?? null,
  chronicCovered: p.chronic_preexisting.covered,
  chronicWaitingPeriodMonths: p.chronic_preexisting.waiting_period_months ?? null,
});
const plans = new Map<string, PlanTerms>(data.plans.map((p: any) => [p.id, toPlan(p)]));

console.log("\nCatalogue");
check(
  "the seeded plan table matches the supplied plans, field for field",
  data.plans.every((p: any) => {
    const seeded = fx.plan.find((row: any) => row.id === p.id);
    if (!seeded) return false;
    const a = toPlan(p);
    return (
      a.deductible === seeded.deductible &&
      a.network === seeded.network &&
      a.outpatientCopayPct === seeded.outpatient_copay_pct &&
      a.annualLimit === seeded.annual_limit &&
      a.maternityCovered === !!seeded.maternity_covered &&
      a.maternityWaitingPeriodMonths === seeded.maternity_waiting_period_months &&
      a.maternityLimit === seeded.maternity_limit &&
      a.chronicCovered === !!seeded.chronic_covered &&
      a.chronicWaitingPeriodMonths === seeded.chronic_waiting_period_months
    );
  }),
);
const sameTiers = (a: readonly string[], b: readonly string[]) => [...a].sort().join() === [...b].sort().join();
check(
  "NETWORK_ADMITS matches the supplied provider_tiers",
  (["restricted", "standard", "wide"] as const).every((n) => sameTiers(NETWORK_ADMITS[n], data.provider_tiers[n])),
);
check(
  "NETWORK_ADMITS matches the seeded network_admits table",
  (["restricted", "standard", "wide"] as const).every((n) =>
    sameTiers(NETWORK_ADMITS[n], fx.network_admits.filter((r: any) => r.network === n).map((r: any) => r.provider_tier)),
  ),
);

// ---------------------------------------------------------------------------
// The thirteen events, as a live system would meet them
// ---------------------------------------------------------------------------

const events: any[] = data.servicing_events;
const byId = new Map<string, any>(events.map((e) => [e.id, e]));
const profiles = profilesInOrder();

const fmtNum = (n: number | null) => (n === null ? "—" : n.toLocaleString("en"));
const ledgerLine = (l: LedgerState) => `ded ${l.deductibleMet} · annual ${l.annualPaid}${l.sublimitUsed.maternity ? ` · maternity ${l.sublimitUsed.maternity}` : ""}`;

console.log("\nThe thirteen supplied events, in order");
console.log("  event   outcome              plan_pays  member_pays  reason_code                  ledger after");

for (const profile of profiles) {
  const log = logFor(profile);
  const planId = events.find((e) => e.profile_id === profile).plan_id;
  const plan = plans.get(planId)!;

  for (let i = 0; i < log.length; i++) {
    // Meet each event the way the live system will: replay the history so far,
    // including this event, and read this event's step.
    const { steps } = replay(plan, log.slice(0, i + 1));
    const event = log[i];
    const step = steps.find((s) => s.event.id === event.id);

    let got: Expected;
    if (step) {
      const r = step.result;
      got = {
        outcome: event.kind === "appeal" ? "overturned" : r.outcome,
        planPays: r.planPays,
        memberPays: r.memberPays,
        reasonCode: r.reasonCode,
      };
    } else {
      // An upheld appeal takes no part in the fold: its result is the denial it left standing.
      const contested = byId.get(byId.get(event.id).contests);
      const original = replay(plan, log.slice(0, log.findIndex((l) => l.id === contested.id) + 1)).steps.find((s) => s.event.id === contested.id)!;
      got = { outcome: "upheld", planPays: original.result.planPays, memberPays: original.result.memberPays, reasonCode: original.result.reasonCode };
    }

    const want = EXPECTED[event.id];
    const ok = JSON.stringify(got) === JSON.stringify(want);
    const after = step ? ledgerLine(step.result.ledgerAfter) : "unchanged";
    console.log(
      `  ${event.id.padEnd(7)} ${got.outcome.padEnd(20)} ${fmtNum(got.planPays).padStart(9)}  ${fmtNum(got.memberPays).padStart(11)}  ${got.reasonCode.padEnd(27)}  ${after}`,
    );
    check(`${event.id}: outcome, plan_pays, member_pays, reason_code`, ok, ok ? "" : `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }

  const finalLedger = replay(plan, log).ledger;
  const diffs = compareLedgers(EXPECTED_LEDGER[profile], finalLedger);
  check(`${profile}: final ledger — ${ledgerLine(EXPECTED_LEDGER[profile])}`, diffs.length === 0, diffs.join("; "));
}

// ---------------------------------------------------------------------------
// The ledger is wired in, and replay is a projection
// ---------------------------------------------------------------------------

console.log("\nThe ledger is wired in");
{
  const p1 = plans.get("plan_a")!;
  const log = logFor("P1");
  // The wrong answer the spec warns about: 1,590. Reached by re-applying the
  // deductible, i.e. by adjudicating CLM-6 against a ledger that has not seen CLM-1.
  const backwards = replay(p1, [
    { ...log[1], seq: 1 },
    { ...log[0], seq: 2 },
  ]);
  const clm6 = backwards.steps.find((s) => s.event.id === "CLM-6")!.result;
  check("CLM-6 with an empty ledger pays 210 / 1,590 — so the answer depends on CLM-1 having been seen", clm6.planPays === 210 && clm6.memberPays === 1590);

  const p2 = plans.get("plan_c")!;
  const l2 = logFor("P2");
  const flipped = replay(p2, [
    { ...l2[2], seq: 1 }, // CLM-7 before CLM-2
    { ...l2[1], seq: 2 },
  ]);
  check("P2: postnatal follow-up is covered when it comes before the delivery — CLM-7's denial exists only because CLM-2 ran first", flipped.steps.find((s) => s.event.id === "CLM-7")!.result.outcome === "covered");
}

console.log("\nReplay");
{
  const p4 = plans.get("plan_b")!;
  const log = logFor("P4");
  const a = replay(p4, log);
  const shuffled = replay(p4, [log[2], log[0], log[1]]);
  check("replay does not depend on the order the rows are handed over, only on seq", JSON.stringify(a) === JSON.stringify(shuffled));

  check("CLM-4 is superseded by APP-2: the denial drops out of the fold, the overturn stands", !a.steps.some((s) => s.event.id === "CLM-4") && a.steps.some((s) => s.event.id === "APP-2"));

  const without = replay(p4, log.filter((e) => e.id !== "APP-2"));
  check("without APP-2 the ledger is untouched — the denial consumed nothing", compareLedgers(emptyLedger(), without.ledger).length === 0);

  // Rule 3 of the spec: the overturn writes at the original event's position,
  // not at the appeal date. File the appeal AFTER the month-9 pre-authorization
  // and the ledger — and where the overturn sits in the order — must not move.
  const lateAppeal: ReplayEvent[] = [
    log[0], // CLM-4, seq 1
    { ...log[2], seq: 2 }, // PRE-2 filed first
    { ...log[1], seq: 3 }, // APP-2 filed last
  ];
  const late = replay(p4, lateAppeal);
  check("an overturn filed after a later event still lands at the denial's position", effectOrder(lateAppeal).map((e) => e.id).join() === "APP-2,PRE-2");
  check("...and the ledger is the same whenever the appeal was filed", compareLedgers(a.ledger, late.ledger).length === 0);
  check(
    "PRE-2 forecasts against a deductible the overturn already met (22,400 / 5,600, not 22,000 / 6,000)",
    late.steps.find((s) => s.event.id === "PRE-2")!.result.planPays === 22400,
  );

  const p2 = plans.get("plan_c")!;
  const l2 = logFor("P2");
  const noPre = replay(p2, l2.filter((e) => e.kind !== "preauth"));
  check("a pre-authorization reads the ledger and writes nothing (P2)", compareLedgers(replay(p2, l2).ledger, noPre.ledger).length === 0);
  const noPre4 = replay(p4, log.filter((e) => e.kind !== "preauth"));
  check("a pre-authorization reads the ledger and writes nothing (P4)", compareLedgers(a.ledger, noPre4.ledger).length === 0);

  let threw = false;
  try {
    effectOrder([{ ...log[1], supersedesId: "NOPE" }]);
  } catch {
    threw = true;
  }
  check("an event superseding something not in the log is an error, not a silent no-op", threw);
  threw = false;
  try {
    effectOrder([
      { ...log[0], id: "X", supersedesId: "Y" },
      { ...log[0], id: "Y", seq: 2, supersedesId: "X" },
    ]);
  } catch {
    threw = true;
  }
  check("a supersession cycle is an error", threw);
}

// ---------------------------------------------------------------------------
// Boundaries the supplied events do not reach
// ---------------------------------------------------------------------------

console.log("\nBoundaries");
{
  const p3 = plans.get("plan_b")!;
  const base = {
    plan: p3,
    ledger: emptyLedger(),
    policyStatus: "active" as const,
    policyMonth: 6,
    benefitClass: "chronic_preexisting" as const,
    providerTier: "in_network_clinic" as const,
    geography: "uae" as const,
    amount: 1000,
    dryRun: false,
  };
  check("a 6-month wait clears at month 6, not 7", adjudicate(base).reasonCode === "covered" && adjudicate({ ...base, policyMonth: 5 }).reasonCode === "waiting_period_not_elapsed");
  check("a lapsed policy is denied policy_not_active", adjudicate({ ...base, policyStatus: "lapsed" }).reasonCode === "policy_not_active");
  check("maternity on Essential is benefit_excluded", adjudicate({ ...base, plan: plans.get("plan_a")!, benefitClass: "maternity" }).reasonCode === "benefit_excluded");
  const exhausted = adjudicate({ ...base, ledger: { ...emptyLedger(), annualPaid: 500000 } });
  check("annual limit fully used is annual_limit_reached", exhausted.reasonCode === "annual_limit_reached");
  const nearAnnual = adjudicate({ ...base, ledger: { deductibleMet: 500, annualPaid: 499900, sublimitUsed: {} } });
  check("a payment that would cross the annual limit is clipped to what remains", nearAnnual.planPays === 100 && nearAnnual.clippedBy === "annual_limit");
  const claimCapped = adjudicate({ ...base, plan: plans.get("plan_c")!, benefitClass: "maternity", policyMonth: 9, providerTier: "private_hospital", amount: 40000 });
  const preCapped = adjudicate({ ...base, plan: plans.get("plan_c")!, benefitClass: "maternity", policyMonth: 9, providerTier: "private_hospital", amount: 40000, dryRun: true });
  check("the same cap is `covered` on a claim and `approved_with_limit` on a pre-auth", claimCapped.outcome === "covered" && preCapped.outcome === "approved_with_limit");
  check("a pre-authorization leaves the ledger exactly as it found it", compareLedgers(preCapped.ledgerBefore, preCapped.ledgerAfter).length === 0);

  const cents1 = adjudicate({ ...base, plan: plans.get("plan_a")!, benefitClass: "general", amount: 1234.56 });
  check("fractional amounts stay to the cent and plan + member = billed", cents(cents1.planPays! + cents1.memberPays!) === 1234.56);

  const bad = (f: () => unknown) => {
    try {
      f();
      return false;
    } catch {
      return true;
    }
  };
  check("a zero, negative or non-numeric amount is rejected", bad(() => adjudicate({ ...base, amount: 0 })) && bad(() => adjudicate({ ...base, amount: -5 })) && bad(() => adjudicate({ ...base, amount: NaN })));
  check("a negative or fractional policy month is rejected", bad(() => adjudicate({ ...base, policyMonth: -1 })) && bad(() => adjudicate({ ...base, policyMonth: 1.5 })));
}

// ---------------------------------------------------------------------------
// Phase 2: the seed, the dates, the next steps, and both registers
// ---------------------------------------------------------------------------

console.log("\nPolicy-month dates");
{
  check("month 6 of a policy incepting 1 Jan 2026 is 1 July 2026", addMonths("2026-01-01", 6) === "2026-07-01");
  check("a month past the year end rolls the year (month 13)", addMonths("2026-01-01", 13) === "2027-02-01");
  check("the day clamps to the month's end: 31 Jan + 1 month = 28 Feb", addMonths("2026-01-31", 1) === "2026-02-28");
  check("...and to 29 Feb in a leap year", addMonths("2028-01-31", 1) === "2028-02-29");
  check("the policy year containing month 11 ends 1 Jan 2027; month 12 begins a year that ends 1 Jan 2028", policyYearEndsOn("2026-01-01", 11) === "2027-01-01" && policyYearEndsOn("2026-01-01", 12) === "2028-01-01");
  check("a date reads as a member would say it", longDate("2026-07-01") === "1 July 2026");
  let threw = false;
  try {
    addMonths("July 1st", 1);
  } catch {
    threw = true;
  }
  check("a malformed date is an error, not NaN-01-01", threw);
}

console.log("\nThe seed, built through the engine");
{
  const seed = buildServicingSeed(fx);
  const rows = new Map(seed.events.map((r) => [r.externalRef!, r]));
  check("all thirteen supplied events are seeded", seed.events.length === 13 && Object.keys(EXPECTED).every((ref) => rows.has(ref)));

  const wrong = Object.entries(EXPECTED).filter(([ref, want]) => {
    const r = rows.get(ref)!;
    const planPays = r.planPays === null || r.planPays === undefined ? null : Number(r.planPays);
    const memberPays = r.memberPays === null || r.memberPays === undefined ? null : Number(r.memberPays);
    return r.outcome !== want.outcome || planPays !== want.planPays || memberPays !== want.memberPays || r.reasonCode !== want.reasonCode;
  });
  check("every seeded row carries the acceptance-table outcome, amounts and reason code", wrong.length === 0, wrong.map(([ref]) => ref).join(", "));

  for (const ref of ["CLM-1", "CLM-6"]) {
    check(`${ref}: regenerated calculation trace is identical to the hand-typed original`, JSON.stringify(rows.get(ref)!.calculation) === JSON.stringify(EXPECTED_TRACE[ref]));
  }
  check(
    "the reassessment fixture still points at CLM-6's id (the seed kept the ids that other rows reference)",
    fx.plan_fit_reassessment.every((r: any) => r.triggered_by_event_id === rows.get("CLM-6")!.id),
  );

  const ids = new Set(seed.events.map((r) => r.id));
  check(
    "every supersedes / appeal-of points at an event that exists",
    seed.events.every((r) => (!r.supersedesEventId || ids.has(r.supersedesEventId)) && (!r.appealOfEventId || ids.has(r.appealOfEventId))),
  );
  check(
    "the table's own CHECK holds: a pre-auth has an estimate, a claim or reimbursement has a billed amount",
    seed.events.every((r) => (r.kind === "preauth" ? r.estimatedAmount != null : r.kind === "appeal" || r.billedAmount != null)),
  );
  check(
    "confidence is null exactly where the system returned no answer, and otherwise within 0..1",
    seed.events.every((r) => (r.outcome === "insufficient_data") === (r.confidence == null) && (r.confidence == null || (r.confidence >= 0 && r.confidence <= 1))),
  );
  const upheld = rows.get("APP-1")!;
  check("an upheld appeal writes a row and moves nothing", JSON.stringify(upheld.ledgerBefore) === JSON.stringify(upheld.ledgerAfter) && !upheld.supersedesEventId);
  const overturn = rows.get("APP-2")!;
  check("an overturn supersedes the denial it reverses, and an advisor signed it", overturn.supersedesEventId === rows.get("CLM-4")!.id && overturn.decidedBy === "advisor");
  check("every other event was decided by the system", seed.events.filter((r) => r.decidedBy === "advisor").length === 1);
  const open = seed.tasks.filter((t) => t.status === "open");
  check(
    "two tasks are open — CLM-9, the undecidable one, and a QUALITY CHECK on APP-1 (a close call that resolved: banded 40, so it blocks nothing) — and one is resolved: APP-2's signature",
    open.length === 2 &&
      open.some((t) => t.subjectId === rows.get("CLM-9")!.id && t.priorityScore === 100) &&
      open.some((t) => t.subjectId === upheld.id && t.priorityScore === 40 && /^Quality check: APP-1/.test(t.reason)) &&
      seed.tasks.find((t) => t.status === "resolved")!.subjectId === overturn.id &&
      seed.decisions.length === 1,
  );
  check("ids and dates are deterministic: building twice gives the same rows", JSON.stringify(buildServicingSeed(fx).events) === JSON.stringify(seed.events));
}

console.log("\nNext steps are computed, not written");
{
  const planB = plans.get("plan_b")!;
  const base = {
    plan: planB,
    kind: "claim" as const,
    benefitClass: "chronic_preexisting" as const,
    providerTier: "in_network_clinic" as const,
    policyMonth: 4,
    inceptionDate: "2026-01-01",
  };
  const cl3 = adjudicate({ plan: planB, ledger: emptyLedger(), policyStatus: "active", policyMonth: 4, benefitClass: "chronic_preexisting", providerTier: "in_network_clinic", geography: "uae", amount: 2800, dryRun: false });
  const f3 = nextStepFacts({ ...base, result: cl3 });
  check("CLM-3: the wait ends 1 July 2026 and the finding can be appealed", f3.waitingPeriod?.clearsOn === "2026-07-01" && f3.waitingPeriod.months === 6 && f3.appealable);

  const planC = plans.get("plan_c")!;
  const cl7 = adjudicate({ plan: planC, ledger: { deductibleMet: 0, annualPaid: 25000, sublimitUsed: { maternity: 25000, dental_optical: 0 } }, policyStatus: "active", policyMonth: 11, benefitClass: "maternity", providerTier: "in_network_clinic", geography: "uae", amount: 3000, dryRun: false });
  const f7 = nextStepFacts({ ...base, plan: planC, benefitClass: "maternity", policyMonth: 11, result: cl7 });
  check("CLM-7: the maternity limit resets 1 January 2027, with 25,000 of 25,000 used", f7.limit?.resetsOn === "2027-01-01" && f7.limit.used === 25000 && f7.limit.cap === 25000);

  const cl9 = adjudicate({ plan: planC, ledger: emptyLedger(), policyStatus: "active", policyMonth: 6, benefitClass: "chronic_preexisting", providerTier: "unknown_foreign", geography: "abroad", amount: 4500, dryRun: false });
  check("CLM-9 is not appealable — it is already with a person", !nextStepFacts({ ...base, plan: planC, providerTier: "unknown_foreign", policyMonth: 6, result: cl9 }).appealable);
  check("a pre-authorization is never appealable — it is a forecast", !nextStepFacts({ ...base, kind: "preauth", result: cl3 }).appealable);
  const paid = adjudicate({ plan: planB, ledger: emptyLedger(), policyStatus: "active", policyMonth: 8, benefitClass: "general", providerTier: "in_network_clinic", geography: "uae", amount: 2000, dryRun: false });
  check("a covered claim has nothing to appeal, and the claim that finishes the deductible says so", !nextStepFacts({ ...base, benefitClass: "general", result: paid }).appealable && nextStepFacts({ ...base, benefitClass: "general", result: paid }).deductibleNowMet);
}

console.log("\nBoth registers, all thirteen events");
{
  const seed = buildServicingSeed(fx);
  // The rules live in lib/servicing/copy-rules.ts so the propose_outcome tool enforces the same ones at runtime.
  const BANNED = MEMBER_BANNED;
  const PROMISES = TIME_PROMISES;
  const REFS = INTERNAL_REF;

  const hits = (text: string, patterns: RegExp[]) => patterns.filter((p) => p.test(text)).map(String);
  const banned = seed.events.flatMap((r) => hits(r.memberExplanation ?? "", BANNED).map((h) => `${r.externalRef}: ${h}`));
  check("no member-facing string carries classification vocabulary or a raw reason code", banned.length === 0, banned.join("; "));
  const promised = seed.events.flatMap((r) => hits(r.memberExplanation ?? "", PROMISES).map((h) => `${r.externalRef}: ${h}`));
  check("no member-facing string promises a time", promised.length === 0, promised.join("; "));
  check("a member is never shown an internal reference (POL-, CLM-, APP-, PRE-)", seed.events.every((r) => !REFS.test(r.memberExplanation ?? "")));

  // The calculation trace is member-facing too — spec §4b lists it as visible to the customer. A first
  // version of this scan covered only the explanation, and CLM-9's trace reached a member's screen reading
  // "provider tier unknown_foreign … routed to a reviewer". Every string a member can read is scanned.
  const traceOf = (r: (typeof seed.events)[number]): string[] => (Array.isArray(r.calculation) ? (r.calculation as string[]) : []);
  const traceLeaks = seed.events.flatMap((r) => traceOf(r).flatMap((line) => [...hits(line, BANNED), ...hits(line, PROMISES), ...(REFS.test(line) ? ["internal reference"] : [])].map((h) => `${r.externalRef}: ${h} in "${line}"`)));
  check("no calculation trace line — which a member reads — carries an enum token, an internal reference, workflow vocabulary or a time promise", traceLeaks.length === 0, traceLeaks.join("; "));

  const same = seed.events.filter((r) => r.memberExplanation === r.brokerExplanation).map((r) => r.externalRef);
  check("every event has two different explanations, not one shown twice", same.length === 0, same.join(", "));
  const noRef = seed.events.filter((r) => !REFS.test(r.brokerExplanation ?? "") && !["CLM-1", "CLM-6"].includes(r.externalRef!)).map((r) => r.externalRef);
  check("each broker explanation names its policy or event — something the member's text must not", noRef.length === 0, noRef.join(", "));
  const generic = seed.events.filter((r) => (r.memberExplanation ?? "").length < 60 || (r.brokerExplanation ?? "").length < 60).map((r) => r.externalRef);
  check("no explanation is a stub", generic.length === 0, generic.join(", "));

  const denialsWithoutNextStep = seed.events
    .filter((r) => r.outcome === "denied" && ["waiting_period_not_elapsed", "sublimit_exhausted", "annual_limit_reached"].includes(r.reasonCode ?? ""))
    .filter((r) => !/\d{4}/.test(r.memberExplanation ?? ""))
    .map((r) => r.externalRef);
  check("every denial that ends on a date names the date", denialsWithoutNextStep.length === 0, denialsWithoutNextStep.join(", "));
  const appealable = seed.events.filter((r) => r.outcome === "denied").map((r) => r.externalRef!);
  check(
    "every appealable denial tells the member they can appeal (CLM-3, CLM-4, CLM-7)",
    ["CLM-3", "CLM-4", "CLM-7"].every((ref) => /appeal/i.test(seed.events.find((r) => r.externalRef === ref)!.memberExplanation ?? "")) && appealable.length === 3,
  );
  check(
    "the pre-authorizations say they are estimates and that nothing was claimed",
    ["PRE-1", "PRE-2"].every((ref) => /estimate/i.test(seed.events.find((r) => r.externalRef === ref)!.memberExplanation ?? "") && /nothing has been claimed/i.test(seed.events.find((r) => r.externalRef === ref)!.memberExplanation ?? "")),
  );
  check(
    "CLM-9 says a person will look, and that nothing sent was lost",
    /person needs to look/i.test(seed.events.find((r) => r.externalRef === "CLM-9")!.memberExplanation ?? "") && /nothing you've sent has been lost/i.test(seed.events.find((r) => r.externalRef === "CLM-9")!.memberExplanation ?? ""),
  );
}

// ---------------------------------------------------------------------------
// Invariants, over generated histories
// ---------------------------------------------------------------------------

console.log("\nInvariants over generated histories");
{
  // Small seeded PRNG so a failure is reproducible.
  let s = 0x9e3779b9;
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

  const planList = [...plans.values()];
  const geographies = ["uae", "uae", "uae", "uae", "abroad", "unknown"] as const;
  const statuses = ["active", "active", "active", "active", "active", "lapsed", "cancelled"] as const;
  const violations: string[] = [];
  const note = (msg: string) => violations.length < 5 && violations.push(msg);
  let steps = 0;
  const reached: Record<string, number> = {};

  for (let run = 0; run < 3000; run++) {
    const plan = pick(planList);
    // Histories start from an empty ledger a third of the time and from an
    // arbitrary VALID mid-life state otherwise — otherwise the annual limit and
    // an exhausted sublimit are almost never reachable inside eight events.
    let ledger = emptyLedger();
    if (rand() < 0.35) {
      ledger = {
        deductibleMet: cents(rand() * plan.deductible),
        annualPaid: pick([0, cents(plan.annualLimit * 0.99), plan.annualLimit, cents(rand() * plan.annualLimit)]),
        sublimitUsed: {
          maternity: plan.maternityLimit === null ? 0 : pick([0, plan.maternityLimit, cents(rand() * plan.maternityLimit)]),
          dental_optical: 0,
        },
      };
    }
    const len = 1 + Math.floor(rand() * 8);
    for (let i = 0; i < len; i++) {
      const dryRun = rand() < 0.2;
      const amount = rand() < 0.5 ? Math.floor(rand() * 200000) + 1 : Math.round(rand() * 2e7) / 100 + 0.01;
      const input = {
        plan,
        ledger,
        policyStatus: pick(statuses),
        policyMonth: Math.floor(rand() * 15),
        benefitClass: pick(benefitClassEnum) as BenefitClass,
        providerTier: pick(claimProviderTierEnum) as ClaimProviderTier,
        geography: pick(geographies),
        amount,
        dryRun,
      };
      let r: AdjudicationResult;
      try {
        r = adjudicate(input);
      } catch (err) {
        note(`threw on valid input: ${(err as Error).message}`);
        continue;
      }
      steps += 1;
      reached[r.reasonCode] = (reached[r.reasonCode] ?? 0) + 1;
      const tag = `${plan.id}/${input.benefitClass}/${input.providerTier}/${input.geography}/m${input.policyMonth}/${amount}`;

      const undecidable = input.geography !== "uae" || input.providerTier === "unknown_foreign";
      if ((r.outcome === "insufficient_data") !== undecidable) note(`insufficient_data reached wrongly: ${tag}`);
      if (!reasonCodeEnum.includes(r.reasonCode)) note(`unknown reason code ${r.reasonCode}`);
      if (r.outcome === "insufficient_data") {
        if (r.planPays !== null || r.memberPays !== null) note(`insufficient_data returned numbers: ${tag}`);
      } else {
        if (r.planPays === null || r.memberPays === null) note(`decided outcome has null amounts: ${tag}`);
        else {
          if (r.planPays < 0 || r.memberPays < 0) note(`negative amount: ${tag}`);
          if (cents(r.planPays + r.memberPays) !== cents(amount)) note(`plan + member != billed: ${tag}`);
          if (r.planPays > amount) note(`plan pays more than billed: ${tag}`);
        }
      }
      const payable = r.outcome === "covered" || r.outcome === "approved_with_limit";
      if (payable !== (r.reasonCode === "covered")) note(`outcome/reason mismatch: ${r.outcome}/${r.reasonCode}`);
      if (r.outcome === "approved_with_limit" && !dryRun) note(`approved_with_limit on a claim: ${tag}`);
      if ((!payable || dryRun) && compareLedgers(r.ledgerBefore, r.ledgerAfter).length) note(`ledger moved on ${r.outcome}${dryRun ? " dry run" : ""}: ${tag}`);
      if (r.outcome === "denied" && r.planPays !== 0) note(`denial paid something: ${tag}`);

      const a = r.ledgerAfter;
      if (a.deductibleMet < ledger.deductibleMet || a.annualPaid < ledger.annualPaid) note(`ledger went backwards: ${tag}`);
      if (a.deductibleMet > plan.deductible) note(`deductible over-consumed: ${tag}`);
      if (a.annualPaid > plan.annualLimit) note(`annual limit exceeded: ${tag}`);
      if (plan.maternityLimit !== null && (a.sublimitUsed.maternity ?? 0) > plan.maternityLimit) note(`maternity limit exceeded: ${tag}`);
      if (input.benefitClass !== "maternity" && (a.sublimitUsed.maternity ?? 0) !== (ledger.sublimitUsed.maternity ?? 0)) note(`non-maternity claim moved the maternity sublimit: ${tag}`);

      if (!dryRun) ledger = r.ledgerAfter;
    }
  }
  check(`${steps.toLocaleString("en")} generated adjudications hold every arithmetic invariant`, violations.length === 0, violations.join("\n         "));
  const codes = reasonCodeEnum.filter((c) => !reached[c]);
  check("the generator reached every reason code (so the invariants were exercised on each)", codes.length === 0, `never reached: ${codes.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Limits come from configuration
// ---------------------------------------------------------------------------

console.log("\nLoop limits");
{
  const d = readLimits({});
  check("defaults apply when nothing is set", d.clarificationRounds === 5 && d.evidenceRequestRounds === 3 && d.reassessmentRounds === 2 && d.toolCallsPerTurn === 10);
  const o = readLimits({ SERVICING_MAX_CLARIFICATION_ROUNDS: "7", SERVICING_MAX_TOOL_CALLS: " 4 " });
  check("environment overrides the defaults, and only the ones set", o.clarificationRounds === 7 && o.toolCallsPerTurn === 4 && o.evidenceRequestRounds === 3);
  check("a blank value falls back to the default", readLimits({ SERVICING_MAX_EVIDENCE_REQUEST_ROUNDS: "  " }).evidenceRequestRounds === 3);
  const rejects = (v: string) => {
    try {
      readLimits({ SERVICING_MAX_REASSESSMENT_ROUNDS: v });
      return false;
    } catch {
      return true;
    }
  };
  check("a set-but-invalid value throws rather than silently defaulting", ["abc", "0", "-1", "2.5", "1e3"].every(rejects));
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
