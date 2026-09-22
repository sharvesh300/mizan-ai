"use client";

import { useState } from "react";
import { SendHorizonalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { QuestionCard as Payload } from "@/lib/servicing/cards";
import { CardShell, TOUCH, type CardViewProps } from "./shell";

/**
 * One question. A closed vocabulary is chips, so the member types only when only typing will do — and
 * "Not sure" is a chip like any other: a real answer with its own handling, not a way out of the form.
 */
export function QuestionCard({ card, handlers, answered, disabled, focusOnMount }: { card: Payload } & CardViewProps) {
  const [text, setText] = useState("");
  const locked = disabled || answered != null;

  const send = (value: string, label = value) => {
    if (!value.trim() || locked) return;
    handlers?.onAnswer?.({ fieldKey: card.fieldKey, value: value.trim(), label });
  };

  return (
    <CardShell label="A question for you" focusOnMount={focusOnMount}>
      <p className="text-sm text-pretty">{card.text}</p>

      {card.chips.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {card.chips.map((chip) => {
            const chosen = answered === chip.label || answered === chip.value;
            return (
              <Button
                key={chip.value}
                type="button"
                variant={chosen ? "default" : "outline"}
                aria-pressed={chosen}
                disabled={locked && !chosen}
                className={TOUCH}
                onClick={() => send(chip.value, chip.label)}
              >
                {chip.label}
              </Button>
            );
          })}
        </div>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {card.input === "amount" ? <span className="text-sm text-muted-foreground">AED</span> : null}
            <Input
              value={answered ?? text}
              onChange={(e) => setText(e.target.value)}
              disabled={locked}
              type={card.input === "date" ? "date" : "text"}
              inputMode={card.input === "amount" ? "decimal" : undefined}
              aria-label={card.text}
              placeholder={card.input === "amount" ? "Total amount" : card.input === "date" ? undefined : "Type your answer"}
              className="h-11 min-w-0 flex-1"
            />
          </div>
          <Button type="submit" size="icon-lg" className="size-11" disabled={locked || !text.trim()} aria-label="Send answer">
            <SendHorizonalIcon />
          </Button>
        </form>
      )}
    </CardShell>
  );
}
