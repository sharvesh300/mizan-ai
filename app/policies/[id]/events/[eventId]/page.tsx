import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CasePage } from "@/components/servicing/case/case-page";
import { defaultDenyMessage } from "@/lib/servicing";
import { conversationForEvent } from "@/lib/servicing/appeal-store";
import { getEventCase, listColleagues, undecidablePreview } from "@/lib/servicing/case";
import { getPacket } from "@/lib/servicing/packet";
import { getCurrentUser } from "@/lib/session";

export const metadata: Metadata = { title: "Case · Mizan AI" };

/**
 * A servicing event, for the person deciding on it — BROKER ONLY. A member gets a 404, not a redirect: the member surface
 * is one screen (plan §13.2), and a page that exists for them and says "not yours" would confirm the URL is real.
 */
export default async function EventCasePage(props: PageProps<"/policies/[id]/events/[eventId]">) {
  const { id, eventId } = await props.params;
  const user = await getCurrentUser();
  if (!user) return null;
  if (user.role !== "advisor") notFound();

  const found = await getEventCase(id, eventId);
  if (!found) notFound();
  const conversationId = found.conversationId ?? (await conversationForEvent(id, eventId));
  const [packet, preview, colleagues] = await Promise.all([getPacket({ policyId: id, conversationId, eventId }), undecidablePreview(id, eventId), listColleagues(user.id)]);
  const e = found.event;
  const deny = preview && (e.kind === "claim" || e.kind === "reimbursement") ? defaultDenyMessage(e.kind, Number(e.billedAmount ?? 0)) : null;
  return <CasePage c={found} x={{ packet, preview, colleagues, defaultDenyMessage: deny }} />;
}
