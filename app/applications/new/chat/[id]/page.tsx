import { ChatThread } from "@/components/chat/chat-thread";
import { getCurrentUser } from "@/lib/session";

/**
 * The full-screen conversation.
 *
 * Everything this page used to hold now lives in `ChatThread`, because the
 * launcher drawer renders the same conversation and the derived state behind
 * it — what the applicant is being asked, whether a shortlist is live, whether
 * an advisor is holding the record — is not something to keep two copies of.
 */
export default async function ChatIntakePage(props: PageProps<"/applications/new/chat/[id]">) {
  const { id } = await props.params;
  const user = await getCurrentUser();
  if (!user) return null;

  return <ChatThread id={id} user={user} />;
}
