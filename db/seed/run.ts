// Seeds the v1 (non-AI) tables from db/seed/fixtures.json — the supplied
// hackathon mock data. Run with: bun run db:seed
//
// Re-runnable. Two things have to be true for that, and neither is free:
//
//   1. The teardown has to get past the append-only guards. `servicing_event`
//      and `message` carry BEFORE DELETE triggers (db/triggers.sql) so that
//      application code can never rewrite history — but a reseed is exactly
//      the case where a full wipe is intended. The guards are dropped for the
//      duration of the load and put back at the end.
//   2. It has to be all-or-nothing. The wipe walks the FK graph children-first
//      across 34 tables; a failure partway through used to leave the database
//      with some tables emptied and some not, which is worse than either
//      outcome and is only recoverable by deleting the file. The whole
//      teardown-and-load runs in one transaction, so a failure rolls the
//      database back to exactly what it was — the dropped triggers included,
//      since SQLite DDL is transactional.
import { eq, sql } from "drizzle-orm";
import { applyAppendOnlyGuards, db, dropAppendOnlyGuards } from "../client";
import * as schema from "../schema";
import type {
  ActorKind,
  ApplicationStatus,
  BenefitClass,
  BudgetBand,
  ConditionStability,
  ConfidenceLevel,
  DentalOpticalTier,
  FitVerdict,
  FlagSeverity,
  IntakeSource,
  MaritalStatus,
  NetworkTier,
  PolicyStatus,
  PriorityTag,
  ProviderTier,
  RecoStatus,
  RelationshipType,
  ReviewAction,
  ReviewStatus,
  ReviewSubject,
  UserRole,
} from "../schema";
import { rebuildLedger, checkReplay } from "@/lib/servicing/store";
import fixtures from "./fixtures.json";
import { buildServicingSeed } from "./servicing";

const ts = (iso: string | null | undefined): Date | null => (iso == null ? null : new Date(iso));

// JSON imports type string columns as plain `string`, not the narrowed
// union `text(col, { enum: [...] })` expects. Values are hand-verified
// against db/seed/fixtures.json against every enum tuple in schema/enums.ts
// — this only narrows the type, it does not skip runtime validation (there
// is none at the DB level either; see the note in schema/enums.ts).
const lit = <T extends string>(value: string): T => value as T;
const litN = <T extends string>(value: string | null): T | null => value as T | null;

// Children first — mirrors the FK graph.
//
// The v2 AI/conversation tables lead, even though nothing seeds them yet: they
// reference `app_user`, `person`, `application`, `policy` and `review_task`,
// so the moment anything writes a conversation the v1 wipe below would fail on
// a foreign key. Cheap to delete from an empty table; expensive to debug later.
const tablesInDeleteOrder = [
  // v2 · AI & conversation layer
  schema.extraction,
  schema.conversationAction,
  schema.aiDecision,
  schema.modelRun,
  schema.conversationQuestion,
  schema.messageMedia,
  schema.message,
  schema.conversation,
  schema.channelIdentity,
  schema.messageTemplate,

  // v1 · core
  schema.planFitReassessment,
  // Before `servicingEvent`: a payout points at the event it pays for, so the log cannot be cleared under it.
  schema.claimSettlement,
  schema.benefitLedger,
  schema.servicingEvent,
  schema.policy,
  schema.reviewDecision,
  schema.reviewTask,
  schema.recommendationRejection,
  schema.recommendation,
  schema.quote,
  schema.assessmentFlag,
  schema.assessment,
  schema.networkAdmits,
  schema.plan,
  schema.carrier,
  schema.applicationExpectedProvider,
  schema.applicationPriority,
  schema.applicationNeed,
  schema.applicationProcedure,
  schema.applicationMedication,
  schema.applicationCondition,
  schema.applicationStatusHistory,
  schema.application,
  schema.person,
  schema.appUser,
];

// Built before the transaction so it is in scope for the summary, and so a bad fixture fails
// before anything is wiped. Pure: adjudicates every supplied event through lib/servicing.
const servicing = buildServicingSeed(fixtures, { appeals: process.env.SEED_APPEALS === "pending" ? "pending" : "decided" });

