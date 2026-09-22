// The human hand-off, attacked (plan §7, §8, §12.2, §13.3.1-2, §17 phase 6).
//
//   bun run db/seed/check-handoff.ts
//
// Seeds a THROWAWAY database (the acceptance table exactly as supplied: CLM-9 undecidable, APP-1 upheld on a judgment call,
// APP-2 reversed) and drives real cases through the session and the hand-off verbs.
//
// What is under test:
//   - the queue is in the order §13.3.1 gives (Undecidable → Blocked → Genuinely uncertain → Needs a decision), a clean claim
//     is absent, and APP-1 appears as a quality check rather than vanishing
//   - a member can ask for a person from ANY point, and asking twice raises one task, not two
//   - an undecidable case is decided by supplying the MISSING INPUT — the engine computes the money; a person never types an amount
//   - "not covered" is the one stored result replay takes at its word, and it can only ever be a zero
//   - what a person writes to a member is held to the same register and figure fence as what the agent writes
//   - every verb leaves a decision; a member's words land in the packet; no member string promises a time
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { isServicingCard, memberCopyViolations, type ServicingCard } from "@/lib/servicing";

/* eslint-disable @typescript-eslint/no-explicit-any */
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${!ok && detail ? `\n         ${detail}` : ""}`);
};

const dir = mkdtempSync(path.join(tmpdir(), "mizan-handoff-"));
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
  const handoff = await import("@/lib/ai/servicing-handoff");
  const store = await import("@/lib/servicing/store");
  const packetLib = await import("@/lib/servicing/packet");
  const caseLib = await import("@/lib/servicing/case");
  const appealStore = await import("@/lib/servicing/appeal-store");
  const queries = await import("@/lib/servicing/queue");
  const { benefitLedger, conversation, conversationAction, message, person, policy, reviewDecision, reviewTask, servicingEvent, appUser } = schema;

  const owners = await db.select({ ref: policy.externalRef, id: policy.id, owner: person.ownerUserId }).from(policy).innerJoin(person, eq(policy.personId, person.id));
  const P = (ref: string) => owners.find((o) => o.ref === ref)!;
  const users = await db.select().from(appUser);
  const advisors = users.filter((u) => u.role === "advisor");
  const karim = advisors.find((u) => u.fullName === "Karim Youssef")!.id;
  const leila = advisors.find((u) => u.fullName === "Leila Mansour")!.id;
  const today = "2026-09-20";

  const eventByRef = async (ref: string) => (await db.select().from(servicingEvent).where(eq(servicingEvent.externalRef, ref)))[0];
  const eventsOf = (policyId: string) => db.select().from(servicingEvent).where(eq(servicingEvent.policyId, policyId));
  const ledgerOf = async (policyId: string) => {
    const [l] = await db.select().from(benefitLedger).where(eq(benefitLedger.policyId, policyId));
    return JSON.stringify({ d: Number(l.deductibleMet), a: Number(l.annualPaid), s: l.sublimitUsed });
  };
  const messagesOf = (id: string) => db.select().from(message).where(eq(message.conversationId, id)).orderBy(message.seq);
  const convoOf = async (id: string) => (await db.select().from(conversation).where(eq(conversation.id, id)))[0];
  const cardsOf = async (id: string) => (await messagesOf(id)).filter((m) => m.role === "assistant" && isServicingCard(m.payload)).map((m) => m.payload as ServicingCard);
  const tasksFor = async (subjectId: string) => db.select().from(reviewTask).where(eq(reviewTask.subjectId, subjectId));
  const decisionsOf = (taskId: string) => db.select().from(reviewDecision).where(eq(reviewDecision.reviewTaskId, taskId));
  /** The queue as `listQueue` builds it — open tasks, highest priority first, oldest first — minus the application joins. */
  const listQueue = async () => {
    const tasks = (await db.select().from(reviewTask).where(ne(reviewTask.status, "resolved")).orderBy(desc(reviewTask.priorityScore), asc(reviewTask.createdAt))).map((task) => ({ task }));
    const subs = await queries.servicingSubjects(tasks);
    return tasks.map((t) => ({ task: t.task, subject: subs.get(t.task.id) ?? null }));
  };
  const claimForm = (over: Record<string, string> = {}) => ({ treatment: "Cardiac follow-up consultation", treatment_date: "2026-08-20", provider_type: "unknown_foreign", provider_name: "Clinique du Lac", amount: "3,000", paid_by_member: "yes", benefit_class: "general", ...over });

  const suresh = P("POL-P5");
  const aisha = P("POL-P1");
  const omar = P("POL-P2");
  const clm9 = await eventByRef("CLM-9");

  // ==========================================================================
  console.log("\nThe queue, on the seeded conditions (§13.3.1)");
  const queue = await listQueue();
  const sub = (row: any) => (row.subject?.kind === "servicing" ? row.subject : null);
  const rowFor = (id: string) => queue.find((r) => r.task.subjectId === id)!;
  const cSub = sub(rowFor(clm9.id));
  check("CLM-9 is hydrated as UNDECIDABLE, with who, which policy, and the cause", cSub?.group === "undecidable" && cSub.task === "undecidable" && cSub.cause === "insufficient_data" && cSub.personName === "Suresh Nair" && cSub.policyRef === "POL-P5" && cSub.eventRef === "CLM-9", JSON.stringify(cSub));
  const app1 = await eventByRef("APP-1");
  const qSub = sub(rowFor(app1.id));
  check("APP-1 appears as a QUALITY CHECK — it did not vanish — banded medium, with the reason", qSub?.group === "uncertain" && qSub.task === "quality" && qSub.confidence === "medium" && /declared/.test(qSub.uncertaintyReason ?? ""), JSON.stringify(qSub));
  check("a quality check sits below everything that blocks a member: priority 40", rowFor(app1.id).task.priorityScore === 40);
  const cleanIds = await Promise.all(["CLM-1", "CLM-2", "CLM-5", "CLM-6", "CLM-8"].map(async (ref) => (await eventByRef(ref)).id));
  // A PAYOUT is not a doubt about the decision — it is money that still has to leave (§payouts). Both counts
  // below therefore exclude settlements: the invariant they were written for is "the system needed no help
  // DECIDING this", and a clean claim awaiting payment has not stopped being cleanly decided.
  const decisions = queue.filter((r) => sub(r) && sub(r).task !== "settlement");
  check("a clean, settled claim raises no task ABOUT ITS ADJUDICATION — its absence IS its confidence signal", cleanIds.every((id) => !queue.some((r) => r.task.subjectId === id)) && decisions.length === 2, `decision rows: ${decisions.length}`);
  check("the reversal that was already signed is not in the OPEN queue", !queue.some((r) => /Appeal overturn/.test(r.task.reason)));
  check("the order is Undecidable, then the quality check — CLM-9 first", decisions.map((r) => sub(r).group).join() === "undecidable,uncertain");

  // ...and the money those clean claims owe is not lost by being absent from the decision queue: it is present
  // as a PAYMENT, which is the whole point of the distinction above.
  const payouts = queue.filter((r) => sub(r)?.task === "settlement");
  check("the clean claims that owe money appear as PAYMENTS instead — separately counted, separately badged", payouts.length > 0, `payout rows: ${payouts.length}`);
  check("...each naming an amount and who it goes to, so the row can be judged before it is clicked", payouts.every((r) => (sub(r).settlement?.amount ?? 0) > 0 && ["member", "provider"].includes(sub(r).settlement?.payee ?? "")));
  check("...and every one sits in the 'needs a decision' band: the work is done, it is one informed click", payouts.every((r) => sub(r).group === "decide"));
  check("a payout already PAID is gone from the open queue — CLM-1 was settled in the seed", !payouts.some((r) => sub(r).settlement?.status === "paid"));

  console.log("\nWhy it left the agent is the queue's fact — and it is counted (§13.3.5)");
  const st0 = await queries.getStraightThrough(new Date("2026-09-21"));
  check("straight-through counts each outcome once: 13 events, CLM-4 replaced by its reversal → 12, of which CLM-9 and APP-2 needed a person", st0.all.total === 12 && st0.all.straight === 10, JSON.stringify(st0.all));
  check("the other two are broken down by the closed cause set", st0.causes.some((c) => c.cause === "insufficient_data" && c.count === 1) && st0.causes.some((c) => c.cause === "appeal_overturn" && c.count === 1), JSON.stringify(st0.causes));

  // ==========================================================================
  console.log("\nAsking for a person, from any point (§13.2.1, §8)");
  const points: { name: string; open: () => Promise<string> }[] = [
    { name: "the very start of a claim, with nothing said", open: async () => ((await session.openServicing({ userId: aisha.owner, policyId: aisha.id, intent: "claim" }, { today })) as any).conversationId },
    {
      name: "the confirm card, before anything is computed",
      open: async () => {
        const id = ((await session.openServicing({ userId: aisha.owner, policyId: aisha.id, intent: "claim" }, { today })) as any).conversationId;
        await session.handleServicingInput(id, aisha.owner, { kind: "form", values: claimForm({ provider_type: "in_network_clinic" }) }, { today });
        return id;
      },
    },
    {
      name: "the middle of an APPEAL, with an evidence request on screen",
      open: async () => ((await session.openAppeal({ userId: omar.owner, policyId: omar.id, eventId: (await eventByRef("CLM-7")).id }, { today })) as any).conversationId,
    },
  ];
  const handed: string[] = [];
  for (const pt of points) {
    const id = await pt.open();
    const owner = pt.name.includes("APPEAL") ? omar.owner : aisha.owner;
    const before = (await messagesOf(id)).length;
    const r = (await session.handleServicingInput(id, owner, { kind: "advisor" }, { today })) as any;
    const tasks = (await tasksFor(id)).filter((t) => t.subjectType === "conversation");
    check(`from ${pt.name}: it works — the case is with an advisor, at the stalled-member priority`, r.ok && (await convoOf(id)).status === "escalated" && tasks.length === 1 && tasks[0].priorityScore === 80, JSON.stringify({ r, tasks }));
    const again = (await session.handleServicingInput(id, owner, { kind: "advisor" }, { today })) as any;
    check(`...and asking a second time raises no second task and posts nothing again`, again.ignored === true && (await tasksFor(id)).filter((t) => t.subjectType === "conversation").length === 1 && (await messagesOf(id)).length === before + 2, `messages ${before} → ${(await messagesOf(id)).length}`);
    const [esc] = await db.select().from(conversationAction).where(and(eq(conversationAction.conversationId, id), eq(conversationAction.actionType, "escalated")));
    check(`...and the cause is recorded as a row for the queue, never on a card`, (esc.arguments as any).cause === "member_requested" && (await cardsOf(id)).every((c) => !/member_requested|cause/.test(JSON.stringify(c))));
    handed.push(id);
  }

  console.log("\nA human thread (§13.2.7)");
  const [h0, h1] = handed;
  const t0 = (await tasksFor(h0)).find((t) => t.subjectType === "conversation")!;
  await session.handleServicingInput(h0, aisha.owner, { kind: "text", text: "Sorry, I meant to say the clinic was in Beirut." }, { today });
  check("with an advisor, the member can write to them — no model, no cards — and it is recorded", (await messagesOf(h0)).at(-1)!.role === "applicant" && /Beirut/.test((await messagesOf(h0)).at(-1)!.bodyText ?? "") && (await convoOf(h0)).status === "escalated");
  const q1 = (await listQueue()).find((r) => r.task.id === t0.id)!;
  check("the queue row says so: the MEMBER wrote last, so the advisor is the one being waited on", sub(q1)?.memberReplied === true && sub(q1)?.group === "blocked" && sub(q1)?.cause === "member_requested", JSON.stringify(sub(q1)));

  const bad = async (text: string) => (await handoff.replyInThread({ taskId: t0.id, advisorUserId: karim, message: text })).ok;
  check("what an advisor writes to a member is held to the member's register: internal words refused", (await bad("We escalated your case to the reviewer and set its priority to high because confidence was low.")) === false);
  check("...a promised time is refused — the system has no SLA, so the words cannot invent one", (await bad("Thanks for that — someone will call you within 24 hours to go through it.")) === false);
  check("...a figure that is nowhere on the case is refused", (await bad("Thanks — we can pay AED 9,999 towards this one, let us talk it through with you.")) === false);
  check("...a member cannot use the verb: only an advisor may", (await handoff.replyInThread({ taskId: t0.id, advisorUserId: aisha.owner, message: "Hello, this is a message that is long enough." })).ok === false);
  const sent = await handoff.replyInThread({ taskId: t0.id, advisorUserId: karim, message: "Thanks, I have your note about the clinic. Could you tell me the clinic's city so I can place it?" });
  check("a proper reply lands in the member's own thread, as an advisor's words", sent.ok && (await messagesOf(h0)).at(-1)!.role === "advisor");
  const waiting = await session.findWaitingServicing(aisha.owner);
  check("the member's dot lights for it — the thread is the one place they ever have to look", waiting?.reason === "advisor_reply" && waiting.conversationId === h0 && waiting.messageId !== null, JSON.stringify(waiting));
  const thread = await session.readServicingThread(h0, aisha.owner);
  check("the thread shows it as an advisor, distinct from the assistant", thread!.messages.at(-1)!.from === "advisor");
  check("the task is now in progress, assigned to whoever replied — and it stays on the queue", (await db.select().from(reviewTask).where(eq(reviewTask.id, t0.id)))[0].status === "in_progress");
  await session.handleServicingInput(h0, aisha.owner, { kind: "text", text: "It was in Beirut, Lebanon." }, { today });
  check("once the member answers, the dot goes out: the advisor is the one waiting again", (await session.findWaitingServicing(aisha.owner)) === null);

  console.log("\nCallback, and handing on");
  const cb = await session.requestCallback(h0, aisha.owner, { window: "morning", phone: "+971 50 000 0000" });
  const q2 = (await listQueue()).find((r) => r.task.id === t0.id)!;
  check("a callback the member asked for shows on the SAME task, with the number and the window", cb.ok && sub(q2)?.callback?.window === "morning" && sub(q2)?.callback?.phone === "+971 50 000 0000" && sub(q2)?.callback?.called === false);
  check("marking it called needs a note, and records who", (await handoff.markCalled({ taskId: t0.id, advisorUserId: karim, note: "ok" })).ok === false && (await handoff.markCalled({ taskId: t0.id, advisorUserId: karim, note: "Called; the clinic is in Beirut, no Lebanese network." })).ok);
  check("...and the row now says it was called", sub((await listQueue()).find((r) => r.task.id === t0.id))?.callback?.called === true && (await decisionsOf(t0.id)).some((d) => d.action === "called"));
  check("a case can be handed to a colleague, and not to oneself or a member", (await handoff.handOff({ taskId: t0.id, advisorUserId: karim, toUserId: karim, note: "handing to me" })).ok === false && (await handoff.handOff({ taskId: t0.id, advisorUserId: karim, toUserId: aisha.owner, note: "handing to a member" })).ok === false && (await handoff.handOff({ taskId: t0.id, advisorUserId: karim, toUserId: leila, note: "Leila knows the overseas providers." })).ok);
  check("...the assignment is on the task, with a decision that says who to", (await db.select().from(reviewTask).where(eq(reviewTask.id, t0.id)))[0].assignedToUserId === leila && (await decisionsOf(t0.id)).some((d) => d.action === "hand_off" && (d.payload as any).to));

  console.log("\nThe packet is a query over what already exists (§8)");
  const pk = await packetLib.getPacket({ policyId: aisha.id, conversationId: h0, eventId: null });
  check("it holds the whole conversation — what the member said, verbatim, and what the advisor said", pk.transcript.some((m) => m.from === "member" && /Beirut/.test(m.text)) && pk.transcript.some((m) => m.from === "advisor"));
  check("...why it left the agent, in the broker's words; the callback; and what has been done about it, oldest first", pk.why.cause === "member_requested" && pk.callback?.phone === "+971 50 000 0000" && pk.decisions.map((d) => d.action).join() === "reply,called,hand_off", JSON.stringify(pk.decisions.map((d) => d.action)));
  const pk1 = await packetLib.getPacket({ policyId: aisha.id, conversationId: h1, eventId: null });
  check("...and the facts collected before the hand-off, each with the sentence it came from — so nothing is asked twice", pk1.facts.some((f) => f.key === "treatment" && f.quote.length > 0) && pk1.facts.length >= 4, JSON.stringify(pk1.facts.map((f) => f.key)));
  const pkA = await packetLib.getPacket({ policyId: omar.id, conversationId: handed[2], eventId: null });
  check("an appeal's packet shows what is still open with the member: the document being asked for", pkA.unresolved.some((u) => /being asked/.test(u)) && pkA.evidenceState!.requested.length === 1);

  console.log("\nResolving a hand-off");
  check("resolving needs a note AND a message the member reads", (await handoff.resolveCase({ taskId: t0.id, advisorUserId: karim, note: "ok", memberMessage: "Thanks, all sorted." })).ok === false && (await handoff.resolveCase({ taskId: t0.id, advisorUserId: leila, note: "Resolved on the call; no claim to make on this one.", memberMessage: "ok" })).ok === false);
  const done = await handoff.resolveCase({ taskId: t0.id, advisorUserId: leila, note: "Resolved on the call; the treatment was abroad and not a claim on this plan.", memberMessage: "Thanks for talking it through. Treatment abroad isn't something this plan covers, so there is nothing to claim here." });
  check("with both, it closes: the member gets the last word, in the thread, from a person", done.ok && (await convoOf(h0)).status === "completed" && (await messagesOf(h0)).at(-1)!.role === "advisor");
  check("...and the task is resolved, with a decision on the record", (await db.select().from(reviewTask).where(eq(reviewTask.id, t0.id)))[0].status === "resolved" && (await decisionsOf(t0.id)).some((d) => d.action === "resolve"));
  check("a closed case takes no more from the member", ((await session.handleServicingInput(h0, aisha.owner, { kind: "text", text: "one more thing" }, { today })) as any).reason === "closed");

  // ==========================================================================
  console.log("\nAn undecidable case, decided by supplying the missing input");
  const before9 = await ledgerOf(suresh.id);
  const preview = await caseLib.undecidablePreview(suresh.id, clm9.id);
  check("the advisor sees what the engine says for each choice — and never types an amount", preview!.length === 5 && preview!.every((p) => p.planPays !== null || p.outcome === "denied") && preview!.some((p) => p.tier === "general_hospital"), JSON.stringify(preview));
  const task9 = (await tasksFor(clm9.id)).find((t) => t.status === "open")!;
  check("a decision needs a note, and a known kind of provider", (await handoff.coverIt({ taskId: task9.id, advisorUserId: karim, providerTier: "general_hospital", note: "ok" })).ok === false && (await handoff.coverIt({ taskId: task9.id, advisorUserId: karim, providerTier: "a_lovely_place", note: "Treating this as a lovely place." })).ok === false);
  check("a member cannot decide their own claim", (await handoff.coverIt({ taskId: task9.id, advisorUserId: suresh.owner, providerTier: "general_hospital", note: "Covering my own claim, thanks." })).ok === false);
  check("a message the advisor writes that states a number nobody computed is refused", (await handoff.coverIt({ taskId: task9.id, advisorUserId: karim, providerTier: "general_hospital", note: "Treat as a general hospital abroad.", memberMessage: "Good news — the plan will now pay AED 88,888 of the bill for this claim." })).ok === false);
  const gh = preview!.find((p) => p.tier === "general_hospital")!;
  const cover = await handoff.coverIt({ taskId: task9.id, advisorUserId: karim, providerTier: "general_hospital", note: "Overseas general hospital; treat as the plan would a general hospital in the UAE.", today });
  check("Cover it goes through", cover.ok, JSON.stringify(cover));
  const dec = await eventByRef("CLM-9-A");
  check("the new row is the engine's answer for the input supplied — the figures are exactly the preview's", Number(dec.planPays) === gh.planPays && Number(dec.memberPays) === gh.memberPays && dec.providerTier === "general_hospital" && dec.geography === "uae", JSON.stringify({ dec: [dec.planPays, dec.memberPays], gh }));
  check("it is decided by the ADVISOR, supersedes the undecidable row, and carries no confidence — a person's decision, not a system's", dec.decidedBy === "advisor" && dec.decidedByUserId === karim && dec.supersedesEventId === clm9.id && dec.confidence === null);
  check("the undecidable row is still on the record — it happened — but no longer counts", (await eventByRef("CLM-9")).outcome === "insufficient_data" && ((await appealStore.checkAppealable(suresh.id, clm9.id)) as any).exit === "superseded");
  check("the ledger moved by what the engine computed, and replay still passes: no stored number is authoritative", (await ledgerOf(suresh.id)) !== before9 && (await store.checkReplay(suresh.id)).ok);
  check("the task is resolved, with a decision: override, the advisor, and what they supplied", (await db.select().from(reviewTask).where(eq(reviewTask.id, task9.id)))[0].status === "resolved" && (await decisionsOf(task9.id)).some((d) => d.action === "override" && (d.payload as any).supplied.providerTier === "general_hospital"));
  const caseView = await caseLib.getEventCase(suresh.id, clm9.id);
  check("the case page's banner says an ADVISOR decided it directly — not 'reversed on appeal', which is wrong for a hand decision", caseView?.supersededBy?.kind === "advisor" && caseView.supersededBy.ref === "CLM-9-A", JSON.stringify(caseView?.supersededBy));
  check("the queue no longer has it — and the broker's text names the decision and who took it, in a different voice from the member's", !(await listQueue()).some((r) => r.task.subjectId === clm9.id) && /Karim/.test(dec.brokerExplanation ?? "") && dec.brokerExplanation !== dec.memberExplanation);
  check("a case decided once cannot be decided again", (await handoff.coverIt({ taskId: task9.id, advisorUserId: karim, providerTier: "private_hospital", note: "Another go at it." })).ok === false);

  // ==========================================================================
  console.log("\nCLM-9, live: the member's side, end to end");
  const live = (await session.openServicing({ userId: suresh.owner, policyId: suresh.id, intent: "claim" }, { today })) as any;
  await session.handleServicingInput(live.conversationId, suresh.owner, { kind: "form", values: claimForm() }, { today });
  await session.handleServicingInput(live.conversationId, suresh.owner, { kind: "confirm" }, { today });
  const liveEvent = (await eventsOf(suresh.id)).find((e) => e.outcome === "insufficient_data" && e.id !== clm9.id)!;
  check("treatment abroad reaches an advisor: an event that records it, and the conversation escalated", liveEvent !== undefined && (await convoOf(live.conversationId)).status === "escalated");
  const escCard: any = (await cardsOf(live.conversationId)).at(-1);
  check("the member sees the escalation card: a reference, a callback, and never why", escCard.kind === "servicing_escalation" && escCard.reference === liveEvent.externalRef && !/insufficient|cause|plan terms/i.test(JSON.stringify(escCard)));
  const qLive = sub((await listQueue()).find((r) => r.task.subjectId === liveEvent.id));
  check("the advisor sees it FIRST in the queue, with the cause, and the group it belongs to", qLive?.group === "undecidable" && qLive.cause === "insufficient_data" && (await listQueue())[0].task.subjectId === liveEvent.id, JSON.stringify(qLive));
  const packetLive = await packetLib.getPacket({ policyId: suresh.id, conversationId: live.conversationId, eventId: liveEvent.id });
  check("the packet carries the case: every fact with its sentence, what the plan could not say, and the conversation", packetLive.facts.length >= 4 && packetLive.why.cause === "insufficient_data" && packetLive.transcript.length >= 3 && packetLive.reassessments.length >= 0);
  const liveTask = (await tasksFor(liveEvent.id)).find((t) => t.status === "open")!;
  const before2 = await ledgerOf(suresh.id);
  const deny = await handoff.denyIt({ taskId: liveTask.id, advisorUserId: karim, note: "No cover for overseas care on this plan; nothing in the terms extends it.", today });
  check("Don't cover it goes through, with the member's message drafted for them", deny.ok, JSON.stringify(deny));
  const denied = (await eventsOf(suresh.id)).find((e) => e.supersedesEventId === liveEvent.id)!;
  check("the row is a denial by the ADVISOR that supersedes the undecidable one, worth nothing: 0 paid, the whole bill the member's", denied.outcome === "denied" && denied.decidedBy === "advisor" && Number(denied.planPays) === 0 && Number(denied.memberPays) === 3000);
  check("it consumes nothing: the ledger is exactly what it was", (await ledgerOf(suresh.id)) === before2);
  const rep = await store.checkReplay(suresh.id);
  check("replay takes it at its word — the ONE stored result that is authoritative — and it still passes, without drift", rep.ok && rep.drifted.length === 0, JSON.stringify(rep));
  check("...and it can be rebuilt from the log alone: drop the ledger, refold, the same", await (async () => {
    const was = await ledgerOf(suresh.id);
    await db.delete(benefitLedger).where(eq(benefitLedger.policyId, suresh.id));
    await store.rebuildLedger(suresh.id);
    return (await ledgerOf(suresh.id)) === was;
  })());
  check("a denial an advisor made is theirs to revisit, not the appeal loop's", ((await appealStore.checkAppealable(suresh.id, denied.id)) as any).exit === "already_with_advisor");
  const told = (await cardsOf(live.conversationId)).at(-1) as any;
  check("the member is told IN THE THREAD, on an outcome card that says not covered and what it costs them — closing the conversation", told.kind === "servicing_outcome" && told.outcome === "denied" && told.figures.member.value === 3000 && (await convoOf(live.conversationId)).status === "completed");
  check("...in the member's register, with no promised time and no internal word", memberCopyViolations(told.explanation).length === 0);

  // ==========================================================================
  console.log("\nA quality check is a close call that resolved");
  const qTask = (await tasksFor(app1.id)).find((t) => t.status === "open")!;
  check("it can be closed with a note, and it changes nothing about the decision", (await handoff.closeQualityCheck({ taskId: qTask.id, advisorUserId: karim, note: "ok" })).ok === false && (await handoff.closeQualityCheck({ taskId: qTask.id, advisorUserId: karim, note: "Read the declaration against her account; the upheld finding is right." })).ok && (await eventByRef("APP-1")).outcome === "upheld");
  check("...and cannot be used on a case that needs a real decision", (await handoff.closeQualityCheck({ taskId: task9.id, advisorUserId: karim, note: "Closing something that is not a quality check." })).ok === false);

  // ==========================================================================
  console.log("\nQuality checks come from the session, and clean claims do not");
  const noModel = (await session.openServicing({ userId: aisha.owner, policyId: aisha.id, intent: "claim" }, { today })) as any;
  await session.handleServicingInput(noModel.conversationId, aisha.owner, { kind: "form", values: claimForm({ provider_type: "in_network_clinic", amount: "900", treatment_date: "2026-09-10" }) }, { today });
  await session.handleServicingInput(noModel.conversationId, aisha.owner, { kind: "confirm" }, { today });
  const noModelEvent = (await eventsOf(aisha.id)).at(-1)!;
  const nmTask = await tasksFor(noModelEvent.id);
  check("a claim whose category the MEMBER picked from a list is a quality check — medium confidence, a reason, priority 40 — not a blocker", nmTask.length === 1 && nmTask[0].priorityScore === 40 && Number(noModelEvent.confidence) === 0.75 && /chosen by the member/.test(noModelEvent.uncertaintyReason ?? ""), JSON.stringify(nmTask));

  // ==========================================================================
  console.log("\nThe queue, after all of that");
  const finalQueue = await listQueue();
  const order = finalQueue.map((r) => sub(r)?.group ?? "other");
  const rank: Record<string, number> = { undecidable: 0, blocked: 1, uncertain: 2, decide: 3 };
  const ranked = finalQueue.filter((r) => sub(r)).map((r) => rank[sub(r).group]);
  check("every open servicing task falls into a group §13.3.1 defines, and none is dropped", ranked.length === finalQueue.filter((r) => r.task.subjectType !== "application" && r.task.subjectType !== "recommendation").length && ranked.every((n) => n >= 0), order.join());
  check("the still-open hand-offs are Blocked, the quality check is Uncertain — priority 80 outranks 40 within the queue's own order", finalQueue.filter((r) => sub(r)?.task === "quality").every((r) => r.task.priorityScore === 40) && finalQueue.filter((r) => sub(r)?.group === "blocked").every((r) => r.task.priorityScore >= 80));

  console.log("\nNo member string promises a time (§18.14)");
  const spoken = await db.select().from(message).where(and(eq(message.direction, "outbound")));
  const said = spoken.filter((m) => m.role === "advisor" || m.role === "assistant");
  // What is READ: the message text, and the prose fields of a card (its option values are wire values, not words on screen).
  const prose = (m: (typeof said)[number]) => [m.bodyText ?? "", ...(m.payload && isServicingCard(m.payload) ? [(m.payload as any).explanation, ...((m.payload as any).nextSteps ?? []), ...((m.payload as any).trace ?? [])].filter(Boolean) : [])];
  check("every message a member has been sent — the agent's, and every advisor's — reads in their register with no time promise", said.length > 10 && said.every((m) => prose(m).every((t) => memberCopyViolations(t).length === 0)));
  check("every stored ledger equals a replay of its log", (await Promise.all(owners.map((o) => store.checkReplay(o.id)))).every((r) => r.ok));
  const st1 = await queries.getStraightThrough(new Date("2026-09-21"));
  check("the dashboard's number moved with the work: the two decided cases are people's, and the hand-offs that never became outcomes are counted with their cause", st1.all.total > st0.all.total && st1.causes.some((c) => c.cause === "member_requested"), JSON.stringify(st1));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
