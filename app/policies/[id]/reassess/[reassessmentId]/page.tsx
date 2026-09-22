import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReassessmentCasePage } from "@/components/servicing/case/reassessment-case-page";
import { getReassessmentCase } from "@/lib/servicing/reassess-case";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = { title: "Plan-fit reassessment · Mizan AI" };

/**
 * A plan-fit recommendation, for the person deciding on it — BROKER ONLY. A member gets a 404, not a redirect: the
 * same discipline as the servicing event's case page.
 */
export default async function ReassessmentCaseRoute(props: PageProps<"/policies/[id]/reassess/[reassessmentId]">) {
  const { id, reassessmentId } = await props.params;
  const user = await getCurrentUser();
  if (!user) return null;
  if (user.role !== "advisor") notFound();

  const found = await getReassessmentCase(id, reassessmentId);
  if (!found) notFound();
  return <ReassessmentCasePage c={found} />;
}
