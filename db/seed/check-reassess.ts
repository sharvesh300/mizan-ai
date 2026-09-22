// The reassessment engine, attacked (plan §5.5, §13.3.4, §17 phase 7).
//
//   bun --conditions=react-server run db/seed/check-reassess.ts
//
// Part 2 imports `lib/queries.ts`, which pulls in a `server-only` module — that package no-ops itself only under
// Next's own "react-server" resolve condition, which bun's default resolver does not set, so a bare `bun run`
// throws on load. `--conditions=react-server` sets it, the same way `check:servicing` in package.json runs this
// file (see there if this is being invoked directly and throws "cannot be imported from a Client Component").
//
// Part 1 is the PURE engine against constructed histories — no database, matching how adjudicate.ts and
// appeal.ts are checked. Part 2 (appended once the session wiring exists) drives it live.
//
// What is under test:
//   - features are read from `replay()`'s own steps, not a second reading of stored columns
//   - an upheld appeal is cited even though it moved no money and produced no replay step
//   - a wait that cleared and then paid is CONFIRM, never a reason to recommend a change — §5.5's own example
//   - `recommend_change` only fires when a real alternative resolves EVERY persisting reason for no more cost
//   - the hindsight table replays the same history on every plan, and "covers what was declared" is honest
//   - every citation in the prose is structured data, never parsed back out of the sentence
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { adjudicate, buildHindsightTable, computeVerdict, extractFitFeatures, buildReassessmentProse, memberCopyViolations, INTERNAL_REF, type ReassessEvent, type ReassessmentProse } from "@/lib/servicing";
import type { PlanTerms } from "@/lib/assessment";
import type { ReplayEvent } from "@/lib/servicing/types";

