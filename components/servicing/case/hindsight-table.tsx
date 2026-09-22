// "Had you been on this plan from the start" — plan §13.3.4 (stretch). The SAME history, replayed against every
// catalogue plan, so a recommendation is never a broker's guess: the table underneath it is the proof.

import { CheckIcon, XIcon } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { money } from "@/lib/domain";
import type { HindsightRow } from "@/lib/servicing";

export function HindsightTable({ rows }: { rows: HindsightRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <caption className="sr-only">Every catalogue plan, replayed against this policy&apos;s own claim history.</caption>
        <thead className="bg-muted/40 text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-medium">
              Plan
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Premium
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Member paid
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Total
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Claims refused
            </th>
            <th scope="col" className="px-3 py-2 text-center font-medium">
              Covers what was declared
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={r.planId} className={r.current ? "bg-brand-subtle/30" : undefined}>
              <th scope="row" className="px-3 py-2 text-left font-medium">
                {r.planName}
                {r.current ? (
                  <StatusBadge tone="neutral" className="ml-1.5 align-middle">
                    Current
                  </StatusBadge>
                ) : null}
              </th>
              <td className="px-3 py-2 text-right tabular-nums">{money(r.premium)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{money(r.memberPaid)}</td>
              <td className="px-3 py-2 text-right font-medium tabular-nums">{money(r.total)}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {r.claimsRefused} / {r.claimsTotal}
              </td>
              <td className="px-3 py-2 text-center">
                {r.coversWhatWasDeclared ? (
                  <CheckIcon className="mx-auto size-4 text-success" aria-label="Covers what was declared" />
                ) : (
                  <XIcon className="mx-auto size-4 text-destructive" aria-label="Does not cover what was declared" />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
