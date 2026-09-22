"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { FactsFormCard as Payload } from "@/lib/servicing/cards";
import { CardShell, TOUCH, type CardViewProps } from "./shell";

/**
 * The agent's question as a form: exactly the missing fields, nothing else.
 *
 * With no model key, or after a failed turn, a conversation must never dead-end (free models throttle
 * without warning). This is what it degrades to — in the same thread, from the same missing-fact list a
 * tool returns. Slower to fill in than a sentence, and it always works.
 */
export function FactsFormCard({ card, handlers, answered, disabled, focusOnMount }: { card: Payload } & CardViewProps) {
  // Start from what is already known: a form opened to change one thing must not make the member retype the rest.
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(card.fields.filter((f) => f.current).map((f) => [f.fieldKey, f.current as string])));
  const locked = disabled || answered != null;
  const ready = card.fields.filter((f) => f.required).every((f) => (values[f.fieldKey] ?? "").trim() !== "");
  const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));

  return (
    <CardShell label="A few details" focusOnMount={focusOnMount}>
      <p className="text-sm text-pretty">{card.intro}</p>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !locked) handlers?.onSubmitForm?.(values);
        }}
      >
        {card.fields.map((field) => {
          const id = `facts-${field.fieldKey}`;
          return (
            <div key={field.fieldKey} className="space-y-1.5">
              <Label htmlFor={id}>
                {field.label}
                {field.required ? null : <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}
              </Label>
              {field.input === "choice" || field.input === "yes_no" ? (
                <NativeSelect id={id} value={values[field.fieldKey] ?? ""} disabled={locked} aria-invalid={field.error ? true : undefined} aria-describedby={field.error ? `${id}-error` : undefined} onChange={(e) => set(field.fieldKey, e.target.value)} className="w-full">
                  <NativeSelectOption value="">Choose…</NativeSelectOption>
                  {field.options.map((o) => (
                    <NativeSelectOption key={o.value} value={o.value}>
                      {o.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : (
                <Input
                  id={id}
                  className="h-11"
                  type={field.input === "date" ? "date" : "text"}
                  inputMode={field.input === "amount" ? "decimal" : undefined}
                  value={values[field.fieldKey] ?? ""}
                  disabled={locked}
                  aria-invalid={field.error ? true : undefined}
                  aria-describedby={field.error ? `${id}-error` : field.hint ? `${id}-hint` : undefined}
                  onChange={(e) => set(field.fieldKey, e.target.value)}
                />
              )}
              {field.error ? (
                <p id={`${id}-error`} role="alert" className="text-xs text-destructive text-pretty">
                  {field.error}
                </p>
              ) : null}
              {field.hint ? (
                <p id={`${id}-hint`} className="text-xs text-muted-foreground">
                  {field.hint}
                </p>
              ) : null}
            </div>
          );
        })}
        <Button type="submit" className={TOUCH + " w-full"} disabled={!ready || locked}>
          Continue
        </Button>
      </form>
    </CardShell>
  );
}
