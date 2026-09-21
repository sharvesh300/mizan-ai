// Read layer. Everything the UI renders comes from here, so the two audiences
// stay honest: the applicant-facing helpers never select a broker-only column
// (cohort, flags, reviewer decisions, confidence), and the broker helpers
// return the whole record.

import { and, asc, desc, eq, gt, inArray, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { cohortLabel } from "@/lib/domain";
import { loadAssessmentRecord } from "@/lib/assessment/load";
import type { PlanTerms } from "@/lib/assessment";
import { estimateAnnualCost } from "@/lib/recommendation/cost";
import { buildScenario, scenarioForRecord } from "@/lib/recommendation/scenarios";
import {
  aiDecision,
  application,
  applicationCondition,
  applicationExpectedProvider,
  applicationNeed,
  applicationPriority,
  applicationStatusHistory,
  appUser,
  assessment,
  assessmentFlag,
  benefitLedger,
  conversation,
  conversationAction,
  conversationQuestion,
  message,
  person,
  plan,
  planFitReassessment,
  policy,
  quote,
  recommendation,
  recommendationRejection,
  reviewDecision,
  reviewTask,
  servicingEvent,
  type ConfidenceLevel,
} from "@/db/schema";

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

/** Applications owned by this user (their own + any dependants they hold). */
export async function listApplicationsForUser(userId: string) {
  return db
    .select({
      id: application.id,
      reference: application.reference,
      status: application.status,
      intakeSource: application.intakeSource,
      createdAt: application.createdAt,
      statusChangedAt: application.statusChangedAt,
      personName: person.fullName,
      relationship: person.relationshipToOwner,
      planName: plan.name,
      policyId: policy.id,
    })
    .from(application)
    .innerJoin(person, eq(application.personId, person.id))
    .leftJoin(policy, eq(policy.applicationId, application.id))
    .leftJoin(plan, eq(policy.planId, plan.id))
    .where(eq(person.ownerUserId, userId))
    .orderBy(desc(application.createdAt));
}

/**
 * Every application, for the advisor's pipeline board.
 *
 * An application can carry more than one assessment — an advisor correcting a
 * cohort appends rather than overwrites — so the join is de-duplicated to the
 * newest one per application. Without that, correcting a cohort makes the
 * application appear twice in the pipeline, once under each label.
 */
export async function listAllApplications() {
  const rows = await db
    .select({
      id: application.id,
      reference: application.reference,
      status: application.status,
      intakeSource: application.intakeSource,
      age: application.age,
      budget: application.budget,
      createdAt: application.createdAt,
      statusChangedAt: application.statusChangedAt,
      personName: person.fullName,
      ownerName: appUser.fullName,
      cohort: assessment.cohort,
      confidence: assessment.confidence,
      assessedAt: assessment.createdAt,
      planName: plan.name,
      policyId: policy.id,
    })
    .from(application)
    .innerJoin(person, eq(application.personId, person.id))
    .innerJoin(appUser, eq(person.ownerUserId, appUser.id))
    .leftJoin(assessment, eq(assessment.applicationId, application.id))
    .leftJoin(policy, eq(policy.applicationId, application.id))
    .leftJoin(plan, eq(policy.planId, plan.id))
    .orderBy(desc(application.statusChangedAt), desc(assessment.createdAt));

  // First row per application is its newest assessment, given the ordering.
  const seen = new Set<string>();
  return rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
}

/** The intake snapshot — safe for either audience. */
export async function getApplication(applicationId: string) {
  const [row] = await db
    .select({
      application,
      person,
      owner: { id: appUser.id, fullName: appUser.fullName, email: appUser.email },
    })
    .from(application)
    .innerJoin(person, eq(application.personId, person.id))
    .innerJoin(appUser, eq(person.ownerUserId, appUser.id))
    .where(eq(application.id, applicationId))
    .limit(1);
  return row ?? null;
}

/** What the applicant told us. Their own words — shown to both audiences. */
export async function getDeclared(applicationId: string) {
  const [conditions, needs, priorities, providers, history] = await Promise.all([
    db.select().from(applicationCondition).where(eq(applicationCondition.applicationId, applicationId)),
    db.select().from(applicationNeed).where(eq(applicationNeed.applicationId, applicationId)),
    db.select().from(applicationPriority).where(eq(applicationPriority.applicationId, applicationId)),
    db.select().from(applicationExpectedProvider).where(eq(applicationExpectedProvider.applicationId, applicationId)),
    db
      .select()
      .from(applicationStatusHistory)
      .where(eq(applicationStatusHistory.applicationId, applicationId))
      .orderBy(asc(applicationStatusHistory.changedAt)),
  ]);
  return { conditions, needs, priorities, providers, history };
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/**
 * Every intake conversation this user has started, most recent first, with a
 * one-line preview of the last message. Drives the chat history list, so
 * "start a new chat" and "pick up an old one" are both real choices instead
 * of the app silently deciding for the applicant.
 */
export async function listIntakeConversations(userId: string) {
  const conversations = await db
    .select({
      id: conversation.id,
      status: conversation.status,
      startedAt: conversation.startedAt,
      applicationId: conversation.applicationId,
      personName: person.fullName,
      relationship: person.relationshipToOwner,
      reference: application.reference,
    })
    .from(conversation)
    .leftJoin(application, eq(conversation.applicationId, application.id))
    .leftJoin(person, eq(application.personId, person.id))
    .where(and(eq(conversation.userId, userId), eq(conversation.purpose, "intake")))
    .orderBy(desc(conversation.startedAt));

  if (conversations.length === 0) return [];

  const messages = await db
    .select({ conversationId: message.conversationId, bodyText: message.bodyText })
    .from(message)
    .where(inArray(message.conversationId, conversations.map((c) => c.id)))
    .orderBy(desc(message.seq));

  // First hit per conversation is the latest, since `messages` is seq-desc.
  const previewByConversation = new Map<string, string>();
  for (const m of messages) {
    if (m.bodyText && !previewByConversation.has(m.conversationId)) {
      previewByConversation.set(m.conversationId, m.bodyText);
    }
  }

  return conversations.map((c) => ({ ...c, preview: previewByConversation.get(c.id) ?? null }));
}

/** All three plans priced for this application, best-ranked first. */
export async function getQuotes(applicationId: string) {
  return db
    .select({
      id: quote.id,
      planId: quote.planId,
      annualPremium: quote.annualPremium,
      eligible: quote.eligible,
      rank: quote.rank,
      score: quote.score,
      plan,
    })
    .from(quote)
    .innerJoin(plan, eq(quote.planId, plan.id))
    .where(eq(quote.applicationId, applicationId))
    .orderBy(asc(quote.rank));
}

/**
 * What a realistic year on each plan would actually cost this applicant.
 *
 * This exists because the broker view used to print `quote.score` as a "fit
 * score". That column holds `1 / (1 + totalOutlay)` (lib/recommendation/quote.ts)
 * — for an 8,900 premium, 0.000112 — so three plans rendered as three
 * "0.00"s in the one panel where an advisor compares them. The number that
 * actually separates the three plans is the one the quoting pass ranked them
 * on in the first place: premium plus what the applicant pays at the point of
 * care under the scenario their own record implies.
 *
 * Every figure carries the scenario and constants version that produced it,
 * because both are declared modelling assumptions, not facts — the same
 * discipline the tool layer applies wherever this number is spoken.
 */
export async function getQuoteOutlays(applicationId: string): Promise<{
  scenarioId: string;
  constantsVersion: string;
  outpatientVisits: number;
  inpatientAdmissions: number;
  byPlanId: Record<string, number>;
} | null> {
  const [loaded, catalogue] = await Promise.all([loadAssessmentRecord(applicationId), loadCatalogueTerms()]);
  if (!loaded || catalogue.length === 0) return null;

  const scenarioId = scenarioForRecord(loaded.record);
  const scenario = buildScenario(scenarioId, loaded.record);

  return {
    scenarioId,
    constantsVersion: scenario.constantsVersion,
    outpatientVisits: scenario.basket.outpatientVisits,
    inpatientAdmissions: scenario.basket.inpatientAdmissions,
    byPlanId: Object.fromEntries(
      catalogue.map((terms) => [terms.id, estimateAnnualCost(terms, scenario).total]),
    ),
  };
}

/**
 * Plan terms in the shape the cost model reads. Deliberately not
 * `loadCatalogue` from lib/ai/assessment-session — that module pulls the graph
 * and the model client in with it, and a page reading a number has no reason
 * to load either.
 */
async function loadCatalogueTerms(): Promise<PlanTerms[]> {
  const rows = await db.select().from(plan);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    annualPremium: row.annualPremium,
    deductible: row.deductible,
    outpatientCopayPct: row.outpatientCopayPct,
    annualLimit: row.annualLimit,
    network: row.network,
    maternityCovered: row.maternityCovered,
    maternityLimit: row.maternityLimit,
    maternityWaitingPeriodMonths: row.maternityWaitingPeriodMonths,
    chronicCovered: row.chronicCovered,
    chronicWaitingPeriodMonths: row.chronicWaitingPeriodMonths,
    dentalOptical: row.dentalOptical,
  }));
}


