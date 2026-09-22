// The brief's deliverable 3: "All five applicants run end to end, with outputs captured — cohort and flags,
// quotes, recommendation and reasoning, then every servicing event in order with its adjudication and the
// resulting ledger state." (docs/project_brief.md §3). A folder of JSON dumps, one per applicant, plus a combined
// summary — written from the SAME seeded data the acceptance table (plan §14) is checked against, so what this
// folder shows is exactly what `bun run check:servicing` verifies, not a hand-picked run.
//
//   bun --conditions=react-server run db/seed/dump-outputs.ts
//
// (needs `--conditions=react-server`: it imports `lib/queries.ts`, which pulls in a `server-only` module — see
// the note in db/seed/check-reassess.ts's own header and the memory on this.)
//
// Every servicing event's adjudication and ledger-after comes from `replayPolicy()` — the SAME replay every other
// part of this system trusts — never a second reading of the stored columns, so this dump cannot silently drift
// from what replay itself would produce.

import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const dir = mkdtempSync(path.join(tmpdir(), "mizan-dump-"));
process.env.DATABASE_URL = path.join(dir, "dump.db");
const seed = spawnSync(process.execPath, ["run", "db/seed/run.ts"], { env: process.env, encoding: "utf8" });
if (seed.status !== 0) {
  console.error(seed.stdout, seed.stderr);
  process.exit(1);
}

try {
  const { db } = await import("@/db/client");
  const schema = await import("@/db/schema");
  const queries = await import("@/lib/queries");
  const { replayPolicy } = await import("@/lib/servicing/store");
  const { asc, eq, like } = await import("drizzle-orm");
  const { policy, application, person, planFitReassessment } = schema;

  const outDir = path.join(process.cwd(), "outputs");
  mkdirSync(outDir, { recursive: true });

  const policies = await db
    .select({ policy, application, person })
    .from(policy)
    .innerJoin(application, eq(policy.applicationId, application.id))
    .innerJoin(person, eq(policy.personId, person.id))
    .where(like(policy.externalRef, "POL-P%"))
    .orderBy(asc(policy.externalRef));

  const summary: unknown[] = [];

  for (const { policy: pol, application: app, person: p } of policies) {
    const [assessment, quotes, recommendation, reassessments, replayed] = await Promise.all([
      queries.getAssessment(app.id),
      queries.getQuotes(app.id),
      queries.getRecommendation(app.id),
      db.select().from(planFitReassessment).where(eq(planFitReassessment.policyId, pol.id)),
      replayPolicy(pol.id),
    ]);

    // Every STORED event, in write order — not just `.steps`, which omits an event that moved no ledger (an
    // upheld appeal, a denial an overturn later replaced). The acceptance table (plan §14) lists those too, so
    // this dump must. Ledger-moving events take their outcome/figures/ledger-after from the replay STEP itself
    // (the same fold every other part of the system trusts); an event with no step falls back to its own stored
    // adjudication (still real — an upheld appeal really did restate the original finding) and the ledger state
    // simply carries forward from the last step, because that event did not move it.
    const stepByEventId = new Map(replayed.steps.map((s) => [s.event.id, s]));
    let carryLedger = replayed.steps[0]?.result.ledgerBefore ?? null;
    const events = replayed.stored.map((row) => {
      const step = stepByEventId.get(row.id);
      if (step) carryLedger = step.result.ledgerAfter;
      return {
        ref: row.externalRef ?? row.id.slice(0, 8),
        kind: row.kind,
        policyMonth: row.policyMonth,
        billedAmount: row.billedAmount ?? row.estimatedAmount,
        outcome: step ? step.result.outcome : row.outcome,
        plan_pays: step ? step.result.planPays : row.planPays,
        member_pays: step ? step.result.memberPays : row.memberPays,
        reason_code: step ? step.result.reasonCode : row.reasonCode,
        ledger_after: carryLedger,
      };
    });

    const record = {
      applicant: p.externalRef,
      applicationRef: app.reference,
      policyRef: pol.externalRef,
      personName: p.fullName,
      cohort_and_flags: assessment ? { cohort: assessment.cohort, confidence: assessment.confidence, flags: assessment.flags.map((f) => ({ severity: f.severity, ruleCode: f.ruleCode, reason: f.reason })) } : null,
      quotes: quotes.map((q) => ({ plan: q.plan.name, annualPremium: q.annualPremium, eligible: q.eligible, rank: q.rank })),
      recommendation: recommendation
        ? {
            plan: recommendation.plan.name,
            brokerReasoning: recommendation.recommendation.brokerReasoning,
            memberReasoning: recommendation.recommendation.memberReasoning,
            rejections: recommendation.rejections.map((r) => ({ plan: r.plan.name, reason: r.reason })),
          }
        : null,
      servicing_events: events,
      plan_fit_reassessments: reassessments.map((r) => ({
        verdict: r.verdict,
        recommendedPlanId: r.recommendedPlanId,
        brokerReasoning: r.brokerReasoning,
        memberReasoning: r.memberReasoning,
        citations: r.citations,
      })),
    };

    writeFileSync(path.join(outDir, `${p.externalRef}.json`), JSON.stringify(record, null, 2) + "\n");
    summary.push({ applicant: p.externalRef, policyRef: pol.externalRef, cohort: assessment?.cohort ?? null, plan: recommendation?.plan.name ?? null, eventCount: events.length, reassessmentCount: reassessments.length });
    console.log(`  wrote outputs/${p.externalRef}.json — ${events.length} events, ${reassessments.length} reassessment(s)`);
  }

  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`\nWrote ${policies.length} applicant files + summary.json to ${outDir}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
