// Run the five supplied profiles through assess() and compare the result to
// the assessments in the fixture file.
//
//   bun run db/seed/check-assessment.ts
//
// The supplied cohorts, confidences and rule codes are the contract: several
// submissions are read side by side, so a live assessment of P1..P5 that does
// not reproduce them is a bug in the rules, not a difference of opinion. This
// reads the fixture JSON directly — no database, no model, no server.
import fixtures from "@/db/seed/fixtures.json";
import { assess, admitsKey, type AssessmentRecord, type Catalogue } from "@/lib/assessment";

/* eslint-disable @typescript-eslint/no-explicit-any */
const f = fixtures as any;

const catalogue: Catalogue = {
  plans: f.plan.map((p: any) => ({
    id: p.id,
    name: p.name,
    annualPremium: p.annual_premium,
    deductible: p.deductible,
    network: p.network,
    outpatientCopayPct: p.outpatient_copay_pct,
    annualLimit: p.annual_limit,
    dentalOptical: p.dental_optical,
    maternityCovered: p.maternity_covered,
    maternityWaitingPeriodMonths: p.maternity_waiting_period_months,
    maternityLimit: p.maternity_limit,
    chronicCovered: p.chronic_covered,
    chronicWaitingPeriodMonths: p.chronic_waiting_period_months,
  })),
  admits: new Set(f.network_admits.map((a: any) => admitsKey(a.network, a.provider_tier))),
};

const people = new Map<string, any>(f.person.map((p: any) => [p.id, p]));
const expected = new Map<string, { cohort: string; confidence: string; flags: string[] }>(
  f.assessment.map((a: any) => [
    a.application_id,
    { cohort: a.cohort, confidence: a.confidence, flags: f.assessment_flag.filter((x: any) => x.assessment_id === a.id).map((x: any) => x.rule_code) },
  ]),
);

let failures = 0;

for (const app of f.application) {
  const record: AssessmentRecord = {
    applicationId: app.id,
    reference: app.reference,
    age: app.age,
    maritalStatus: app.marital_status,
    smoker: app.smoker,
    emirate: app.emirate,
    budget: app.budget,
    policyInception: app.policy_inception,
    treatmentOutsideUaeExpected: app.treatment_outside_uae_expected,
    subjectRelationship: people.get(app.person_id)!.relationship_to_owner,
    conditions: f.application_condition
      .filter((c: any) => c.application_id === app.id)
      .map((c: any) => ({ id: c.id, rawText: c.raw_text, conditionCode: c.condition_code, stability: c.stability })),
    needs: f.application_need
      .filter((n: any) => n.application_id === app.id)
      .map((n: any) => ({ id: n.id, rawText: n.raw_text, benefitClass: n.benefit_class, horizonMonths: n.horizon_months })),
    priorities: f.application_priority
      .filter((p: any) => p.application_id === app.id)
      .map((p: any) => ({ id: p.id, rawText: p.raw_text, tag: p.tag })),
    providers: f.application_expected_provider
      .filter((p: any) => p.application_id === app.id)
      .map((p: any) => ({ id: p.id, providerName: p.provider_name, tier: p.tier })),
  };

  // The fixtures were assessed on 2025-12-01, before their own inception dates.
  const result = assess({
    record,
    catalogue,
    context: { today: "2025-12-01", openApplicationsForPerson: 0 },
  });

  const want = expected.get(app.id)!;
  const gotFlags = result.flags.map((x) => x.ruleCode);
  const ok =
    result.cohort.cohort === want.cohort &&
    result.confidence === want.confidence &&
    JSON.stringify([...gotFlags].sort()) === JSON.stringify([...want.flags].sort());
  if (!ok) failures++;

  console.log(`\n${ok ? "OK  " : "FAIL"} ${app.reference}  age ${app.age} · ${app.budget}`);
  console.log(`  cohort     got ${result.cohort.cohort}  want ${want.cohort}`);
  console.log(`  confidence got ${result.confidence}  want ${want.confidence}`);
  console.log(`  flags      got [${gotFlags}]  want [${want.flags}]`);
  console.log(`  gate ${result.gate} · priority ${result.priorityScore}`);
  for (const flag of result.flags) console.log(`    - ${flag.ruleCode} (${flag.severity}) ${flag.reason}`);
  if (result.uncertaintyReason) console.log(`  why you: ${result.uncertaintyReason}`);
}

console.log(`\n${failures === 0 ? "all five match" : `${failures} mismatch(es)`}`);
