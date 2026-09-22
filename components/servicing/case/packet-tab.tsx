// The case packet, as a broker reads it (plan §8) — a query rendered, so it cannot disagree with the record. Read-only.

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { dateLabel, money, reasonCodeLabel, reviewActionLabel } from "@/lib/domain";
import type { ReviewAction, ReasonCode } from "@/db/schema/enums";
import type { Packet } from "@/lib/servicing/packet";

const Section = ({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) => (
  <Card>
    <CardHeader>
      <CardTitle className="text-base">{title}</CardTitle>
      {description ? <CardDescription>{description}</CardDescription> : null}
    </CardHeader>
    <CardContent>{children}</CardContent>
  </Card>
);
const Empty = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-muted-foreground">{children}</p>;

export function PacketTab({ p }: { p: Packet }) {
  return (
    <div className="space-y-4">
      <Section title="Why it needs you" description="The cause is the queue's fact — the member is never told it.">
        {p.why.cause ? (
          <p className="text-sm">
            <StatusBadge tone="warning">{p.why.cause.replace(/_/g, " ")}</StatusBadge> <span className="text-muted-foreground">— {p.why.meaning}.</span>
          </p>
        ) : null}
        {p.why.reasons.length ? (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-pretty">
            {p.why.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : (
          <Empty>No reason recorded.</Empty>
        )}
        {p.callback ? (
          <p className="mt-3 text-sm">
            <span className="font-medium">Callback requested</span> · {p.callback.window} · <span className="tabular-nums">{p.callback.phone}</span>
          </p>
        ) : null}
      </Section>

      <Section title="What the member told us" description="Each fact, the sentence it came from, and how it was read.">
        {p.facts.length ? (
          <table className="w-full text-sm">
            <tbody>
              {p.facts.map((f) => (
                <tr key={f.key} className="border-t first:border-t-0 align-top">
                  <th scope="row" className="w-32 py-1.5 pr-3 text-left font-normal text-muted-foreground">
                    {f.label}
                  </th>
                  <td className="py-1.5">
                    <span className="font-medium">{f.value}</span>
                    <span className="block text-xs text-muted-foreground text-pretty">“{f.quote}” — {f.source}</span>
                  </td>
                </tr>
              ))}
              {p.benefitClass ? (
                <tr className="border-t align-top">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal text-muted-foreground">
                    Counts as
                  </th>
                  <td className="py-1.5">
                    <span className="font-medium">{p.benefitClass.value.replace(/_/g, " ")}</span>
                    <span className="block text-xs text-muted-foreground">{p.benefitClass.declaredCondition ? `their declared ${p.benefitClass.declaredCondition} · ` : ""}chosen by {p.benefitClass.by === "member" ? "the member" : "the agent"}</span>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : (
          <Empty>Nothing collected — the case left the agent before any details were given.</Empty>
        )}
      </Section>

      {p.evidence.length || p.evidenceState ? (
        <Section title="Evidence, and where it stands">
          {p.evidence.length ? (
            <ol className="space-y-2 text-sm">
              {p.evidence.map((e, i) => (
                <li key={i} className="rounded-lg border p-3">
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline">Evidence {i + 1}</Badge>
                    {e.verdict ? <StatusBadge tone={e.verdict === "bears_on" ? "success" : "neutral"}>{e.verdict === "bears_on" ? `bears on the finding${e.kind ? ` · ${e.kind.replace(/_/g, " ")}` : ""}` : "does not bear on the finding"}</StatusBadge> : <StatusBadge tone="warning">not yet read</StatusBadge>}
                  </div>
                  <p className="whitespace-pre-line text-pretty text-muted-foreground">{e.text}</p>
                </li>
              ))}
            </ol>
          ) : (
            <Empty>Nothing supplied.</Empty>
          )}
          {p.evidenceState ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Asked for: {p.evidenceState.requested.join(", ") || "—"} · declined: {p.evidenceState.declined.join(", ") || "—"} · supplied: {p.evidenceState.supplied.join(", ") || "—"}
            </p>
          ) : null}
        </Section>
      ) : null}

      <Section title="Still open with the member">
        {p.unresolved.length ? (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {p.unresolved.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        ) : (
          <Empty>Nothing is waiting on the member.</Empty>
        )}
      </Section>

      <Section title="The conversation" description="Verbatim. Everything the member has already said — they should never be asked twice.">
        {p.transcript.length ? (
          <ol className="space-y-2">
            {p.transcript.map((m) => (
              <li key={m.id} className={`rounded-lg px-3 py-2 text-sm ${m.from === "member" ? "bg-brand-subtle/40" : m.from === "advisor" ? "border border-brand/40" : "bg-muted/40"}`}>
                <span className="mr-2 text-xs font-medium text-muted-foreground">{m.from === "member" ? "Member" : m.from === "advisor" ? "Advisor" : "Assistant"}</span>
                <span className="text-pretty">{m.text || (m.card ? `(${m.card.replace(/^servicing_/, "").replace(/_/g, " ")} card)` : "")}</span>
              </li>
            ))}
          </ol>
        ) : (
          <Empty>There is no conversation behind this — it was recorded directly.</Empty>
        )}
      </Section>

      <Section title="On this policy">
        <ol className="space-y-1 text-sm">
          {p.history.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-x-2">
              <span className="font-mono text-xs">{h.ref}</span>
              <span>{h.kind}</span>
              <span className="text-muted-foreground tabular-nums">· month {h.month}</span>
              {h.outcome ? <span className="text-muted-foreground">· {h.outcome.replace(/_/g, " ")}</span> : null}
              {h.reasonCode ? <span className="text-xs text-muted-foreground">({reasonCodeLabel[h.reasonCode as ReasonCode] ?? h.reasonCode})</span> : null}
              <span className="text-muted-foreground tabular-nums">· plan {money(h.planPays)}</span>
            </li>
          ))}
        </ol>
        {p.appeals.length ? <p className="mt-2 text-xs text-muted-foreground">Appeals: {p.appeals.map((a) => `${a.ref} → ${a.contests} (${a.outcome})`).join("; ")}</p> : null}
        {p.reassessments.length ? <p className="mt-1 text-xs text-muted-foreground text-pretty">Plan fit: {p.reassessments[0].verdict.replace(/_/g, " ")} — {p.reassessments[0].reasoning}</p> : null}
      </Section>

      <Section title="What has been done">
        {p.decisions.length ? (
          <ol className="space-y-1.5 text-sm">
            {p.decisions.map((d, i) => (
              <li key={i} className="text-pretty">
                <span className="font-medium">{reviewActionLabel[d.action as ReviewAction] ?? d.action}</span> · {d.by ?? "someone"} · <span className="text-muted-foreground">{dateLabel(d.at)}</span>
                {d.notes ? <span className="block text-xs text-muted-foreground">{d.notes}</span> : null}
              </li>
            ))}
          </ol>
        ) : (
          <Empty>Nothing yet.</Empty>
        )}
      </Section>
    </div>
  );
}
