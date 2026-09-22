import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ConversationCasePage } from "@/components/servicing/case/conversation-case-page";
import { getConversationCase, listColleagues } from "@/lib/servicing/case";
import { getPacket } from "@/lib/servicing/packet";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = { title: "Hand-off · Mizan AI" };

/** A hand-off with no claim of its own — BROKER ONLY, and a 404 for a member, like the case page beside it. */
export default async function ConversationCaseRoute(props: PageProps<"/policies/[id]/conversations/[conversationId]">) {
  const { id, conversationId } = await props.params;
  const user = await getCurrentUser();
  if (!user) return null;
  if (user.role !== "advisor") notFound();
  const found = await getConversationCase(id, conversationId);
  if (!found) notFound();
  const [packet, colleagues] = await Promise.all([getPacket({ policyId: id, conversationId, eventId: null }), listColleagues(user.id)]);
  return <ConversationCasePage c={found} packet={packet} colleagues={colleagues} />;
}
