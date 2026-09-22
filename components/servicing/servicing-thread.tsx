"use client";

// The servicing conversation.
//
// A NEW component, not a branch of ChatThread: that one derives its state from intake questionnaires and
// shortlists, and threading a second conversation type through it would put two lifecycles behind one set
// of conditionals. What they share is the chrome — the message primitives, the composer, the autoscroll.
//
// What this component owns, and nothing else:
//   - laying a transcript out: a card message is rendered AS the card (its text is for previews and the
//     transcript, and printing both would say everything twice);
//   - deciding which card is open (the last message, while the conversation is waiting on the member) and
//     which have been answered (a card is closed by the member's next message, which it then shows);
//   - turning a card's callback into one server action, and keeping the member oriented while it runs.
// It never decides what a card means. The server re-derives that from its own state.

import { ScaleIcon, UserRoundIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { requestServicingCallback, sendServicingInput, startAppeal, type ServicingActionResult } from "@/app/policies/[id]/service/actions";
import { ChatComposer, TypingIndicator } from "@/components/chat-composer";
import { ServicingCardView } from "@/components/servicing/cards/servicing-card";
import type { CardHandlers } from "@/components/servicing/cards/shell";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Message, MessageAvatar, MessageContent, MessageGroup } from "@/components/ui/message";
import type { ThreadMessage } from "@/lib/ai/servicing-session";
import { cn } from "cn";

/** Cards whose reply is shown INSIDE the card. A facts form is the exception: its reply is a summary bubble. */
const REPLY_SHOWN_IN_CARD = new Set(["servicing_question", "servicing_confirm", "servicing_conflict", "servicing_evidence_request"]);
/** A form the member has submitted is replaced by the summary of what they gave — an emptied, locked form says nothing. */
const HIDDEN_ONCE_ANSWERED = new Set(["servicing_facts_form"]);

type Props = {
  policyId: string;
  conversationId: string;
  status: string;
  messages: ThreadMessage[];
  /** With no model key, free text cannot be read: the thread is cards and forms, and there is no composer. */
  hasModel: boolean;
  advisorPhone: string | null;
  defaultPhone: string;
  callbackRequested: boolean;
  /** The decision this conversation produced, IF it can be appealed right now (read from the log by the server). */
  appealEventId: string | null;
  /** What this conversation is — the composer's words follow it. */
  intent?: "claim" | "preauth" | "appeal";
  initials: string;
  variant?: "page" | "drawer";
};

const kindOf = (card: unknown): string | null => (card && typeof card === "object" && "kind" in card ? String((card as { kind: unknown }).kind) : null);