await db.run(sql`begin`);
try {
  // Only the seed may do this, and only here. See dropAppendOnlyGuards().
  dropAppendOnlyGuards();

  for (const table of tablesInDeleteOrder) {
    await db.delete(table);
  }

  await db.insert(schema.appUser).values(
    fixtures.app_user.map((row) => ({
      id: row.id,
      role: lit<UserRole>(row.role),
      fullName: row.full_name,
      email: row.email,
      phone: row.phone,
    })),
  );

  await db.insert(schema.person).values(
    fixtures.person.map((row) => ({
      id: row.id,
      externalRef: row.external_ref,
      ownerUserId: row.owner_user_id,
      relationshipToOwner: lit<RelationshipType>(row.relationship_to_owner),
      fullName: row.full_name,
      dateOfBirth: row.date_of_birth,
      maritalStatus: litN<MaritalStatus>(row.marital_status),
      smoker: row.smoker,
      emirate: row.emirate,
    })),
  );

  await db.insert(schema.application).values(
    fixtures.application.map((row) => ({
      id: row.id,
      reference: row.reference,
      personId: row.person_id,
      createdByUserId: row.created_by_user_id,
      intakeSource: lit<IntakeSource>(row.intake_source),
      status: lit<ApplicationStatus>(row.status),
      age: row.age,
      maritalStatus: litN<MaritalStatus>(row.marital_status),
      smoker: row.smoker,
      emirate: row.emirate,
      budget: lit<BudgetBand>(row.budget),
      policyInception: row.policy_inception,
      treatmentOutsideUaeExpected: row.treatment_outside_uae_expected,
      submittedAt: ts(row.submitted_at),
      confirmedAt: ts(row.confirmed_at),
      statusChangedAt: ts(row.status_changed_at) ?? undefined,
    })),
  );

  await db.insert(schema.applicationStatusHistory).values(
    fixtures.application_status_history.map((row) => ({
      id: row.id,
      applicationId: row.application_id,
      fromStatus: litN<ApplicationStatus>(row.from_status),
      toStatus: lit<ApplicationStatus>(row.to_status),
      changedBy: lit<ActorKind>(row.changed_by),
      changedByUserId: row.changed_by_user_id,
      reason: row.reason,
      changedAt: ts(row.changed_at) ?? undefined,
    })),
  );

  await db.insert(schema.applicationCondition).values(
    fixtures.application_condition.map((row) => ({
      id: row.id,
      applicationId: row.application_id,
      rawText: row.raw_text,
      conditionCode: row.condition_code,
      stability: lit<ConditionStability>(row.stability),
      declaredAtIntake: row.declared_at_intake,
      enteredByUserId: row.entered_by_user_id,
    })),
  );

  await db.insert(schema.applicationMedication).values(
    fixtures.application_medication.map((row) => ({
      id: row.id,
      applicationId: row.application_id,
      rawText: row.raw_text,
    })),
  );

  await db.insert(schema.applicationProcedure).values(
    fixtures.application_procedure.map((row) => ({
      id: row.id,
      applicationId: row.application_id,
      rawText: row.raw_text,
      occurredOn: row.occurred_on,
    })),
  );

  await db.insert(schema.applicationNeed).values(
    fixtures.application_need.map((row) => ({
      id: row.id,
      applicationId: row.application_id,
      rawText: row.raw_text,
      benefitClass: litN<BenefitClass>(row.benefit_class),
      horizonMonths: row.horizon_months,
    })),
  );

  await db.insert(schema.applicationPriority).values(
    fixtures.application_priority.map((row) => ({
      id: row.id,
      applicationId: row.application_id,
      rawText: row.raw_text,
      tag: lit<PriorityTag>(row.tag),
    })),
  );

  await db.insert(schema.applicationExpectedProvider).values(
    fixtures.application_expected_provider.map((row) => ({
      id: row.id,
      applicationId: row.application_id,
      providerName: row.provider_name,
      tier: litN<ProviderTier>(row.tier),
    })),
  );

  await db.insert(schema.carrier).values(fixtures.carrier.map((row) => ({ id: row.id, name: row.name })));

  await db.insert(schema.plan).values(
    fixtures.plan.map((row) => ({
      id: row.id,
      carrierId: row.carrier_id,
      name: row.name,
      annualPremium: row.annual_premium,
      deductible: row.deductible,
      network: lit<NetworkTier>(row.network),
      networkNote: row.network_note,
      outpatientCopayPct: row.outpatient_copay_pct,
      annualLimit: row.annual_limit,
      dentalOptical: lit<DentalOpticalTier>(row.dental_optical),
      maternityCovered: row.maternity_covered,
      maternityWaitingPeriodMonths: row.maternity_waiting_period_months,
      maternityLimit: row.maternity_limit,
      chronicCovered: row.chronic_covered,
      chronicWaitingPeriodMonths: row.chronic_waiting_period_months,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
    })),
  );

  await db.insert(schema.networkAdmits).values(
    fixtures.network_admits.map((row) => ({
      network: lit<NetworkTier>(row.network),
      providerTier: lit<ProviderTier>(row.provider_tier),
    })),
  );

  await db.insert(schema.assessment).values(
    fixtures.assessment.map((row) => ({
      id: row.id,
      applicationId: row.application_id,
      cohort: row.cohort,
      confidence: lit<ConfidenceLevel>(row.confidence),
      createdBy: lit<ActorKind>(row.created_by),
      createdByUserId: row.created_by_user_id,
      createdAt: ts(row.created_at) ?? undefined,
    })),
  );

  await db.insert(schema.assessmentFlag).values(
    fixtures.assessment_flag.map((row) => ({
      id: row.id,
      assessmentId: row.assessment_id,
      ruleCode: row.rule_code,
      severity: lit<FlagSeverity>(row.severity),
      fields: row.fields,
      reason: row.reason,
    })),
  );

  await db.insert(schema.quote).values(
    fixtures.quote.map((row) => ({
      id: row.id,
      applicationId: row.application_id,
      planId: row.plan_id,
      annualPremium: row.annual_premium,
      eligible: row.eligible,
      rank: row.rank,
      score: row.score,
      createdAt: ts(row.created_at) ?? undefined,
    })),
  );

  await db.insert(schema.recommendation).values(
    fixtures.recommendation.map((row) => ({
      id: row.id,
      applicationId: row.application_id,
      planId: row.plan_id,
      version: row.version,
      status: lit<RecoStatus>(row.status),
      brokerReasoning: row.broker_reasoning,
      memberReasoning: row.member_reasoning,
      createdBy: lit<ActorKind>(row.created_by),
      createdByUserId: row.created_by_user_id,
      createdAt: ts(row.created_at) ?? undefined,
    })),
  );

  await db.insert(schema.recommendationRejection).values(
    fixtures.recommendation_rejection.map((row) => ({
      id: row.id,
      recommendationId: row.recommendation_id,
      planId: row.plan_id,
      reason: row.reason,
    })),
  );

  await db.insert(schema.reviewTask).values(
    fixtures.review_task.map((row) => ({
      id: row.id,
      subjectType: lit<ReviewSubject>(row.subject_type),
      subjectId: row.subject_id,
      reason: row.reason,
      priorityScore: row.priority_score,
      status: lit<ReviewStatus>(row.status),
      assignedToUserId: row.assigned_to_user_id,
      resolvedAt: ts(row.resolved_at),
    })),
  );

  await db.insert(schema.reviewDecision).values(
    fixtures.review_decision.map((row) => ({
      id: row.id,
      reviewTaskId: row.review_task_id,
      actorUserId: row.actor_user_id,
      action: lit<ReviewAction>(row.action),
      notes: row.notes,
      payload: row.payload,
      decidedAt: ts(row.decided_at) ?? undefined,
    })),
  );

  await db.insert(schema.policy).values(
    fixtures.policy.map((row) => ({
      id: row.id,
      externalRef: row.external_ref,
      applicationId: row.application_id,
      personId: row.person_id,
      planId: row.plan_id,
      recommendationId: row.recommendation_id,
      policyNumber: row.policy_number,
      inceptionDate: row.inception_date,
      status: lit<PolicyStatus>(row.status),
      annualPremium: row.annual_premium,
    })),
  );

  // The servicing history is not typed in: every event is adjudicated by the engine and
  // the ledger is rebuilt by replaying the log (see `servicing` above the transaction).
  await db.insert(schema.servicingEvent).values(servicing.events);
  await db.insert(schema.reviewTask).values(servicing.tasks);
  if (servicing.decisions.length > 0) await db.insert(schema.reviewDecision).values(servicing.decisions);
  for (const row of fixtures.policy) await rebuildLedger(row.id);

  await db.insert(schema.planFitReassessment).values(
    fixtures.plan_fit_reassessment.map((row) => ({
      id: row.id,
      policyId: row.policy_id,
      triggeredByEventId: row.triggered_by_event_id,
      verdict: lit<FitVerdict>(row.verdict),
      recommendedPlanId: row.recommended_plan_id,
      brokerReasoning: row.broker_reasoning,
      memberReasoning: row.member_reasoning,
      createdBy: lit<ActorKind>(row.created_by),
      createdAt: ts(row.created_at) ?? undefined,
    })),
  );

  await db.run(sql`commit`);

} catch (error) {
  await db.run(sql`rollback`);
  throw error;
} finally {
  // Idempotent. After a commit this re-creates the guards; after a rollback
  // SQLite has already restored them with the rest of the transaction and
  // this is a no-op.
  applyAppendOnlyGuards();
}

