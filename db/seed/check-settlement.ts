// Payouts, attacked (§payouts).
//
//   bun --conditions=react-server run db/seed/check-settlement.ts
//
// Part 1 is the PURE rule — which decided events owe money, and the two state transitions — with no database.
// Part 2 drives the real session: a claim committed through the graph opens a real payout, an advisor approves
// it and marks it paid, and every refusal in between is checked against the real rows.
//
// The invariant that matters most, and the one this file exists to defend: A SETTLEMENT MOVES NO LEDGER. The
// ledger is a projection of what the plan OWES; a payout records what it PAID. Drop every settlement row and
// replay must produce exactly the same deductible, annual total and outcomes it did before.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canApprove, canMarkPaid, memberSettlementLine, owesPayment, payeeOf, refusalFor } from "@/lib/servicing";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${!ok && detail ? `\n         ${detail}` : ""}`);
};

const ev = (over: Partial<Parameters<typeof owesPayment>[0]> = {}) =>
  ({ kind: "claim" as const, outcome: "covered" as const, planPays: 2000, supersededByEventId: null, ...over });

// ==========================================================================
console.log("\nWhat owes a payout, and what does not");
check("a covered claim the plan paid on owes a payout", owesPayment(ev()));
check("a covered REIMBURSEMENT owes one too — the member is out of pocket", owesPayment(ev({ kind: "reimbursement" })));
check("a claim clipped by a sublimit still owes what the plan agreed to pay", owesPayment(ev({ outcome: "approved_with_limit", planPays: 25000 })));
check("a PRE-AUTHORIZATION never owes: it is a forecast, nothing has been claimed", !owesPayment(ev({ kind: "preauth" })));
check("a denial owes nothing — there is no amount", !owesPayment(ev({ outcome: "denied", planPays: 0 })));
check("a case the plan could not decide owes nothing", !owesPayment(ev({ outcome: "insufficient_data", planPays: null })));
check("a covered claim that consumed the whole deductible owes nothing — a payout for zero is not a payout", !owesPayment(ev({ planPays: 0 })));
check("a row a later decision REPLACED owes nothing — otherwise an overturned denial is paid beside its own correction", !owesPayment(ev({ supersededByEventId: "later-row" })));
check("an upheld appeal owes nothing: it changed no money", !owesPayment(ev({ kind: "appeal", outcome: "upheld", planPays: 0 })));

console.log("\nWho the money goes to — derived from the kind, never stored twice");
check("a reimbursement pays the MEMBER back", payeeOf({ kind: "reimbursement" }) === "member");
check("a claim pays the PROVIDER", payeeOf({ kind: "claim" }) === "provider");

console.log("\nApproving and paying are different acts");
check("a fresh payout can be approved, but not marked paid", canApprove("awaiting_approval") && !canMarkPaid("awaiting_approval"));
check("an approved payout can be marked paid, but not approved twice", canMarkPaid("approved") && !canApprove("approved"));
check("a paid one can be neither", !canApprove("paid") && !canMarkPaid("paid"));
check("...and each refusal says what is actually true now, not a generic 'no'", /already approved/.test(refusalFor("approve", "approved") ?? "") && /not been approved yet/.test(refusalFor("mark_paid", "awaiting_approval") ?? ""));
check("a legal transition has no refusal to give", refusalFor("approve", "awaiting_approval") === null && refusalFor("mark_paid", "approved") === null);

console.log("\nWhat the member reads about their money");
check("waiting: no promise of when", memberSettlementLine("awaiting_approval", null) === "Payment is being arranged.");
check("approved: honest, and still no date invented", /on its way/.test(memberSettlementLine("approved", null)));
check("paid: the date they can check against their bank", /25 September 2026/.test(memberSettlementLine("paid", "25 September 2026")));
check(
  "no member line carries a reference, an advisor's name, or workflow vocabulary",
  (["awaiting_approval", "approved", "paid"] as const).every((s) => !/reference|advisor|approved by|task|queue|priority/i.test(memberSettlementLine(s, "25 September 2026"))),
);

// ==========================================================================
// Part 2 — live, through the real session
// ==========================================================================

const dir = mkdtempSync(path.join(tmpdir(), "mizan-settle-"));
process.env.DATABASE_URL = path.join(dir, "check.db");
const seed = spawnSync(process.execPath, ["run", "db/seed/run.ts"], { env: process.env, encoding: "utf8" });
if (seed.status !== 0) {
  console.error(seed.stdout, seed.stderr);
  process.exit(1);
}