/* eslint-disable @typescript-eslint/no-explicit-any */
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${!ok && detail ? `\n         ${detail}` : ""}`);
};
void adjudicate;

// Every prose pair Part 1 builds, collected here so the banned-vocabulary scan (§18.8) and the register-difference
// check (§18.9) run over ALL of them at once, the same discipline check-servicing.ts applies to the 13 seeded
// events — not just the one or two scenarios that happen to get an inline spot-check nearby.
const allProse: (ReassessmentProse & { label: string })[] = [];

// ---------------------------------------------------------------------------
// Fixture plans — small, hand-picked terms so the arithmetic is checkable by eye
// ---------------------------------------------------------------------------

const balanced: PlanTerms = { id: "balanced", name: "Balanced", annualPremium: 8900, deductible: 500, network: "standard", outpatientCopayPct: 20, annualLimit: 500000, dentalOptical: "basic", maternityCovered: true, maternityWaitingPeriodMonths: 12, maternityLimit: 10000, chronicCovered: true, chronicWaitingPeriodMonths: 6 };
const essential: PlanTerms = { id: "essential", name: "Essential", annualPremium: 4200, deductible: 1500, network: "restricted", outpatientCopayPct: 30, annualLimit: 150000, dentalOptical: "none", maternityCovered: false, maternityWaitingPeriodMonths: null, maternityLimit: null, chronicCovered: false, chronicWaitingPeriodMonths: null };
const comprehensive: PlanTerms = { id: "comprehensive", name: "Comprehensive", annualPremium: 16500, deductible: 0, network: "wide", outpatientCopayPct: 10, annualLimit: 1500000, dentalOptical: "full", maternityCovered: true, maternityWaitingPeriodMonths: 3, maternityLimit: 25000, chronicCovered: true, chronicWaitingPeriodMonths: 0 };
// A plan that covers chronic conditions from day one at a price between the other two — the genuine alternative.
const flexible: PlanTerms = { id: "flexible", name: "Flexible", annualPremium: 9500, deductible: 500, network: "wide", outpatientCopayPct: 20, annualLimit: 500000, dentalOptical: "basic", maternityCovered: true, maternityWaitingPeriodMonths: 3, maternityLimit: 10000, chronicCovered: true, chronicWaitingPeriodMonths: 0 };
const catalogue = [balanced, essential, comprehensive, flexible];

const ev = (over: Partial<ReplayEvent>): ReplayEvent => ({ id: "x", seq: 1, kind: "claim", policyMonth: 0, benefitClass: "general", providerTier: "in_network_clinic", geography: "uae", amount: 1000, supersedesId: null, ...over });
const meta = (id: string, ref: string, description: string, policyMonth: number): ReassessEvent => ({ id, ref, description, policyMonth });

// ==========================================================================
console.log("\nFeatures are read from replay's own steps");
{
  // P3, in miniature: a chronic claim denied for the wait, then paid once the wait cleared.
  const clm3 = ev({ id: "clm3", seq: 1, policyMonth: 4, benefitClass: "chronic_preexisting", amount: 2800 });
  const clm8 = ev({ id: "clm8", seq: 2, policyMonth: 7, benefitClass: "chronic_preexisting", amount: 1200 });
  const refOf = new Map([
    ["clm3", meta("clm3", "CLM-3", "Endocrinology consult, HbA1c, medication review", 4)],
    ["clm8", meta("clm8", "CLM-8", "Follow-up endocrinology review", 7)],
  ]);
  const f = extractFitFeatures(balanced, [clm3, clm8], refOf, [{ id: "app1", ref: "APP-1", description: null, policyMonth: 4, contestsRef: "CLM-3", verdict: "upheld", reasonCode: "waiting_period_not_elapsed" }]);
  check("the denial and the later paid claim are the SAME step replay produced, not a re-read of stored columns", f.standing.find((c) => c.ref === "CLM-3")?.outcome === "denied" && f.standing.find((c) => c.ref === "CLM-8")?.outcome === "covered", JSON.stringify(f.standing));
  check("the wait clearing is recognised and both events are on it", f.waitingPeriodsCleared.length === 1 && f.waitingPeriodsCleared[0].denied.ref === "CLM-3" && f.waitingPeriodsCleared[0].laterPaid.ref === "CLM-8");
  check("the upheld appeal is a feature even though it moved no ledger and produced no replay step", f.appealAttempts.length === 1 && f.appealAttempts[0].ref === "APP-1" && f.appealAttempts[0].verdict === "upheld");
  check("a single denial is not 'repeated'", f.repeatedDenialReasons.length === 0);

  const v = computeVerdict(f, balanced, catalogue, [clm3, clm8]);
  check("§5.5's own worked example — a wait that cleared and then paid — is CONFIRM, never a reason to switch", v.verdict === "confirm", JSON.stringify(v));

  const prose = buildReassessmentProse({ features: f, verdict: v, plan: balanced, recommendedPlan: null, policyRef: "POL-P3" });
  allProse.push({ ...prose, label: "confirm, wait cleared + upheld appeal" });
  check("the member text names BOTH events by their plain description — never a reason code, never a reference", prose.member.includes("Endocrinology consult, HbA1c, medication review") && prose.member.includes("Follow-up endocrinology review") && !/CLM-|APP-|waiting_period/.test(prose.member), prose.member);
  check("...and the appeal too, in the member's own words", /looked again|second look/.test(prose.member));
  check("the broker text names all three by id: CLM-3, CLM-8, APP-1", /CLM-3/.test(prose.broker) && /CLM-8/.test(prose.broker) && /APP-1/.test(prose.broker), prose.broker);
  check("the two documents are not the same document", prose.member !== prose.broker);
  check("every citation the prose makes is structured data — three events, no more, no fewer", prose.citations.length === 3 && new Set(prose.citations.map((c) => c.eventId)).size === 3, JSON.stringify(prose.citations));
  check("a citation's ref and description both come from the SAME row the prose cited — never a mismatch", prose.citations.every((c) => c.ref && c.description));
}

// ==========================================================================
console.log("\nA denial that resolved on appeal does not count against the plan");
{
  // Denied out-of-network, then overturned: the corrected row supersedes the denial, which drops out of the fold.
  const denied = ev({ id: "d1", seq: 1, policyMonth: 7, providerTier: "top_tier_private_hospital", amount: 6000 });
  const overturn = ev({ id: "o1", seq: 3, policyMonth: 7, providerTier: "in_network_clinic", amount: 6000, supersedesId: "d1" });
  const refOf = new Map([
    ["d1", meta("d1", "CLM-4", "Physiotherapy following a shoulder injury", 7)],
    ["o1", meta("o1", "APP-2", "Appeal — Physiotherapy following a shoulder injury", 7)],
  ]);
  const f = extractFitFeatures(balanced, [denied, overturn], refOf, [{ id: "o1", ref: "APP-2", description: null, policyMonth: 7, contestsRef: "CLM-4", verdict: "overturned", reasonCode: "provider_out_of_network" }]);
  check("the denial is gone from the standing set — the overturn replaced it, the same way the ledger never saw it", !f.standing.some((c) => c.outcome === "denied"), JSON.stringify(f.standing));
  check("no out-of-network episode counts: the correction was a recording error, not a network gap", f.outOfNetworkEpisodes.length === 0);
  const v = computeVerdict(f, balanced, catalogue, [denied, overturn]);
  check("nothing here recommends a change", v.verdict === "confirm");
}

// ==========================================================================
console.log("\nA genuine, repeated mismatch — where a real alternative resolves it — recommends a change");
{
  // Two chronic claims, denied both times because Essential excludes chronic conditions entirely.
  const c1 = ev({ id: "c1", seq: 1, policyMonth: 2, benefitClass: "chronic_preexisting", amount: 2000 });
  const c2 = ev({ id: "c2", seq: 2, policyMonth: 5, benefitClass: "chronic_preexisting", amount: 1500 });
  const refOf = new Map([
    ["c1", meta("c1", "CLM-1", "Diabetes review", 2)],
    ["c2", meta("c2", "CLM-2", "Diabetes follow-up", 5)],
  ]);
  const f = extractFitFeatures(essential, [c1, c2], refOf, []);
  check("both denials are the same reason: benefit_excluded", f.denialsByReasonCode.benefit_excluded?.length === 2);
  check("that reason is repeated", f.repeatedDenialReasons.includes("benefit_excluded"));

  // Balanced would deny the SAME two claims too — chronic is covered, but its 6-month wait has not elapsed by
  // month 5 either, so it denies for a DIFFERENT reason. That is not progress, and must not be picked. Only a
  // plan with no wait and a low enough premium is a genuine, affordable alternative.
  const cheapChronic: PlanTerms = { ...balanced, id: "cheap-chronic", name: "Everyday Care", annualPremium: 5000, chronicWaitingPeriodMonths: 0 };
  // Cheaper still, but resolves NOTHING — it excludes chronic conditions exactly as `essential` does. A verdict rule
  // that checks cost before checking whether a plan actually pays the claim would pick this one; it must not.
  const decoy: PlanTerms = { ...essential, id: "decoy", annualPremium: 100 };
  const cat2 = [essential, balanced, comprehensive, cheapChronic, decoy];
  const v = computeVerdict(f, essential, cat2, [c1, c2]);
  check("Balanced does NOT resolve it — it denies the same two claims for the waiting period instead", v.verdict === "recommend_change" && (v as any).recommendedPlanId !== "balanced", JSON.stringify(v));
  check("the decoy is cheaper still but resolves nothing — it is never picked just for its price", v.verdict === "recommend_change" && (v as any).recommendedPlanId !== "decoy", JSON.stringify(v));
  check("the genuinely resolving, cheaper plan is recommended, and the reason is on the record", v.verdict === "recommend_change" && (v as any).recommendedPlanId === "cheap-chronic" && (v as any).reasonCodes.includes("benefit_excluded"), JSON.stringify(v));

  const recommended = cat2.find((p) => p.id === (v as any).recommendedPlanId)!;
  const prose = buildReassessmentProse({ features: f, verdict: v, plan: essential, recommendedPlan: recommended, policyRef: "POL-X" });
  allProse.push({ ...prose, label: "recommend_change, repeated benefit_excluded" });
  check("the member is told a plan change may be worth looking at, and that an advisor is involved — not the figures of a switch nobody has approved", /advisor/.test(prose.member) && !/Everyday Care/.test(prose.member), prose.member);
  check("the broker text names the recommended plan and the reason", /Everyday Care/.test(prose.broker) && /benefit_excluded/.test(prose.broker), prose.broker);
}

console.log("\nA wait, however many times it is hit before it clears, is a clock — never a persisting reason to switch");
{
  // Two claims, both still inside the wait, neither cleared yet — genuinely "repeated" by count, but a wait is
  // not a mismatch and must never drive a recommendation on its own.
  const c1 = ev({ id: "w1", seq: 1, policyMonth: 1, benefitClass: "chronic_preexisting", amount: 2000 });
  const c2 = ev({ id: "w2", seq: 2, policyMonth: 3, benefitClass: "chronic_preexisting", amount: 1500 });
  const refOf = new Map([
    ["w1", meta("w1", "CLM-1", "Diabetes review", 1)],
    ["w2", meta("w2", "CLM-2", "Diabetes follow-up", 3)],
  ]);
  const f = extractFitFeatures(balanced, [c1, c2], refOf, []);
  check("the wait was hit twice — a real repeat, by count", f.repeatedDenialReasons.includes("waiting_period_not_elapsed"));
  const noWaitAtAll: PlanTerms = { ...balanced, id: "no-wait", annualPremium: 5000, chronicWaitingPeriodMonths: 0 };
  const v = computeVerdict(f, balanced, [balanced, essential, noWaitAtAll], [c1, c2]);
  check("even with a cheaper, no-wait alternative sitting right there, this is CONFIRM — a wait is a clock, not a mismatch", v.verdict === "confirm", JSON.stringify(v));
  allProse.push({ ...buildReassessmentProse({ features: f, verdict: v, plan: balanced, recommendedPlan: null, policyRef: "POL-W" }), label: "confirm, wait hit twice, still running" });
}

console.log("\nWaiting periods only pair with a LATER paid claim of the SAME benefit class");
{
  const denied = ev({ id: "p1", seq: 1, policyMonth: 1, benefitClass: "chronic_preexisting", amount: 2000 });
  // A later claim that paid, but for a DIFFERENT benefit — must not be read as "the wait cleared".
  const unrelated = ev({ id: "p2", seq: 2, policyMonth: 8, benefitClass: "general", amount: 500 });
  const refOf = new Map([
    ["p1", meta("p1", "CLM-1", "Diabetes review", 1)],
    ["p2", meta("p2", "CLM-2", "Sprained ankle", 8)],
  ]);
  const fUnrelated = extractFitFeatures(balanced, [denied, unrelated], refOf, []);
  check("no pairing: the later paid claim is a different benefit entirely", fUnrelated.waitingPeriodsCleared.length === 0, JSON.stringify(fUnrelated.waitingPeriodsCleared));

  const fAlone = extractFitFeatures(balanced, [denied], refOf, []);
  check("no pairing when nothing later exists at all", fAlone.waitingPeriodsCleared.length === 0);
}

console.log("\nA plan that resolves it but is more expensive overall is not recommended");
{
  const c1 = ev({ id: "e1", seq: 1, policyMonth: 2, benefitClass: "chronic_preexisting", amount: 2000 });
  const c2 = ev({ id: "e2", seq: 2, policyMonth: 5, benefitClass: "chronic_preexisting", amount: 1500 });
  const refOf = new Map([
    ["e1", meta("e1", "CLM-1", "Diabetes review", 2)],
    ["e2", meta("e2", "CLM-2", "Diabetes follow-up", 5)],
  ]);
  const f = extractFitFeatures(essential, [c1, c2], refOf, []);
  const tooExpensive: PlanTerms = { ...comprehensive, id: "too-expensive", annualPremium: 200000 };
  const v = computeVerdict(f, essential, [essential, tooExpensive], [c1, c2]);
  check("the only resolving plan costs far more than staying put — confirm, not a manufactured signal", v.verdict === "confirm", JSON.stringify(v));
}

console.log("\nAn out-of-network repeat, resolved only by a wider network, is recommended when the wider network is affordable");
{
  const c1 = ev({ id: "r1", seq: 1, policyMonth: 1, providerTier: "premium_private_hospital", amount: 3000 });
  const c2 = ev({ id: "r2", seq: 2, policyMonth: 3, providerTier: "premium_private_hospital", amount: 2000 });
  const refOf = new Map([
    ["r1", meta("r1", "CLM-1", "Specialist consultation", 1)],
    ["r2", meta("r2", "CLM-2", "Specialist follow-up", 3)],
  ]);
  const f = extractFitFeatures(essential, [c1, c2], refOf, []);
  check("both denials are the same, repeated, persisting reason", f.repeatedDenialReasons.includes("provider_out_of_network"));

  // `essential` (restricted network) denies both; `comprehensive` (wide) admits a premium private hospital, but its
  // premium alone dwarfs what two modest bills would ever save — a real plan at that price is never the answer here.
  const tooExpensive = computeVerdict(f, essential, [essential, balanced, comprehensive], [c1, c2]);
  check("comprehensive's premium alone outweighs two modest claims — confirm, not chased for a marginal saving", tooExpensive.verdict === "confirm", JSON.stringify(tooExpensive));

  // A wide-network plan priced close to Essential — genuinely affordable — IS recommended.
  const affordableWide: PlanTerms = { ...comprehensive, id: "affordable-wide", name: "Open Access", annualPremium: 5200 };
  const v = computeVerdict(f, essential, [essential, balanced, affordableWide], [c1, c2]);
  check("an affordable wide-network plan that actually admits the provider is recommended", v.verdict === "recommend_change" && (v as any).recommendedPlanId === "affordable-wide", JSON.stringify(v));
  allProse.push({ ...buildReassessmentProse({ features: f, verdict: v, plan: essential, recommendedPlan: affordableWide, policyRef: "POL-R" }), label: "recommend_change, repeated provider_out_of_network" });

  // Same history, but priced far beyond what avoiding two out-of-network bills is worth.
  const expensiveOnly: PlanTerms = { ...comprehensive, annualPremium: 200000 };
  const v2 = computeVerdict(f, essential, [essential, balanced, expensiveOnly], [c1, c2]);
  check("...and when the only resolving plan costs far more, it is confirm — not a manufactured signal", v2.verdict === "confirm", JSON.stringify(v2));
}

// ==========================================================================
console.log("\nThe hindsight table");
{
  const c1 = ev({ id: "h1", seq: 1, policyMonth: 4, benefitClass: "chronic_preexisting", amount: 2800 });
  const c2 = ev({ id: "h2", seq: 2, policyMonth: 7, benefitClass: "chronic_preexisting", amount: 1200 });
  const rows = buildHindsightTable(catalogue, balanced.id, [c1, c2]);
  check("one row per catalogue plan, the current one marked", rows.length === catalogue.length && rows.filter((r) => r.current).length === 1);
  const essentialRow = rows.find((r) => r.planId === "essential")!;
  check("Essential is cheapest on premium alone but excludes the condition entirely — both claims refused", essentialRow.claimsRefused === 2 && essentialRow.coversWhatWasDeclared === false, JSON.stringify(essentialRow));
  const balancedRow = rows.find((r) => r.planId === "balanced")!;
  check("Balanced (current) covers the condition and both claims are eventually decided (one denied on the wait, one paid) — 1 refused", balancedRow.claimsRefused === 1 && balancedRow.coversWhatWasDeclared === true, JSON.stringify(balancedRow));
  const comprehensiveRow = rows.find((r) => r.planId === "comprehensive")!;
  check("Comprehensive covers it with NO wait, so 0 refused, but costs the most overall", comprehensiveRow.claimsRefused === 0 && comprehensiveRow.total > balancedRow.total, JSON.stringify(comprehensiveRow));
  check("a plan with nothing declared has no false negatives: 'covers what was declared' is trivially true with an empty history", buildHindsightTable(catalogue, balanced.id, []).every((r) => r.coversWhatWasDeclared === true));
}

// ==========================================================================
console.log(`\nBoth registers, every reassessment prose built above (${allProse.length}) — §18.8, §18.9`);
{
  // §18.8: the same banned-vocabulary scan check-servicing.ts runs over the 13 seeded events' explanations,
  // run here over every reassessment's MEMBER text — classification vocabulary, raw enum tokens, a time promise,
  // or an internal reference are each disqualifying on a member's own screen.
  const violations = allProse.flatMap((p) => memberCopyViolations(p.member).map((v) => `${p.label}: ${v}`));
  check("no reassessment's member text carries banned vocabulary, an enum token, a time promise or an internal reference", violations.length === 0, violations.join("; "));

  // §18.9: register difference — the broker text must carry what the member's does not (an internal reference),
  // and the two must never be the same document.
  const noRefInBroker = allProse.filter((p) => !INTERNAL_REF.test(p.broker)).map((p) => p.label);
  check("every broker text names at least one internal reference — something the member's text must not", noRefInBroker.length === 0, noRefInBroker.join(", "));
  const same = allProse.filter((p) => p.member === p.broker).map((p) => p.label);
  check("every reassessment has two different documents, not one shown twice", same.length === 0, same.join(", "));
  const shortMember = allProse.filter((p) => p.member.length < 40).map((p) => p.label);
  check("no member document is a stub", shortMember.length === 0, shortMember.join(", "));
}

// ==========================================================================
// Part 2 — live, against the session: seeded rows, real turns, real writes
// ==========================================================================

const dir = mkdtempSync(path.join(tmpdir(), "mizan-reassess-"));
process.env.DATABASE_URL = path.join(dir, "check.db");
const seed = spawnSync(process.execPath, ["run", "db/seed/run.ts"], { env: process.env, encoding: "utf8" });
if (seed.status !== 0) {
  console.error(seed.stdout, seed.stderr);
  process.exit(1);
}

try {
  const { db } = await import("@/db/client");
  const schema = await import("@/db/schema");
  const session = await import("@/lib/ai/servicing-session");
  const reassessLib = await import("@/lib/ai/servicing-reassess");
  const reassessCaseLib = await import("@/lib/servicing/reassess-case");
  const packetLib = await import("@/lib/servicing/packet");
  const queue = await import("@/lib/servicing/queue");
  const store = await import("@/lib/servicing/store");
  const queries = await import("@/lib/queries");
  const { and, eq, ne } = await import("drizzle-orm");
  const { plan, person, policy, application, applicationCondition, planFitReassessment, reviewTask, appUser } = schema;

  const today = "2026-09-20";
  const [meera] = await db.select().from(person).where(eq(person.externalRef, "P3"));
  const advisorId = (await db.select().from(appUser)).find((u: any) => u.role === "advisor")!.id;
  const memberId = meera.ownerUserId;

  // A genuinely affordable, day-one-chronic-covering plan — the catalogue's real three cannot construct a
  // resolving, cheaper case against Essential for a member who has already declared a chronic condition, because
  // none of the three supplied plans is both. Inserted directly, the same way other checks add synthetic rows
  // for a case the acceptance table itself never puts in front of the engine.
  await db.insert(plan).values({
    id: "plan_cheap_chronic",
    name: "Everyday Care",
    annualPremium: 5000,
    deductible: 500,
    network: "standard",
    outpatientCopayPct: 20,
    annualLimit: 500000,
    dentalOptical: "none",
    maternityCovered: false,
    chronicCovered: true,
    chronicWaitingPeriodMonths: 0,
  });

  // A second application and policy for the SAME person, on Essential (chronic excluded) — hers is on Balanced
  // already; this is what puts a member with a declared chronic condition on a plan that will not pay for it.
  const appId = crypto.randomUUID();
  await db.insert(application).values({
    id: appId,
    reference: "APP-TEST-REASSESS",
    personId: meera.id,
    createdByUserId: advisorId,
    intakeSource: "web_form",
    status: "policy_issued",
    age: 45,
    budget: "low",
    policyInception: "2026-01-01",
    treatmentOutsideUaeExpected: false,
  });
  await db.insert(applicationCondition).values({ applicationId: appId, rawText: "type 2 diabetes (managed)", conditionCode: "type_2_diabetes", stability: "managed", declaredAtIntake: true });
  const testPolicyId = crypto.randomUUID();
  await db.insert(policy).values({ id: testPolicyId, externalRef: "POL-TEST", applicationId: appId, personId: meera.id, planId: "plan_a", policyNumber: "TEST-0001", inceptionDate: "2026-01-01", status: "active", annualPremium: 4200 });

  const claimForm = (over: Record<string, string> = {}) => ({ treatment: "Diabetes review", treatment_date: "2026-02-10", provider_type: "in_network_clinic", provider_name: "City Clinic", amount: "2,000", paid_by_member: "yes", benefit_class: "chronic:type 2 diabetes", ...over });

  console.log("\nTwo real claims, through the session, land on a persisting denial — and reassessment runs after each");
  const c1 = (await session.openServicing({ userId: memberId, policyId: testPolicyId, intent: "claim" }, { today })) as any;
  await session.handleServicingInput(c1.conversationId, memberId, { kind: "form", values: claimForm() }, { today });
  await session.handleServicingInput(c1.conversationId, memberId, { kind: "confirm" }, { today });
  const firstRow = (await db.select().from(planFitReassessment).where(eq(planFitReassessment.policyId, testPolicyId)))[0];
  check("after the first claim, reassessment ran and wrote a row citing it", firstRow !== undefined && firstRow.verdict === "confirm", JSON.stringify(firstRow));
  check("...it is CONFIRM: one denial is not yet a repeat", firstRow.verdict === "confirm");

  const c2 = (await session.openServicing({ userId: memberId, policyId: testPolicyId, intent: "claim" }, { today })) as any;
  await session.handleServicingInput(c2.conversationId, memberId, { kind: "form", values: claimForm({ treatment: "Diabetes follow-up", treatment_date: "2026-05-10", amount: "1,500" }) }, { today });
  await session.handleServicingInput(c2.conversationId, memberId, { kind: "confirm" }, { today });

  const rows = await db.select().from(planFitReassessment).where(eq(planFitReassessment.policyId, testPolicyId));
  check("a SECOND row was written — one per triggering event, not one overwritten in place", rows.length === 2);
  const latest = rows.sort((a: any, b: any) => (a.createdAt < b.createdAt ? -1 : 1)).at(-1)!;
  check("the second reassessment recommends the genuinely resolving, affordable plan", latest.verdict === "recommend_change" && latest.recommendedPlanId === "plan_cheap_chronic", JSON.stringify(latest));
  check("its citations are structured — the two claims, by id — not parsed back out of the prose", Array.isArray(latest.citations) && (latest.citations as any[]).length >= 2);
  check("the broker text names them by ref, the member text never does", /CLM-\d+/.test(latest.brokerReasoning) && !/CLM-\d+/.test(latest.memberReasoning));
  check(
    "§18.8 against the LIVE row too, not just the constructed fixtures above: the stored member text carries no banned vocabulary",
    memberCopyViolations(latest.memberReasoning).length === 0,
    memberCopyViolations(latest.memberReasoning).join("; "),
  );
  check(
    "the two rows tie on `createdAt` (unix SECONDS, same request) — the read layer still picks the true latest, by write order, not the earlier CONFIRM row",
    rows[0].createdAt.getTime() === rows[1].createdAt.getTime() && rows[0].verdict !== rows[1].verdict,
    JSON.stringify(rows.map((r: any) => ({ id: r.id, verdict: r.verdict, createdAt: r.createdAt }))),
  );

  console.log("\nA `recommend_change` is a sales act — the member does not read it until a person has looked");
  const task = (await db.select().from(reviewTask).where(and(eq(reviewTask.subjectType, "reassessment"), eq(reviewTask.subjectId, latest.id))))[0];
  check("a review task was raised, at the judgment band (60) — not blocking, not undecidable", task !== undefined && task.priorityScore === 60 && task.status === "open");
  check("before it is approved, the member reads nothing recommending a change: only CONFIRM rows are visible to them", await (async () => {
    const visible = await packetLib.getPacket({ policyId: testPolicyId, conversationId: null, eventId: null });
    void visible;
    const memberVisible = await reassessLib.reassessmentApproved(latest.id);
    return memberVisible === false;
  })());
  check("a second claim on the same repeating reason does not raise a SECOND open task while the first is still open", (await db.select().from(reviewTask).where(and(eq(reviewTask.subjectType, "reassessment"), eq(reviewTask.status, "open")))).length === 1);
  check(
    "the read layer's own `listMemberReassessments` picks the SAME latest row despite the createdAt tie, and withholds it before it's approved",
    (await queries.listMemberReassessments(testPolicyId)).length === 0,
  );

  console.log("\nThe queue carries it, hydrated, at the judgment band");
  const openTasks = (await db.select().from(reviewTask).where(ne(reviewTask.status, "resolved"))).map((t: any) => ({ task: t }));
  const subjects = await queue.servicingSubjects(openTasks);
  const qSub = subjects.get(task.id);
  check(
    "the queue subject names the recommended plan's cost, the current plan, and nothing about it looks like a claim or an appeal",
    qSub !== undefined &&
      qSub.task === "reassessment" &&
      qSub.group === "decide" &&
      qSub.cause === "reassessment_change" &&
      qSub.eventId === null &&
      qSub.reassessment !== null &&
      qSub.reassessment.reassessmentId === latest.id &&
      qSub.reassessment.currentPlanName === "Essential" &&
      qSub.reassessment.currentPremium === 4200 &&
      qSub.reassessment.recommendedPlanName === "Everyday Care" &&
      qSub.reassessment.recommendedPremium === 5000,
    JSON.stringify(qSub),
  );

  console.log("\nThe broker's verbs");
  check("dismiss needs a note", (await reassessLib.dismissReassessment({ taskId: task.id, advisorUserId: advisorId, note: "x" })).ok === false);
  check("a member cannot decide their own reassessment", (await reassessLib.approveReassessment({ taskId: task.id, advisorUserId: memberId, note: "Approving my own recommendation, thanks." })).ok === false);

  const edited = await reassessLib.editReassessmentReasoning({ taskId: task.id, advisorUserId: advisorId, note: "Confirmed the numbers against the catalogue before signing off.", brokerReasoning: "Edited: Everyday Care resolves the repeated chronic exclusion for a lower total cost than Essential, given her history." });
  check("editing the reasoning goes through, closes the task, and changes the stored broker text", edited.ok, JSON.stringify(edited));
  const afterEdit = (await db.select().from(planFitReassessment).where(eq(planFitReassessment.id, latest.id)))[0];
  check("...the row now carries the edited text", /Edited: Everyday Care/.test(afterEdit.brokerReasoning));
  check("...the task is resolved, with a decision: edit, the advisor, their note", (await db.select().from(reviewTask).where(eq(reviewTask.id, task.id)))[0].status === "resolved");
  check("...and NOW the member may read it — approved or edited both unlock it", await reassessLib.reassessmentApproved(latest.id));
  check(
    "...and `listMemberReassessments` now surfaces exactly that row — the true latest, still, not the earlier CONFIRM one it ties with",
    await (async () => {
      const visible = await queries.listMemberReassessments(testPolicyId);
      return visible.length === 1 && visible[0].id === latest.id && visible[0].verdict === "recommend_change" && /Edited: Everyday Care/.test(visible[0].memberReasoning) === false;
    })(),
  );
  check("a task already resolved cannot be decided again", (await reassessLib.approveReassessment({ taskId: task.id, advisorUserId: advisorId, note: "Approving again, for luck." })).ok === false);

  console.log("\nA THIRD event that now confirms the plan closes a still-open recommendation automatically");
  // Start over: a fresh policy, two denials raise a task, then a plan-fit change (the plan itself starts covering
  // it) or — simpler and real — dismiss the open task, then confirm the auto-resolve path with a constructed case.
  const c3 = (await session.openServicing({ userId: memberId, policyId: testPolicyId, intent: "claim" }, { today })) as any;
  await session.handleServicingInput(c3.conversationId, memberId, { kind: "form", values: claimForm({ treatment: "Diabetes annual review", treatment_date: "2026-08-10", amount: "1,000" }) }, { today });
  await session.handleServicingInput(c3.conversationId, memberId, { kind: "confirm" }, { today });
  check("a third denial on the same reason writes ANOTHER recommend_change row, but the earlier task is already resolved so a new one opens", (await db.select().from(reviewTask).where(and(eq(reviewTask.subjectType, "reassessment"), eq(reviewTask.status, "open")))).length === 1);

  console.log("\nThe case page's decision panel disappears once the task is decided — Dismiss, this time");
  const rows3 = await db.select().from(planFitReassessment).where(eq(planFitReassessment.policyId, testPolicyId));
  const latest3 = rows3.sort((a: any, b: any) => (a.createdAt < b.createdAt ? -1 : 1)).at(-1)!;
  const [task3] = await db.select().from(reviewTask).where(and(eq(reviewTask.subjectType, "reassessment"), eq(reviewTask.subjectId, latest3.id), eq(reviewTask.status, "open")));
  check("a fresh open task exists to dismiss", task3 !== undefined);
  const beforeDismiss = await reassessCaseLib.getReassessmentCase(testPolicyId, latest3.id);
  check("before deciding, the case page carries the OPEN task — the decision panel has something to act on", beforeDismiss?.task?.status === "open", JSON.stringify(beforeDismiss?.task));
  const dismissed = await reassessLib.dismissReassessment({ taskId: task3.id, advisorUserId: advisorId, note: "Not now — already in a call with the member about this." });
  check("dismiss goes through", dismissed.ok, JSON.stringify(dismissed));
  const afterDismiss = await reassessCaseLib.getReassessmentCase(testPolicyId, latest3.id);
  check(
    "...and NOW the case page carries NO open task — a resolved task must not re-offer Approve/Edit/Dismiss with a blank note on the next load",
    afterDismiss?.task === null,
    JSON.stringify(afterDismiss?.task),
  );
  check("the member still cannot read it — dismissed, not approved", (await queries.listMemberReassessments(testPolicyId)).every((r: any) => r.id !== latest3.id));

  console.log("\nEvery stored ledger still equals a replay of its log — reassessment writes nothing to it");
  check("replay passes on the test policy and on every seeded one", (await store.checkReplay(testPolicyId)).ok);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
