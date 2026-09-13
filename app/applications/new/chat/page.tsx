import { ArrowRightIcon, MessageSquareIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { conversationStatusLabel, conversationStatusTone, dateLabel } from "@/lib/domain";
import { listIntakeConversations } from "@/lib/queries";
import { getCurrentUser } from "@/lib/session";
import { startChatIntake } from "../actions";

export default async function ChatIntakeEntryPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  const conversations = await listIntakeConversations(user.id);

  return (
    <>
      <PageHeader backHref="/applications/new" title="Talk it through" />
      <PageBody className="space-y-8">
        <Card className="mx-auto max-w-lg">
          <CardHeader>
            <span className="flex size-10 items-center justify-center rounded-xl bg-brand-subtle text-brand">
              <MessageSquareIcon className="size-5" />
            </span>
            <CardTitle className="mt-3">A few questions, one at a time</CardTitle>
            <CardDescription className="text-pretty">
              Answer in your own words — everything is saved as you go, so you can close this and come back to the
              same place. Applying for yourself and someone else? Start a separate chat for each — nothing is sent to
              an advisor until you say so.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Always a fresh conversation. Resuming an unfinished one is a
                click away in the list below, so this button never has to
                guess which one the applicant means. */}
            <form action={startChatIntake}>
              <Button type="submit" size="lg" className="w-full">
                <PlusIcon />
                Start a new chat
              </Button>
            </form>
          </CardContent>
        </Card>

        {conversations.length > 0 ? (
          <div className="mx-auto max-w-lg space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">Your conversations</h2>
            <ul className="divide-y rounded-xl border">
              {conversations.map((convo) => (
                <li key={convo.id}>
                  <Link
                    href={`/applications/new/chat/${convo.id}`}
                    className="flex items-center gap-4 px-4 py-4 transition-colors hover:bg-muted/50"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <MessageSquareIcon className="size-4 text-muted-foreground" />
                    </span>
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          {convo.personName
                            ? convo.relationship === "self"
                              ? convo.personName
                              : `${convo.personName} (${convo.relationship})`
                            : "New application"}
                        </span>
                        <StatusBadge tone={conversationStatusTone[convo.status]}>
                          {conversationStatusLabel[convo.status]}
                        </StatusBadge>
                      </div>
                      {convo.preview ? (
                        <p className="truncate text-sm text-muted-foreground">{convo.preview}</p>
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        {convo.reference ? `${convo.reference} · ` : ""}Started {dateLabel(convo.startedAt)}
                      </p>
                    </div>
                    <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </PageBody>
    </>
  );
}
