// Verification script for the unified policy pipeline graph (runPolicyPipeline).
//
//   bun run --conditions=react-server db/seed/check-pipeline.ts
//
// Verifies:
// 1. A clean profile (APP-P1) automatically traverses assessment and recommendation.
// 2. A flagged profile (APP-P2) halts at gate with phase 'gated_for_review' and recommendation null.

import fixtures from "@/db/seed/fixtures.json";
import { admitsKey, type AssessmentRecord, type Catalogue } from "@/lib/assessment";
import { runPolicyPipeline } from "@/lib/ai/graph";

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

function buildRecord(ref: string): AssessmentRecord {
  const app = f.application.find((a: any) => a.reference === ref);
  if (!app) throw new Error(`App with ref ${ref} not found`);
  const person = people.get(app.person_id);
  return {
    applicationId: app.id,
    reference: app.reference,
    age: app.age,
    maritalStatus: app.marital_status,
    smoker: app.smoker,
    emirate: app.emirate,
    budget: app.budget,
    policyInception: app.policy_inception,
    treatmentOutsideUaeExpected: app.treatment_outside_uae_expected,
    subjectRelationship: person?.relationship_to_owner ?? "self",
    conditions: f.application_condition
      .filter((c: any) => c.application_id === app.id)
      .map((c: any) => ({ rawText: c.raw_text, stability: c.stability })),
    needs: f.application_need
      .filter((n: any) => n.application_id === app.id)
      .map((n: any) => ({ rawText: n.raw_text, benefitClass: n.benefit_class, horizonMonths: n.horizon_months })),
    providers: f.application_expected_provider
      .filter((p: any) => p.application_id === app.id)
      .map((p: any) => ({ providerName: p.provider_name, tier: p.tier })),
    priorities: f.application_priority
      .filter((p: any) => p.application_id === app.id)
      .map((p: any) => ({ rawText: p.raw_text, tag: p.tag })),
  };
}

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};

async function main() {
  console.log("Testing unified policy pipeline (runPolicyPipeline)...");

  // Test 1: APP-P1 (clean young healthy -> gate auto -> should flow into recommendation)
  const p1Record = buildRecord("APP-P1");
  const p1Outcome = await runPolicyPipeline({
    record: p1Record,
    catalogue,
    context: { today: "2025-12-01", openApplicationsForPerson: 0 },
  });

  check("P1 gate is auto", p1Outcome.assessment.gate === "auto");
  check("P1 phase is recommended", p1Outcome.phase === "recommended");
  check("P1 has recommendation", p1Outcome.recommendation != null);
  check("P1 quotes present", (p1Outcome.recommendation?.quotes.length ?? 0) === 3);

  // Test 2: APP-P2 (maternity planning with budget mismatch -> gate needs_review -> pauses at gate)
  const p2Record = buildRecord("APP-P2");
  const p2Outcome = await runPolicyPipeline({
    record: p2Record,
    catalogue,
    context: { today: "2025-12-01", openApplicationsForPerson: 0 },
  });

  check("P2 gate is needs_review", p2Outcome.assessment.gate === "needs_review");
  check("P2 phase is gated_for_review", p2Outcome.phase === "gated_for_review");
  check("P2 has routedToReview true", p2Outcome.assessment.routedToReview === true);
  check("P2 recommendation is null (halted at gate)", p2Outcome.recommendation == null);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  } else {
    console.log("\nAll unified pipeline checks passed successfully!");
  }
}

main().catch((err) => {
  console.error("Pipeline test crashed:", err);
  process.exit(1);
});
