// The case page — where a decision gets made (plan §13.3.2), BROKER ONLY.
//
// It mirrors the application record's tab pattern so a broker already knows how to read it: Decision, Working, History.
// What the member was told is shown VERBATIM beside what the system did: the brief's "a system that generates one
// explanation and reformats it will read wrong in one of the two views" is answered by putting the two on one screen.

import { ArrowRightIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { confidenceBand, eventKindLabel, money, reasonCodeLabel } from "@/lib/domain";
import type { EventCase } from "@/lib/servicing/case";
import { monthYear, policyMonthStart } from "@/lib/servicing/dates";
import { CalculationTrace, Money, OutcomeBadge, traceLines } from "../primitives";
import type { Packet } from "@/lib/servicing/packet";
import { ArithmeticDiff, LedgerDiff } from "./arithmetic";
import { CaseDecision, type CaseKind } from "./case-decision";
import { PacketTab } from "./packet-tab";
import { OverturnDecision } from "./overturn-decision";

const CONFIDENCE_TONE = { high: "success", medium: "info", low: "warning" } as const;

export type CaseExtras = {
  packet: Packet;
  /** What the engine says for each tier an advisor could treat an undecidable provider as. */
  preview: { tier: string; label: string; outcome: string; planPays: number | null; memberPays: number | null }[] | null;
  colleagues: { id: string; name: string }[];
  defaultDenyMessage: string | null;
};

export function CasePage({ c, x }: { c: EventCase; x: CaseExtras }) {
  const { event, proposal, task } = c;
  const forecast = event.kind === "preauth";
  const amount = Number(event.billedAmount ?? event.estimatedAmount ?? 0) || null;
  const band = confidenceBand(event.confidence);

  return (
    <>
      <PageHeader
        backHref={`/policies/${c.policy.id}`}
        backLabel={c.policy.ref}
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-base">{c.ref}</span>
            <span>
              {eventKindLabel[event.kind]}
              {amount ? ` · ${money(amount)}` : ""}
            </span>
          </span>
        }
        description={`${c.subject.fullName} · ${c.policy.ref} · ${c.policy.planName} · month ${event.policyMonth} (${monthYear(policyMonthStart(c.policy.inceptionDate, event.policyMonth))})`}
      >
        {event.outcome ? <OutcomeBadge outcome={event.outcome} /> : null}
      </PageHeader>

      <PageBody className="space-y-5">
        {c.supersededBy ? (
          <Alert className="border-brand/40">
            <AlertTitle>Superseded by {c.supersededBy.ref}</AlertTitle>
            <AlertDescription className="text-pretty">
              {c.supersededBy.kind === "appeal"
                ? "This decision was reversed on appeal. It stays on the record — it was denied, and the appeal reversed it — but it no longer counts in the ledger. See the History tab."
                : "An advisor has since decided this case directly. It stays on the record, but the later decision is the one that counts. See the History tab."}
            </AlertDescription>
          </Alert>
        ) : null}
        {task ? (
          <Alert className="border-warning/40">
            <TriangleAlertIcon className="text-warning" />
            <AlertTitle>Why this needs you</AlertTitle>
            <AlertDescription className="text-pretty">{task.reason}</AlertDescription>
          </Alert>
        ) : null}

        <Tabs defaultValue="decision">
          <TabsList className="max-w-full overflow-x-auto">
            <TabsTrigger value="decision">Decision</TabsTrigger>
            <TabsTrigger value="packet">Packet</TabsTrigger>
            <TabsTrigger value="working">Working</TabsTrigger>
            <TabsTrigger value="history">History ({c.chain.length})</TabsTrigger>
          </TabsList>

          {/* ------------------------------------------------------------------------------------------------ */}
          <TabsContent value="decision" className="space-y-4 pt-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">What the system did</CardTitle>
                  <CardDescription className="flex flex-wrap items-center gap-1.5">
                    {event.reasonCode ? <span className="font-mono text-xs">{event.reasonCode}</span> : null}
                    <span>{event.reasonCode ? reasonCodeLabel[event.reasonCode] : ""}</span>
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge tone="neutral">Decided by {event.decidedBy === "advisor" ? (c.decidedByName ?? "an advisor") : "the system"}</StatusBadge>
                    {band ? <StatusBadge tone={CONFIDENCE_TONE[band]}>{band} confidence</StatusBadge> : null}
                  </div>
                  <dl className="grid grid-cols-3 gap-3">
                    {[
                      [forecast ? "Estimated" : "Billed", amount],
                      ["Plan pays", event.planPays === null ? null : Number(event.planPays)],
                      ["Member pays", event.memberPays === null ? null : Number(event.memberPays)],
                    ].map(([k, v]) => (
                      <div key={String(k)}>
                        <dt className="text-xs text-muted-foreground">{k}</dt>
                        <dd className="font-medium">
                          <Money value={v as number | null} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <p className="text-sm text-pretty">{event.brokerExplanation}</p>
                  {event.uncertaintyReason && band !== "high" ? <p className="text-xs text-muted-foreground text-pretty">Why this is worth a look: {event.uncertaintyReason}</p> : null}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{proposal ? "What the member will be told" : "What the member was told"}</CardTitle>
                  <CardDescription>Verbatim. It is a different document from the one beside it — read them together.</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-pretty">{proposal ? proposal.draft.memberExplanation : (event.memberExplanation ?? "Nothing has been said to the member yet.")}</p>
                </CardContent>
              </Card>
            </div>

            {proposal && task ? (
              <Card className="border-brand/40">
                <CardHeader>
                  <CardTitle className="text-base">Proposed reversal — for your signature</CardTitle>
                  <CardDescription className="text-pretty">
                    The engine re-ran this claim at its original position in the history, with one input corrected. Nothing has been written; the standing decision is still{" "}
                    {c.ref}. You are signing the arithmetic below.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <ArithmeticDiff
                    before={{ outcome: proposal.original.outcome, planPays: proposal.original.planPays, memberPays: proposal.original.memberPays }}
                    after={{ reasonCode: proposal.draft.reasonCode, planPays: proposal.draft.planPays, memberPays: proposal.draft.memberPays }}
                  />
                  <p className="text-sm text-pretty">
                    <span className="font-medium">{proposal.correction.field.replace(/_/g, " ")}</span> corrected{" "}
                    <span className="font-mono text-xs">{proposal.correction.from}</span> → <span className="font-mono text-xs">{proposal.correction.to}</span>, on evidence: “{proposal.correction.quote}”
                  </p>
                  <LedgerDiff before={proposal.ledgerBeforeContested} after={proposal.draft.ledgerAfter} caption={`Ledger at month ${proposal.draft.policyMonth}: before this claim, and after it is paid`} />
                  <OverturnDecision policyId={c.policy.id} eventId={event.id} taskId={task.id} memberMessage={proposal.draft.memberExplanation} canAskMore={c.canAskMore} />
                </CardContent>
              </Card>
            ) : task ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Your decision</CardTitle>
                  <CardDescription className="text-pretty">
                    {event.outcome === "insufficient_data" ? "The plan terms do not decide this. Supply the missing input, or say it is not covered." : x.packet.conversation ? "This case is with you. The member has been told; they lose nothing." : "A close call that resolved. It blocks nothing."}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <CaseDecision
                    policyId={c.policy.id}
                    subjectId={event.id}
                    taskId={task.id}
                    kind={(event.outcome === "insufficient_data" ? "undecidable" : x.packet.why.cause && x.packet.conversation ? "escalation" : "quality") satisfies CaseKind}
                    preview={x.preview}
                    colleagues={x.colleagues}
                    hasConversation={x.packet.conversation?.status === "escalated"}
                    callbackRequested={x.packet.callback !== null}
                    defaultDenyMessage={x.defaultDenyMessage}
                  />
                </CardContent>
              </Card>
            ) : null}
          </TabsContent>

          <TabsContent value="packet" className="pt-4">
            <PacketTab p={x.packet} />
          </TabsContent>

          {/* ------------------------------------------------------------------------------------------------ */}
          <TabsContent value="working" className="space-y-4 pt-4">
            {c.restated.length > 0 ? (
              <p className="rounded-md border border-info/30 bg-info-subtle px-3 py-2 text-xs text-pretty">
                <span className="font-medium">Restated.</span> Recorded before a later appeal was reversed at an earlier position, so replaying the log now gives:{" "}
                {c.restated.map((d) => `${d.field.replace(/_/g, " ")} ${d.stored} → ${d.replayed}`).join("; ")}. Expected — not drift.
              </p>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{proposal ? "The appeal, step by step" : "Calculation"}</CardTitle>
                <CardDescription>{proposal ? "The path in plan §5.4: which finding, what evidence, what the agent judged, what the engine then did." : "Every figure came from the engine."}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {proposal ? (
                  <ol className="space-y-2.5 text-sm">
                    {[
                      ["Contested finding", `${proposal.contestedReason} — ${reasonCodeLabel[proposal.contestedReason]}`],
                      ["Evidence supplied", `${proposal.evidence.length} piece${proposal.evidence.length === 1 ? "" : "s"}, as text`],
                      ["Admissibility", `${proposal.evidenceKind.replace(/_/g, " ")} — the kind of evidence that can bear on this finding`],
                      ["Correction (one field)", `${proposal.correction.field}: ${proposal.correction.from} → ${proposal.correction.to}`],
                      ["Re-adjudication", `at month ${proposal.draft.policyMonth}, against the ledger as it stood before ${c.ref}`],
                      ["Different outcome?", `${proposal.original.outcome} ${money(proposal.original.planPays)} → ${proposal.draft.reasonCode} ${money(proposal.draft.planPays)}: better for the member, so an overturn, and never worse (§5.4.6)`],
                    ].map(([k, v], i) => (
                      <li key={k} className="flex gap-3">
                        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs tabular-nums">{i + 1}</span>
                        <span className="text-pretty">
                          <span className="font-medium">{k}.</span> <span className="text-muted-foreground">{v}</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : null}
                <CalculationTrace lines={proposal ? proposal.draft.calculation : traceLines(event.calculation)} label="Calculation trace" />
                {!proposal ? <LedgerDiff before={event.ledgerBefore} after={event.ledgerAfter} caption="The ledger when this was decided" /> : null}
              </CardContent>
            </Card>

            {proposal && proposal.trace.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">The agent&apos;s steps</CardTitle>
                  <CardDescription>Thought, tool, validation, observation. A refusal is shown: the table said no and the agent corrected it.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ol className="space-y-3">
                    {proposal.trace.map((t) => (
                      <li key={t.step} className="space-y-1 rounded-lg border p-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs text-muted-foreground tabular-nums">Step {t.step}</span>
                          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{t.tool}</code>
                          <StatusBadge tone={t.validation === "ok" ? "success" : "warning"}>{t.validation === "ok" ? "accepted" : "refused"}</StatusBadge>
                        </div>
                        {t.thought && t.thought !== "deterministic driver" ? <p className="text-pretty text-muted-foreground">“{t.thought}”</p> : null}
                        {t.validation !== "ok" ? <p className="text-xs text-pretty text-warning">{t.validation}</p> : null}
                        <details className="text-xs text-muted-foreground">
                          <summary className="cursor-pointer select-none">Observation</summary>
                          <p className="mt-1 font-mono break-words whitespace-pre-wrap">{t.observation}</p>
                        </details>
                      </li>
                    ))}
                  </ol>
                </CardContent>
              </Card>
            ) : null}

            {(proposal ? proposal.evidence.length > 0 : Boolean(event.evidenceText)) ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Evidence on file</CardTitle>
                  <CardDescription>What the member sent, verbatim.</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm whitespace-pre-line text-pretty text-muted-foreground">{proposal ? proposal.evidence.join("\n\n") : event.evidenceText}</p>
                </CardContent>
              </Card>
            ) : null}
          </TabsContent>

          {/* ------------------------------------------------------------------------------------------------ */}
          <TabsContent value="history" className="pt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Supersession chain</CardTitle>
                <CardDescription>The denial happened, and the appeal may have reversed it. Both stay visible; nothing is collapsed.</CardDescription>
              </CardHeader>
              <CardContent>
                <ol className="space-y-2">
                  {c.chain.map((l) => (
                    <li key={l.id} className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm ${l.current ? "border-brand/50 bg-brand-subtle/30" : ""}`}>
                      <span className="font-mono text-xs">{l.ref}</span>
                      <span>{eventKindLabel[l.kind]}</span>
                      {l.outcome ? <OutcomeBadge outcome={l.outcome} /> : null}
                      <span className="text-xs text-muted-foreground tabular-nums">
                        · month {l.policyMonth} · plan {money(l.planPays)}
                      </span>
                      {l.relation === "supersedes" ? <StatusBadge tone="brand">supersedes</StatusBadge> : l.relation === "appeals" ? <StatusBadge tone="neutral">appeals</StatusBadge> : null}
                      <span className="text-xs text-muted-foreground">· {l.decidedBy === "advisor" ? (l.decidedByName ?? "an advisor") : "system"}</span>
                      {l.current ? <span className="ml-auto text-xs text-muted-foreground">this one</span> : (
                        <Link href={`/policies/${c.policy.id}/events/${l.id}`} className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                          Open <ArrowRightIcon className="size-3" />
                        </Link>
                      )}
                    </li>
                  ))}
                  {c.proposal ? (
                    <li className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
                      <StatusBadge tone="info">proposed</StatusBadge> an overturn of {c.ref} is waiting for a signature — not yet part of the history
                    </li>
                  ) : null}
                </ol>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </PageBody>
    </>
  );
}
