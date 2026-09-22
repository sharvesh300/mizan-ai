import type { Metadata } from "next";
import { ServicingThread } from "@/components/servicing/servicing-thread-page";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = { title: "Your request · Mizan AI" };

/** The full-screen conversation — a reload, a shared link, or "Full view" from the drawer. */
export default async function ServicingPage(props: PageProps<"/policies/[id]/service/[conversationId]">) {
  const { id, conversationId } = await props.params;
  const user = await getCurrentUser();
  if (!user || user.role !== "applicant") return null;
  return <ServicingThread policyId={id} conversationId={conversationId} user={user} />;
}
