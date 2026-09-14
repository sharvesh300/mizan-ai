"use server";

// What the APPLICANT can do to their own application.
//
// Kept in its own file rather than alongside the advisor's decisions, because
// the authorisation rule is the opposite one and mixing them is how a form
// post ends up calling something it should not be able to. Nothing here
// touches a cohort, a flag, a queue priority or a decision.

import { desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db/client";
import { application, conversation, person, reviewTask } from "@/db/schema";
import { sayInbound } from "@/lib/ai/intake-session";
import { getCurrentUser } from "@/lib/session";

/**
 * "Something wrong? Tell your advisor."
 *
 * That line has been on the record card since the first build with no
 * mechanism behind it. This is the mechanism: the applicant says what is
 * wrong, in their own words, and it becomes a queue item for a person —
 * priority above a routine review, because a record we know to be wrong is
 * worse than one that is merely hard.
 *
 * It deliberately does NOT edit the declared data. The intake snapshot is
 * what they told us at the time, every later step reads it, and letting it be
 * rewritten in place would quietly invalidate an assessment that has already
 * been made against it. An advisor re-opens the question properly.
 */
export async function flagCorrection(applicationId: string, formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) throw new Error("No active user.");

  const [record] = await db
    .select({ reference: application.reference, ownerUserId: person.ownerUserId })
    .from(application)
    .innerJoin(person, eq(application.personId, person.id))
    .where(eq(application.id, applicationId))
    .limit(1);
  if (!record) throw new Error("Application not found.");
  // An applicant may only speak about their own record. An advisor has the
  // decision surface for this and should not be filing corrections as one.
  if (user.role !== "applicant" || record.ownerUserId !== user.id) {
    throw new Error("Only the applicant can flag a correction on their own application.");
  }

  const text = (formData.get("correction")?.toString() ?? "").trim();
  if (!text) return;

  await db.insert(reviewTask).values({
    subjectType: "application",
    subjectId: applicationId,
    reason: `Applicant says something on the record is wrong: "${text}"`,
    // Above a routine review flag: the rules ran against data we have now been
    // told is wrong, so whatever they concluded is suspect until someone looks.
    priorityScore: 75,
    status: "open",
  });

  // Their own words, in their own thread, so the correction is part of the
  // conversation rather than a note about them they never see.
  const [convo] = await db
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.applicationId, applicationId))
    .orderBy(desc(conversation.startedAt))
    .limit(1);
  if (convo) await sayInbound(convo.id, text);

  revalidatePath(`/applications/${applicationId}`);
  revalidatePath("/queue");
}
