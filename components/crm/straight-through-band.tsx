// The number that measures the goal (plan §13.3.5). The point of the feature is FEWER HUMANS IN THE LOOP, so the dashboard says
// whether it is working — and, where it is not, why. The two numbers together answer the only question that matters: is the
// agent earning its keep, and where is it still failing?

import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { QueueRowData } from "@/components/crm/queue-row";
import type { StraightThrough } from "@/lib/queries";
import { ESCALATION_LABEL } from "@/lib/servicing/escalation";

const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((n / d) * 100)}%`);

export function StraightThroughBand({ s, queue }: { s: StraightThrough; queue: QueueRowData[] }) {
  const servicing = queue.flatMap((r) => (r.subject?.kind === "servicing" ? [r.subject] : []));
  const waiting = [
    ["Undecidable", servicing.filter((x) => x.group === "undecidable").length],
    ["Signatures", servicing.filter((x) => x.task === "overturn").length],
    ["Blocked", servicing.filter((x) => x.group === "blocked").length],
    ["Quality checks", servicing.filter((x) => x.task === "quality").length],
    ["Callbacks", servicing.filter((x) => x.callback && !x.callback.called).length],
  ] as const;
  const others = s.all.total - s.all.straight;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Straight-through</CardTitle>
        <CardDescription>Servicing outcomes the system decided on its own, of all of them.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-3">
        <div className="space-y-3">
          <div>
            <p className="text-2xl font-semibold tabular-nums">
              {s.all.straight} of {s.all.total} <span className="text-base font-normal text-muted-foreground">{pct(s.all.straight, s.all.total)}</span>
            </p>
            <p className="text-xs text-muted-foreground">So far</p>
          </div>
          <div>
            <p className="text-lg font-medium tabular-nums">
              {s.week.straight} of {s.week.total} <span className="text-sm font-normal text-muted-foreground">{pct(s.week.straight, s.week.total)}</span>
            </p>
            <p className="text-xs text-muted-foreground">This week</p>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium">{others === 0 ? "Nothing needed a person" : `Why the other ${others} needed a person`}</p>
          {s.causes.length ? (
            <ul className="space-y-1.5 text-sm">
              {s.causes.map((c) => (
                <li key={c.cause} className="flex items-center gap-2">
                  <StatusBadge tone="neutral">{ESCALATION_LABEL[c.cause]}</StatusBadge>
                  <span className="tabular-nums text-muted-foreground">{c.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No causes recorded.</p>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium">Waiting on you now</p>
          <ul className="space-y-1.5 text-sm">
            {waiting.map(([label, n]) => (
              <li key={label} className="flex items-center justify-between gap-3">
                <span>{label}</span>
                <Link href="/queue" className={`tabular-nums ${n > 0 ? "font-medium" : "text-muted-foreground"}`}>
                  {n}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
