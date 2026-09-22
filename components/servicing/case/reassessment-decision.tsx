"use client";

// The three verbs on a plan-fit recommendation waiting for a signature (plan §13.3.3). Approve keeps the reasoning
// exactly as written; Edit lets the broker rewrite it (still unlocks it for the member — the CHANGE is theirs to
// sign on, not the words); Dismiss means not now, and the row stays on the record either way.

import { CheckIcon, PencilIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { decideReassessment } from "@/app/policies/[id]/reassess/[reassessmentId]/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type Verb = "approve" | "edit" | "dismiss";

export function ReassessmentDecision({ policyId, reassessmentId, taskId, brokerReasoning }: { policyId: string; reassessmentId: string; taskId: string; brokerReasoning: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const [reasoning, setReasoning] = useState(brokerReasoning);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const decide = (verb: Verb) => {
    if (pending) return;
    setResult(null);
    startTransition(async () => {
      try {
        const raw = verb === "edit" ? { taskId, verb, note, brokerReasoning: reasoning } : { taskId, verb, note };
        const r = await decideReassessment(policyId, reassessmentId, raw);
        setResult({ ok: r.ok, text: r.message });
        if (r.ok) router.refresh();
      } catch {
        setResult({ ok: false, text: "That didn't go through. Nothing was decided — please try again." });
      }
    });
  };

  const noteOk = note.trim().length >= 10;
  const reasoningOk = reasoning.trim().length >= 20;

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="reassess-note">Note for the file</Label>
        <Textarea id="reassess-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you checked before deciding" disabled={pending} />
      </div>

      {editing ? (
        <div className="space-y-1.5">
          <Label htmlFor="reassess-reasoning">Reasoning for the file (the broker&apos;s register)</Label>
          <Textarea id="reassess-reasoning" rows={4} value={reasoning} onChange={(e) => setReasoning(e.target.value)} disabled={pending} />
          <p className="text-xs text-muted-foreground">The member&apos;s own wording is untouched — this is what the broker record reads, not what they are sent.</p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {!editing ? (
          <>
            <Button type="button" disabled={pending || !noteOk} onClick={() => decide("approve")}>
              <CheckIcon />
              Approve
            </Button>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setEditing(true)}>
              <PencilIcon />
              Edit reasoning
            </Button>
            <Button type="button" variant="outline" disabled={pending || !noteOk} onClick={() => decide("dismiss")}>
              <XIcon />
              Dismiss
            </Button>
          </>
        ) : (
          <>
            <Button type="button" disabled={pending || !noteOk || !reasoningOk} onClick={() => decide("edit")}>
              <CheckIcon />
              Save and unlock for the member
            </Button>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        )}
      </div>
      {!noteOk ? <p className="text-xs text-muted-foreground">Add a note (a sentence) to enable a decision — every one is on the record.</p> : null}
      {editing && !reasoningOk ? <p className="text-xs text-muted-foreground">Write the reasoning you want on the file (at least a couple of sentences).</p> : null}

      {result ? (
        <p role={result.ok ? "status" : "alert"} className={`rounded-lg border px-3 py-2.5 text-sm ${result.ok ? "border-success/30 bg-success-subtle text-success" : "border-destructive/30 bg-destructive/5 text-destructive"}`}>
          {result.text}
        </p>
      ) : null}
    </div>
  );
}
