import { asc, eq } from "drizzle-orm";
import { ArrowRightIcon, CheckCircle2Icon, ScaleIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChatAutoscroll } from "@/components/chat-autoscroll";
import { ChatComposer } from "@/components/chat-composer";
import { ChatQuestionnaire } from "@/components/chat-questionnaire";
import { PageHeader } from "@/components/page-header";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Message, MessageAvatar, MessageContent, MessageGroup } from "@/components/ui/message";
import { db } from "@/db/client";
import { conversation, conversationQuestion, message } from "@/db/schema";
import { isQuestionnairePayload } from "@/lib/ai/intake-session";
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

  // The last assistant message carries whatever the applicant answers with:
  // a questionnaire to fill in, or quick replies next to the composer.
  const last = messages.at(-1);
  const openPayload = !done && last?.role === "assistant" ? last.payload : null;
  const questionnaire = isQuestionnairePayload(openPayload) ? openPayload : null;
  const suggestions =
    !questionnaire && openPayload && typeof openPayload === "object"
      ? ((openPayload as { suggestions?: string[] }).suggestions ?? [])
      : [];

  const initials = user.fullName
    .split(" ")
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();

  return (
    // A chat is a bottom-anchored surface: the header stays put, the transcript
    // scrolls, and the composer sits on the bottom edge at full width.
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col">
      <div className="shrink-0">
        <PageHeader
          backHref="/applications/new/chat"
          backLabel="Your chats"
          title="Your application"
          description={
            done
              ? "All done — this conversation is saved with your application."
              : answered > 0
                ? `${answered} question${answered === 1 ? "" : "s"} answered so far. Everything is saved as you go.`
                : "Say as much or as little as you like — everything is saved as you go."
          }
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
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
                          ? "w-fit max-w-[min(42rem,85%)] rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2.5 whitespace-pre-wrap"
                          : "w-fit max-w-[min(42rem,85%)] rounded-2xl rounded-br-sm bg-brand px-3.5 py-2.5 text-brand-foreground whitespace-pre-wrap"
                      }
                    >
                      {msg.bodyText}
                    </div>
                  </MessageContent>
                </Message>
              );
            })}
          </MessageGroup>

          {questionnaire ? (
            <div className="mt-4 ps-10">
              <ChatQuestionnaire conversationId={id} questions={questionnaire.questions} />
            </div>
          ) : null}

          {done ? (
            <div className="mt-6 flex flex-col items-start gap-3 rounded-xl border border-success/30 bg-success-subtle p-4">
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
          ) : null}

          <ChatAutoscroll dep={messages.length} />
        </div>
      </div>

      {done ? null : (
        <ChatComposer
          conversationId={id}
          suggestions={suggestions}
          initials={initials}
          placeholder={questionnaire ? "…or just tell me in your own words" : "Tell me what you're after…"}
        />
      )}
    </div>
  );
}
