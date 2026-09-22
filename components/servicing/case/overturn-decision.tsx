"use client";

// The three verbs on a reversal waiting for a signature (plan §13.3.2). The arithmetic is on the page ABOVE this — the
// case page and the queue row both show it first — so a signature is one informed act, not a click in the dark.
//
// Every verb that speaks to the member takes TWO texts: a note for the file, and the message the member reads. The
// message is pre-drafted (it is the proposal's own, already checked) and editable; what an advisor changes is held to the
// member register and to the figures the working holds when it is signed, on the server.

import { CheckIcon, HelpCircleIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { decideOverturn } from "@/app/policies/[id]/events/[eventId]/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Verb = "confirm" | "uphold" | "more_evidence";

export function OverturnDecision({ policyId, eventId, taskId, memberMessage, canAskMore }: { policyId: string; eventId: string; taskId: string; memberMessage: string; canAskMore: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [message, setMessage] = useState(memberMessage);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const decide = (verb: Verb) => {
    if (pending) return;
    setResult(null);
    startTransition(async () => {
      try {
        const r = await decideOverturn(policyId, eventId, { taskId, verb, note, memberMessage: verb === "uphold" ? undefined : message });
        setResult({ ok: r.ok, text: r.message });
        if (r.ok) router.refresh();
      } catch {
        setResult({ ok: false, text: "That didn't go through. Nothing was signed — please try again." });
      }
    });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="decision-note">Note for the file</Label>
        <Textarea id="decision-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you checked before deciding" disabled={pending} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="decision-message">Message to the member</Label>
        <Textarea id="decision-message" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} disabled={pending} />
        <p className="text-xs text-muted-foreground">Pre-drafted from the working. Edit it if it reads badly — it is still held to the member&apos;s wording and to figures the working holds.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={pending || note.trim().length < 10} onClick={() => decide("confirm")}>
          <CheckIcon />
          Confirm reversal
        </Button>
        <Button type="button" variant="outline" disabled={pending || note.trim().length < 10} onClick={() => decide("uphold")}>
          <XIcon />
          Uphold instead
        </Button>
        <Button type="button" variant="outline" disabled={pending || !canAskMore || note.trim().length < 10} onClick={() => decide("more_evidence")}>
          <HelpCircleIcon />
          Ask for more evidence
        </Button>
      </div>
      {note.trim().length < 10 ? <p className="text-xs text-muted-foreground">Add a note (a sentence) to enable a decision — every one is on the record.</p> : null}
      {!canAskMore ? <p className="text-xs text-muted-foreground">There is nothing further that could be asked for on this decision.</p> : null}

      {result ? (
        <p role={result.ok ? "status" : "alert"} className={`rounded-lg border px-3 py-2.5 text-sm ${result.ok ? "border-success/30 bg-success-subtle text-success" : "border-destructive/30 bg-destructive/5 text-destructive"}`}>
          {result.text}
        </p>
      ) : null}
    </div>
  );
}