// ---------------------------------------------------------------------------
// Advisor dashboard
// ---------------------------------------------------------------------------

/**
 * The stages an application passes through, in order.
 *
 * Exported because the dashboard funnel and the pipeline board both count by
 * them, and a book that reads two different ways on two pages is worse than
 * one that reads badly on both. Coarser than `application_status` on purpose:
 * fourteen statuses is the schema's vocabulary, not a broker's.
 */
export const FUNNEL_STAGES = [
  { key: "in_intake", label: "In intake", statuses: ["draft", "in_intake"] },
  { key: "submitted", label: "Submitted", statuses: ["submitted"] },
  { key: "assessed", label: "Assessed", statuses: ["assessed", "in_review"] },
  { key: "recommended", label: "Recommended", statuses: ["recommended"] },
  { key: "chosen", label: "Plan chosen", statuses: ["plan_selected"] },
  { key: "issued", label: "Policy live", statuses: ["policy_issued"] },
] as const;

/** An application nobody has touched for this long is starving, whatever its priority score. */
const STALE_DAYS = 7;

const DAY_MS = 86_400_000;
const daysSince = (value: Date | string | null | undefined): number | null => {
  if (value == null) return null;
  const then = typeof value === "string" ? new Date(value) : value;
  return Math.floor((Date.now() - then.getTime()) / DAY_MS);
};

/**
 * Everything the advisor dashboard renders, in one pass.
 *
 * The figures deliberately mix two questions a broker asks at the same time
 * and used to have to answer on three different pages: how much work is
 * waiting on me (queue depth, the oldest thing still waiting, what has
 * stalled), and what is the book doing (applications per stage, premium
 * quoted, premium live).
 *
 * Both money figures are ANNUALISED and INDICATIVE. Pipeline premium is the
 * recommended plan's quoted premium on applications that have not converted —
 * a quote, not a booking — and it is labelled that way wherever it renders.
 */
