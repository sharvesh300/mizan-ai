"use client";

import { useState } from "react";
import { CheckCircle2Icon, CopyIcon, PhoneCallIcon, PhoneIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { EscalationCard as Payload } from "@/lib/servicing/cards";
import { CardShell, TOUCH, type CardViewProps } from "./shell";

/** Shown after a callback is requested — interactive state, so a render of the initial card never reaches it. Exported so it can be scanned. */
export const CALLBACK_RECEIVED = "Request received. An advisor will call you.";

const WINDOW_LABEL = { morning: "Morning", afternoon: "Afternoon", evening: "Evening" } as const;

/**
 * The hand-off. Calm — nothing has gone wrong from the member's side — and complete: their progress is not
 * lost, and they never repeat anything.
 *
 * Two things this card must NOT do. It does not say WHY the case left the agent (that cause is the broker's,
 * and is not on the payload at all), and it does not promise a time — the system has no SLA, so the copy
 * cannot state one. The number to call comes in as a prop from trusted server configuration; the model
 * never sees it and never writes it, and it is not part of the payload.
 */
export function EscalationCard({
  card,
  handlers,
  advisorPhone,
  defaultPhone = "",
  callbackRequested = false,
  disabled,
  focusOnMount,
}: {
  card: Payload;
  /** From server-side configuration (ADVISOR_PHONE). Null when none is configured: then only the callback is offered. */
  advisorPhone: string | null;
  /** The member's own number, from their profile — so a callback re-collects nothing. */
  defaultPhone?: string;
  /** A callback was already requested (read from the database), so a reload does not offer it again. */
  callbackRequested?: boolean;
} & CardViewProps) {
  const [asking, setAsking] = useState(false);
  const [windowChoice, setWindowChoice] = useState<string>(card.callbackWindows[0]);
  const [phone, setPhone] = useState(defaultPhone);
  const [requested, setRequested] = useState(callbackRequested);
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <CardShell label="Your case is with an advisor" wide focusOnMount={focusOnMount}>
      <div className="space-y-1">
        <h3 className="text-base font-medium text-balance">We couldn&apos;t settle this one automatically.</h3>
        <p className="text-sm text-pretty text-muted-foreground">
          Your request and everything you&apos;ve told us is with an advisor — you won&apos;t need to repeat any of it.
        </p>
      </div>

      <p className="text-sm">
        Reference <span className="ml-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{card.reference}</span>
      </p>

      {requested ? (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-success/30 bg-success-subtle px-3 py-2.5 text-sm text-success">
          <CheckCircle2Icon className="size-4 shrink-0" />
          {CALLBACK_RECEIVED}
        </p>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {advisorPhone ? (
              <Button nativeButton={false} className={TOUCH} disabled={disabled} render={<a href={`tel:${advisorPhone.replace(/\s+/g, "")}`} />}>
                <PhoneIcon />
                Call an advisor
              </Button>
            ) : null}
            <Button type="button" variant={advisorPhone ? "outline" : "default"} className={TOUCH} disabled={disabled} aria-expanded={asking} onClick={() => setAsking((v) => !v)}>
              <PhoneCallIcon />
              Request a callback
            </Button>
          </div>
          {/* A tel: link does nothing on a laptop, so the number is always readable too. */}
          {advisorPhone ? (
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>Or call {advisorPhone}</span>
              <Button
                type="button"
                variant="ghost"
                className={TOUCH}
                aria-label={copied ? "Number copied" : "Copy the number"}
                onClick={() => {
                  void navigator.clipboard?.writeText(advisorPhone).then(() => setCopied(true), () => undefined);
                }}
              >
                <CopyIcon />
                {copied ? "Copied" : "Copy"}
              </Button>
            </p>
          ) : null}

          {asking ? (
            <form
              className="space-y-3 rounded-lg border p-3"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!phone.trim() || sending) return;
                setSending(true);
                setFailed(false);
                const ok = await handlers?.onCallback?.({ window: windowChoice, phone: phone.trim() });
                setSending(false);
                if (ok === false) setFailed(true);
                else setRequested(true);
              }}
            >
              <fieldset className="space-y-1.5">
                <legend className="text-xs font-medium">When suits you?</legend>
                <div className="grid grid-cols-3 gap-2">
                  {card.callbackWindows.map((w) => (
                    <label
                      key={w}
                      className={`flex min-h-11 cursor-pointer items-center justify-center rounded-lg border px-2 text-sm has-[:checked]:border-brand has-[:checked]:bg-brand-subtle has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50`}
                    >
                      <input type="radio" name="callback-window" value={w} checked={windowChoice === w} onChange={() => setWindowChoice(w)} className="sr-only" />
                      {WINDOW_LABEL[w]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="space-y-1.5">
                <Label htmlFor="callback-phone">Best number to reach you</Label>
                <Input id="callback-phone" type="tel" className="h-11" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
              {failed ? (
                <p role="alert" className="text-sm text-destructive">
                  We couldn&apos;t record that. Check the number and try again.
                </p>
              ) : null}
              <Button type="submit" className={TOUCH + " w-full"} disabled={!phone.trim() || sending}>
                {sending ? "Sending…" : "Send request"}
              </Button>
            </form>
          ) : null}
        </>
      )}

      <details className="group rounded-md border bg-muted/30 px-3 py-2 text-sm">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none group-open:mb-2">What your advisor will have</summary>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          {card.summary.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
    </CardShell>
  );
}
