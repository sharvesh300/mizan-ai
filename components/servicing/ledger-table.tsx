// The running ledger — BROKER ONLY.
//
// The brief asks for "utilization and history … not just the current balance, but
// what happened and when." One row per event, in the order it TOOK EFFECT (which is
// not always the order it was filed: an overturn lands at the denial's position),
// with the ledger after each. A broker can see the month a cap was hit.
//
// A pre-authorization is a forecast: it reads the ledger and never moves it, so its
// row is dimmed and its ledger cells are blank rather than repeating a number that
// did not change because of it.

import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { eventKindLabel, outcomeLabel, outcomeTone } from "@/lib/domain";
import type { replayPolicy } from "@/lib/servicing/store";
import { cn } from "cn";
import { Money } from "./primitives";

type Replayed = Awaited<ReturnType<typeof replayPolicy>>;

export function LedgerTable({ replayed }: { replayed: Replayed }) {
  const { steps, stored, terms } = replayed;
  const byId = new Map(stored.map((row) => [row.id, row]));
  const showMaternity = terms.maternityCovered;

  return (
    <div className="overflow-x-auto rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Event</TableHead>
            <TableHead>Month</TableHead>
            <TableHead>Outcome</TableHead>
            <TableHead className="text-right">Billed</TableHead>
            <TableHead className="text-right">Plan pays</TableHead>
            <TableHead className="text-right">Member pays</TableHead>
            <TableHead className="text-right">Deductible met</TableHead>
            <TableHead className="text-right">Annual paid</TableHead>
            {showMaternity ? <TableHead className="text-right">Maternity used</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {steps.map(({ event, result }) => {
            const row = byId.get(event.id)!;
            const forecast = event.kind === "preauth";
            const after = result.ledgerAfter;
            const outcome = row.outcome ?? result.outcome;
            return (
              <TableRow key={event.id} className={cn(forecast && "text-muted-foreground")}>
                <TableCell>
                  <span className="font-mono text-xs">{row.externalRef ?? row.id.slice(0, 8)}</span>
                  <span className="block text-xs text-muted-foreground">{eventKindLabel[row.kind]}</span>
                </TableCell>
                <TableCell className="tabular-nums">{event.policyMonth}</TableCell>
                <TableCell>
                  <StatusBadge tone={outcomeTone[outcome]}>{outcomeLabel[outcome]}</StatusBadge>
                </TableCell>
                <TableCell className="text-right">
                  <Money value={event.amount} />
                </TableCell>
                <TableCell className="text-right">
                  <Money value={result.planPays} />
                </TableCell>
                <TableCell className="text-right">
                  <Money value={result.memberPays} />
                </TableCell>
                <TableCell className="text-right">{forecast ? "—" : <Money value={after.deductibleMet} />}</TableCell>
                <TableCell className="text-right">{forecast ? "—" : <Money value={after.annualPaid} />}</TableCell>
                {showMaternity ? (
                  <TableCell className="text-right">{forecast ? "—" : <Money value={after.sublimitUsed.maternity ?? 0} />}</TableCell>
                ) : null}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