export async function getAdvisorDashboard() {
  const [queue, applications, policies, decisions] = await Promise.all([
    listQueue(),
    listAllApplications(),
    listAllPolicies(),
    db
      .select({
        decision: reviewDecision,
        actor: { id: appUser.id, fullName: appUser.fullName },
        subjectType: reviewTask.subjectType,
        subjectId: reviewTask.subjectId,
      })
      .from(reviewDecision)
      .innerJoin(appUser, eq(reviewDecision.actorUserId, appUser.id))
      .innerJoin(reviewTask, eq(reviewDecision.reviewTaskId, reviewTask.id))
      .where(gt(reviewDecision.decidedAt, new Date(Date.now() - 7 * DAY_MS)))
      .orderBy(desc(reviewDecision.decidedAt)),
  ]);

  const live = applications.filter(
    (row) => !["policy_issued", "declined", "withdrawn", "expired"].includes(row.status),
  );

  // Premium quoted against applications still in play. Read off the LIVE
  // recommendation's plan rather than the application row, so it follows an
  // applicant who picked something other than what was suggested (`pickPlan`
  // makes their choice the live row) and excludes superseded rounds.
  const quoted = await db
    .select({ applicationId: recommendation.applicationId, annualPremium: plan.annualPremium })
    .from(recommendation)
    .innerJoin(plan, eq(recommendation.planId, plan.id))
    .innerJoin(application, eq(recommendation.applicationId, application.id))
    .where(
      and(
        inArray(application.status, ["recommended", "plan_selected"]),
        inArray(recommendation.status, ["pending_review", "approved", "edited", "overridden"]),
      ),
    );

  const oldestWaiting = queue.reduce<number | null>((oldest, row) => {
    const age = daysSince(row.task.createdAt);
    return age == null ? oldest : oldest == null || age > oldest ? age : oldest;
  }, null);

  return {
    queue,
    counts: {
      queueOpen: queue.length,
      queueUnassigned: queue.filter((row) => !row.assignee).length,
      oldestWaitingDays: oldestWaiting,
      inFlight: live.length,
      policiesLive: policies.filter(({ policy: row }) => row.status === "active").length,
    },
    money: {
      pipelineAnnual: quoted.reduce((sum, row) => sum + row.annualPremium, 0),
      pipelineCount: quoted.length,
      liveAnnual: policies
        .filter(({ policy: row }) => row.status === "active")
        .reduce((sum, { policy: row }) => sum + row.annualPremium, 0),
    },
    funnel: FUNNEL_STAGES.map((stage) => ({
      key: stage.key,
      label: stage.label,
      count: applications.filter((row) => (stage.statuses as readonly string[]).includes(row.status)).length,
    })),
    /**
     * Where the system is unsure, across the whole open queue rather than one
     * row at a time. A book with ten low-confidence records waiting is a
     * different morning from one with ten the system is sure of, and the
     * queue's own ordering cannot say that at a glance.
     */
    uncertainty: (["low", "medium", "high"] as const).map((level) => ({
      level,
      count: queue.filter((row) => row.subject?.confidence === level).length,
    })),
    /** Open applications nobody has moved in a week. Priority ordering starves these. */
    stalled: live
      .map((row) => ({ ...row, idleDays: daysSince(row.statusChangedAt) ?? 0 }))
      .filter((row) => row.idleDays >= STALE_DAYS)
      .sort((a, b) => b.idleDays - a.idleDays)
      .slice(0, 5),
    /**
     * Who decided what this week — the record of human judgement, per the
     * brief. "Approved · Karim · Tuesday" six times over says nothing without
     * the subject, so each row carries the record it was about.
     */
    decisions: await withSubjects(decisions.slice(0, 6)),
    decisionsThisWeek: decisions.length,
  };
}


/**
 * Name what a review decision was about.
 *
 * `review_task.subject_id` is polymorphic (SCHEMA.md §2.6), so an application
 * id and a recommendation id are resolved separately and then merged back onto
 * the rows in one pass — a join cannot do it, and a query per row would be six
 * round trips for a panel.
 */
async function withSubjects<T extends { subjectType: string; subjectId: string }>(rows: T[]) {
  if (rows.length === 0) return [] as (T & { subject: { reference: string; personName: string; applicationId: string } | null })[];

  const applicationIds = rows.filter((row) => row.subjectType === "application").map((row) => row.subjectId);
  const recommendationIds = rows.filter((row) => row.subjectType === "recommendation").map((row) => row.subjectId);

  const [apps, recos] = await Promise.all([
    applicationIds.length
      ? db
          .select({ id: application.id, reference: application.reference, personName: person.fullName })
          .from(application)
          .innerJoin(person, eq(application.personId, person.id))
          .where(inArray(application.id, applicationIds))
      : [],
    recommendationIds.length
      ? db
          .select({
            id: recommendation.id,
            applicationId: application.id,
            reference: application.reference,
            personName: person.fullName,
          })
          .from(recommendation)
          .innerJoin(application, eq(recommendation.applicationId, application.id))
          .innerJoin(person, eq(application.personId, person.id))
          .where(inArray(recommendation.id, recommendationIds))
      : [],
  ]);

  const byApplication = new Map(apps.map((row) => [row.id, { ...row, applicationId: row.id }]));
  const byRecommendation = new Map(recos.map((row) => [row.id, row]));

  return rows.map((row) => ({
    ...row,
    subject:
      row.subjectType === "application"
        ? byApplication.get(row.subjectId) ?? null
        : byRecommendation.get(row.subjectId) ?? null,
  }));
}


// ---------------------------------------------------------------------------
// Clients — the CRM spine
// ---------------------------------------------------------------------------

/**
 * Everyone this brokerage covers or is trying to cover, one row per PERSON.
 *
 * The product had no such page. It has 13 people against 43 applications, and
 * every screen was keyed on an application — so the fact that one applicant
 * has six open applications existed only as a flag fired inside one of them
 * (`duplicate_open_application`). A brokerage works relationships, not
 * records; this is the list that says so.
 */
