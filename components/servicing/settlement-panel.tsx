"use client";

// A payout, and the two verbs on it (§payouts) — BROKER ONLY.
//
// Approve, then mark paid. They are deliberately separate buttons in separate states rather than one control
// that changes label: an advisor looking at this needs to see at a glance which of the two has happened, and a
// single morphing button cannot show that.

import { BanknoteIcon, CheckIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { decideSettlement } from "@/app/policies/[id]/settlements/actions";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { money } from "@/lib/domain";

export type SettlementRow = {
  settlementId: string;
  taskId: string | null;
  status: "awaiting_approval" | "approved" | "paid";
  amount: number;
  payee: "member" | "provider";
  eventRef: string;
  paidOn: string | null;
  approvedBy: string | null;
  paidBy: string | null;
  paymentReference: string | null;
};

const STATUS: Record<SettlementRow["status"], { label: string; tone: "brand" | "info" | "success" }> = {
  awaiting_approval: { label: "Awaiting approval", tone: "brand" },
  approved: { label: "Approved — not yet paid", tone: "info" },
  paid: { label: "Paid", tone: "success" },
};

export function SettlementPanel({ policyId, row }: { policyId: string; row: SettlementRow }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [reference, setReference] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const decide = (raw: Record<string, unknown>) => {
    if (pending) return;
    setResult(null);
    startTransition(async () => {
      try {
        const r = await decideSettlement(policyId, { ...raw, taskId: row.taskId });
        setResult({ ok: r.ok, text: r.message });
        if (r.ok) router.refresh();
      } catch {
        setResult({ ok: false, text: "That didn't go through. Nothing was paid — please try again." });
      }
    });
  };

  const status = STATUS[row.status];

  return (
    <div className="space-y-3 rounded-lg border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
        <span className="text-sm font-medium">{money(row.amount)}</span>
        <span className="text-xs text-muted-foreground">
          to the {row.payee === "member" ? "member" : "provider"} · {row.eventRef}
        </span>
      </div>

      {row.status === "paid" ? (
        <p className="text-xs text-muted-foreground text-pretty">
          {row.paidOn ? `Paid ${row.paidOn}` : "Paid"}
          {row.paymentReference ? ` · reference ${row.paymentReference}` : ""}
          {row.paidBy ? ` · by ${row.paidBy}` : ""}
        </p>
      ) : null}

      {row.status === "awaiting_approval" && row.taskId ? (
        <div className="space-y-2">
          <Label htmlFor={`note-${row.settlementId}`}>Note for the file</Label>
          <Textarea
            id={`note-${row.settlementId}`}
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What you checked before releasing this"
            disabled={pending}
          />
          <Button type="button" disabled={pending || note.trim().length < 10} onClick={() => decide({ verb: "approve", note })}>
            <CheckIcon />
            Approve payment
          </Button>
          {note.trim().length < 10 ? <p className="text-xs text-muted-foreground">Add a note (a sentence) — every payment decision is on the record.</p> : null}
        </div>
      ) : null}

      {row.status === "approved" && row.taskId ? (
        <div className="space-y-2">
          <Label htmlFor={`ref-${row.settlementId}`}>Payment reference</Label>
          <Input
            id={`ref-${row.settlementId}`}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="e.g. TRF-88214"
            disabled={pending}
          />
          <p className="text-xs text-muted-foreground text-pretty">
            {row.approvedBy ? `Approved by ${row.approvedBy}. ` : ""}Mark this paid only once the money has actually left.
          </p>
          <Button type="button" disabled={pending || reference.trim().length < 3} onClick={() => decide({ verb: "mark_paid", paymentReference: reference })}>
            <BanknoteIcon />
            Mark as paid
          </Button>
        </div>
      ) : null}

      {result ? (
        <p
          role={result.ok ? "status" : "alert"}
          className={`rounded-lg border px-3 py-2.5 text-sm ${result.ok ? "border-success/30 bg-success-subtle text-success" : "border-destructive/30 bg-destructive/5 text-destructive"}`}
        >
          {result.text}
        </p>
      ) : null}
    </div>
  );
}
