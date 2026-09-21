import { ChatDrawer } from "@/components/chat/chat-drawer";
import { ChatThread } from "@/components/chat/chat-thread";
import { getCurrentUser } from "@/lib/session";

/**
 * The conversation, in the drawer.
 *
 * Exactly the component the full page renders — only the shell differs. Being
 * a real route means the chat actions' own `revalidatePath` calls refresh this
 * as they already do for the page, with nothing extra wired up.
 */
export default async function ChatThreadDrawer(props: PageProps<"/applications/new/chat/[id]">) {
  const { id } = await props.params;
  const user = await getCurrentUser();
  if (!user || user.role !== "applicant") return null;

  return (
    <ChatDrawer title="Your application" fullHref={`/applications/new/chat/${id}`}>
      <ChatThread id={id} user={user} variant="drawer" />
    </ChatDrawer>
  );
}
