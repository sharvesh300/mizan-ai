"use client";

import { SendHorizonalIcon } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { sendChatMessage } from "@/app/applications/new/actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * The composer, and the two things that make the wait bearable: the message
 * the applicant just sent stays on screen, and the assistant visibly thinks.
 *
 * Both matter more here than in most chat UIs. The turn is a server action
 * that re-renders the thread only when it finishes, and a free model takes
 * several seconds — without this the applicant's own words disappear into a
 * blank pause, which reads as "it broke", not as "it is working".
 */
export function ChatComposer({
  conversationId,
  suggestions = [],
  placeholder = "Tell me what you're after…",
  initials,
}: {
  conversationId: string;
  suggestions?: string[];
  placeholder?: string;
  initials?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const send = (text: string) => {
    const answer = text.trim();
    if (!answer || pending) return;
    const formData = new FormData();
    formData.set("answer", answer);
    setValue("");
    setSent(answer);
    startTransition(async () => {
      await sendChatMessage(conversationId, formData);
      // The thread now holds the real message; drop the stand-in.
      setSent(null);
      inputRef.current?.focus();
    });
  };

  return (
    <div className="sticky bottom-0 z-10 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto w-full max-w-5xl space-y-2 px-4 py-3 sm:px-6">
        {sent ? (
          <div className="space-y-3 pb-1">
            <div className="flex justify-end gap-2">
              <div className="w-fit max-w-[min(42rem,85%)] rounded-2xl rounded-br-sm bg-brand px-3.5 py-2.5 text-sm whitespace-pre-wrap text-brand-foreground opacity-70">
                {sent}
              </div>
              <span className="flex size-8 shrink-0 items-center justify-center self-end rounded-full bg-muted text-xs">
                {initials}
              </span>
            </div>
            <TypingIndicator />
          </div>
        ) : null}

        {suggestions.length > 0 && !pending ? (
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((suggestion) => (
              <Button
                key={suggestion}
                type="button"
                variant="outline"
                size="xs"
                disabled={pending}
                onClick={() => send(suggestion)}
              >
                {suggestion}
              </Button>
            ))}
          </div>
        ) : null}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            send(value);
          }}
          className="flex w-full items-end gap-2 rounded-2xl border bg-background p-2 shadow-sm focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
        >
          <Textarea
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send(value);
              }
            }}
            rows={1}
            disabled={pending}
            placeholder={pending ? "Thinking…" : placeholder}
            aria-label="Your message"
            className="max-h-48 min-h-9 flex-1 resize-none border-0 bg-transparent px-2.5 py-1.5 text-base shadow-none focus-visible:ring-0 md:text-sm"
          />
          <Button
            type="submit"
            size="icon"
            className="shrink-0 rounded-xl"
            disabled={pending || value.trim().length === 0}
            aria-label="Send"
          >
            <SendHorizonalIcon />
          </Button>
        </form>

        <p className="px-1 text-[11px] text-muted-foreground">
          Enter sends · Shift + Enter for a new line · nothing goes to an advisor until you say so
        </p>
      </div>
    </div>
  );
}

/** Three dots, the universal "still here". */
function TypingIndicator() {
  return (
    <div className="flex items-center gap-2" role="status" aria-label="Assistant is typing">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground">
        <span className="size-2 rounded-full bg-brand-foreground/70" />
      </span>
      <span className="flex items-center gap-1 rounded-2xl rounded-bl-sm bg-muted px-3.5 py-3">
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
    </div>
  );
}
