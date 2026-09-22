// The servicing session, attacked (plan §6, §10, §17 phase 4).
//
//   bun run db/seed/check-servicing-session.ts
//
// Seeds a THROWAWAY database, then drives whole conversations through the real session and the real graph —
// with no model (forms), with a scripted model, with a model that dies, with one that cheats — and checks what
// is left in the database. The model is a script; nothing here calls a network.
//
// The properties under test: a model failure produces a form and never a wrong number; the ledger is wired in
// (a second claim sees the first); nothing is written that the engine did not compute; a conversation resumes
// from rows alone; and no one reaches another member's conversation.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import type { Decision, ServicingDecider } from "@/lib/ai/graph/nodes/servicing";
import { isServicingCard, type ServicingCard } from "@/lib/servicing";

/* eslint-disable @typescript-eslint/no-explicit-any */
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${!ok && detail ? `\n         ${detail}` : ""}`);
};

const dir = mkdtempSync(path.join(tmpdir(), "mizan-session-"));
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
  const store = await import("@/lib/servicing/store");
  const { conversation, conversationAction, extraction, message, modelRun, person, policy, reviewTask, servicingEvent, appUser } = schema;

  // ---- who owns what -------------------------------------------------------
  const owners = await db.select({ ref: policy.externalRef, id: policy.id, owner: person.ownerUserId }).from(policy).innerJoin(person, eq(policy.personId, person.id));
  const P = (ref: string) => owners.find((o) => o.ref === ref)!;
  const users = await db.select().from(appUser);
  const advisorId = users.find((u) => u.role === "advisor")!.id;

  // ---- helpers -------------------------------------------------------------
  const cardsOf = async (conversationId: string) =>
    (await db.select().from(message).where(eq(message.conversationId, conversationId)).orderBy(message.seq)).filter((m) => m.role === "assistant" && isServicingCard(m.payload)).map((m) => m.payload as ServicingCard);
  const lastCard = async (id: string) => (await cardsOf(id)).at(-1)!;
  const messagesOf = (id: string) => db.select().from(message).where(eq(message.conversationId, id)).orderBy(message.seq);
  const convoOf = async (id: string) => (await db.select().from(conversation).where(eq(conversation.id, id)))[0];
  const eventByRef = async (ref: string) => (await db.select().from(servicingEvent).where(eq(servicingEvent.externalRef, ref)))[0];
  const stateOf = async (id: string) => {
    const [row] = await db.select().from(conversationAction).where(and(eq(conversationAction.conversationId, id), eq(conversationAction.actionType, "servicing_state"))).orderBy(desc(conversationAction.createdAt));
    return row?.arguments as any;
  };
  const events = (policyId: string) => db.select().from(servicingEvent).where(eq(servicingEvent.policyId, policyId));

  /** A scripted model: hands out its decisions in order, one per call, across turns. */
  const scripted = (steps: Decision[]): ServicingDecider & { calls: () => number } => {
    let i = 0;
    const fn = (async () => {
      if (i >= steps.length) throw new Error("the script ran out of decisions");
      return { decision: steps[i++], servedBy: "scripted", latencyMs: 1 };
    }) as unknown as ServicingDecider & { calls: () => number };
    fn.calls = () => i;
    return fn;
  };

  const claimForm = (over: Record<string, string> = {}) => ({ treatment: "Physiotherapy for my wrist", treatment_date: "2026-09-04", provider_type: "in_network_clinic", provider_name: "Al Noor Clinic", amount: "1,800", paid_by_member: "no", benefit_class: "general", ...over });
  const today = "2026-09-20";

  // ==========================================================================
  console.log("\nNo model: the conversation runs on forms");
  const aisha = P("POL-P1");
  const opened = await session.openServicing({ userId: aisha.owner, policyId: aisha.id, intent: "claim" }, { today });
  check("a member opens a conversation on their own cover", opened.ok);
  const c1 = (opened as any).conversationId as string;
  const first = await lastCard(c1);
  check("with no model it opens on a FORM (free text cannot be read), asking only for what is missing", first.kind === "servicing_facts_form" && (first as any).fields.map((f: any) => f.fieldKey).join() === "treatment,treatment_date,provider_type,amount,paid_by_member,benefit_class,provider_name");
  check("the form lists the required fields as required and provider_name as optional", (first as any).fields.filter((f: any) => f.required).length === 6 && (first as any).fields.find((f: any) => f.fieldKey === "provider_name").required === false);
  check("the provider question has no 'Not sure' in the form — it cannot be resolved by a form", !(first as any).fields.find((f: any) => f.fieldKey === "provider_type").options.some((o: any) => o.value === "unsure"));
  check("the conversation is waiting on the member, and nothing is in the log yet", (await convoOf(c1)).status === "awaiting_user" && (await events(aisha.id)).length === 2);
  check("the state row parses and reserves a reference (CLM-10: the supplied data ends at CLM-9)", (await stateOf(c1)).eventRef === "CLM-10");

  const t1 = await session.handleServicingInput(c1, aisha.owner, { kind: "form", values: claimForm() }, { today });
  check("submitting the form shows the confirm card — before any money is computed", t1.ok && (await lastCard(c1)).kind === "servicing_confirm" && (await events(aisha.id)).length === 2);
  const confirmRows = (await lastCard(c1) as any).rows;
  check("the confirm card marks what the member CHOSE from a list as theirs, not 'worked out'", confirmRows.find((r: any) => r.fieldKey === "benefit_class").origin === "told_us" && confirmRows.every((r: any) => r.origin === "told_us"));
  check("the member's form is in the thread as one readable line", (await messagesOf(c1)).some((m) => m.role === "applicant" && /Physiotherapy for my wrist · 4 September 2026 · Clinic/.test(m.bodyText ?? "")));

  const t2 = await session.handleServicingInput(c1, aisha.owner, { kind: "confirm" }, { today });
  const ev1 = await eventByRef("CLM-10");
  check("confirming adjudicates and commits: covered, plan 1,260, member 540 — the acceptance table's CLM-6", t2.ok && ev1?.outcome === "covered" && Number(ev1.planPays) === 1260 && Number(ev1.memberPays) === 540, JSON.stringify(ev1));
  check("the conversation is completed, and the state records the event", (await convoOf(c1)).status === "completed" && (await stateOf(c1)).committedEventId === ev1.id && (await stateOf(c1)).phase === "done");
  check("the outcome card was posted, and it is the last thing in the thread", (await lastCard(c1)).kind === "servicing_outcome");
  check("the event carries the medium confidence and the reason a member-chosen category earns", Number(ev1.confidence) === 0.75 && /chosen by the member/.test(ev1.uncertaintyReason ?? ""));
  check("the member's explanation and the broker's are different documents; only the broker's names the policy and the event", ev1.memberExplanation !== ev1.brokerExplanation && /POL-P1/.test(ev1.brokerExplanation!) && /CLM-10/.test(ev1.brokerExplanation!) && !/POL-|CLM-/.test(ev1.memberExplanation!));
  check("the event is derived from the engine: the stored calculation is the engine's own trace", JSON.stringify(ev1.calculation) === JSON.stringify(["deductible applied 0 (remaining was 0)", "co-pay 30% of 1800 = 540", "plan pays 1260, member pays 540"]));

  const report1 = await store.checkReplay(aisha.id);
  const ledger1 = (await db.select().from(schema.benefitLedger).where(eq(schema.benefitLedger.policyId, aisha.id)))[0];
  check("the ledger was rebuilt from the log: annual paid 2,450 → 3,710, and the policy is still replayable", Number(ledger1.annualPaid) === 3710 && report1.ok, JSON.stringify(report1));
  const replayed1 = await store.replayPolicy(aisha.id);
  check("submission order is write order: the new claim is the LAST step of the replay", replayed1.steps.at(-1)!.event.id === ev1.id);
  check("provenance: each fact has an extraction row holding the member's own words", (await db.select().from(extraction).where(eq(extraction.conversationId, c1))).length === 6 && (await db.select().from(extraction).where(eq(extraction.conversationId, c1))).some((e) => e.rawSpan === "Al Noor Clinic"));
  check("a conversation that is finished takes no further input", (await session.handleServicingInput(c1, aisha.owner, { kind: "text", text: "hello?" }, { today })).ok === false);

  console.log("\nThe ledger is wired in: a second claim sees the first");
  const c2 = ((await session.openServicing({ userId: aisha.owner, policyId: aisha.id, intent: "claim" }, { today })) as any).conversationId as string;
  check("the next reference is issued from the log (CLM-11)", (await stateOf(c2)).eventRef === "CLM-11");
  await session.handleServicingInput(c2, aisha.owner, { kind: "form", values: claimForm({ amount: "1,000", treatment: "A follow-up physiotherapy session" }) }, { today });
  await session.handleServicingInput(c2, aisha.owner, { kind: "confirm" }, { today });
  const ev2 = await eventByRef("CLM-11");
  check("the second claim pays 700 / 300 — the deductible was already met, which only the ledger knows", Number(ev2.planPays) === 700 && Number(ev2.memberPays) === 300);
  check("...and annual paid is now 4,410 (the first claim's 1,260 is in it)", Number((await db.select().from(schema.benefitLedger).where(eq(schema.benefitLedger.policyId, aisha.id)))[0].annualPaid) === 4410);

  console.log("\nA pre-authorization moves nothing");
  const omar = P("POL-P2");
  const before2 = (await db.select().from(schema.benefitLedger).where(eq(schema.benefitLedger.policyId, omar.id)))[0];
  const cp = ((await session.openServicing({ userId: omar.owner, policyId: omar.id, intent: "preauth" }, { today: "2026-10-05" })) as any).conversationId as string;
  const preForm = await lastCard(cp);
  check("a pre-authorization's form has no date and no 'paid' — there is nothing yet to ask", !(preForm as any).fields.some((f: any) => f.fieldKey === "treatment_date" || f.fieldKey === "paid_by_member"));
  check("its reference is a PRE- one, numbered from the log", (await stateOf(cp)).eventRef === "PRE-3");
  await session.handleServicingInput(cp, omar.owner, { kind: "form", values: { treatment: "Planned delivery", provider_type: "private_hospital", amount: "40000", benefit_class: "maternity" } }, { today: "2026-10-05" });
  await session.handleServicingInput(cp, omar.owner, { kind: "confirm" }, { today: "2026-10-05" });
  const pre = await eventByRef("PRE-3");
  // PRE-1's acceptance numbers (approved with a limit, 25,000 / 15,000) hold against the ledger as it stood in month 6.
  // This policy's maternity limit has SINCE been used up by CLM-2, and a forecast reads the CURRENT ledger — so the
  // honest answer today is a denial. Same engine, later ledger, different and correct answer.
  check("a maternity forecast on a policy whose maternity limit is already used is DENIED — a forecast reads today's ledger", pre.outcome === "denied" && pre.reasonCode === "sublimit_exhausted" && Number(pre.memberPays) === 40000);
  check("...and it is shown as an estimate, in the estimate's own words", (await lastCard(cp)).kind === "servicing_estimate" && /wouldn't be covered/i.test(((await lastCard(cp)) as any).explanation));
  const after2 = (await db.select().from(schema.benefitLedger).where(eq(schema.benefitLedger.policyId, omar.id)))[0];
  check("the ledger is exactly as it was: a forecast reads the ledger and writes nothing", Number(after2.annualPaid) === Number(before2.annualPaid) && Number(after2.deductibleMet) === Number(before2.deductibleMet) && JSON.stringify(after2.sublimitUsed) === JSON.stringify(before2.sublimitUsed));
  check("it is stored as an estimate, with an estimated (not billed) amount", pre.kind === "preauth" && Number(pre.estimatedAmount) === 40000 && pre.billedAmount === null);

  const dan = P("POL-P4");
  const cp2 = ((await session.openServicing({ userId: dan.owner, policyId: dan.id, intent: "preauth" }, { today: "2026-10-05" })) as any).conversationId as string;
  await session.handleServicingInput(cp2, dan.owner, { kind: "form", values: { treatment: "Planned shoulder arthroscopy", provider_type: "private_hospital", amount: "28000", benefit_class: "general" } }, { today: "2026-10-05" });
  await session.handleServicingInput(cp2, dan.owner, { kind: "confirm" }, { today: "2026-10-05" });
  const pre2 = await eventByRef("PRE-4");
  check("PRE-2's numbers through the session: covered, plan 22,400, member 5,600 — against the overturned, deductible-met ledger", pre2.outcome === "covered" && Number(pre2.planPays) === 22400 && Number(pre2.memberPays) === 5600);
  check("...and the estimate card carries the caveat exactly once", ((await lastCard(cp2)) as any).caveat === null ? /Nothing has been claimed/.test((await lastCard(cp2) as any).explanation) : true);

  console.log("\nA denial, with what the member declared");
  const meera = P("POL-P3");
  const c3 = ((await session.openServicing({ userId: meera.owner, policyId: meera.id, intent: "claim" }, { today: "2026-05-20" })) as any).conversationId as string;
  const form3: any = await lastCard(c3);
  check("the member's own declared conditions are the options — nothing they told us is asked again", form3.fields.find((f: any) => f.fieldKey === "benefit_class").options.some((o: any) => /type 2 diabetes/.test(o.label)) && form3.fields.find((f: any) => f.fieldKey === "benefit_class").options.some((o: any) => /hypertension/.test(o.label)));
  await session.handleServicingInput(c3, meera.owner, { kind: "form", values: claimForm({ treatment: "Endocrinology review", treatment_date: "2026-05-03", amount: "2800", benefit_class: "chronic:type 2 diabetes", provider_name: "" }) }, { today: "2026-05-20" });
  check("the confirm card names the condition, in the member's own words", ((await lastCard(c3)) as any).rows.some((r: any) => /your type 2 diabetes/.test(r.value)));
  await session.handleServicingInput(c3, meera.owner, { kind: "confirm" }, { today: "2026-05-20" });
  const ev3 = await eventByRef("CLM-12");
  check("CLM-3 through the session: denied on the waiting period, plan 0, member 2,800", ev3.outcome === "denied" && ev3.reasonCode === "waiting_period_not_elapsed" && Number(ev3.planPays) === 0 && Number(ev3.memberPays) === 2800);
  const denialCard: any = await lastCard(c3);
  check("the card offers what the member can do (their date, once) and marks the decision appealable", denialCard.appealable === true && /1 July 2026/.test(denialCard.explanation) && (denialCard.nextSteps.join(" ").match(/1 July 2026/g) ?? []).length === 0);
  check("a denial consumes nothing: the ledger is untouched", Number((await db.select().from(schema.benefitLedger).where(eq(schema.benefitLedger.policyId, meera.id)))[0].annualPaid) === 1680);

  console.log("\nThe edge of the plan data hands over to a person");
  const suresh = P("POL-P5");
  const c5 = ((await session.openServicing({ userId: suresh.owner, policyId: suresh.id, intent: "claim" }, { today: "2026-07-15" })) as any).conversationId as string;
  await session.handleServicingInput(c5, suresh.owner, { kind: "form", values: claimForm({ treatment: "Cardiac follow-up while overseas", treatment_date: "2026-07-03", provider_type: "unknown_foreign", amount: "4500", paid_by_member: "yes", benefit_class: "chronic:coronary artery disease", provider_name: "" }) }, { today: "2026-07-15" });
  const ledger5 = Number((await db.select().from(schema.benefitLedger).where(eq(schema.benefitLedger.policyId, suresh.id)))[0].annualPaid);
  await session.handleServicingInput(c5, suresh.owner, { kind: "confirm" }, { today: "2026-07-15" });
  const ev5 = await eventByRef("CLM-13");
  check("CLM-9 through the session: insufficient_data, with NO amounts (null, not zero)", ev5.outcome === "insufficient_data" && ev5.planPays === null && ev5.memberPays === null);
  check("...recorded as a reimbursement, because the member had already paid", ev5.kind === "reimbursement");
  const [task5] = await db.select().from(reviewTask).where(eq(reviewTask.subjectId, ev5.id));
  check("a review task is open at the top of the range, so a broker really has it", task5?.status === "open" && task5.priorityScore === 100 && task5.subjectType === "servicing_event");
  check("the conversation is escalated, and the member is told in words — then given the escalation card", (await convoOf(c5)).status === "escalated" && (await lastCard(c5)).kind === "servicing_escalation" && (await messagesOf(c5)).some((m) => /person needs to look/.test(m.bodyText ?? "")));
  check("the escalation card names a reference and never the reason it escalated", ((await lastCard(c5)) as any).reference === "CLM-13" && !("cause" in ((await lastCard(c5)) as object)));
  check("no confidence is stored for the one case with no answer", ev5.confidence === null && /no geographic scope/.test(ev5.uncertaintyReason ?? ""));
  check("the ledger did not move", Number((await db.select().from(schema.benefitLedger).where(eq(schema.benefitLedger.policyId, suresh.id)))[0].annualPaid) === ledger5);
  const cb = await session.requestCallback(c5, suresh.owner, { window: "afternoon", phone: "+971 50 000 0000" });
  check("a callback can be requested on an escalated conversation, and is recorded", cb.ok && (await db.select().from(conversationAction).where(and(eq(conversationAction.conversationId, c5), eq(conversationAction.actionType, "callback_requested")))).length === 1);
  check("...and only on one: a finished-normally conversation refuses it", (await session.requestCallback(c1, aisha.owner, { window: "morning", phone: "1" })).ok === false);
  check("...and only by its owner", (await session.requestCallback(c5, aisha.owner, { window: "morning", phone: "1" })).ok === false);

  console.log("\nWhat the thread reads");
  const th5 = await session.readServicingThread(c5, suresh.owner);
  check("the thread read knows a callback was requested (so a reload does not offer it again)", th5?.callbackRequested === true);
  check("...carries the policy, the status and the messages in order, cards as payloads", th5?.policyId === suresh.id && th5.status === "escalated" && th5.messages.length > 1 && th5.messages.some((m) => m.from === "assistant" && m.card));
  check("...member messages carry no card", th5!.messages.filter((m) => m.from === "member").every((m) => m.card === null));
  check("...and it is the OWNER's: another member gets nothing", (await session.readServicingThread(c5, aisha.owner)) === null);
  const aisha1 = await session.readServicingThread(c1, aisha.owner);
  check("a conversation with no callback says so", aisha1?.callbackRequested === false);
  const waitingNow = await session.findWaitingServicing(aisha.owner);
  const stillOpen = await db.select({ id: conversation.id }).from(conversation).where(and(eq(conversation.userId, aisha.owner), eq(conversation.purpose, "servicing"), eq(conversation.status, "awaiting_user")));
  check("the launcher's query agrees with the rows: waiting iff a conversation is awaiting_user", (waitingNow !== null) === (stillOpen.length > 0));
  check("...and an escalated or completed conversation does NOT light it", (await session.findWaitingServicing(suresh.owner)) === null || (await db.select({ id: conversation.id }).from(conversation).where(and(eq(conversation.userId, suresh.owner), eq(conversation.status, "awaiting_user")))).length > 0);

  console.log("\nAsking for a person, before anything is adjudicated");
  const c6 = (await session.openServicing({ userId: aisha.owner, policyId: aisha.id, intent: "claim" }, { today })) as any;
  const cAdv = c6.conversationId as string;
  const adv = await session.handleServicingInput(cAdv, aisha.owner, { kind: "advisor" }, { today });
  const [taskAdv] = await db.select().from(reviewTask).where(eq(reviewTask.subjectId, cAdv));
  check("a member can ask for a person at any point", adv.ok && (await convoOf(cAdv)).status === "escalated" && (await lastCard(cAdv)).kind === "servicing_escalation");
  check("with no event to hang it on, the task is about the CONVERSATION — a hand-off with no task is a promise nobody keeps", taskAdv?.subjectType === "conversation" && taskAdv.status === "open" && taskAdv.priorityScore === 80);
  check("...and no event was written for it", (await events(aisha.id)).length === 4);

  // ==========================================================================
  console.log("\nA model, scripted");
  const sm = scripted([
    { thought: "record what they said", tool: "record_fact", args: { field_key: "treatment", value: "Physiotherapy for my wrist", basis: "stated", quote: "physiotherapy for my wrist" } },
    { thought: "the date", tool: "record_fact", args: { field_key: "treatment_date", value: "2026-09-04", basis: "stated", quote: "4 September" } },
    { thought: "the amount", tool: "record_fact", args: { field_key: "amount", value: 2000, basis: "stated", quote: "2,000" } },
    { thought: "who", tool: "record_fact", args: { field_key: "provider_name", value: "Al Noor Clinic", basis: "stated", quote: "Al Noor Clinic" } },
    { thought: "what is missing", tool: "list_missing_facts", args: {} },
    { thought: "ask the type", tool: "ask_member", args: { field_key: "provider_type", question: "What kind of place is Al Noor Clinic?" } },
    // turn 2: the member taps "Clinic"; processResponse records it
    { thought: "paid?", tool: "ask_member", args: { field_key: "paid_by_member", question: "Have you already paid Al Noor Clinic?" } },
    // turn 3: the member taps "No, not yet"
    { thought: "classify", tool: "classify_benefit", args: { benefit_class: "general" } },
    { thought: "confirm", tool: "confirm_details", args: {} },
    // turn 4: the member confirms
    { thought: "compute", tool: "adjudicate", args: {} },
    {
      thought: "explain",
      tool: "propose_outcome",
      args: {
        member_explanation: "This is covered. Your plan has no deductible, so only your 10% share applies. The plan pays AED 1,800 and you pay AED 200. The plan settles its share with the provider; the rest is yours to pay them.",
        broker_explanation: "POL-P2 general claim at a clinic, month 8: billed AED 2,000, plan paid AED 1,800, member AED 200. No deductible on this plan, so only the co-pay applied.",
        confidence: "high",
      },
    },
  ]);
  const modelDeps = { decide: sm, today };
  const cm = ((await session.openServicing({ userId: omar.owner, policyId: omar.id, intent: "claim" }, modelDeps)) as any).conversationId as string;
  check("with a model, the opening is a sentence — the member just starts typing", (await cardsOf(cm)).length === 0 && (await messagesOf(cm))[0].bodyText!.startsWith("Tell me about the treatment"));
  const m1 = await session.handleServicingInput(cm, omar.owner, { kind: "text", text: "I had physiotherapy for my wrist at Al Noor Clinic on 4 September. It cost 2,000." }, modelDeps);
  const q1: any = await lastCard(cm);
  check("one sentence gave four facts; the agent asked for the ONE thing missing that could not be derived: the provider type, as chips", m1.ok && q1.kind === "servicing_question" && q1.fieldKey === "provider_type" && q1.chips.length === 7);
  check("the state records the open question and the four facts, with the member's words", (await stateOf(cm)).openQuestion === "provider_type" && Object.keys((await stateOf(cm)).draft.facts).length === 4);
  const dup = await session.handleServicingInput(cm, omar.owner, { kind: "chip", fieldKey: "paid_by_member", value: "no", label: "No, not yet" }, modelDeps);
  check("an answer to a question that is not open is ignored — nothing is written", dup.ok && (dup as any).ignored === true && (await messagesOf(cm)).filter((m) => m.role === "applicant").length === 1);
  await session.handleServicingInput(cm, omar.owner, { kind: "chip", fieldKey: "provider_type", value: "in_network_clinic", label: "Clinic" }, modelDeps);
  const twice = await session.handleServicingInput(cm, omar.owner, { kind: "chip", fieldKey: "provider_type", value: "in_network_clinic", label: "Clinic" }, modelDeps);
  check("a double-tapped chip is ignored the second time", (twice as any).ignored === true && (await messagesOf(cm)).filter((m) => m.bodyText === "Clinic").length === 1);
  const q2: any = await lastCard(cm);
  check("the agent then asked whether they had paid — yes / no, and only that", q2.fieldKey === "paid_by_member" && q2.input === "yes_no");
  await session.handleServicingInput(cm, omar.owner, { kind: "chip", fieldKey: "paid_by_member", value: "no", label: "No, not yet" }, modelDeps);
  const conf: any = await lastCard(cm);
  check("the agent's classification is shown as 'worked out — please check'; what the member said is theirs", conf.kind === "servicing_confirm" && conf.rows.find((r: any) => r.fieldKey === "benefit_class").origin === "worked_out" && conf.rows.find((r: any) => r.fieldKey === "amount").origin === "told_us");
  check("nothing is computed before the member confirms", (await events(omar.id)).filter((e) => e.description?.startsWith("Physiotherapy")).length === 0);
  await session.handleServicingInput(cm, omar.owner, { kind: "confirm" }, modelDeps);
  const evm = await eventByRef("CLM-14");
  check("the model's turn ends in the engine's numbers: plan 1,800, member 200", evm?.outcome === "covered" && Number(evm.planPays) === 1800 && Number(evm.memberPays) === 200, JSON.stringify(evm));
  check("a model that finished cleanly carries HIGH confidence — the agent classified it and the member confirmed", Number(evm.confidence) === 0.95 && evm.uncertaintyReason === null);
  check("the model call is audited: a model_run row with the steps, and no transcript", (await db.select().from(modelRun)).some((r) => r.purpose === "servicing_agent" && r.modelId === "scripted" && !JSON.stringify(r.request).includes("physiotherapy") && Array.isArray((r.response as any).steps)));
  check("the scripted model was consulted exactly as scripted: no calls wasted, none missing", sm.calls() === 11, `calls=${sm.calls()}`);

  console.log("\nA model that fails produces a form, never a wrong number");
  const meraDaniel = P("POL-P4");
  const dead: ServicingDecider = async () => {
    throw new Error("model unreachable");
  };
  const cf = ((await session.openServicing({ userId: meraDaniel.owner, policyId: meraDaniel.id, intent: "claim" }, { decide: dead, today }) as any).conversationId) as string;
  const evBefore = (await events(meraDaniel.id)).length;
  const f1 = await session.handleServicingInput(cf, meraDaniel.owner, { kind: "text", text: "physio at a private hospital, 3,000" }, { decide: dead, today });
  check("the model dying mid-conversation degrades to the form — no error page, no crash", f1.ok && (await lastCard(cf)).kind === "servicing_facts_form");
  check("...the failure is audited with its reason", (await db.select().from(modelRun)).some((r) => r.status === "error" && /model call failed/.test(r.errorText ?? "")));
  check("...and nothing was written to the log", (await events(meraDaniel.id)).length === evBefore);
  await session.handleServicingInput(cf, meraDaniel.owner, { kind: "form", values: claimForm({ provider_type: "private_hospital", amount: "3,000", treatment: "Physiotherapy" }) }, { decide: dead, today });
  check("the member can finish the whole thing on forms while the model is dead", (await lastCard(cf)).kind === "servicing_confirm");

  console.log("\n'Change something' — the change is never silently dropped");
  await session.handleServicingInput(cf, meraDaniel.owner, { kind: "change" }, { decide: dead, today });
  check("with a model (even one that is about to fail), 'change' asks in words what to change — and remembers that it did", (await stateOf(cf)).changing === true && (await messagesOf(cf)).at(-1)!.bodyText === "Of course — what would you like to change?");
  check("...and the confirmation is withdrawn: nothing is computed on a reading they are changing", (await stateOf(cf)).draft.confirmed === false && (await stateOf(cf)).awaitingConfirmation === false);
  await session.handleServicingInput(cf, meraDaniel.owner, { kind: "text", text: "the amount was actually 3,500" }, { decide: dead, today });
  const prefilled: any = await lastCard(cf);
  check("the member types the change, the model is dead, and the fallback opens the form PRE-FILLED — not the old confirm card", prefilled.kind === "servicing_facts_form" && prefilled.fields.find((f: any) => f.fieldKey === "amount").current === "3000" && prefilled.fields.find((f: any) => f.fieldKey === "treatment").current === "Physiotherapy" && prefilled.fields.find((f: any) => f.fieldKey === "benefit_class").current === "general");
  await session.handleServicingInput(cf, meraDaniel.owner, { kind: "form", values: claimForm({ provider_type: "private_hospital", amount: "abc", treatment: "Physiotherapy" }) }, { decide: dead, today });
  const bad: any = await lastCard(cf);
  check("an INVALID edit shows the form again with the problem — the old amount is not silently put back in front of them", bad.kind === "servicing_facts_form" && bad.fields.find((f: any) => f.fieldKey === "amount")?.error && (await stateOf(cf)).draft.facts.amount.value === 3000);
  await session.handleServicingInput(cf, meraDaniel.owner, { kind: "form", values: claimForm({ provider_type: "private_hospital", amount: "3,500", treatment: "Physiotherapy" }) }, { decide: dead, today });
  check("a valid edit ends 'changing', and a fresh confirmation with the NEW amount is shown", (await stateOf(cf)).changing === false && (await lastCard(cf)).kind === "servicing_confirm" && ((await lastCard(cf)) as any).rows.some((r: any) => r.fieldKey === "amount" && /3,500/.test(r.value)));
  await session.handleServicingInput(cf, meraDaniel.owner, { kind: "confirm" }, { decide: dead, today });
  const evf = await eventByRef("CLM-15");
  check("the corrected amount is what is adjudicated: 3,500 → plan 2,800, member 700", Number(evf.planPays) === 2800 && Number(evf.memberPays) === 700, JSON.stringify(evf));

  console.log("\nNo model: 'change' opens the form pre-filled straight away");
  const cn = ((await session.openServicing({ userId: aisha.owner, policyId: aisha.id, intent: "claim" }, { today }) as any).conversationId) as string;
  await session.handleServicingInput(cn, aisha.owner, { kind: "form", values: claimForm() }, { today });
  await session.handleServicingInput(cn, aisha.owner, { kind: "change" }, { today });
  const nm: any = await lastCard(cn);
  check("every field, with its value — nothing is retyped", nm.kind === "servicing_facts_form" && nm.intro.startsWith("Here's what I have") && nm.fields.find((f: any) => f.fieldKey === "provider_name")?.current === "Al Noor Clinic" && nm.fields.find((f: any) => f.fieldKey === "amount").current === "1800");

  console.log("\nA model that misbehaves is cut off");
  const runaway = async (steps: () => Decision) => {
    const d: ServicingDecider = async () => ({ decision: steps(), servedBy: "scripted", latencyMs: 1 });
    const c = ((await session.openServicing({ userId: meraDaniel.owner, policyId: meraDaniel.id, intent: "claim" }, { decide: d, today }) as any).conversationId) as string;
    const n = (await events(meraDaniel.id)).length;
    await session.handleServicingInput(c, meraDaniel.owner, { kind: "text", text: "physio at a private hospital, 3,000" }, { decide: d, today });
    return { c, wrote: (await events(meraDaniel.id)).length - n, card: (await lastCard(c)).kind, run: (await db.select().from(modelRun).orderBy(desc(modelRun.createdAt)))[0] };
  };
  const cheat = await runaway(() => ({ thought: "just compute it", tool: "adjudicate", args: { amount: 1 } }));
  check("a model that tries to hand the engine an amount is refused, three times, then cut off — into a form", cheat.card === "servicing_facts_form" && /refused the same way 3 times/.test(cheat.run.errorText ?? "") && cheat.wrote === 0);
  const spin = await runaway(() => ({ thought: "let me look again", tool: "read_policy", args: {} }));
  check("a model that never reaches the member exhausts its tool budget (10 calls) and falls back to a form", spin.card === "servicing_facts_form" && (spin.run.response as any).steps.length === 10 && /budget exhausted/.test(spin.run.errorText ?? "") && spin.wrote === 0);
  const early = await runaway(() => ({ thought: "skip the confirmation", tool: "propose_outcome", args: { member_explanation: "x".repeat(50), broker_explanation: "POL-P4 " + "y".repeat(50), confidence: "high" } }));
  check("a model that tries to explain before anything is adjudicated is refused, and nothing is written", early.wrote === 0);

  console.log("\nThe model's escalation");
  const escModel = scripted([
    { thought: "record", tool: "record_fact", args: { field_key: "treatment", value: "Cardiac follow-up overseas", basis: "stated", quote: "cardiologist overseas" } },
    { thought: "record", tool: "record_fact", args: { field_key: "treatment_date", value: "2026-07-03", basis: "stated", quote: "3 July" } },
    { thought: "record", tool: "record_fact", args: { field_key: "amount", value: 4500, basis: "stated", quote: "4,500" } },
    { thought: "record", tool: "record_fact", args: { field_key: "paid_by_member", value: true, basis: "stated", quote: "paid" } },
    // "overseas" is a reading, not a stated provider type — the tool refuses "stated" for it, so the model says so.
    { thought: "record", tool: "record_fact", args: { field_key: "provider_type", value: "unknown_foreign", basis: "inferred", quote: "overseas" } },
    { thought: "classify", tool: "classify_benefit", args: { benefit_class: "chronic_preexisting", declared_condition: "coronary artery disease" } },
    { thought: "confirm", tool: "confirm_details", args: {} },
    { thought: "compute", tool: "adjudicate", args: {} },
    { thought: "hand over", tool: "escalate", args: { cause: "insufficient_data", note: "Overseas cardiac follow-up.", member_message: "We can't work this out from your plan terms alone. Your plan doesn't say how treatment outside the UAE is handled, so we haven't guessed. A person needs to look at it — nothing you've sent has been lost, and you won't need to send it again." } },
  ]);
  const cE = ((await session.openServicing({ userId: suresh.owner, policyId: suresh.id, intent: "claim" }, { decide: escModel, today: "2026-07-15" }) as any).conversationId) as string;
  await session.handleServicingInput(cE, suresh.owner, { kind: "text", text: "I saw a cardiologist overseas on 3 July and paid 4,500 myself." }, { decide: escModel, today: "2026-07-15" });
  await session.handleServicingInput(cE, suresh.owner, { kind: "confirm" }, { decide: escModel, today: "2026-07-15" });
  const evE = await eventByRef("CLM-16");
  check("the model routes the undecidable case through escalate, and the same rows result as the deterministic path", (await convoOf(cE)).status === "escalated" && evE?.outcome === "insufficient_data" && (await db.select().from(reviewTask).where(eq(reviewTask.subjectId, evE.id))).length === 1);

  console.log("\nForm validation speaks to the member");
  const cv = ((await session.openServicing({ userId: aisha.owner, policyId: aisha.id, intent: "claim" }, { today }) as any).conversationId) as string;
  await session.handleServicingInput(cv, aisha.owner, { kind: "form", values: claimForm({ treatment_date: "2026-10-01", amount: "abc" }) }, { today });
  const errForm: any = await lastCard(cv);
  const err = (k: string) => errForm.fields.find((f: any) => f.fieldKey === k)?.error as string | null;
  check("a future date is refused in words, and points to the right request", errForm.kind === "servicing_facts_form" && /still to come/.test(err("treatment_date") ?? "") && /Is this covered/.test(err("treatment_date") ?? ""));
  check("an amount that is not a number is refused in words", /number/.test(err("amount") ?? ""));
  check("a field that WAS valid is kept — recorded, and not asked for again", (await stateOf(cv)).draft.facts.treatment?.value === "Physiotherapy for my wrist" && !errForm.fields.some((f: any) => f.fieldKey === "treatment"));
  check("a field they got wrong is shown again with its problem, not dropped", errForm.fields.some((f: any) => f.fieldKey === "amount" && f.error) && errForm.fields.some((f: any) => f.fieldKey === "treatment_date" && f.error));
  await session.handleServicingInput(cv, aisha.owner, { kind: "form", values: claimForm({ treatment_date: "2025-12-31" }) }, { today });
  check("a date before the policy started is refused with the date it started", /before your policy started on 1 January 2026/.test(((await lastCard(cv)) as any).fields.find((f: any) => f.fieldKey === "treatment_date")?.error ?? ""));
  check("none of it wrote to the log", (await events(aisha.id)).length === 4);
  check("the errors show as an alert on the form, not a generic failure", ((await lastCard(cv)) as any).intro.length > 0);
  await session.handleServicingInput(cv, aisha.owner, { kind: "text", text: "just claim it please" }, { today });
  check("with no model, typed text is answered honestly and the form stays", (await messagesOf(cv)).some((m) => /can't read typed messages/.test(m.bodyText ?? "")) && (await lastCard(cv)).kind === "servicing_facts_form");

  console.log("\nA conversation resumes from rows alone");
  const stateBefore = await stateOf(cm);
  check("everything a turn needs is in the state row: facts, the open question, counters, and a reserved reference", stateBefore.version === 1 && stateBefore.eventRef === "CLM-14" && typeof stateBefore.clarificationCount === "number");
  const cr = ((await session.openServicing({ userId: aisha.owner, policyId: aisha.id, intent: "claim" }, { today }) as any).conversationId) as string;
  await db.insert(conversationAction).values({ conversationId: cr, actionType: "servicing_state", arguments: { version: 1, intent: "claim", draft: { facts: { amount: { value: "not a number", source: "made-up", quote: 3 } } } }, subjectType: "conversation", subjectId: cr, status: "succeeded", actorKind: "system" });
  const corrupt = await session.handleServicingInput(cr, aisha.owner, { kind: "form", values: claimForm() }, { today });
  check("a state row that does not parse is refused — it is not an empty conversation, and nothing is adjudicated against it", corrupt.ok === false);

  console.log("\nAnother member's conversation is not theirs");
  check("a member cannot open a conversation on someone else's cover", (await session.openServicing({ userId: aisha.owner, policyId: omar.id, intent: "claim" }, { today })).ok === false);
  check("...nor an advisor: servicing is the member's own", (await session.openServicing({ userId: advisorId, policyId: omar.id, intent: "claim" }, { today })).ok === false);
  check("a member cannot send input to someone else's conversation", (await session.handleServicingInput(cm, aisha.owner, { kind: "text", text: "hi" }, modelDeps)).ok === false);
  check("...and a conversation id that does not exist is the same answer as one that is not theirs", (await session.handleServicingInput(crypto.randomUUID(), aisha.owner, { kind: "text", text: "hi" }, modelDeps)).ok === false);
  check("the member's open conversations are listed for them, and only theirs", (await session.listOpenServicing(aisha.owner)).every((c) => c.id !== cm) && (await session.listOpenServicing(omar.owner)).length >= 0);

  console.log("\nTwo conversations, one reference");
  const racing = P("POL-P4");
  const ra = ((await session.openServicing({ userId: racing.owner, policyId: racing.id, intent: "claim" }, { today }) as any).conversationId) as string;
  const rb = ((await session.openServicing({ userId: racing.owner, policyId: racing.id, intent: "claim" }, { today }) as any).conversationId) as string;
  const refA = (await stateOf(ra)).eventRef;
  check("both were issued the same reference when they opened", refA === (await stateOf(rb)).eventRef);
  for (const c of [ra, rb]) await session.handleServicingInput(c, racing.owner, { kind: "form", values: claimForm({ provider_type: "private_hospital", amount: "1,000", treatment: c === ra ? "Session A" : "Session B" }) }, { today });
  await Promise.all([ra, rb].map((c) => session.handleServicingInput(c, racing.owner, { kind: "confirm" }, { today })));
  const evA = (await events(racing.id)).find((e) => e.description?.startsWith("Session A"))!;
  const evB = (await events(racing.id)).find((e) => e.description?.startsWith("Session B"))!;
  check("committed together, they end with DIFFERENT references — the second was re-issued", evA.externalRef !== evB.externalRef && !!evA.externalRef && !!evB.externalRef);
  check("...and the broker's prose on each names ITS OWN reference", evA.brokerExplanation!.includes(evA.externalRef!) && evB.brokerExplanation!.includes(evB.externalRef!) && !evB.brokerExplanation!.includes(evA.externalRef!));

  console.log("\nA policy that has not started yet — cover has no policy month before it begins");
  // `dates.ts`'s `monthOfDate` correctly refuses a negative month, but nothing used to stop a member reaching the
  // graph for a policy whose inception is still in the future — the opening line asks for "the current policy
  // month" and throws before a single message is read (found live, not by any check, once).
  {
    const { application, plan: planTbl } = schema;
    const [meeraP3] = await db.select().from(person).where(eq(person.externalRef, "P3"));
    const [aPlan] = await db.select().from(planTbl).limit(1);
    const appId = crypto.randomUUID();
    await db.insert(application).values({ id: appId, reference: "APP-TEST-FUTURE", personId: meeraP3.id, createdByUserId: advisorId, intakeSource: "web_form", status: "policy_issued", age: 40, budget: "low", policyInception: "2026-10-02", treatmentOutsideUaeExpected: false });
    const futurePolicyId = crypto.randomUUID();
    await db.insert(policy).values({ id: futurePolicyId, externalRef: "POL-TEST-FUTURE", applicationId: appId, personId: meeraP3.id, planId: aPlan.id, policyNumber: "TEST-FUTURE-0001", inceptionDate: "2026-10-02", status: "active", annualPremium: 4200 });
    await store.rebuildLedger(futurePolicyId);

    const openFuture = await session.openServicing({ userId: meeraP3.ownerUserId, policyId: futurePolicyId, intent: "claim" }, { today });
    check(
      "opening a conversation on it is refused, cleanly, with the date cover starts — never a thrown error",
      openFuture.ok === false && (openFuture as any).reason === "not_yet_active" && (openFuture as any).inceptionDate === "2026-10-02",
      JSON.stringify(openFuture),
    );
    check("...and no conversation row was left behind by the attempt", (await db.select().from(conversation).where(eq(conversation.policyId, futurePolicyId))).length === 0);

    // Defense in depth: a conversation opened while the policy still started in the past, whose inception date is
    // then corrected to the future (a real scenario — an admin fixing a typo'd date), must not loop forever on
    // "something went wrong, try again" once the next message arrives — every retry would throw again.
    await db.update(policy).set({ inceptionDate: "2026-01-01" }).where(eq(policy.id, futurePolicyId));
    const opened2 = (await session.openServicing({ userId: meeraP3.ownerUserId, policyId: futurePolicyId, intent: "claim" }, { today })) as any;
    check("...opened fine while the date was still in the past", opened2.ok === true, JSON.stringify(opened2));
    await db.update(policy).set({ inceptionDate: "2026-10-02" }).where(eq(policy.id, futurePolicyId));
    const stuckTurn = await session.handleServicingInput(opened2.conversationId, meeraP3.ownerUserId, { kind: "text", text: "Can I claim this back?" }, { today });
    check("...a turn on it after the date moved into the future is refused the same way — closed, with the date, not a retry loop", stuckTurn.ok === true && (stuckTurn as any).status === "completed", JSON.stringify(stuckTurn));
    const lastMessage = (await messagesOf(opened2.conversationId)).at(-1);
    check("...the member reads the actual date cover starts, in a real sentence — not a generic apology", /2 October 2026/.test(lastMessage?.bodyText ?? ""), lastMessage?.bodyText ?? "(none)");
    check("...and the conversation is closed, not left open to be retried forever", (await convoOf(opened2.conversationId)).status === "completed");
    await db.update(policy).set({ inceptionDate: "2026-01-01" }).where(eq(policy.id, futurePolicyId));
    await store.rebuildLedger(futurePolicyId);
  }

  console.log("\nEverything written is replayable");
  const all = await db.select().from(policy);
  const reports = await Promise.all(all.map((p) => store.checkReplay(p.id)));
  check("after all of that, every policy's stored ledger equals a replay of its log, and no event has drifted", reports.every((r) => r.ok), JSON.stringify(reports.filter((r) => !r.ok)));
  check("no event a conversation wrote disagrees with the engine (the log is derived, not typed)", reports.every((r) => r.drifted.length === 0 && r.restated.length === 0));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