export async function listClients() {
  const [people, applications, policies] = await Promise.all([
    db
      .select({ person, ownerName: appUser.fullName, ownerEmail: appUser.email })
      .from(person)
      .innerJoin(appUser, eq(person.ownerUserId, appUser.id)),
    db
      .select({
        personId: application.personId,
        id: application.id,
        status: application.status,
        statusChangedAt: application.statusChangedAt,
        createdAt: application.createdAt,
      })
      .from(application),
    db
      .select({
        personId: policy.personId,
        status: policy.status,
        annualPremium: policy.annualPremium,
        inceptionDate: policy.inceptionDate,
      })
      .from(policy),
  ]);

  const CLOSED = ["policy_issued", "declined", "withdrawn", "expired"];

  return people
    .map(({ person: row, ownerName, ownerEmail }) => {
      const mine = applications.filter((a) => a.personId === row.id);
      const cover = policies.filter((p) => p.personId === row.id && p.status === "active");
      const open = mine.filter((a) => !CLOSED.includes(a.status));
      const lastMoved = mine.reduce<Date | null>((latest, a) => {
        const at = a.statusChangedAt ?? a.createdAt;
        return at && (!latest || at > latest) ? at : latest;
      }, null);

      return {
        id: row.id,
        fullName: row.fullName,
        relationshipToOwner: row.relationshipToOwner,
        emirate: row.emirate,
        ownerName,
        ownerEmail,
        applications: mine.length,
        openApplications: open.length,
        policies: cover.length,
        liveAnnual: cover.reduce((sum, p) => sum + p.annualPremium, 0),
        lastMoved,
        /**
         * One word for where this relationship stands, chosen most-committed
         * first: cover in force outranks an open application, which outranks
         * a closed history.
         */
        state: (cover.length > 0
          ? "covered"
          : open.length > 0
            ? "in_progress"
            : mine.length > 0
              ? "closed"
              : "no_activity") as "covered" | "in_progress" | "closed" | "no_activity",
      };
    })
    .sort((a, b) => (b.lastMoved?.getTime() ?? 0) - (a.lastMoved?.getTime() ?? 0));
}

export type ClientRow = Awaited<ReturnType<typeof listClients>>[number];

/** One person's header facts, their cover, applications and conversations. */
export async function getClient(personId: string) {
  const [row] = await db
    .select({ person, ownerName: appUser.fullName, ownerEmail: appUser.email, ownerPhone: appUser.phone })
    .from(person)
    .innerJoin(appUser, eq(person.ownerUserId, appUser.id))
    .where(eq(person.id, personId))
    .limit(1);
  if (!row) return null;

  const [applications, policies, conversations] = await Promise.all([
    db
      .select({
        id: application.id,
        reference: application.reference,
        status: application.status,
        intakeSource: application.intakeSource,
        age: application.age,
        budget: application.budget,
        createdAt: application.createdAt,
        statusChangedAt: application.statusChangedAt,
        cohort: assessment.cohort,
        confidence: assessment.confidence,
      })
      .from(application)
      .leftJoin(assessment, eq(assessment.applicationId, application.id))
      .where(eq(application.personId, personId))
      .orderBy(desc(application.statusChangedAt), desc(assessment.createdAt)),
    db
      .select({ policy, plan, ledger: benefitLedger })
      .from(policy)
      .innerJoin(plan, eq(policy.planId, plan.id))
      .leftJoin(benefitLedger, eq(benefitLedger.policyId, policy.id))
      .where(eq(policy.personId, personId))
      .orderBy(desc(policy.createdAt)),
    db
      .select({
        id: conversation.id,
        status: conversation.status,
        channel: conversation.channel,
        startedAt: conversation.startedAt,
        applicationId: conversation.applicationId,
      })
      .from(conversation)
      .innerJoin(application, eq(conversation.applicationId, application.id))
      .where(eq(application.personId, personId))
      .orderBy(desc(conversation.startedAt)),
  ]);

  // The application join above can return a row per assessment; keep the newest.
  const seen = new Set<string>();
  const unique = applications.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));

  return { ...row, applications: unique, policies, conversations };
}

/** One thing that happened to a client, normalised across seven tables. */
export type TimelineEntry = {
  at: Date;
  kind: "application" | "assessment" | "flag" | "recommendation" | "decision" | "policy" | "servicing" | "reassessment";
  title: string;
  detail: string | null;
  /** Who did it. `null` means the system. */
  actor: string | null;
  href: string | null;
  /** A rule code or reason code, when the row carried one. */
  code?: string | null;
};

/**
 * Everything that has happened to one client, in one list.
 *
 * Assembled rather than joined: these rows live in seven tables with no common
 * shape, and the question a broker asks before a call — "what has actually
 * happened with this person" — cannot be answered from any one of them. Each
 * source contributes `{ at, kind, title, detail, actor }` and the merge sorts
 * once, newest first.
 */
