import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { BrokerPolicyView } from "@/components/servicing/broker-policy-view";
import { MemberPolicyView } from "@/components/servicing/member-policy-view";
import { db } from "@/db/client";
import { policy as policyTable } from "@/db/schema";
import { getPolicyRecord } from "@/lib/queries";
import { getCurrentUser } from "@/lib/session";

export async function generateMetadata(props: PageProps<"/policies/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const [row] = await db
    .select({ policyNumber: policyTable.policyNumber })
    .from(policyTable)
    .where(eq(policyTable.id, id))
    .limit(1);
  return { title: row ? `${row.policyNumber} · Mizan AI` : "Policy · Mizan AI" };
}

/**
 * A policy, for whoever is looking.
 *
 * This page decides WHO and hands off — it renders nothing itself. The member and
 * the broker each get their own component tree (components/servicing), because the
 * brief is explicit that the two views must not be the same object with different
 * styling. The old page did exactly that: one tree, one full `servicing_event` row
 * loaded for both, and an `isAdvisor ?` deciding what to print.
 */
export default async function PolicyPage(props: PageProps<"/policies/[id]">) {
  const { id } = await props.params;
  const user = await getCurrentUser();
  if (!user) return null;

  const record = await getPolicyRecord(id);
  if (!record) notFound();

  if (user.role === "advisor") return <BrokerPolicyView record={record} />;

  // A member sees only their own cover; anyone else's is simply not found.
  if (record.subject.ownerUserId !== user.id) notFound();
  return <MemberPolicyView record={record} />;
}
