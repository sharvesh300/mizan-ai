"use client";

// "Something wrong? Tell your advisor" — with something behind it.
//
// Collapsed by default: most people reading their own record are not
// correcting it, and an always-open box invites noise. It says plainly that a
// person will look, because that is what happens — this does not edit the
// record, it asks someone to.

import { useState } from "react";
import { SendIcon } from "lucide-react";
import { flagCorrection } from "@/app/applications/[id]/applicant-actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function CorrectionRequest({ applicationId }: { applicationId: string }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <p className="text-sm text-muted-foreground">
        Thanks — an advisor will look at that and come back to you. Nothing else is needed from you.
      </p>
    );
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Something here is wrong
      </Button>
    );
  }

  return (
    <form
      action={flagCorrection.bind(null, applicationId)}
      onSubmit={() => setSent(true)}
      className="space-y-2"
    >
      <Textarea
        name="correction"
        rows={2}
        required
        autoFocus
        placeholder="My age is wrong — I'm 32, not 23."
        aria-label="What is wrong"
      />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm">
          <SendIcon />
          Send to an advisor
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <span className="text-xs text-muted-foreground">A person reads this — it is not changed automatically.</span>
      </div>
    </form>
  );
}
