import { asc, eq } from "drizzle-orm";
import { ArrowRightIcon, CheckCircle2Icon, ScaleIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChatAutoscroll } from "@/components/chat-autoscroll";
import { ChatComposer } from "@/components/chat-composer";
import { ChatQuestionnaire } from "@/components/chat-questionnaire";
import { ChatRefresh } from "@/components/chat-refresh";
import { PageHeader } from "@/components/page-header";
import { PlanCard } from "@/components/plan-card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Message, MessageAvatar, MessageContent, MessageGroup } from "@/components/ui/message";
import { Spinner } from "@/components/ui/spinner";
import { db } from "@/db/client";
import { conversation, conversationQuestion, message } from "@/db/schema";
import { isQuestionnairePayload, isRecommendationClarifyPayload } from "@/lib/ai/intake-session";
import { getActiveShortlist } from "@/lib/queries";
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
  // `completed` today only ever means the policy has issued (issuePolicy,
  // app/applications/[id]/actions.ts) — it is a record of what happened, not
  // a reason to stop the applicant asking about the cover they now have.
  const done = convo.status === "completed";
  // The one thing `done` SHOULD still close: an applicant reopening a
  // conversation that was completed before it ever produced an application
  // (nothing here to ask a plan question about). Everything past that keeps
  // the composer live.
  const canStillChat = Boolean(convo.applicationId) || !done;
  // `awaiting_review` now means an actual person owns this — either Review 1
  // gated the record (`in_review`), or a round 2 objection is being worked.
  // A clean record never sets this (lib/ai/conversation-continuation.ts).
  const waitingOnAdvisor = convo.status === "awaiting_review";

  // The last assistant message carries whatever the applicant answers with
  // right now: a questionnaire to fill in, or quick replies next to the
  // composer. The shortlist itself is NOT read off a message payload — it is
  // read live off the database (see getActiveShortlist) so a card an advisor
  // has since edited, or a round the applicant has since rejected, is never
  // shown as if it were still the open offer.
  const last = messages.at(-1);
  const openPayload = !done && !waitingOnAdvisor && last?.role === "assistant" ? last.payload : null;
  const questionnaire = isQuestionnairePayload(openPayload) ? openPayload : null;
  // A clarifying question (lib/ai/graph/nodes/clarify.ts) — already fully
  // rendered as the message bubble itself (its bodyText IS the question), so
  // nothing extra needs rendering here beyond suppressing the spinner below:
  // the applicant is being asked something, not waiting on a background job.
  const clarifyPending = isRecommendationClarifyPayload(openPayload);
  const suggestions =
    !questionnaire && openPayload && typeof openPayload === "object" ? ((openPayload as { suggestions?: string[] }).suggestions ?? []) : [];

  const shortlist = convo.applicationId && !done ? await getActiveShortlist(convo.applicationId) : null;
  // Something is still being computed in the background — the initial
  // recommendation round, or a re-round after "none of these fit" — and
  // there is nothing on screen yet that reflects it. Excludes
  // `waitingOnAdvisor` so the spinner and the "With an advisor" panel are
  // never both on screen at once — Review 1 gates the record before
  // recommendation ever runs, so there is nothing "still working" about it —
  // and excludes `clarifyPending`, where the system is waiting on the
  // applicant, not the other way around.
  const working = Boolean(convo.applicationId) && !done && !waitingOnAdvisor && !clarifyPending && (!shortlist || shortlist.pendingRound);

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
              ? canStillChat
                ? "Your cover is active — ask away if you have questions about your plan."
                : "Your cover is active — this conversation is saved with your application."
              : waitingOnAdvisor
                ? "An advisor has this now. We'll be back with you here."
                : clarifyPending
                  ? "One quick question, so we can get this right."
                  : shortlist && !shortlist.pendingRound
                    ? "We've got a plan for you — have a look below."
                    : working
                      ? "Working out the best plan for you — one moment."
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

          {shortlist && !shortlist.pendingRound ? (
            <div className="mt-4 ps-10">
              <PlanCard
                conversationId={id}
                plans={shortlist.plans}
                memberReasoning={shortlist.memberReasoning}
                selectedPlanId={shortlist.selectedPlanId}
              />
            </div>
          ) : null}

          {working ? (
            <div className="mt-4 flex items-center gap-2 ps-10 text-sm text-muted-foreground">
              <Spinner className="size-3.5" />
              Still working on this…
            </div>
          ) : null}

          {done || waitingOnAdvisor ? (
            <div className="mt-6 flex flex-col items-start gap-3 rounded-xl border border-success/30 bg-success-subtle p-4">
              <p className="flex items-center gap-2 text-sm font-medium text-success">
                <CheckCircle2Icon className="size-4" />
                {/* `done` only ever means a policy has issued — nothing else
                    in the app closes a conversation (issuePolicy,
                    app/applications/[id]/actions.ts). `waitingOnAdvisor` is
                    the other, distinct state: a person owns this next, but
                    nothing has concluded yet. */}
                {done ? "Your cover is active" : "With an advisor"}
              </p>
              {convo.applicationId ? (
                <Button
                  nativeButton={false}
                  size="sm"
                  render={
                    <Link href={done ? "/policies" : `/applications/${convo.applicationId}`}>
                      {done ? "View your policy" : "Track your application"}
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

      {canStillChat ? (
        <ChatComposer
          conversationId={id}
          suggestions={suggestions}
          initials={initials}
          placeholder={done ? "Ask about your plan or policy…" : questionnaire ? "…or just tell me in your own words" : "Tell me what you're after…"}
        />
      ) : null}

      {/* Polls until the background recommendation round lands — see the
          component doc for why this is a fallback, not the primary path. */}
      {working ? <ChatRefresh /> : null}
    </div>
  );
}
