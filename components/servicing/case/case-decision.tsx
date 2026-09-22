"use client";

// The verbs on a case that was handed over (plan §13.3.2). Which ones appear depends on what kind of case it is:
//
//   undecidable   Cover it (choose the missing INPUT — the engine's money for each choice is shown, an advisor never types an
//                 amount) · Don't cover it · Reply in thread · Hand off
//   escalation    Reply in thread · Resolve · Hand off · Mark called
//   quality       Close it — a close call that resolved, looked at
//
// Every verb that speaks to the member takes a note for the file AND a message the member reads; the message is held to the
// member's register and to the figures on the case when it is sent, on the server.

import { CheckIcon, MessageSquareIcon, PhoneCallIcon, UsersIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { decideCase } from "@/app/policies/[id]/events/[eventId]/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { money } from "@/lib/domain";

export type CaseKind = "undecidable" | "escalation" | "quality";
type Preview = { tier: string; label: string; outcome: string; planPays: number | null; memberPays: number | null };

export function CaseDecision({
  policyId,
  subjectId,
  taskId,
  kind,
  preview,
  colleagues,
  hasConversation,
  callbackRequested,
  defaultDenyMessage,
}: {
  policyId: string;
  subjectId: string;
  taskId: string;
  kind: CaseKind;
  preview: Preview[] | null;
  colleagues: { id: string; name: string }[];
  hasConversation: boolean;
  callbackRequested: boolean;
  defaultDenyMessage: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [tier, setTier] = useState(preview?.find((p) => p.outcome !== "denied")?.tier ?? preview?.[0]?.tier ?? "");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState("");
  const [colleague, setColleague] = useState(colleagues[0]?.id ?? "");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const go = (body: Record<string, unknown>) => {
    if (pending) return;
    setResult(null);
    startTransition(async () => {
      try {
        const r = await decideCase(policyId, subjectId, { taskId, ...body });
        setResult({ ok: r.ok, text: r.message });
        if (r.ok) {
          setReply("");
          router.refresh();
        }
      } catch {
        setResult({ ok: false, text: "That didn't go through. Nothing was recorded — please try again." });
      }
    });
  };
  const noted = note.trim().length >= 10;
  const chosen = preview?.find((p) => p.tier === tier);

  return (
    <div className="space-y-5">
      {kind === "undecidable" && preview ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">If you cover it, treat the provider as…</legend>
          <p className="text-xs text-muted-foreground text-pretty">The plan defines no cover for treatment outside the UAE. You supply the missing input; the engine works out the money — you never type an amount.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {preview.map((p) => (
              <label key={p.tier} className={`flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm has-[:checked]:border-brand has-[:checked]:bg-brand-subtle has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50`}>
                <span className="flex items-center gap-2">
                  <input type="radio" name="tier" value={p.tier} checked={tier === p.tier} onChange={() => setTier(p.tier)} className="sr-only" />
                  {p.label}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">{p.outcome === "denied" ? "not covered" : `plan ${money(p.planPays)} · member ${money(p.memberPays)}`}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="case-note">Note for the file</Label>
        <Textarea id="case-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} disabled={pending} placeholder="What you checked, and why" />
      </div>

      {hasConversation && (kind === "undecidable" || kind === "escalation") ? (
        <div className="space-y-1.5">
          <Label htmlFor="case-message">Message to the member{kind === "undecidable" ? " (optional)" : ""}</Label>
          <Textarea
            id="case-message"
            rows={3}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={pending}
            placeholder={kind === "undecidable" ? "Leave blank to send the drafted explanation" : "What the member reads when this is closed"}
          />
          <p className="text-xs text-muted-foreground">Held to the member&apos;s wording and to the figures on the case — no internal terms, no promised times.</p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {kind === "undecidable" ? (
          <>
            <Button type="button" disabled={pending || !noted || !chosen || chosen.outcome === "insufficient_data"} onClick={() => go({ verb: "cover", providerTier: tier, note, memberMessage: message || undefined })}>
              <CheckIcon />
              Cover it
            </Button>
            <Button type="button" variant="outline" disabled={pending || !noted} onClick={() => go({ verb: "deny", note, memberMessage: message || undefined })}>
              <XIcon />
              Don&apos;t cover it
            </Button>
          </>
        ) : null}
        {kind === "escalation" ? (
          <Button type="button" disabled={pending || !noted || message.trim().length < 20} onClick={() => go({ verb: "resolve", note, memberMessage: message })}>
            <CheckIcon />
            Resolve
          </Button>
        ) : null}
        {kind === "quality" ? (
          <Button type="button" disabled={pending || !noted} onClick={() => go({ verb: "close_quality", note })}>
            <CheckIcon />
            Looks right — close it
          </Button>
        ) : null}
        {kind === "escalation" && callbackRequested ? (
          <Button type="button" variant="outline" disabled={pending || !noted} onClick={() => go({ verb: "called", note })}>
            <PhoneCallIcon />
            Mark called
          </Button>
        ) : null}
      </div>
      {!noted ? <p className="text-xs text-muted-foreground">Add a note (a sentence) to enable a decision — every one is on the record.</p> : null}
      {kind === "undecidable" && defaultDenyMessage ? <p className="text-xs text-muted-foreground text-pretty">If you don&apos;t cover it and leave the message blank, the member reads: “{defaultDenyMessage}”</p> : null}

      {hasConversation && kind !== "quality" ? (
        <div className="space-y-2 rounded-lg border p-3">
          <Label htmlFor="case-reply" className="flex items-center gap-1.5">
            <MessageSquareIcon className="size-3.5" />
            Reply in the member&apos;s thread
          </Label>
          <Textarea id="case-reply" rows={2} value={reply} onChange={(e) => setReply(e.target.value)} disabled={pending} placeholder="It lands in their conversation, and lights their dot" />
          <Button type="button" size="sm" variant="outline" disabled={pending || reply.trim().length < 20} onClick={() => go({ verb: "reply", message: reply })}>
            Send to the member
          </Button>
        </div>
      ) : null}

      {kind !== "quality" && colleagues.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border p-3">
          <div className="space-y-1.5">
            <Label htmlFor="case-colleague" className="flex items-center gap-1.5">
              <UsersIcon className="size-3.5" />
              Hand to a colleague
            </Label>
            <NativeSelect id="case-colleague" value={colleague} onChange={(e) => setColleague(e.target.value)} disabled={pending}>
              {colleagues.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button type="button" size="sm" variant="outline" disabled={pending || !noted || !colleague} onClick={() => go({ verb: "hand_off", toUserId: colleague, note })}>
            Hand off
          </Button>
        </div>
      ) : null}

      {result ? (
        <p role={result.ok ? "status" : "alert"} className={`rounded-lg border px-3 py-2.5 text-sm ${result.ok ? "border-success/30 bg-success-subtle text-success" : "border-destructive/30 bg-destructive/5 text-destructive"}`}>
          {result.text}
        </p>
      ) : null}
    </div>
  );
}
