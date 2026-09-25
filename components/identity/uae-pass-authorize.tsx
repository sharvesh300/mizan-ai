"use client";

import { BellRingIcon, CheckIcon, FingerprintIcon, SmartphoneIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { cancelUaePassVerification, completeUaePassVerification } from "@/app/verify/uae-pass/actions";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

type Scope = { claim: string; label: string };

/**
 * The provider's side of the hand-off, simulated.
 *
 * Real UAE PASS web login is two screens: enter your identifier, then approve
 * the push notification on your phone. The second screen is the one that sells
 * the idea in a demo, so the "phone" is drawn on the page and its Approve
 * button is what finishes the flow. Nothing here asks for a credential.
 */
export function UaePassAuthorize({
  state,
  identifier,
  scopes,
}: {
  state: string;
  identifier: string;
  scopes: readonly Scope[];
}) {
  const [step, setStep] = useState<"login" | "phone">("login");

  return (
    <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-5 py-3">
        <FingerprintIcon className="size-5 text-success" />
        <span className="text-sm font-semibold tracking-wide">UAE PASS</span>
        <span className="ml-auto rounded-full bg-warning-subtle px-2 py-0.5 text-[0.65rem] font-medium tracking-wide text-warning uppercase">
          Sandbox · simulated
        </span>
      </div>

      {step === "login" ? (
        <div className="space-y-5 p-5">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">Login to continue to Mizan AI</h2>
            <p className="text-sm text-muted-foreground text-pretty">
              Mizan AI is asking UAE PASS to confirm who you are and share the following:
            </p>
          </div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {scopes.map((scope) => (
              <li key={scope.claim} className="flex items-center gap-2 text-sm">
                <CheckIcon className="size-4 shrink-0 text-success" />
                {scope.label}
              </li>
            ))}
          </ul>
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Emirates ID, email or phone</p>
            <p className="rounded-lg border bg-muted/40 px-3 py-2 font-mono text-sm">{identifier}</p>
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <form action={cancelUaePassVerification}>
              <Button type="submit" variant="ghost" className="w-full sm:w-auto">
                Cancel
              </Button>
            </form>
            <Button size="lg" onClick={() => setStep("phone")}>
              <SmartphoneIcon />
              Send request to my UAE PASS app
            </Button>
          </div>
        </div>
      ) : (
        <PhoneStep state={state} scopes={scopes} />
      )}
    </div>
  );
}

function PhoneStep({ state, scopes }: { state: string; scopes: readonly Scope[] }) {
  // The real request expires after two minutes; the countdown is there so the screen reads as waiting, not stuck.
  const [left, setLeft] = useState(120);
  useEffect(() => {
    const id = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="grid gap-6 p-5 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Check your phone</h2>
        <p className="text-sm text-muted-foreground text-pretty">
          We sent a request to the UAE PASS app. Open the notification and approve it to continue.
        </p>
        <p className="font-mono text-sm tabular-nums text-muted-foreground" aria-live="polite">
          Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
        </p>
      </div>

      {/* The simulated handset. */}
      <div className="mx-auto w-60 rounded-[2rem] border-4 border-foreground/80 bg-background p-3 shadow-lg">
        <div className="mx-auto mb-3 h-1.5 w-16 rounded-full bg-foreground/20" />
        <div className="space-y-3 rounded-xl border bg-card p-3">
          <div className="flex items-center gap-2">
            <BellRingIcon className="size-4 text-success" />
            <span className="text-xs font-semibold">UAE PASS</span>
            <span className="ml-auto text-[0.65rem] text-muted-foreground">now</span>
          </div>
          <p className="text-xs text-pretty">
            <span className="font-medium">Mizan AI</span> wants to verify your identity and read:
          </p>
          <ul className="space-y-0.5 text-[0.7rem] text-muted-foreground">
            {scopes.map((scope) => (
              <li key={scope.claim}>· {scope.label}</li>
            ))}
          </ul>
          {left === 0 ? (
            <p className="text-xs text-destructive">Request expired.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <form action={cancelUaePassVerification}>
                <Button type="submit" size="sm" variant="outline" className="w-full">
                  <XIcon />
                  Decline
                </Button>
              </form>
              <form action={completeUaePassVerification}>
                <input type="hidden" name="state" value={state} />
                <ApproveButton />
              </form>
            </div>
          )}
        </div>
        <p className="mt-3 text-center text-[0.65rem] text-muted-foreground">Simulated device</p>
      </div>
    </div>
  );
}

function ApproveButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" className="w-full" disabled={pending}>
      {pending ? <Spinner className="size-3.5" /> : <FingerprintIcon />}
      Approve
    </Button>
  );
}
