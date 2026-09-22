"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { EvidenceRequestCard as Payload } from "@/lib/servicing/cards";
import { CardShell, TOUCH, type CardViewProps } from "./shell";

/**
 * A request for one thing, naming what it has to show — and a real way to say no.
 *
 * "I don't have this" is an action, not silence. Without it the only way to decline is to say nothing, and
 * the loop that decides whether to ask again would have to wait out a timeout instead of resolving.
 * Documents arrive as text: the brief puts document processing out of scope, and the supplied evidence
 * is a sentence.
 */
export function EvidenceRequestCard({ card, handlers, answered, disabled, focusOnMount }: { card: Payload } & CardViewProps) {
  const [text, setText] = useState("");
  const locked = disabled || answered != null;

  return (
    <CardShell label="A document request" wide focusOnMount={focusOnMount}>
      <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
        <p className="font-medium text-pretty">{card.contested.title}</p>
        <p className="text-xs text-muted-foreground text-pretty">{card.contested.decision}</p>
      </div>

      <p className="text-sm text-pretty">{card.prompt}</p>
      <p className="text-xs text-muted-foreground text-pretty">
        <span className="font-medium text-foreground">It needs to show:</span> {card.mustShow}
      </p>

      {/* Where the evidence is, so the member knows what is happening to it (plan §13.2.6). */}
      <ol aria-label="Progress" className="flex items-center gap-3 text-xs text-muted-foreground">
        {["Asked", "Received", "Checked"].map((step, i) => {
          const at = answered != null ? 1 : 0;
          return (
            <li key={step} className="flex items-center gap-1.5" aria-current={i === at ? "step" : undefined}>
              <span className={`size-2 rounded-full ${i <= at ? "bg-brand" : "border"}`} aria-hidden />
              <span className={i === at ? "font-medium text-foreground" : undefined}>{step}</span>
            </li>
          );
        })}
      </ol>

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() && !locked) handlers?.onEvidence?.(text.trim());
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="evidence-text">Paste or describe what it says</Label>
          <Textarea id="evidence-text" rows={4} value={answered ?? text} disabled={locked} onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button type="submit" className={TOUCH} disabled={locked || !text.trim()}>
            Send
          </Button>
          <Button type="button" variant="outline" className={TOUCH} disabled={locked} onClick={() => handlers?.onDeclineEvidence?.()}>
            I don&apos;t have this
          </Button>
        </div>
      </form>
    </CardShell>
  );
}
