// Intake, once, in one place.
//
// Two surfaces feed this — the form and the chat — and they must produce the
// same rows, or "collected once, reused across every step" is a slogan rather
// than a property of the system. The form gathers an `IntakeDraft` in one shot;
// the chat gathers the same draft one answer at a time. Both hand it to
// createApplication() below.
//
// WHERE THE MODEL IS *NOT*: the chat's parsing is deterministic — regex and
// keyword matching, listed in full below. No API key is needed to run this
// project, and intake gating fields (age, budget, conditions, horizons) are
// exactly the fields where a confident wrong guess is most expensive. The
// conversation, its questions and the span each answer came from are all
// persisted, so an extraction model can replace `parse` per step without
// touching anything else.

import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  application,
  applicationCondition,
  applicationNeed,
  applicationPriority,
  applicationStatusHistory,
  person,
  reviewTask,
  type BenefitClass,
  type BudgetBand,
  type ConditionStability,
  type IntakeSource,
  type MaritalStatus,
  type PriorityTag,
  type RelationshipType,
} from "@/db/schema";

export type IntakeDraft = {
  /** Who the cover is for. Null until the applicant has said. */
  subjectRelationship: RelationshipType | null;
  /** Only meaningful (and only asked for) when `subjectRelationship` is not "self". */
  subjectFullName: string | null;
  age: number | null;
  maritalStatus: MaritalStatus | null;
  smoker: boolean | null;
  emirate: string | null;
  budget: BudgetBand | null;
  policyInception: string | null;
  treatmentOutsideUaeExpected: boolean;
  conditions: { rawText: string; stability: ConditionStability }[];
  needs: { rawText: string; benefitClass: BenefitClass | null; horizonMonths: number | null }[];
  priorities: { rawText: string; tag: PriorityTag }[];
};

export const emptyDraft = (): IntakeDraft => ({
  subjectRelationship: null,
  subjectFullName: null,
  age: null,
  maritalStatus: null,
  smoker: null,
  emirate: null,
  budget: null,
  policyInception: null,
  treatmentOutsideUaeExpected: false,
  conditions: [],
  needs: [],
  priorities: [],
});