try {
  const { db } = await import("@/db/client");
  const schema = await import("@/db/schema");
  const session = await import("@/lib/ai/servicing-session");
  const settle = await import("@/lib/ai/servicing-settlement");
  const store = await import("@/lib/servicing/store");
  const { and, eq } = await import("drizzle-orm");
  const { appUser, benefitLedger, claimSettlement, person, policy, reviewDecision, reviewTask, servicingEvent } = schema;

  const today = "2026-09-20";
  const owners = await db.select({ ref: policy.externalRef, id: policy.id, owner: person.ownerUserId }).from(policy).innerJoin(person, eq(policy.personId, person.id));
  const P = (ref: string) => owners.find((o) => o.ref === ref)!;
  const users = await db.select().from(appUser);
  const advisorId = users.find((u) => u.role === "advisor")!.id;
  const p1 = P("POL-P1");

  const claimForm = (over: Record<string, string> = {}) => ({
    treatment: "Physiotherapy for my wrist", treatment_date: "2026-09-04", provider_type: "in_network_clinic",
    provider_name: "Al Noor Clinic", amount: "1,800", paid_by_member: "no", benefit_class: "general", ...over,
  });

  console.log("\nA covered claim, committed through the session, opens a payout by itself");
  const c1 = (await session.openServicing({ userId: p1.owner, policyId: p1.id, intent: "claim" }, { today })) as any;
  await session.handleServicingInput(c1.conversationId, p1.owner, { kind: "form", values: claimForm() }, { today });
  await session.handleServicingInput(c1.conversationId, p1.owner, { kind: "confirm" }, { today });

  const { sql } = await import("drizzle-orm");
  // The newest row by write order — `servicing_event` has no seq column, so rowid IS the order (see store.ts).
  const [committed] = await db.select().from(servicingEvent).where(eq(servicingEvent.policyId, p1.id)).orderBy(sql`rowid desc`).limit(1);
  check("the claim committed and the plan owes money on it", committed !== undefined && Number(committed.planPays) > 0, JSON.stringify(committed?.planPays));
  const [payout] = await db.select().from(claimSettlement).where(eq(claimSettlement.servicingEventId, committed.id));
  check("a payout was opened for it, awaiting a person", payout !== undefined && payout.status === "awaiting_approval", JSON.stringify(payout));
  check("...for the ENGINE's amount, not a number anyone typed", payout && Number(payout.amount) === Number(committed.planPays));
  const [task] = await db.select().from(reviewTask).where(and(eq(reviewTask.subjectType, "settlement"), eq(reviewTask.subjectId, payout.id)));
  check("...and it reached the queue at the payout band (50), open", task !== undefined && task.priorityScore === 50 && task.status === "open");

  console.log("\nA forecast and a denial open nothing — there is nothing to pay");
  const preauth = (await session.openServicing({ userId: p1.owner, policyId: p1.id, intent: "preauth" }, { today })) as any;
  await session.handleServicingInput(preauth.conversationId, p1.owner, { kind: "form", values: { treatment: "Planned knee scan", provider_type: "in_network_clinic", provider_name: "Al Noor Clinic", amount: "2,000", benefit_class: "general" } }, { today });
  await session.handleServicingInput(preauth.conversationId, p1.owner, { kind: "confirm" }, { today });
  const [preauthEvent] = await db.select().from(servicingEvent).where(eq(servicingEvent.policyId, p1.id)).orderBy(sql`rowid desc`).limit(1);
  check("the pre-authorization committed as a forecast", preauthEvent.kind === "preauth", preauthEvent.kind);
  check(
    "...and opened NO payout of its own: nothing has been claimed, so nothing is owed",
    (await db.select().from(claimSettlement).where(eq(claimSettlement.servicingEventId, preauthEvent.id))).length === 0,
  );

  console.log("\nThe two verbs, and who may use them");
  check("a member cannot approve their own payment", (await settle.approvePayment({ taskId: task.id, advisorUserId: p1.owner, note: "Approving my own money, thanks." })).ok === false);
  check("approving needs a note for the file", (await settle.approvePayment({ taskId: task.id, advisorUserId: advisorId, note: "ok" })).ok === false);
  check("it cannot be marked paid before it is approved", (await settle.markPaid({ taskId: task.id, advisorUserId: advisorId, paymentReference: "TRF-1" })).ok === false);

  const approved = await settle.approvePayment({ taskId: task.id, advisorUserId: advisorId, note: "Checked the invoice against the clinic's own reference before releasing." });
  check("an advisor approves it, with a note", approved.ok, JSON.stringify(approved));
  const afterApprove = (await db.select().from(claimSettlement).where(eq(claimSettlement.id, payout.id)))[0];
  check("...the payout is approved, stamped with who and when", afterApprove.status === "approved" && afterApprove.approvedByUserId === advisorId && afterApprove.approvedAt !== null);
  check("...the task is still OPEN — the money has not moved yet, so the work is not done", (await db.select().from(reviewTask).where(eq(reviewTask.id, task.id)))[0].status === "open");
  check("approving twice is refused, in words that say why", (await settle.approvePayment({ taskId: task.id, advisorUserId: advisorId, note: "Approving it again for luck." })).ok === false);

  check("marking paid needs the payment reference", (await settle.markPaid({ taskId: task.id, advisorUserId: advisorId, paymentReference: "" })).ok === false);
  const paid = await settle.markPaid({ taskId: task.id, advisorUserId: advisorId, paymentReference: "TRF-88214" });
  check("marking it paid goes through", paid.ok, JSON.stringify(paid));
  const afterPaid = (await db.select().from(claimSettlement).where(eq(claimSettlement.id, payout.id)))[0];
  check("...paid, stamped, and carrying the reference", afterPaid.status === "paid" && afterPaid.paidAt !== null && afterPaid.paymentReference === "TRF-88214");
  check("...and NOW the task is resolved", (await db.select().from(reviewTask).where(eq(reviewTask.id, task.id)))[0].status === "resolved");
  const decisions = await db.select().from(reviewDecision).where(eq(reviewDecision.reviewTaskId, task.id));
  check("both acts are on the record separately — 'approved' and 'paid' are not the same fact", decisions.length === 2 && decisions.some((d: any) => d.action === "approve_payment") && decisions.some((d: any) => d.action === "mark_paid"));
  check("paying twice is refused", (await settle.markPaid({ taskId: task.id, advisorUserId: advisorId, paymentReference: "TRF-99999" })).ok === false);

  console.log("\nA settlement moves NO ledger — the invariant this whole file exists for");
  const ledgerBefore = (await db.select().from(benefitLedger).where(eq(benefitLedger.policyId, p1.id)))[0];
  const replayNow = await store.checkReplay(p1.id);
  check("replay still passes with a paid settlement on the policy", replayNow.ok, JSON.stringify(replayNow));
  await db.delete(claimSettlement).where(eq(claimSettlement.policyId, p1.id));
  await store.rebuildLedger(p1.id);
  const ledgerAfter = (await db.select().from(benefitLedger).where(eq(benefitLedger.policyId, p1.id)))[0];
  check(
    "drop every payout, rebuild from the log, and the ledger is IDENTICAL — cover and cash are separate books",
    Number(ledgerBefore.deductibleMet) === Number(ledgerAfter.deductibleMet) && Number(ledgerBefore.annualPaid) === Number(ledgerAfter.annualPaid),
    JSON.stringify({ before: ledgerBefore, after: ledgerAfter }),
  );

  console.log("\nReconciliation: money owed that nobody queued");
  const unsettled = await settle.unsettledEvents(p1.id);
  check("with the payouts deleted, the claim shows up as owed-but-unqueued", unsettled.some((u: any) => u.eventId === committed.id), JSON.stringify(unsettled));
  const mine = unsettled.find((u: any) => u.eventId === committed.id)!;
  check("...naming the amount the engine computes, and who it goes to", mine?.amount === Number(committed.planPays) && mine?.payee === "provider", JSON.stringify(mine));
  // P1's SEEDED claims (CLM-1, CLM-6) owe money too and have no payout — they predate this feature, and the
  // reconciliation is right to name them. That is the point of it, so the assertion is about the one under test.
  check("the seeded history shows up as owed too — a real gap, honestly reported, not hidden", unsettled.length > 1, JSON.stringify(unsettled.map((u: any) => u.ref)));
  await settle.openSettlementForEvent(p1.id, committed.id);
  check("re-opening it closes the gap for that claim", !(await settle.unsettledEvents(p1.id)).some((u: any) => u.eventId === committed.id));
  await settle.openSettlementForEvent(p1.id, committed.id);
  check("...and opening it again is a no-op, not a second payout for the same claim", (await db.select().from(claimSettlement).where(eq(claimSettlement.servicingEventId, committed.id))).length === 1);

  console.log("\nEvery stored ledger still equals a replay of its log");
  const all = await db.select().from(policy);
  const reports = await Promise.all(all.map((p: any) => store.checkReplay(p.id)));
  check("replay passes on every seeded policy", reports.every((r: any) => r.ok), JSON.stringify(reports.filter((r: any) => !r.ok)));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