// Payouts (§payouts), opened AFTER the commit and through the REAL code path rather than written as fixtures,
// so the seeded history can never disagree with what a live claim would produce: `owesPayment` alone decides
// which of the thirteen events owe anything, and the pre-authorizations and denials correctly open nothing.
// Two are then carried to their end states by the real verbs, so a fresh seed shows all three rather than a
// queue of identical untouched rows.
const settled = await seedSettlements(fixtures.policy);

// The seed checks its own work: the ledger it just wrote must equal a replay of the history it
// just wrote. Nothing else in the seed would notice a projection that had drifted from its log.

const reports = await Promise.all(fixtures.policy.map((row) => checkReplay(row.id)));
const drifted = reports.filter((report) => !report.ok);
if (drifted.length > 0) {
  console.error("seed produced a ledger that does not match its own history:");
  for (const report of drifted) console.error(report.policyId, report.ledgerDiffs, report.drifted);
  process.exit(1);
}

console.log("seeded:", {
  appUser: fixtures.app_user.length,
  person: fixtures.person.length,
  application: fixtures.application.length,
  applicationStatusHistory: fixtures.application_status_history.length,
  applicationCondition: fixtures.application_condition.length,
  applicationMedication: fixtures.application_medication.length,
  applicationProcedure: fixtures.application_procedure.length,
  applicationNeed: fixtures.application_need.length,
  applicationPriority: fixtures.application_priority.length,
  applicationExpectedProvider: fixtures.application_expected_provider.length,
  carrier: fixtures.carrier.length,
  plan: fixtures.plan.length,
  networkAdmits: fixtures.network_admits.length,
  assessment: fixtures.assessment.length,
  assessmentFlag: fixtures.assessment_flag.length,
  quote: fixtures.quote.length,
  recommendation: fixtures.recommendation.length,
  recommendationRejection: fixtures.recommendation_rejection.length,
  reviewTask: fixtures.review_task.length,
  reviewDecision: fixtures.review_decision.length,
  policy: fixtures.policy.length,
  servicingEvent: servicing.events.length,
  benefitLedger: fixtures.policy.length,
  planFitReassessment: fixtures.plan_fit_reassessment.length,
  claimSettlement: `${settled.opened} opened, ${settled.approved} approved, ${settled.paid} paid`,
  replayChecked: `${reports.length} of ${fixtures.policy.length} policies`,
});

