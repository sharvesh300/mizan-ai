import { asc, eq } from "drizzle-orm";
import { ArrowRightIcon, CheckCircle2Icon, ScaleIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChatComposer } from "@/components/chat-composer";
import { PageBody, PageHeader } from "@/components/page-header";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Message, MessageAvatar, MessageContent, MessageGroup } from "@/components/ui/message";
import { db } from "@/db/client";
import { conversation, conversationQuestion, message } from "@/db/schema";
import { getCurrentUser } from "@/lib/session";

export default async function ChatIntakePage(props: PageProps<"/applications/new/chat/[id]">) {
  const { id } = await props.params;
  const user = await getCurrentUser();
  if (!user) return null;

  const [convo] = await db.select().from(conversation).where(eq(conversation.id, id)).limit(1);
  if (!convo || convo.userId !== user.id) notFound();

  const [messages, questions] = await Promise.all([
    db.select().from(message).where(eq(message.conversationId, id)).orderBy(asc(message.seq)),
    db.select().from(conversationQuestion).where(eq(conversationQuestion.conversationId, id)),
  ]);

  const answered = questions.filter((q) => q.status === "answered" || q.status === "skipped").length;
  const done = convo.status === "completed";

  // Quick replies ride along on the last assistant message's payload.
  const last = messages.at(-1);
  const suggestions =
    !done && last?.role === "assistant" && last.payload && typeof last.payload === "object"
      ? ((last.payload as { suggestions?: string[] }).suggestions ?? [])
      : [];

  const initials = user.fullName
    .split(" ")
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();

  return (
    <>
      <PageHeader
        backHref="/applications"
        backLabel="My applications"
        title="Your application"
        description={
          done
            ? "All done — this conversation is saved with your application."
            : `${answered} question${answered === 1 ? "" : "s"} answered so far. Everything is saved as you go.`
        }
      />
      <PageBody className="mx-auto w-full max-w-2xl">
        <MessageGroup className="gap-4">
          {messages.map((msg) => {
            const fromAssistant = msg.role === "assistant";
            return (
              <Message key={msg.id} align={fromAssistant ? "start" : "end"}>
                <MessageAvatar>
                  {fromAssistant ? (
                    <span className="flex size-8 items-center justify-center bg-brand text-brand-foreground">
                      <ScaleIcon className="size-4" />
                    </span>
                  ) : (
                    <Avatar className="size-8">
                      <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                    </Avatar>
                  )}
                </MessageAvatar>
                <MessageContent>
                  <div
                    className={
                      fromAssistant
                        ? "w-fit max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2.5 whitespace-pre-wrap"
                        : "w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-brand px-3.5 py-2.5 text-brand-foreground whitespace-pre-wrap"
                    }
                  >
                    {msg.bodyText}
                  </div>
                </MessageContent>
              </Message>
            );
          })}
        </MessageGroup>

        <div className="mt-6">
          {done ? (
            <div className="flex flex-col items-start gap-3 rounded-xl border border-success/30 bg-success-subtle p-4">
              <p className="flex items-center gap-2 text-sm font-medium text-success">
                <CheckCircle2Icon className="size-4" />
                Sent to an advisor
              </p>
              {convo.applicationId ? (
                <Button
            nativeButton={false}
                  size="sm"
                  render={
                    <Link href={`/applications/${convo.applicationId}`}>
                      Track your application
                      <ArrowRightIcon />
                    </Link>
                  }
                />
              ) : null}
            </div>
          ) : (
            <ChatComposer conversationId={id} suggestions={suggestions} />
          )}
        </div>
      </PageBody>
    </>
  );
}