/** First of next month — the default a broker would assume. */
export function defaultInception(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Deterministic classifiers, shared by both surfaces
// ---------------------------------------------------------------------------

const NEGATIVE = /^\s*(no|none|nope|nothing|n\/a|na|-)\b/i;
export const saysNothing = (text: string) => NEGATIVE.test(text.trim());

const BENEFIT_KEYWORDS: [RegExp, BenefitClass][] = [
  [/maternity|pregnan|baby|birth|delivery|antenatal|prenatal/i, "maternity"],
  [/diabet|hypertens|blood pressure|cardiac|heart|asthma|thyroid|cholesterol|chronic|pre-?existing/i, "chronic_preexisting"],
  [/dental|teeth|tooth|optical|glasses|eye|vision/i, "dental_optical"],
];

export function classifyBenefit(text: string): BenefitClass | null {
  for (const [pattern, benefitClass] of BENEFIT_KEYWORDS) {
    if (pattern.test(text)) return benefitClass;
  }
  // Deliberately null rather than a guess of `general`: the class decides which
  // waiting period applies, and an unclassified need is a review flag upstream.
  return null;
}

const PRIORITY_KEYWORDS: [RegExp, PriorityTag][] = [
  [/premium|cheap|budget|afford|price|cost|low monthly/i, "premium"],
  [/network|hospital|clinic|access|doctor|specialist/i, "network_access"],
  [/chronic|ongoing|existing condition|long term/i, "chronic_depth"],
  [/maternity|pregnan|baby|family/i, "maternity"],
  [/outpatient|co-?pay|deductible|excess/i, "outpatient_terms"],
];

export function classifyPriority(text: string): PriorityTag {
  for (const [pattern, tag] of PRIORITY_KEYWORDS) {
    if (pattern.test(text)) return tag;
  }
  return "other";
}

/** "managed"/"controlled"/"stable" -> managed; "flare"/"unstable" -> unstable. */
export function classifyStability(text: string): ConditionStability {
  if (/managed|controlled|stable|well.?controlled|on medication/i.test(text)) return "managed";
  if (/unstable|flare|uncontrolled|worsening|recent/i.test(text)) return "unstable";
  return "unknown";
}

/** "in 6 months", "6 months", "next year", "right away". Null when unsaid. */
export function parseHorizonMonths(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (/now|immediate|right away|asap|already/.test(t)) return 0;
  const explicit = t.match(/(\d{1,2})\s*(month|mo\b)/);
  if (explicit) return Number(explicit[1]);
  const years = t.match(/(\d{1,2})\s*year/);
  if (years) return Number(years[1]) * 12;
  if (/this year|within a year|next year|12 months/.test(t)) return 12;
  const bare = t.match(/^(\d{1,2})$/);
  if (bare) return Number(bare[1]);
  return null;
}

/** Splits "diabetes, high blood pressure and asthma" into three items. */
export const splitList = (text: string): string[] =>
  text
    .split(/,| and | & |;|\n/i)
    .map((part) => part.trim().replace(/\.$/, ""))
    .filter((part) => part.length > 0);

export const isAffirmative = (text: string) => /^\s*(y|yes|yeah|yep|sure|correct|true|i do)\b/i.test(text.trim());
export const isNegative = (text: string) => /^\s*(n|no|nope|nah|false|i don'?t)\b/i.test(text.trim());

export function parseBudget(text: string): BudgetBand | null {
  const t = text.trim().toLowerCase();
  if (/not a concern|no limit|whatever it takes|money.?no.?object|unlimited/.test(t)) return "not_a_concern";
  if (/comfort|generous|flexible|high/.test(t)) return "comfortable";
  if (/moder|medium|mid|average|reasonable/.test(t)) return "moderate";
  if (/low|tight|cheap|minimal|small|budget/.test(t)) return "low";
  return null;
}

export function parseMaritalStatus(text: string): MaritalStatus | null {
  const t = text.trim().toLowerCase();
  if (/married|spouse|wife|husband/.test(t)) return "married";
  if (/divorc|separated/.test(t)) return "divorced";
  if (/widow/.test(t)) return "widowed";
  if (/single|unmarried|not married/.test(t)) return "single";
  return null;
}

/** "myself"/"my spouse"/"my child"/"my parent"/"someone else". Null when unsaid. */
export function parseRelationship(text: string): RelationshipType | null {
  const t = text.trim().toLowerCase();
  if (/\b(myself|me|i am|i'm|it'?s for me|self|individual|personal|applicant|primary|my own|for me|for myself|just me)\b/.test(t)) return "self";
  if (/\b(spouse|wife|husband|partner)\b/.test(t)) return "spouse";
  if (/\b(child|children|son|daughter|kid|kids|baby|dependant|dependent)\b/.test(t)) return "child";
  if (/\b(parent|parents|mother|father|mom|dad)\b/.test(t)) return "parent";
  if (/\b(someone else|other|friend|relative)\b/.test(t)) return "other";
  return null;
}

export function parseAge(text: string): number | null {
  const match = text.match(/\d{1,3}/);
  if (!match) return null;
  const age = Number(match[0]);
  return age >= 18 && age <= 100 ? age : null;
}

// ---------------------------------------------------------------------------
// Persisting a completed draft
// ---------------------------------------------------------------------------

const reference = () => `APP-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

/**
 * Resolve the subject of this application to a `person` row.
 *
 * "self" always maps to the applicant's own person regardless of what name is
 * on file — that identity does not change between applications. Anyone else
 * (spouse, child, parent, other) is matched by relationship + name so a second
 * application for the same dependant reuses their record instead of forking
 * it, and a genuinely new name creates one. A person is not a login.
 */
async function resolvePerson(
  userId: string,
  ownFullName: string,
  relationship: RelationshipType,
  subjectFullName: string | null,
) {
  const existing = await db
    .select()
    .from(person)
    .where(eq(person.ownerUserId, userId))
    .orderBy(asc(person.createdAt));

  if (relationship === "self") {
    const self = existing.find((p) => p.relationshipToOwner === "self");
    if (self) return self;
    const [created] = await db
      .insert(person)
      .values({ ownerUserId: userId, relationshipToOwner: "self", fullName: ownFullName })
      .returning();
    return created;
  }

  const fullName = (subjectFullName ?? "").trim();
  const match = existing.find(
    (p) => p.relationshipToOwner === relationship && p.fullName.toLowerCase() === fullName.toLowerCase(),
  );
  if (match) return match;

  const [created] = await db.insert(person).values({ ownerUserId: userId, relationshipToOwner: relationship, fullName }).returning();
  return created;
}

/**
 * Writes the application and everything declared with it, then routes it for
 * assessment. One transaction: a half-written intake is worse than none, and
 * the applicant would have no way to tell which half landed.
 */
export async function createApplication(
  user: { id: string; fullName: string },
  draft: IntakeDraft,
  intakeSource: IntakeSource,
): Promise<string> {
  if (draft.age == null || draft.budget == null) {
    throw new Error("Age and budget are required to submit an application.");
  }
  const relationship = draft.subjectRelationship ?? "self";
  if (relationship !== "self" && !draft.subjectFullName?.trim()) {
    throw new Error("The full name of the person this application is for is required.");
  }

  const subject = await resolvePerson(user.id, user.fullName, relationship, draft.subjectFullName);
  const inception = draft.policyInception ?? defaultInception();
  const applicationId = crypto.randomUUID();
  const now = new Date();

  await db.run(sql`begin`);
  try {
    await db.insert(application).values({
      id: applicationId,
      reference: reference(),
      personId: subject.id,
      createdByUserId: user.id,
      intakeSource,
      status: "submitted",
      age: draft.age,
      maritalStatus: draft.maritalStatus,
      smoker: draft.smoker,
      emirate: draft.emirate,
      budget: draft.budget,
      policyInception: inception,
      treatmentOutsideUaeExpected: draft.treatmentOutsideUaeExpected,
      submittedAt: now,
      statusChangedAt: now,
    });

    // The trail the advisor reads as "progress". Recorded as three moves
    // because that is what happened, even though it happened quickly.
    await db.insert(applicationStatusHistory).values(
      (
        [
          [null, "draft", "Application started"],
          ["draft", "in_intake", intakeSource === "chat" ? "Details captured in chat" : "Details captured in the form"],
          ["in_intake", "submitted", "Submitted for assessment"],
        ] as const
      ).map(([from, to, reason]) => ({
        applicationId,
        fromStatus: from,
        toStatus: to,
        changedBy: "applicant" as const,
        changedByUserId: user.id,
        reason,
      })),
    );

    if (draft.conditions.length > 0) {
      await db.insert(applicationCondition).values(
        draft.conditions.map((c) => ({
          applicationId,
          rawText: c.rawText,
          stability: c.stability,
          declaredAtIntake: true,
          enteredByUserId: user.id,
        })),
      );
    }
    if (draft.needs.length > 0) {
      await db.insert(applicationNeed).values(
        draft.needs.map((n) => ({
          applicationId,
          rawText: n.rawText,
          benefitClass: n.benefitClass,
          horizonMonths: n.horizonMonths,
        })),
      );
    }
    if (draft.priorities.length > 0) {
      await db.insert(applicationPriority).values(
        draft.priorities.map((p) => ({ applicationId, rawText: p.rawText, tag: p.tag })),
      );
    }

    // Route it. Priority is the queue's ordering key, so it is set from what
    // actually makes a case harder to decide, not from arrival time.
    const priority =
      50 +
      (draft.conditions.length > 0 ? 20 : 0) +
      (draft.needs.some((n) => n.horizonMonths != null && n.horizonMonths <= 12) ? 15 : 0) +
      (draft.treatmentOutsideUaeExpected ? 10 : 0) +
      (draft.needs.some((n) => n.benefitClass == null) ? 10 : 0);

    const reasons = [
      "New application awaiting assessment",
      draft.conditions.length > 0 ? `${draft.conditions.length} declared condition(s)` : null,
      draft.needs.some((n) => n.benefitClass == null) ? "a stated need could not be classified" : null,
      draft.treatmentOutsideUaeExpected ? "expects treatment outside the UAE" : null,
    ].filter(Boolean);

    await db.insert(reviewTask).values({
      subjectType: "application",
      subjectId: applicationId,
      reason: reasons.join(" · "),
      priorityScore: priority,
      status: "open",
    });

    await db.run(sql`commit`);
  } catch (error) {
    await db.run(sql`rollback`);
    throw error;
  }

  return applicationId;
}
