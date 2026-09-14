// Run the five supplied profiles through recommend() and compare the result to
// the recommendations in the fixture file.
//
//   bun run db/seed/check-recommendation.ts
//
// Two different contracts, deliberately: `quote.eligible` is a coverage test
// (lib/recommendation/eligibility.ts) and is asserted exactly — it is pure
// arithmetic over the declared needs and the plan terms, so a live run that
// disagrees with the fixture is a bug. The fixture's `recommendation.plan_id`
// is ALSO asserted, but only because the deterministic fallback here is
// cohort-aware (see lib/recommendation/fallback.ts) — it reproduces the same
// axis each cohort's own rationale already states in lib/assessment/cohort.ts.
// `quote.rank`/`quote.score` are printed but not asserted: those numbers in
// the fixture reflect an agent-scored run (lib/recommendation/score.ts, which
// only the LLM agent invokes), not the simpler fallback this script exercises.
import fixtures from "@/db/seed/fixtures.json";
import { admitsKey, type AssessmentRecord, type Catalogue } from "@/lib/assessment";
import { priceAllPlans, recommend } from "@/lib/recommendation";

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
const expectedReco = new Map<string, { planId: string }>(
  f.recommendation.map((r: any) => [r.application_id, { planId: r.plan_id }]),
);
const expectedQuotes = new Map<string, Map<string, { eligible: boolean; rank: number; score: number }>>();
for (const q of f.quote) {
  const byPlan = expectedQuotes.get(q.application_id) ?? new Map();
  byPlan.set(q.plan_id, { eligible: q.eligible, rank: q.rank, score: q.score });
  expectedQuotes.set(q.application_id, byPlan);
}

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

  const result = recommend({ record, catalogue });
  const quotes = priceAllPlans(catalogue, record);
  const wantReco = expectedReco.get(app.id);
  const wantQuotes = expectedQuotes.get(app.id);

  let ok = true;
  console.log(`\n${app.reference}  age ${app.age} · ${app.budget}`);

  if (wantReco) {
    const match = result.planId === wantReco.planId;
    ok &&= match;
    console.log(`  ${match ? "OK  " : "FAIL"} recommendation  got ${result.planId}  want ${wantReco.planId}`);
  }

  if (wantQuotes) {
    for (const quote of quotes) {
      const want = wantQuotes.get(quote.planId);
      if (!want) continue;
      const match = quote.eligible === want.eligible;
      ok &&= match;
      console.log(
        `  ${match ? "OK  " : "FAIL"} ${quote.planId}  eligible got ${quote.eligible}  want ${want.eligible}` +
          `  (rank got ${quote.rank} fixture ${want.rank} · score got ${quote.score} fixture ${want.score} — informational, not asserted)`,
      );
    }
  }

  console.log(`  broker: ${result.brokerReasoning}`);
  console.log(`  member: ${result.memberReasoning}`);
  for (const rejection of result.rejections) console.log(`    - ${rejection.planId}: ${rejection.reason}`);

  if (!ok) failures++;
}

console.log(`\n${failures === 0 ? "all five match" : `${failures} mismatch(es)`}`);