export function ServicingThreadView({ policyId, conversationId, status, messages, hasModel, advisorPhone, defaultPhone, callbackRequested, appealEventId, intent = "claim", initials, variant = "page" }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(null);

  const waiting = status === "awaiting_user";

  // The action can return without the thread having changed (a stale double-tap is ignored server-side).
  // Whatever happened, the pending state ends with the transition, so nothing here can stay stuck.
  const run = (call: () => Promise<ServicingActionResult>, label: string | null = null) => {
    if (pending) return;
    setProblem(null);
    setAsked(label);
    startTransition(async () => {
      try {
        const r = await call();
        if (!r.ok) setProblem(r.message);
      } catch {
        setProblem("That didn't go through. Nothing was lost — please try again.");
      } finally {
        setAsked(null);
      }
    });
  };

  const send = (input: unknown, label: string | null = null) => run(() => sendServicingInput(policyId, conversationId, input), label);

  const handlers: CardHandlers = {
    onAnswer: ({ fieldKey, value, label }) => send({ kind: "chip", fieldKey, value, label }, label),
    onConfirm: () => send({ kind: "confirm" }, "Looks right"),
    onChange: () => send({ kind: "change" }, "Change something"),
    onSubmitForm: (values) => send({ kind: "form", values }, "Sending your details"),
    onChooseConflict: (value) => {
      const c = openConflict(messages);
      send({ kind: "conflict", fieldKey: c.fieldKey, value, label: c.display(value) }, c.display(value));
    },
    onCallback: async (request) => {
      try {
        const r = await requestServicingCallback(policyId, conversationId, request);
        if (!r.ok) setProblem(r.message);
        return r.ok;
      } catch {
        setProblem("That didn't go through. Nothing was lost — please try again.");
        return false;
      }
    },
    onTalkToAdvisor: () => send({ kind: "advisor" }, "I'd like to talk to an advisor."),
    // An appeal: the document arrives as text (the brief puts document processing out of scope), and "I don't have this"
    // is an answer — it feeds the set difference that decides whether to ask again.
    onEvidence: (text) => send({ kind: "text", text }, text.length > 160 ? `${text.slice(0, 157)}…` : text),
    onDeclineEvidence: () => send({ kind: "decline_evidence" }, "I don't have this"),
    onAppeal: () => {
      if (!appealEventId || pending) return;
      setProblem(null);
      startTransition(async () => {
        try {
          const r = await startAppeal(policyId, appealEventId);
          if (r.ok && r.href) router.push(r.href);
          else if (!r.ok) setProblem(r.message);
        } catch {
          setProblem("We couldn't start that just now. Please try again.");
        }
      });
    },
  };

  // Lay the transcript out: which messages are cards, which member replies a card absorbs.
  const rows = useMemo(() => {
    const consumed = new Set<string>();
    const answers = new Map<string, string>();
    messages.forEach((m, i) => {
      const k = kindOf(m.card);
      if (m.from !== "assistant" || !k) return;
      const next = messages.slice(i + 1).find((x) => x.from === "member" || kindOf(x.card));
      if (next && next.from === "member") {
        answers.set(m.id, next.text);
        if (REPLY_SHOWN_IN_CARD.has(k)) consumed.add(next.id);
      }
    });
    return { consumed, answers };
  }, [messages]);

  // Keep the right thing in view. A NEW message is scrolled to its START, not its end: a tall card (the form) must
  // show its first field, not its submit button. A short message ends up at the bottom anyway, because the page
  // cannot scroll further. While a turn is running, the typing indicator at the bottom is what to see.
  const scroller = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pending) bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    else scroller.current?.querySelectorAll("[data-slot=message]").item((scroller.current?.querySelectorAll("[data-slot=message]").length ?? 1) - 1)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [messages.length, pending]);

  const lastIndex = messages.length - 1;
  const lead = "flex size-8 items-center justify-center bg-brand text-brand-foreground";

  // A screen reader hears every new turn, without the whole transcript being a live region (which would
  // re-announce on every render). Only the newest assistant/advisor message is echoed here, keyed on its id
  // so the same text said twice (a repeated confirm) still announces the second time.
  const last = messages[lastIndex];
  const announced = last && last.from !== "member" ? last.text : "";

  return (
    <>
      <div aria-live="polite" className="sr-only">
        {/* Keyed on the message id, not its text: identical wording said twice (a repeated "Looks right") must still
            re-announce, and the id itself is never spoken because it lives on the key, not the content. */}
        {last ? <span key={last.id}>{announced}</span> : null}
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className={variant === "page" ? "mx-auto w-full max-w-3xl px-4 py-6 sm:px-6" : "w-full px-4 py-2"}>
          <MessageGroup className="gap-4">
            {messages.map((m, i) => {
              const k = kindOf(m.card);
              if (m.from === "member" && rows.consumed.has(m.id)) return null;

              // A card: the card IS the message.
              if (m.from === "assistant" && k) {
                const answered = rows.answers.get(m.id) ?? null;
                if (answered !== null && HIDDEN_ONCE_ANSWERED.has(k)) return null;
                const isOpen = i === lastIndex && waiting && !pending;
                return (
                  <Message key={m.id} align="start">
                    <MessageAvatar>
                      <span className={lead}>
                        <ScaleIcon className="size-4" />
                      </span>
                    </MessageAvatar>
                    <MessageContent className="min-w-0 flex-1 space-y-2">
                      {/* Every card but the form carries its own words, so printing the text too would say
                          things twice. The form's lead is different — "let me get these a different way" is
                          the ONLY place a member is told why they are looking at a form — so it stays (unless it is just the
                          card's own intro, which the card already prints). */}
                      {k === "servicing_facts_form" && m.text && m.text !== (m.card as { intro?: string }).intro ? (
                        <div className="w-fit max-w-[min(42rem,85%)] rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2.5 whitespace-pre-wrap">{m.text}</div>
                      ) : null}
                      <ServicingCardView
                        card={m.card}
                        handlers={handlers}
                        answered={REPLY_SHOWN_IN_CARD.has(k) ? answered : null}
                        // Terminal cards (outcome, estimate, escalation) are never "answered"; the callback form is
                        // only live while the hand-off is the current state.
                        disabled={k === "servicing_escalation" ? pending : !isOpen}
                        focusOnMount={i === lastIndex}
                        advisorPhone={advisorPhone}
                        defaultPhone={defaultPhone}
                        callbackRequested={callbackRequested}
                        canAppeal={appealEventId !== null && i === lastIndex}
                      />
                    </MessageContent>
                  </Message>
                );
              }

              const mine = m.from === "member";
              const advisor = m.from === "advisor";
              if (!m.text) return null;
              return (
                <Message key={m.id} align={mine ? "end" : "start"}>
                  <MessageAvatar>
                    {mine ? (
                      <Avatar className="size-8">
                        <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                      </Avatar>
                    ) : advisor ? (
                      <span className="flex size-8 items-center justify-center bg-foreground text-background">
                        <UserRoundIcon className="size-4" />
                      </span>
                    ) : (
                      <span className={lead}>
                        <ScaleIcon className="size-4" />
                      </span>
                    )}
                  </MessageAvatar>
                  <MessageContent>
                    {/* A person, not the assistant: named as one, so the member knows who is speaking. */}
                    {advisor ? <span className="text-xs font-medium text-muted-foreground">Your advisor</span> : null}
                    <div
                      className={cn(
                        "w-fit max-w-[min(42rem,85%)] rounded-2xl px-3.5 py-2.5 whitespace-pre-wrap",
                        mine ? "rounded-br-sm bg-brand text-brand-foreground" : advisor ? "rounded-bl-sm border border-foreground/20 bg-background" : "rounded-bl-sm bg-muted",
                      )}
                    >
                      {m.text}
                    </div>
                  </MessageContent>
                </Message>
              );
            })}
          </MessageGroup>

          {/* Shown from the moment a card is pressed until the server answers — a model turn takes seconds, and a
              silent gap after a press reads as "it didn't take". */}
          {pending && asked ? (
            <div className="mt-4 space-y-3">
              <div className="flex justify-end">
                <div className="w-fit max-w-[min(42rem,85%)] rounded-2xl rounded-br-sm bg-brand px-3.5 py-2.5 text-sm text-brand-foreground opacity-70">{asked}</div>
              </div>
              <TypingIndicator />
            </div>
          ) : null}

          {problem ? (
            <p role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
              {problem}
            </p>
          ) : null}

          {waiting ? (
            <div className="mt-4 ps-10">
              <Button type="button" variant="ghost" size="sm" className="min-h-11 text-muted-foreground" disabled={pending} onClick={handlers.onTalkToAdvisor}>
                <UserRoundIcon />
                Talk to an advisor instead
              </Button>
            </div>
          ) : null}

          <div ref={bottom} aria-hidden className="h-px" />
        </div>
      </div>

      {/* With an advisor, it is a HUMAN thread: no model, no cards — the member can write to a person, and a person will read it. */}
      {status === "escalated" ? (
        <ChatComposer
          conversationId={conversationId}
          initials={initials}
          placeholder="Write to your advisor…"
          footnote="Enter sends · an advisor reads this — nothing here is answered automatically"
          onSend={async (text) => {
            const r = await sendServicingInput(policyId, conversationId, { kind: "text", text });
            if (!r.ok) setProblem(r.message);
            return r;
          }}
        />
      ) : null}

      {hasModel && waiting ? (
        <ChatComposer
          conversationId={conversationId}
          initials={initials}
          placeholder={intent === "appeal" ? "Paste or describe what your document says…" : "Tell me about the treatment…"}
          footnote="Enter sends · or use the buttons above · nothing goes to an advisor until you say so"
          onSend={async (text) => {
            const r = await sendServicingInput(policyId, conversationId, { kind: "text", text });
            if (!r.ok) setProblem(r.message);
            return r;
          }}
        />
      ) : null}
    </>
  );
}

/** The newest conflict card's field, and how to show a chosen value — read from the payload, never from the client. */
function openConflict(messages: ThreadMessage[]): { fieldKey: string; display: (value: string) => string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i].card as { kind?: string; fieldKey?: string; options?: { value: string; display: string }[] } | null;
    if (c?.kind === "servicing_conflict" && c.fieldKey) {
      const options = c.options ?? [];
      return { fieldKey: c.fieldKey, display: (v) => options.find((o) => o.value === v)?.display ?? v };
    }
  }
  return { fieldKey: "amount", display: (v) => v };
}
