// A reversal, signed (plan §5.4.5, §5.4.7, §18.4 "overturn survives replay").
//
//   bun run db/seed/check-appeal-signoff.ts
//
// The other appeal suite stops at every proposal; this one lets one through. On the appeals-pending database, APP-2 is
// argued with the supplied certificate, proposed, and signed — and then the ledger is DROPPED and refolded, because the
// claim worth making about an overturn is not that it wrote a row but that the history it left behind still replays:
// the reversal lands at month 7 where the denial was, not at the date it was filed, so P4's month-9 forecast now sees a
// deductible that CLM-4 met.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Decision, ServicingDecider } from "@/lib/ai/graph/nodes/servicing";
import { isServicingCard, memberCopyViolations, type ServicingCard } from "@/lib/servicing";

/* eslint-disable @typescript-eslint/no-explicit-any */
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${!ok && detail ? `\n         ${detail}` : ""}`);
};

const dir = mkdtempSync(path.join(tmpdir(), "mizan-signoff-"));
process.env.DATABASE_URL = path.join(dir, "check.db");
process.env.SEED_APPEALS = "pending";
const seed = spawnSync(process.execPath, ["run", "db/seed/run.ts"], { env: process.env, encoding: "utf8" });
if (seed.status !== 0) {
  console.error(seed.stdout, seed.stderr);
  process.exit(1);
}

try {
  const { db } = await import("@/db/client");
  const schema = await import("@/db/schema");
  const session = await import("@/lib/ai/servicing-session");
  const signoff = await import("@/lib/ai/servicing-signoff");
  const store = await import("@/lib/servicing/store");
  const appealStore = await import("@/lib/servicing/appeal-store");
  const { benefitLedger, conversation, conversationAction, message, person, policy, reviewDecision, reviewTask, servicingEvent, appUser } = schema;

  const owners = await db.select({ ref: policy.externalRef, id: policy.id, owner: person.ownerUserId }).from(policy).innerJoin(person, eq(policy.personId, person.id));
  const daniel = owners.find((o) => o.ref === "POL-P4")!;
  const advisorId = (await db.select().from(appUser)).find((u) => u.role === "advisor")!.id;
  const today = "2026-09-20";
  const clm4 = (await db.select().from(servicingEvent).where(eq(servicingEvent.externalRef, "CLM-4")))[0];

  const CERTIFICATE = "Provider registration: Gulf Physiotherapy Centre LLC, independently licensed outpatient facility, registered at standard network tier, leased suite within the hospital building.";
  const Q = "independently licensed outpatient facility, registered at standard network tier";
  const scripted = (steps: Decision[]): ServicingDecider => {
    let i = 0;
    return (async () => ({ decision: steps[i++], servedBy: "scripted", latencyMs: 1 })) as unknown as ServicingDecider;
  };

  const ledger = async () => {
    const [l] = await db.select().from(benefitLedger).where(eq(benefitLedger.policyId, daniel.id));
    return { d: Number(l.deductibleMet), a: Number(l.annualPaid), s: l.sublimitUsed };
  };
  const ledgerBefore = await ledger();

  console.log("\nAPP-2, proposed");
  const opened = (await session.openAppeal({ userId: daniel.owner, policyId: daniel.id, eventId: clm4.id }, { today })) as any;
  await session.handleServicingInput(
    opened.conversationId,
    daniel.owner,
    { kind: "text", text: CERTIFICATE },
    {
      today,
      decide: scripted([
        { thought: "the registration names the tier", tool: "assess_evidence", args: { evidence_index: 0, verdict: "bears_on", kind: "provider_licence", quote: Q, why: "The registration names the provider's own registered tier." } },
        { thought: "correct the tier", tool: "propose_correction", args: { evidence_index: 0, kind: "provider_licence", field: "provider_tier", value: "in_network_clinic", quote: Q } },
      ]),
    },
  );
  const task = (await db.select().from(reviewTask).where(and(eq(reviewTask.subjectId, clm4.id), eq(reviewTask.status, "open"))))[0];
  check("the proposal is waiting on a signature", task !== undefined && (await db.select().from(conversation).where(eq(conversation.id, opened.conversationId)))[0].status === "awaiting_review");
  const [prop] = await db.select().from(conversationAction).where(and(eq(conversationAction.actionType, "appeal_overturn_proposal"), eq(conversationAction.status, "pending")));

  console.log("\nA signature is re-adjudicated against the log as it stands");
  const tampered = structuredClone(prop.arguments) as any;
  tampered.draft.planPays = 9999;
  await db.update(conversationAction).set({ arguments: tampered }).where(eq(conversationAction.id, prop.id));
  const stale = await signoff.confirmReversal({ taskId: task.id, advisorUserId: advisorId, note: "Certificate reads as described.", today });
  check("numbers that no longer match what the engine now says are NOT signed — nothing is written", stale.ok === false && /no longer match/.test((stale as any).reason) && (await db.select().from(servicingEvent).where(eq(servicingEvent.kind, "appeal"))).length === 0);
  await db.update(conversationAction).set({ arguments: prop.arguments }).where(eq(conversationAction.id, prop.id));

  console.log("\nSigned");
  const signed = await signoff.confirmReversal({ taskId: task.id, advisorUserId: advisorId, note: "Certificate reads as described: an independently licensed outpatient facility at standard tier.", today });
  check("the advisor confirms the reversal", signed.ok, JSON.stringify(signed));
  const app = (await db.select().from(servicingEvent).where(eq(servicingEvent.kind, "appeal")))[0];
  check("the row is an overturned appeal that SUPERSEDES CLM-4 and points at it", app.outcome === "overturned" && app.supersedesEventId === clm4.id && app.appealOfEventId === clm4.id && app.externalRef === "APP-1");
  check("it was decided by the advisor who signed it — the system never self-signs an overturn", app.decidedBy === "advisor" && app.decidedByUserId === advisorId);
  check("it sits at CLM-4's month, with the CORRECTED tier and the original amount", app.policyMonth === 7 && app.providerTier === "in_network_clinic" && Number(app.billedAmount) === 6000);
  check("the money is the engine's: plan pays 4,400, member 1,600 — deductible 500, then the 20% share", Number(app.planPays) === 4400 && Number(app.memberPays) === 1600 && (app.calculation as string[]).some((l) => /500/.test(l)));
  check("the denial is still on the record — both are true: it was denied, and the appeal reversed it", (await db.select().from(servicingEvent).where(eq(servicingEvent.id, clm4.id)))[0].outcome === "denied");
  let refused = false;
  try {
    await db.update(servicingEvent).set({ outcome: "covered" }).where(eq(servicingEvent.id, clm4.id));
  } catch {
    refused = true;
  }
  check("the log is append-only: the denial cannot be edited", refused);

  console.log("\nThe ledger, and what it did to the history after it");
  const after = await ledger();
  check("P4's deductible is now met (500) and 4,400 has been paid", after.d === 500 && after.a > ledgerBefore.a && after.a - ledgerBefore.a === 4400, JSON.stringify({ ledgerBefore, after }));
  const report = await store.checkReplay(daniel.id);
  check("replay passes after the overturn", report.ok, JSON.stringify(report));
  check("PRE-2 is RESTATED, not drifted: an overturn filed after it landed before it", report.restated.some((r) => r.ref === "PRE-2") && report.drifted.length === 0, JSON.stringify(report.restated));
  await db.delete(benefitLedger).where(eq(benefitLedger.policyId, daniel.id));
  await store.rebuildLedger(daniel.id);
  const replayed = await store.replayPolicy(daniel.id);
  check("DROP the ledger, refold from the log: the same ledger comes back", JSON.stringify(await ledger()) === JSON.stringify(after));
  const pre2 = replayed.steps.find((s) => s.event.id === (replayed.stored.find((r) => r.externalRef === "PRE-2")!.id))!;
  check("month 9's pre-authorization now forecasts against a MET deductible: 22,400, where it forecast 22,000 before", pre2.result.planPays === 22400, `planPays=${pre2.result.planPays}`);
  check("...proof `effectOrder` placed the overturn at month 7 and not at the date it was filed", replayed.steps.findIndex((s) => s.event.id === app.id) < replayed.steps.findIndex((s) => s.event.id === pre2.event.id));

  console.log("\nThe record of the decision");
  check("the task is resolved, with a decision: overturn, the advisor, and their note", (await db.select().from(reviewTask).where(eq(reviewTask.id, task.id)))[0].status === "resolved" && (await db.select().from(reviewDecision).where(eq(reviewDecision.reviewTaskId, task.id)))[0].action === "overturn");
  check("the proposal is closed as done, not left pending", (await db.select().from(conversationAction).where(eq(conversationAction.id, prop.id)))[0].status === "succeeded");
  check("signing the same task twice does nothing the second time", (await signoff.confirmReversal({ taskId: task.id, advisorUserId: advisorId, note: "Again, for luck." })).ok === false && (await db.select().from(servicingEvent).where(eq(servicingEvent.kind, "appeal"))).length === 1);
  check("CLM-4 can no longer be appealed: it has been replaced", ((await appealStore.checkAppealable(daniel.id, clm4.id)) as any).exit === "superseded");

  console.log("\nWhat the member reads now");
  const convo = (await db.select().from(conversation).where(eq(conversation.id, opened.conversationId)))[0];
  check("the conversation is complete", convo.status === "completed");
  const cards = (await db.select().from(message).where(eq(message.conversationId, opened.conversationId)).orderBy(message.seq)).filter((m) => isServicingCard(m.payload)).map((m) => m.payload as ServicingCard);
  const out: any = cards.at(-1);
  check("an outcome card, for an appeal, that says it was reversed and shows the numbers", out.kind === "servicing_outcome" && out.eventKind === "appeal" && out.outcome === "overturned" && out.figures.plan.value === 4400 && out.figures.member.value === 1600, JSON.stringify(out));
  check("it opens the way the plan says: 'You were right — …', and says what it means for the year", /^You were right/.test(out.explanation) && /deductible is now met/.test(out.explanation), out.explanation);
  check("...in the member's register: no reason code, no reference, no promised time", memberCopyViolations(out.explanation).length === 0 && !/APP-|CLM-|provider_out_of_network/.test(out.explanation + out.trace.join(" ")));
  check("the broker's text is a different document: the policy, the event, what was corrected, and no fit implication", /POL-P4/.test(app.brokerExplanation ?? "") && /CLM-4/.test(app.brokerExplanation ?? "") && /no fit implication/.test(app.brokerExplanation ?? "") && app.brokerExplanation !== app.memberExplanation);
  check("the record carries what was argued, verbatim", (app.evidenceText ?? "").includes(CERTIFICATE));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