/**
 * Open payouts for the seeded history, and carry two of them to their end states.
 *
 * Deliberately driven through `openSettlementForEvent`, `approvePayment` and `markPaid` — the same functions a
 * live claim uses — so this can never seed a payout the real system would not have created, or a state it could
 * not have reached. A fixture table of settlement rows would drift the first time the rule changed.
 */
async function seedSettlements(policies: { id: string }[]): Promise<{ opened: number; approved: number; paid: number }> {
  const { openSettlementForEvent, approvePayment, markPaid } = await import("@/lib/ai/servicing-settlement");
  const advisor = (await db.select().from(schema.appUser)).find((u) => u.role === "advisor");
  if (!advisor) return { opened: 0, approved: 0, paid: 0 };

  for (const row of policies) {
    const events = await db.select({ id: schema.servicingEvent.id }).from(schema.servicingEvent).where(eq(schema.servicingEvent.policyId, row.id));
    for (const e of events) await openSettlementForEvent(row.id, e.id);
  }

  const opened = await db.select().from(schema.claimSettlement);
  const taskOf = new Map(
    (await db.select().from(schema.reviewTask).where(eq(schema.reviewTask.subjectType, "settlement"))).map((t) => [t.subjectId, t.id]),
  );
  /** The event a demo state is pinned to, by its stable external reference — never by position. */
  const taskFor = async (eventRef: string) => {
    const [event] = await db.select({ id: schema.servicingEvent.id }).from(schema.servicingEvent).where(eq(schema.servicingEvent.externalRef, eventRef));
    const settlement = event ? opened.find((s) => s.servicingEventId === event.id) : undefined;
    return settlement ? (taskOf.get(settlement.id) ?? null) : null;
  };

  let approved = 0;
  let paid = 0;
  // CLM-1: approved and paid — the member's card shows a date they could check against their bank.
  const clm1 = await taskFor("CLM-1");
  if (clm1) {
    if ((await approvePayment({ taskId: clm1, advisorUserId: advisor.id, note: "Invoice matched the clinic's own reference; released." })).ok) approved += 1;
    if ((await markPaid({ taskId: clm1, advisorUserId: advisor.id, paymentReference: "TRF-20260115-001" })).ok) paid += 1;
  }
  // CLM-2: approved, NOT paid — the state that proves the two verbs are genuinely separate.
  const clm2 = await taskFor("CLM-2");
  if (clm2 && (await approvePayment({ taskId: clm2, advisorUserId: advisor.id, note: "Maternity cap applied correctly; approved for payment run." })).ok) approved += 1;

  return { opened: opened.length, approved, paid };
}
