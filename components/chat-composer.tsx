"use client";

import { SendHorizonalIcon } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { sendChatAnswer } from "@/app/applications/new/actions";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

export function ChatComposer({
  conversationId,
  suggestions = [],
  placeholder = "Type your answer…",
}: {
  conversationId: string;
  suggestions?: string[];
  placeholder?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const send = (text: string) => {
    const answer = text.trim();
    if (!answer || pending) return;
    const formData = new FormData();
    formData.set("answer", answer);
    setValue("");
    startTransition(async () => {
      await sendChatAnswer(conversationId, formData);
      inputRef.current?.focus();
    });
  };

  return (
    <div className="space-y-2">
      {suggestions.length > 0 ? (
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
        className="flex items-end gap-2 rounded-xl border bg-background p-2 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
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
          placeholder={placeholder}
          aria-label="Your answer"
          className="max-h-32 min-h-8 resize-none border-0 bg-transparent px-1.5 py-1 shadow-none focus-visible:ring-0"
        />
        <Button type="submit" size="icon-sm" disabled={pending || value.trim().length === 0} aria-label="Send">
          {pending ? <Spinner /> : <SendHorizonalIcon />}
        </Button>
      </form>
    </div>
  );
}