export async function getClientTimeline(personId: string): Promise<TimelineEntry[]> {
  const applications = await db
    .select({ id: application.id, reference: application.reference })
    .from(application)
    .where(eq(application.personId, personId));
  if (applications.length === 0) return [];

  const ids = applications.map((a) => a.id);
  const refOf = new Map(applications.map((a) => [a.id, a.reference]));

  const [history, assessments, recommendations, decisions, policies] = await Promise.all([
    db
      .select({ row: applicationStatusHistory, actor: appUser.fullName })
      .from(applicationStatusHistory)
      .leftJoin(appUser, eq(applicationStatusHistory.changedByUserId, appUser.id))
      .where(inArray(applicationStatusHistory.applicationId, ids)),
    db.select().from(assessment).where(inArray(assessment.applicationId, ids)),
    db
      .select({ row: recommendation, planName: plan.name })
      .from(recommendation)
      .innerJoin(plan, eq(recommendation.planId, plan.id))
      .where(inArray(recommendation.applicationId, ids)),
    db
      .select({ row: reviewDecision, task: reviewTask, actor: appUser.fullName })
      .from(reviewDecision)
      .innerJoin(reviewTask, eq(reviewDecision.reviewTaskId, reviewTask.id))
      .innerJoin(appUser, eq(reviewDecision.actorUserId, appUser.id))
      .where(inArray(reviewTask.subjectId, ids)),
    db
      .select({ row: policy, planName: plan.name })
      .from(policy)
      .innerJoin(plan, eq(policy.planId, plan.id))
      .where(eq(policy.personId, personId)),
  ]);

  const flags = assessments.length
    ? await db
        .select()
        .from(assessmentFlag)
        .where(inArray(assessmentFlag.assessmentId, assessments.map((a) => a.id)))
    : [];

  const events = policies.length
    ? await db
        .select()
        .from(servicingEvent)
        .where(inArray(servicingEvent.policyId, policies.map((p) => p.row.id)))
    : [];

  const reassessments = policies.length
    ? await db
        .select()
        .from(planFitReassessment)
        .where(inArray(planFitReassessment.policyId, policies.map((p) => p.row.id)))
    : [];

  const entries: TimelineEntry[] = [
    ...history.map(({ row, actor }) => ({
      at: row.changedAt,
      kind: "application" as const,
      title: `${refOf.get(row.applicationId) ?? "Application"} → ${row.toStatus.replace(/_/g, " ")}`,
      detail: row.reason,
      actor: row.changedBy === "system" ? null : actor,
      href: `/applications/${row.applicationId}`,
    })),
    ...assessments.map((row) => ({
      at: row.createdAt,
      kind: "assessment" as const,
      title: `Classified as ${cohortLabel(row.cohort)}`,
      detail: `${row.confidence} confidence`,
      actor: null,
      href: `/applications/${row.applicationId}`,
    })),
    ...flags.map((row) => {
      const parent = assessments.find((a) => a.id === row.assessmentId);
      return {
        at: parent?.createdAt ?? new Date(0),
        kind: "flag" as const,
        title: `Flag fired: ${row.ruleCode}`,
        detail: row.reason,
        actor: null,
        href: parent ? `/applications/${parent.applicationId}` : null,
        code: row.ruleCode,
      };
    }),
    ...recommendations.map(({ row, planName }) => ({
      at: row.createdAt,
      kind: "recommendation" as const,
      title: `Recommended ${planName}`,
      detail: row.uncertaintyReason,
      actor: row.createdBy === "system" ? null : "advisor",
      href: `/applications/${row.applicationId}`,
    })),
    ...decisions.map(({ row, task, actor }) => ({
      at: row.decidedAt,
      kind: "decision" as const,
      title: `${row.action.replace(/_/g, " ")} on ${task.subjectType.replace(/_/g, " ")}`,
      detail: row.notes,
      actor,
      href: `/applications/${task.subjectId}`,
    })),
    ...policies.map(({ row, planName }) => ({
      at: row.createdAt,
      kind: "policy" as const,
      title: `Policy issued — ${planName}`,
      detail: `${row.policyNumber}, cover from ${row.inceptionDate}`,
      actor: null,
      href: `/policies/${row.id}`,
    })),
    ...events.map((row) => ({
      at: row.createdAt,
      kind: "servicing" as const,
      title: `${row.kind.replace(/_/g, " ")}${row.outcome ? ` — ${row.outcome.replace(/_/g, " ")}` : ""}`,
      detail: row.description,
      actor: null,
      href: `/policies/${row.policyId}`,
      code: row.reasonCode,
    })),
    ...reassessments.map((row) => ({
      at: row.createdAt,
      kind: "reassessment" as const,
      title: `Fit reassessed — ${row.verdict.replace(/_/g, " ")}`,
      detail: row.brokerReasoning,
      actor: null,
      href: `/policies/${row.policyId}`,
    })),
  ];

  return entries
    .filter((entry) => entry.at != null)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}


/**
 * The book as columns — every application that is still in play, grouped by
 * stage and ordered oldest-first inside each one.
 *
 * Oldest-first, not newest: a column is a queue, and the thing worth seeing at
 * the top of one is what has been sitting there longest. `daysInStage` is
 * carried per row for the same reason.
 *
 * Closed applications are excluded except for `policy_issued`, which is the
 * board's last column and the point of the whole pipeline. Declined and
 * withdrawn records are history, not work.
 */
export async function getPipeline() {
  const rows = await listAllApplications();

  return FUNNEL_STAGES.map((stage) => {
    const cards = rows
      .filter((row) => (stage.statuses as readonly string[]).includes(row.status))
      .map((row) => ({ ...row, daysInStage: daysSince(row.statusChangedAt) ?? 0 }))
      .sort((a, b) => b.daysInStage - a.daysInStage);

    // No per-column aggregates here: the page filters these cards before it
    // renders them, so a count or a worst-case computed now would describe a
    // column the advisor is not looking at. The header derives its own from
    // whatever survives the filter.
    return { key: stage.key, label: stage.label, cards };
  });
}

export type PipelineStage = Awaited<ReturnType<typeof getPipeline>>[number];

/** The live recommendation plus why the other two plans lost. */
export async function getRecommendation(applicationId: string) {
  const [row] = await db
    .select({ recommendation, plan })
    .from(recommendation)
    .innerJoin(plan, eq(recommendation.planId, plan.id))
    .where(eq(recommendation.applicationId, applicationId))
    .orderBy(desc(recommendation.version))
    .limit(1);
  if (!row) return null;

  const rejections = await db
    .select({ planId: recommendationRejection.planId, reason: recommendationRejection.reason, plan })
    .from(recommendationRejection)
    .innerJoin(plan, eq(recommendationRejection.planId, plan.id))
    .where(eq(recommendationRejection.recommendationId, row.recommendation.id));

  return { ...row, rejections };
}

/** BROKER ONLY. Cohort assignment and the flags that fired, with their reasons. */
export async function getAssessment(applicationId: string) {
  const [row] = await db
    .select()
    .from(assessment)
    .where(eq(assessment.applicationId, applicationId))
    .orderBy(desc(assessment.createdAt))
    .limit(1);
  if (!row) return null;
  const flags = await db.select().from(assessmentFlag).where(eq(assessmentFlag.assessmentId, row.id));
  return { ...row, flags };
}

/**
 * BROKER ONLY. The system's own account of the classification it made — how
 * sure it was, and why it thinks a person should look. The applicant sees the
 * outcome of this, never the reasoning about how certain we were.
 */
