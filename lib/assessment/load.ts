// Rebuilding the record the rules read, from the rows intake wrote.
//
// This lived inside lib/ai/assessment-session.ts, which imports the graph and
// through it langgraph and the OpenRouter client. That was fine while the only
// caller was the assessment pass itself, but the broker view needs the same
// record to say what a year on each plan would cost (see `getQuoteOutlays`,
// lib/queries.ts) and a page has no business pulling the model stack in to
// read four tables. So the read lives here — db and pure rules only — and
// assessment-session calls it like everyone else.
//
// Nothing is re-derived and nothing is asked for again: this is the same
// declared data both views render, read once more for a different purpose.

import "server-only";
import { and, eq, notInArray } from "drizzle-orm";
import { db } from "@/db/client";
import {
  application,
  applicationCondition,
  applicationExpectedProvider,
  applicationNeed,
  applicationPriority,
  person,
  type ApplicationStatus,
} from "@/db/schema";
import { deriveRecord } from "./derive";
import type { AssessmentContext, AssessmentRecord } from "./types";

/** Statuses that mean an application is no longer in play. */
export const TERMINAL: ApplicationStatus[] = ["withdrawn", "declined", "expired", "policy_issued"];

export async function loadAssessmentRecord(
  applicationId: string,
): Promise<{ record: AssessmentRecord; context: AssessmentContext } | null> {
  const [row] = await db
    .select({ application, person })
    .from(application)
    .innerJoin(person, eq(application.personId, person.id))
    .where(eq(application.id, applicationId))
    .limit(1);
  if (!row) return null;

  const [conditions, needs, priorities, providers, siblings] = await Promise.all([
    db.select().from(applicationCondition).where(eq(applicationCondition.applicationId, applicationId)),
    db.select().from(applicationNeed).where(eq(applicationNeed.applicationId, applicationId)),
    db.select().from(applicationPriority).where(eq(applicationPriority.applicationId, applicationId)),
    db.select().from(applicationExpectedProvider).where(eq(applicationExpectedProvider.applicationId, applicationId)),
    db
      .select({ id: application.id })
      .from(application)
      .where(and(eq(application.personId, row.person.id), notInArray(application.status, TERMINAL))),
  ]);

  const record: AssessmentRecord = {
    applicationId,
    reference: row.application.reference,
    age: row.application.age,
    maritalStatus: row.application.maritalStatus,
    smoker: row.application.smoker,
    emirate: row.application.emirate,
    budget: row.application.budget,
    policyInception: row.application.policyInception,
    treatmentOutsideUaeExpected: row.application.treatmentOutsideUaeExpected,
    subjectRelationship: row.person.relationshipToOwner,
    conditions: conditions.map((c) => ({
      id: c.id,
      rawText: c.rawText,
      conditionCode: c.conditionCode,
      stability: c.stability,
    })),
    needs: needs.map((n) => ({
      id: n.id,
      rawText: n.rawText,
      benefitClass: n.benefitClass,
      horizonMonths: n.horizonMonths,
    })),
    priorities: priorities.map((p) => ({ id: p.id, rawText: p.rawText, tag: p.tag })),
    providers: providers.map((p) => ({ id: p.id, providerName: p.providerName, tier: p.tier })),
  };

  return {
    // `deriveRecord` (./derive.ts) is applied HERE, at the one place a record
    // is assembled from rows, and nowhere else: a declared condition implies a
    // need to cover it, and a comma-joined priority is several priorities.
    // Both are readings of what the applicant said, not edits to it — the rows
    // keep their own words — so every record gets the same reading whether it
    // was captured today or months ago.
    record: deriveRecord(record),
    context: {
      // Explicit rather than read inside a rule, so replaying an assessment
      // produces the flags it produced on the day, not today's.
      today: new Date().toISOString().slice(0, 10),
      openApplicationsForPerson: siblings.filter((s) => s.id !== applicationId).length,
    },
  };
}
