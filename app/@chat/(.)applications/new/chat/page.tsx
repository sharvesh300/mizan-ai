import { MessageSquareIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { ChatDrawer } from "@/components/chat/chat-drawer";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { conversationStatusLabel, conversationStatusTone, dateLabel } from "@/lib/domain";
import { listIntakeConversations } from "@/lib/queries";
import { getCurrentUser } from "@/lib/session";
import { startChatIntake } from "@/app/applications/new/actions";

/**
 * The launcher's first screen: every conversation this applicant has, newest
 * first. Intercepted, so this is the same route the full page serves — reload
 * it and you land on the page instead, with the same list.
 */
export default async function ChatListDrawer() {
  const user = await getCurrentUser();
  if (!user || user.role !== "applicant") return null;

  const conversations = await listIntakeConversations(user.id);

  return (
    <ChatDrawer
      title="Your chats"
      description="Everything you've talked to us about, saved as you go."
      fullHref="/applications/new/chat"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-4 pb-3">
          <form action={startChatIntake}>
            <Button type="submit" size="sm" className="w-full">
              <PlusIcon />
              Start a new chat
            </Button>
          </form>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {conversations.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground text-pretty">
              No conversations yet. Start one and we&apos;ll take it a question at a time.
            </p>
          ) : (
            <ul className="divide-y border-t">
              {conversations.map((convo) => (
                <li key={convo.id}>
                  <Link
                    href={`/applications/new/chat/${convo.id}`}
                    className="flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-muted/50"
                  >
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <MessageSquareIcon className="size-4 text-muted-foreground" />
                    </span>
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {convo.personName
                            ? convo.relationship === "self"
                              ? convo.personName
                              : `${convo.personName} (${convo.relationship})`
                            : "New application"}
                        </span>
                        <StatusBadge tone={conversationStatusTone[convo.status]}>
                          {conversationStatusLabel[convo.status]}
                        </StatusBadge>
                      </span>
                      {convo.preview ? (
                        <span className="block truncate text-xs text-muted-foreground">{convo.preview}</span>
                      ) : null}
                      <span className="block text-xs text-muted-foreground">
                        {convo.reference ? `${convo.reference} · ` : ""}
                        {dateLabel(convo.startedAt)}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </ChatDrawer>
  );
}
