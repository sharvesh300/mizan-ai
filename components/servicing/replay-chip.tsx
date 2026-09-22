// "Ledger matches its history" — with a button that proves it.
//
// The brief's definition of done: "delete it, replay the events, get the same
// numbers back." This is that, pressable. The check runs on every render (it is a
// replay of a dozen rows), so the chip is never a stale claim; Rebuild rewrites the
// projection from the log through the store — the only writer of `benefit_ledger`.

import { CheckCircle2Icon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { rebuildLedgerAction } from "@/app/policies/[id]/actions";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { dateLabel } from "@/lib/domain";
import type { ReplayReport } from "@/lib/servicing/store";

export function ReplayChip({ report }: { report: ReplayReport }) {
  return (
    <div className="space-y-2 rounded-lg border px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {report.ok ? (
          <StatusBadge tone="success">
            <CheckCircle2Icon className="size-3" />
            Ledger matches its history
          </StatusBadge>
        ) : (
          <StatusBadge tone="danger">
            <TriangleAlertIcon className="size-3" />
            Ledger has drifted from its history
          </StatusBadge>
        )}
        {report.restated.length > 0 ? <StatusBadge tone="info">{new Set(report.restated.map((d) => d.ref)).size} restated after an overturn</StatusBadge> : null}
        <span className="text-xs text-muted-foreground">
          The ledger is a projection of the event log. Last rebuilt {report.ledgerRebuiltAt ? dateLabel(report.ledgerRebuiltAt) : "never"}.
        </span>
        <form action={rebuildLedgerAction.bind(null, report.policyId)} className="ml-auto">
          <Button type="submit" size="xs" variant="outline">
            <RefreshCwIcon />
            Rebuild from history
          </Button>
        </form>
      </div>
      {!report.ok ? (
        <ul className="space-y-0.5 font-mono text-xs text-destructive">
          {report.ledgerDiffs.map((line) => (
            <li key={line}>{line}</li>
          ))}
          {report.drifted.map((d) => (
            <li key={`${d.ref}-${d.field}`}>
              {d.ref} {d.field}: stored {String(d.stored)}, replayed {String(d.replayed)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