export async function getClassificationDecision(applicationId: string) {
  const [row] = await db
    .select()
    .from(aiDecision)
    .where(
      and(eq(aiDecision.subjectId, applicationId), eq(aiDecision.decisionType, "cohort_classification")),
    )
    .orderBy(desc(aiDecision.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * BROKER ONLY. The recommendation agent's own account of its shortlist — the
 * criteria and weights it chose, the scenario and its provenance, the citation
 * check, and why this one needs a human. Same shape as
 * `getClassificationDecision`, one decisionType over.
 */
export async function getRecommendationDecision(applicationId: string) {
  const [row] = await db
    .select()
    .from(aiDecision)
    .where(and(eq(aiDecision.subjectId, applicationId), eq(aiDecision.decisionType, "plan_recommendation")))
    .orderBy(desc(aiDecision.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * A recommendation review task is **Review 2** — the applicant's own choice,
 * the one that gates policy issuance (doc §2.2) — iff the applicant has
 * actually picked a plan off it: a `select_plan` conversation_action whose
 * `subjectId` is this recommendation (written by `pickPlan`,
 * app/applications/new/actions.ts). Any other recommendation task is
 * **Review 1.5**, the pre-presentation quality check that now runs in
 * parallel with the applicant seeing the card (doc §3.7's gate) rather than
 * ahead of it — approving one must never issue a policy nobody chose.
 */
export async function isSelectionReview(recommendationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: conversationAction.id })
    .from(conversationAction)
    .where(
      and(
        eq(conversationAction.actionType, "select_plan"),
        eq(conversationAction.subjectType, "recommendation"),
        eq(conversationAction.subjectId, recommendationId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** One plan on the applicant's panel, with everything the chat card shows — the same factual fields `PlanComparison` (app/applications/[id]/page.tsx) already renders, so the two views never disagree. */
export type ActiveShortlistPlan = {
  planId: string;
  name: string;
  annualPremium: number;
  deductible: number;
  outpatientCopayPct: number;
  annualLimit: number;
  maternityCovered: boolean;
  maternityWaitingPeriodMonths: number | null;
  maternityLimit: number | null;
  chronicCovered: boolean;
  chronicWaitingPeriodMonths: number | null;
  network: string;
  /** The system's top pick this round — everything else is still a real, chooseable option. */
  recommended: boolean;
};

/**
 * What the applicant's chat should currently show for "the plan we'd
 * suggest" — every eligible plan on the panel with its own terms, which one
 * is the system's pick, whether a plan has already been chosen off it, and
 * whether a newer round has been asked for (`rejectShortlist`,
 * app/applications/new/actions.ts) and has not landed yet.
 *
 * Deliberately factual, not the agent's own prose, for every plan but the
 * recommended one: `recommendation_rejection.reason` is broker-register text
 * (it names the cohort — see docs/recommendation_architecture.md §6, "never
 * rendered here: the cohort...") and does not belong in the applicant's
 * thread. The same deductible/co-pay/limit/maternity/network fields the
 * broker's own `PlanComparison` already shows are safe for both audiences.
 *
 * The `pendingRound` check exists because superseding the old live row only
 * happens when the NEW round's `persistRecommendation` commits — between
 * `rejectShortlist` writing the objection and that commit, the old
 * recommendation is still the "live" one by every other test. Without this,
 * the chat would keep showing a card the applicant already said didn't fit,
 * as if it were still open for a decision.
 */
export async function getActiveShortlist(applicationId: string): Promise<{
  recommendationId: string;
  round: number;
  plans: ActiveShortlistPlan[];
  memberReasoning: string;
  selected: boolean;
  selectedPlanId: string | null;
  pendingRound: boolean;
} | null> {
  const reco = await getRecommendation(applicationId);
  if (!reco) return null;

  const [selected, pendingRoundRows, quotes] = await Promise.all([
    isSelectionReview(reco.recommendation.id),
    db
      .select({ id: conversationAction.id })
      .from(conversationAction)
      .where(
        and(
          eq(conversationAction.actionType, "reject_shortlist"),
          eq(conversationAction.subjectType, "application"),
          eq(conversationAction.subjectId, applicationId),
          gt(conversationAction.createdAt, reco.recommendation.createdAt),
        ),
      )
      .limit(1),
    getQuotes(applicationId),
  ]);

  const plans: ActiveShortlistPlan[] = quotes
    .filter((q) => q.eligible)
    .map((q) => ({
      planId: q.plan.id,
      name: q.plan.name,
      annualPremium: q.plan.annualPremium,
      deductible: q.plan.deductible,
      outpatientCopayPct: q.plan.outpatientCopayPct,
      annualLimit: q.plan.annualLimit,
      maternityCovered: q.plan.maternityCovered,
      maternityWaitingPeriodMonths: q.plan.maternityWaitingPeriodMonths,
      maternityLimit: q.plan.maternityLimit,
      chronicCovered: q.plan.chronicCovered,
      chronicWaitingPeriodMonths: q.plan.chronicWaitingPeriodMonths,
      network: q.plan.network,
      recommended: q.plan.id === reco.plan.id,
    }));

  return {
    recommendationId: reco.recommendation.id,
    round: reco.recommendation.version,
    plans,
    memberReasoning: reco.recommendation.memberReasoning,
    selected,
    selectedPlanId: selected ? reco.plan.id : null,
    pendingRound: pendingRoundRows.length > 0,
  };
}

/**
 * What an advisor has said TO the applicant about this application.
 *
 * Deliberately narrow: `action`, the member-register message and when it was
 * said. The broker note on the same decision row is not selected here at all,
 * so there is no way for this helper to leak one into an applicant-facing
 * view by accident — the same reason the cohort and flag helpers are separate
 * from the declared-record ones.
 */
export async function getMemberNotices(applicationId: string) {
  const rows = await db
    .select({
      action: reviewDecision.action,
      payload: reviewDecision.payload,
      decidedAt: reviewDecision.decidedAt,
    })
    .from(reviewDecision)
    .innerJoin(reviewTask, eq(reviewDecision.reviewTaskId, reviewTask.id))
    .where(eq(reviewTask.subjectId, applicationId))
    .orderBy(desc(reviewDecision.decidedAt));

  return rows.flatMap((row) => {
    const message = row.payload?.memberMessage;
    if (typeof message !== "string" || !message.trim()) return [];
    return [{ action: row.action, message, decidedAt: row.decidedAt }];
  });
}

/** The intake conversation behind an application, if it came from chat. */
export async function getConversationForApplication(applicationId: string) {
  const [row] = await db
    .select({ id: conversation.id, status: conversation.status })
    .from(conversation)
    .where(eq(conversation.applicationId, applicationId))
    .orderBy(desc(conversation.startedAt))
    .limit(1);
  return row ?? null;
}

/** How many questions are sitting open on that conversation, waiting on them. */
export async function countOpenQuestions(conversationId: string) {
  const rows = await db
    .select({ id: conversationQuestion.id })
    .from(conversationQuestion)
    .where(and(eq(conversationQuestion.conversationId, conversationId), eq(conversationQuestion.status, "asked")));
  return rows.length;
}

// ---------------------------------------------------------------------------
// Policies & servicing
// ---------------------------------------------------------------------------

export async function getPolicyForApplication(applicationId: string) {
  const [row] = await db
    .select({ policy, plan, ledger: benefitLedger })
    .from(policy)
    .innerJoin(plan, eq(policy.planId, plan.id))
    .leftJoin(benefitLedger, eq(benefitLedger.policyId, policy.id))
    .where(eq(policy.applicationId, applicationId))
    .limit(1);
  return row ?? null;
}

export async function listPoliciesForUser(userId: string) {
  return db
    .select({ policy, plan, ledger: benefitLedger, personName: person.fullName })
    .from(policy)
    .innerJoin(person, eq(policy.personId, person.id))
    .innerJoin(plan, eq(policy.planId, plan.id))
    .leftJoin(benefitLedger, eq(benefitLedger.policyId, policy.id))
    .where(eq(person.ownerUserId, userId))
    .orderBy(desc(policy.createdAt));
}

export async function listAllPolicies() {
  return db
    .select({ policy, plan, ledger: benefitLedger, personName: person.fullName, ownerName: appUser.fullName })
    .from(policy)
    .innerJoin(person, eq(policy.personId, person.id))
    .innerJoin(appUser, eq(person.ownerUserId, appUser.id))
    .innerJoin(plan, eq(policy.planId, plan.id))
    .leftJoin(benefitLedger, eq(benefitLedger.policyId, policy.id))
    .orderBy(desc(policy.createdAt));
}

/**
 * The event log for a policy, oldest first. This is the authoritative history —
 * the ledger is only a projection of it, so anything that reasons about "what
 * happened" reads this, not the counters.
 */
export async function listEvents(policyId: string) {
  return db
    .select()
    .from(servicingEvent)
    .where(eq(servicingEvent.policyId, policyId))
    .orderBy(asc(servicingEvent.policyMonth), asc(servicingEvent.createdAt));
}

export async function listReassessments(policyId: string) {
  return db
    .select({ reassessment: planFitReassessment, plan })
    .from(planFitReassessment)
    .leftJoin(plan, eq(planFitReassessment.recommendedPlanId, plan.id))
    .where(eq(planFitReassessment.policyId, policyId))
    .orderBy(desc(planFitReassessment.createdAt));
}

// ---------------------------------------------------------------------------
// Review worklist — BROKER ONLY
// ---------------------------------------------------------------------------

/**
 * The queue, highest priority first.
 *
 * Ordering is a deliberate choice: open work only, then by priority score
 * descending, then oldest first so nothing starves at the bottom. Resolved
 * tasks are excluded outright — a worklist that lists finished work is a list,
 * not a queue.
 */
export async function listOpenReviewTasks() {
  return db
    .select({
      task: reviewTask,
      assignee: { id: appUser.id, fullName: appUser.fullName },
    })
    .from(reviewTask)
    .leftJoin(appUser, eq(reviewTask.assignedToUserId, appUser.id))
    .where(ne(reviewTask.status, "resolved"))
    .orderBy(desc(reviewTask.priorityScore), asc(reviewTask.createdAt));
}

/**
 * The queue with enough on each row to decide without opening the record.
 *
 * A worklist of reasons alone tells a broker that seven things are waiting and
 * nothing about which of them is hard. Each row carries who it is about, the
 * cohort, how sure the system was, the worst severity that fired and the line
 * saying why a person is needed — which is what lets the page group them by
 * the KIND of attention they want rather than listing them all as equal.
 */
/** `recommendation.confidence` is a number (see CONFIDENCE_VALUE in lib/ai/recommendation-session.ts); band it back for the same badge the assessment side uses. */
function confidenceBand(value: number | null): ConfidenceLevel | null {
  if (value == null) return null;
  if (value >= 0.9) return "high";
  if (value >= 0.6) return "medium";
  return "low";
}

export async function listQueue() {
  const tasks = await db
    .select({ task: reviewTask, assignee: { id: appUser.id, fullName: appUser.fullName } })
    .from(reviewTask)
    .leftJoin(appUser, eq(reviewTask.assignedToUserId, appUser.id))
    .where(ne(reviewTask.status, "resolved"))
    .orderBy(desc(reviewTask.priorityScore), asc(reviewTask.createdAt));
  if (tasks.length === 0) return [];

  const applicationIds = tasks
    .filter(({ task }) => task.subjectType === "application")
    .map(({ task }) => task.subjectId);
  const recommendationIds = tasks
    .filter(({ task }) => task.subjectType === "recommendation")
    .map(({ task }) => task.subjectId);

  const recommendationRows = recommendationIds.length
    ? await db
        .select({ recommendation, plan, application, personName: person.fullName })
        .from(recommendation)
        .innerJoin(plan, eq(recommendation.planId, plan.id))
        .innerJoin(application, eq(recommendation.applicationId, application.id))
        .innerJoin(person, eq(application.personId, person.id))
        .where(inArray(recommendation.id, recommendationIds))
    : [];
  const byRecommendation = new Map(recommendationRows.map((row) => [row.recommendation.id, row]));

  // Same test as `isSelectionReview`, batched: which of these recommendation
  // tasks are Review 2 (the applicant already picked) vs. Review 1.5 (a
  // quality check the applicant may not have acted on yet) — the queue row
  // is what tells an advisor which decision they are actually making.
  const selections = recommendationIds.length
    ? await db
        .select({ subjectId: conversationAction.subjectId })
        .from(conversationAction)
        .where(
          and(
            eq(conversationAction.actionType, "select_plan"),
            eq(conversationAction.subjectType, "recommendation"),
            inArray(conversationAction.subjectId, recommendationIds),
          ),
        )
    : [];
  const selectionReviewIds = new Set(selections.map((s) => s.subjectId));
  const reviewKindFor = (recommendationId: string) => (selectionReviewIds.has(recommendationId) ? ("selection" as const) : ("quality" as const));

  if (applicationIds.length === 0) {
    return tasks.map((row) => {
      if (row.task.subjectType !== "recommendation") return { ...row, subject: null };
      const found = byRecommendation.get(row.task.subjectId);
      if (!found) return { ...row, subject: null };
      return {
        ...row,
        subject: {
          kind: "recommendation" as const,
          applicationId: found.application.id,
          reference: found.application.reference,
          personName: found.personName,
          planName: found.plan.name,
          status: found.recommendation.status,
          confidence: confidenceBand(found.recommendation.confidence),
          uncertaintyReason: found.recommendation.uncertaintyReason,
          reviewKind: reviewKindFor(row.task.subjectId),
        },
      };
    });
  }

  const [applications, assessments, decisions] = await Promise.all([
    db
      .select({
        id: application.id,
        reference: application.reference,
        status: application.status,
        age: application.age,
        budget: application.budget,
        personName: person.fullName,
      })
      .from(application)
      .innerJoin(person, eq(application.personId, person.id))
      .where(inArray(application.id, applicationIds)),
    db
      .select()
      .from(assessment)
      .where(inArray(assessment.applicationId, applicationIds))
      .orderBy(desc(assessment.createdAt)),
    db
      .select()
      .from(aiDecision)
      .where(
        and(
          inArray(aiDecision.subjectId, applicationIds),
          eq(aiDecision.decisionType, "cohort_classification"),
        ),
      )
      .orderBy(desc(aiDecision.createdAt)),
  ]);

  // Newest first above, so the first hit per application is the live one.
  const latestAssessment = new Map<string, (typeof assessments)[number]>();
  for (const row of assessments) if (!latestAssessment.has(row.applicationId)) latestAssessment.set(row.applicationId, row);

  const latestDecision = new Map<string, (typeof decisions)[number]>();
  for (const row of decisions) if (!latestDecision.has(row.subjectId)) latestDecision.set(row.subjectId, row);

  const flags = latestAssessment.size
    ? await db
        .select()
        .from(assessmentFlag)
        .where(inArray(assessmentFlag.assessmentId, [...latestAssessment.values()].map((a) => a.id)))
    : [];

  const byApplication = new Map(applications.map((row) => [row.id, row]));

  return tasks.map((row) => {
    if (row.task.subjectType === "recommendation") {
      const found = byRecommendation.get(row.task.subjectId);
      return {
        ...row,
        subject: found
          ? {
              kind: "recommendation" as const,
              applicationId: found.application.id,
              reference: found.application.reference,
              personName: found.personName,
              planName: found.plan.name,
              status: found.recommendation.status,
              confidence: confidenceBand(found.recommendation.confidence),
              uncertaintyReason: found.recommendation.uncertaintyReason,
              reviewKind: reviewKindFor(row.task.subjectId),
            }
          : null,
      };
    }
    if (row.task.subjectType !== "application") return { ...row, subject: null };
    const app = byApplication.get(row.task.subjectId);
    const assessed = latestAssessment.get(row.task.subjectId);
    const own = assessed ? flags.filter((f) => f.assessmentId === assessed.id) : [];

    return {
      ...row,
      subject: app
        ? {
            kind: "application" as const,
            reference: app.reference,
            personName: app.personName,
            age: app.age,
            budget: app.budget,
            status: app.status,
            cohort: assessed?.cohort ?? null,
            confidence: assessed?.confidence ?? null,
            uncertaintyReason: latestDecision.get(row.task.subjectId)?.uncertaintyReason ?? null,
            blocked: own.some((f) => f.severity === "block"),
            needsDecision: own.some((f) => f.severity === "review"),
            flagCount: own.length,
          }
        : null,
    };
  });
}

export async function listRecentlyResolvedTasks(limit = 10) {
  return db
    .select({ task: reviewTask, assignee: { id: appUser.id, fullName: appUser.fullName } })
    .from(reviewTask)
    .leftJoin(appUser, eq(reviewTask.assignedToUserId, appUser.id))
    .where(eq(reviewTask.status, "resolved"))
    .orderBy(desc(reviewTask.resolvedAt))
    .limit(limit);
}

/** Review tasks attached to one application, however they were routed. */
export async function getReviewTasksForApplication(applicationId: string, recommendationId?: string) {
  const subjectIds = [applicationId, ...(recommendationId ? [recommendationId] : [])];
  const tasks = await db
    .select()
    .from(reviewTask)
    .where(inArray(reviewTask.subjectId, subjectIds))
    .orderBy(desc(reviewTask.priorityScore));
  if (tasks.length === 0) return [];

  const decisions = await db
    .select({ decision: reviewDecision, actor: { fullName: appUser.fullName } })
    .from(reviewDecision)
    .innerJoin(appUser, eq(reviewDecision.actorUserId, appUser.id))
    .where(inArray(reviewDecision.reviewTaskId, tasks.map((t) => t.id)))
    .orderBy(asc(reviewDecision.decidedAt));

  return tasks.map((task) => ({
    task,
    decisions: decisions.filter((d) => d.decision.reviewTaskId === task.id),
  }));
}
