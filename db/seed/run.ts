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
import { sql } from "drizzle-orm";
import { applyAppendOnlyGuards, db, dropAppendOnlyGuards } from "../client";
import * as schema from "../schema";
import type {
  ActorKind,
  ApplicationStatus,
  BenefitClass,
  BudgetBand,
  CareSetting,
  ConditionStability,
  ConfidenceLevel,
  DentalOpticalTier,
  EventKind,
  EventOutcome,
  FitVerdict,
  FlagSeverity,
  IntakeSource,
  MaritalStatus,
  NetworkTier,
  PolicyStatus,
  PriorityTag,
  ProviderTier,
  ReasonCode,
  RecoStatus,
  RelationshipType,
  ReviewAction,
  ReviewStatus,
  ReviewSubject,
  UserRole,
} from "../schema";
import fixtures from "./fixtures.json";

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

  await db.insert(schema.servicingEvent).values(
    fixtures.servicing_event.map((row) => ({
      id: row.id,
      externalRef: row.external_ref,
      policyId: row.policy_id,
      kind: lit<EventKind>(row.kind),
      policyMonth: row.policy_month,
      benefitClass: litN<BenefitClass>(row.benefit_class),
      setting: litN<CareSetting>(row.setting),
      providerTier: litN<ProviderTier>(row.provider_tier),
      billedAmount: row.billed_amount,
      estimatedAmount: row.estimated_amount,
      description: row.description,
      evidenceText: row.evidence_text,
      submittedByUserId: row.submitted_by_user_id,
      occurredOn: row.occurred_on,
      outcome: litN<EventOutcome>(row.outcome),
      reasonCode: litN<ReasonCode>(row.reason_code),
      planPays: row.plan_pays,
      memberPays: row.member_pays,
      calculation: row.calculation,
      ledgerBefore: row.ledger_before,
      ledgerAfter: row.ledger_after,
      memberExplanation: row.member_explanation,
      brokerExplanation: row.broker_explanation,
      decidedBy: litN<ActorKind>(row.decided_by),
      decidedByUserId: row.decided_by_user_id,
      supersedesEventId: row.supersedes_event_id,
      appealOfEventId: row.appeal_of_event_id,
    })),
  );

  await db.insert(schema.benefitLedger).values(
    fixtures.benefit_ledger.map((row) => ({
      policyId: row.policy_id,
      deductibleMet: row.deductible_met,
      annualPaid: row.annual_paid,
      sublimitUsed: row.sublimit_used,
      lastEventId: row.last_event_id,
    })),
  );

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
  servicingEvent: fixtures.servicing_event.length,
  benefitLedger: fixtures.benefit_ledger.length,
  planFitReassessment: fixtures.plan_fit_reassessment.length,
});
