"use client";

// What every servicing card shares: the container, the touch-target sizing, and the
// handlers a card reports back through.
//
// The handlers are plain callbacks on purpose. A card is DISPLAY ONLY (lib/servicing/cards.ts):
// what comes back is never trusted as data — a chip press reports WHICH chip, and the
// server re-derives its meaning from its own row. Phase 4 wires each callback to a server
// action; the components do not know or care.

import { useEffect, useRef } from "react";
import { cn } from "cn";

export type CardHandlers = {
  /** A chip pressed, or a typed answer sent. `value` is what to interpret; `label` is what the member saw. */
  onAnswer?: (answer: { fieldKey: string; value: string; label: string }) => void;
  /** "Looks right". */
  onConfirm?: () => void;
  /** "Change something". */
  onChange?: () => void;
  /** The no-model form, submitted. */
  onSubmitForm?: (values: Record<string, string>) => void;
  /** Evidence typed or pasted. */
  onEvidence?: (text: string) => void;
  /** "I don't have this" — a real answer, not silence. */
  onDeclineEvidence?: () => void;
  /** One of two conflicting values chosen. */
  onChooseConflict?: (value: string) => void;
  onAppeal?: () => void;
  /** Resolves false when the request was NOT recorded, so the card never claims a callback that was not booked. */
  onCallback?: (request: { window: string; phone: string }) => void | Promise<boolean | void>;
  /** "Talk to an advisor", from wherever the member is. */
  onTalkToAdvisor?: () => void;
};

export type CardViewProps = {
  handlers?: CardHandlers;
  /** True once the member has answered: the card stays on screen, read-only, showing what they chose. */
  answered?: string | null;
  disabled?: boolean;
  /** Move focus into the card when it appears (the newest card in a thread does; a card in history does not). */
  focusOnMount?: boolean;
};

/**
 * A touch target of at least 44px, for chips and actions. The stock button is 32px, which is fine
 * for a mouse and too small for the phone a claim is usually submitted from.
 */
export const TOUCH = "h-auto min-h-11 whitespace-normal py-2";

export function CardShell({
  label,
  wide = false,
  dashed = false,
  focusOnMount = false,
  className,
  children,
}: {
  /** Names the group for a screen reader. */
  label: string;
  wide?: boolean;
  dashed?: boolean;
  focusOnMount?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusOnMount) ref.current?.querySelector<HTMLElement>("button:not(:disabled), input, textarea, select")?.focus();
  }, [focusOnMount]);

  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      className={cn(
        // @container: children size themselves to the CARD, not the viewport — the same card sits in a phone
        // screen, the chat drawer and a wide page, and only its own width says whether three columns fit.
        "@container w-full space-y-3 rounded-2xl rounded-bl-sm border bg-card p-4 shadow-sm",
        wide ? "max-w-xl" : "max-w-md",
        dashed && "border-dashed",
        className,
      )}
    >
      {children}
    </div>
  );
}
