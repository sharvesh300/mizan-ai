import { ChatDrawer } from "@/components/chat/chat-drawer";
import { ServicingThread } from "@/components/servicing/servicing-thread-page";
import { getCurrentUser } from "@/lib/session";

/**
 * The same conversation, in the drawer. An intercepted render of the real route, so the URL, the back button and
 * a reload all behave, and the actions' own `revalidatePath` refreshes it with nothing extra wired up.
 */
export default async function ServicingDrawer(props: PageProps<"/policies/[id]/service/[conversationId]">) {
  const { id, conversationId } = await props.params;
  const user = await getCurrentUser();
  if (!user || user.role !== "applicant") return null;
  return (
    <ChatDrawer title="Your request" fullHref={`/policies/${id}/service/${conversationId}`}>
      <ServicingThread policyId={id} conversationId={conversationId} user={user} variant="drawer" />
    </ChatDrawer>
  );
}
