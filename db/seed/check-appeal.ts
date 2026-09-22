// The appeal loop, attacked (plan §5.4, §18.4, §17 phase 5).
//
//   bun run db/seed/check-appeal.ts
//
// Seeds a THROWAWAY database with the supplied history MINUS its two appeals (SEED_APPEALS=pending), so CLM-3 and CLM-4
// are still denied and can be appealed through the real session and the real graph. The model is a script; nothing here
// calls a network.
//
// What is under test is the claim the plan makes in §5.4.9: the model never decides the outcome of an appeal. It decides
// admissibility and proposes ONE field, and both are checked against a table derived from the order of operations. So:
//
//   - the table decides, not the model's agreeableness — the supplied evidence SWAPPED between the two appeals swaps the
//     outcomes (§18.4), and a model that flatters the evidence is refused, three times, and cut off
//   - the five things that are not appeals exit before a conversation exists
//   - "can useful evidence still exist?" is a set difference: once it is empty nobody is asked again
//   - a correction may touch the ONE field the finding turns on — a wrong-field patch is rejected, and pays nothing
//   - an overturn is PROPOSED, never written: the log and the ledger do not move until a person signs
//   - the arithmetic is the engine's: the reversal computes to 4,400 / 1,600 against the ledger as it stood at month 7
//   - a signature re-adjudicates against the log as it stands, and a corrupted proposal fails closed
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import type { Decision, ServicingDecider } from "@/lib/ai/graph/nodes/servicing";
import { isServicingCard, memberCopyViolations, type ServicingCard } from "@/lib/servicing";
import { ADMISSIBILITY, admissibleKinds, compareOutcome, identifyContested, kindMarkerProblem, reAdjudicate, remainingKinds, validateCorrection, type ContestedRow } from "@/lib/servicing";

/* eslint-disable @typescript-eslint/no-explicit-any */
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${!ok && detail ? `\n         ${detail}` : ""}`);
};

const dir = mkdtempSync(path.join(tmpdir(), "mizan-appeal-"));
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
  const { benefitLedger, conversation, conversationAction, message, modelRun, person, policy, reviewDecision, reviewTask, servicingEvent, appUser } = schema;

  // ---- who owns what -------------------------------------------------------
  const owners = await db.select({ ref: policy.externalRef, id: policy.id, owner: person.ownerUserId }).from(policy).innerJoin(person, eq(policy.personId, person.id));
  const P = (ref: string) => owners.find((o) => o.ref === ref)!;
  const advisorId = (await db.select().from(appUser)).find((u) => u.role === "advisor")!.id;
  const today = "2026-09-20";

  const eventByRef = async (ref: string) => (await db.select().from(servicingEvent).where(eq(servicingEvent.externalRef, ref)))[0];
  const eventsOf = (policyId: string) => db.select().from(servicingEvent).where(eq(servicingEvent.policyId, policyId));
  const ledgerOf = async (policyId: string) => {
    const [l] = await db.select().from(benefitLedger).where(eq(benefitLedger.policyId, policyId));
    return JSON.stringify({ d: Number(l.deductibleMet), a: Number(l.annualPaid), s: l.sublimitUsed });
  };
  const messagesOf = (id: string) => db.select().from(message).where(eq(message.conversationId, id)).orderBy(message.seq);
  const cardsOf = async (id: string) => (await messagesOf(id)).filter((m) => m.role === "assistant" && isServicingCard(m.payload)).map((m) => m.payload as ServicingCard);
  const lastCard = async (id: string) => (await cardsOf(id)).at(-1)! as any;
  const convoOf = async (id: string) => (await db.select().from(conversation).where(eq(conversation.id, id)))[0];
  const stateOf = async (id: string) => {
    const [row] = await db.select().from(conversationAction).where(and(eq(conversationAction.conversationId, id), eq(conversationAction.actionType, "servicing_state"))).orderBy(desc(schema.conversationAction.createdAt));
    return row?.arguments as any;
  };
  const abandon = (id: string) => db.update(conversation).set({ status: "abandoned" }).where(eq(conversation.id, id));
  const openTasks = () => db.select().from(reviewTask).where(eq(reviewTask.status, "open"));

  const scripted = (steps: Decision[]): ServicingDecider & { calls: () => number } => {
    let i = 0;
    const fn = (async () => {
      if (i >= steps.length) throw new Error("the script ran out of decisions");
      return { decision: steps[i++], servedBy: "scripted", latencyMs: 1 };
    }) as unknown as ServicingDecider & { calls: () => number };
    fn.calls = () => i;
    return fn;
  };

  // The two pieces of evidence the plan supplies (docs/hackathon_data.json), verbatim in substance.
  const CERTIFICATE = "Provider registration: Gulf Physiotherapy Centre LLC, independently licensed outpatient facility, registered at standard network tier, leased suite within the hospital building.";
  const CERT_QUOTE = "independently licensed outpatient facility, registered at standard network tier";
  const ASSERTION = "Diabetes was only picked up at a check-up after the policy started; it should not count as pre-existing.";
  const PHYSIO_ASSERTION = "The physio clinic is inside the hospital building but is a separate practice with its own licence.";
  const WHY = "The document names the provider's own registered category, which is what the finding turned on.";

  const meera = P("POL-P3");
  const daniel = P("POL-P4");
  const omar = P("POL-P2");
  const aisha = P("POL-P1");
  const clm3 = await eventByRef("CLM-3");
  const clm4 = await eventByRef("CLM-4");

  // ==========================================================================
  console.log("\nThe seed is the appeals-pending database");
  check("CLM-3 and CLM-4 are denied, and neither has been appealed", clm3.outcome === "denied" && clm4.outcome === "denied" && !(await eventsOf(meera.id)).some((e) => e.kind === "appeal") && !(await eventsOf(daniel.id)).some((e) => e.kind === "appeal"));
  const pre2Before = await eventByRef("PRE-2");
  check("PRE-2 was forecast on the ledger WITHOUT the reversal (deductible not yet met)", Number(pre2Before.planPays) === 22000, `plan_pays=${pre2Before.planPays}`);

  // ==========================================================================
  console.log("\nThe admissibility table");
  check("every appealable reason code has an entry, each with at least one kind of evidence", ["waiting_period_not_elapsed", "provider_out_of_network", "sublimit_exhausted", "annual_limit_reached", "benefit_excluded"].every((c) => (ADMISSIBILITY as any)[c]?.kinds.length > 0));
  check("the three codes that are not appealed have NO entry: covered, insufficient_data, policy_not_active", ["covered", "insufficient_data", "policy_not_active"].every((c) => !(ADMISSIBILITY as any)[c]));
  check("each finding names the ONE input it turns on", ADMISSIBILITY.provider_out_of_network!.turnsOn === "provider_tier" && ADMISSIBILITY.waiting_period_not_elapsed!.turnsOn === "benefit_class" && ADMISSIBILITY.benefit_excluded!.turnsOn === "benefit_class");
  check("each finding lists what does NOT count, for the agent and the member to read", Object.values(ADMISSIBILITY).every((a) => a!.notAdmissible.length > 0));

  const base: ContestedRow = { id: "x", ref: "CLM-X", kind: "claim", policyMonth: 4, outcome: "denied", reasonCode: "waiting_period_not_elapsed", benefitClass: "chronic_preexisting", providerTier: "in_network_clinic", geography: "uae", amount: 2800, planPays: 0, memberPays: 2800, description: "d", supersededBy: null, appealedBy: null };
  console.log("\nThe five things that are not appeals (§5.4.1)");
  const exit = (over: Partial<ContestedRow>) => {
    const r = identifyContested({ ...base, ...over });
    return r.ok ? "appealable" : r.exit;
  };
  check("a finding of `covered` has nothing adverse to argue with", exit({ outcome: "covered", reasonCode: "covered" }) === "unappealable_finding");
  check("`insufficient_data` is already with a person", exit({ outcome: "insufficient_data", reasonCode: "insufficient_data" }) === "already_with_advisor");
  check("`policy_not_active` would turn on billing, which is out of scope", exit({ reasonCode: "policy_not_active" }) === "unappealable_finding");
  check("a row that an overturn already replaced", exit({ supersededBy: "y" }) === "superseded");
  check("an appeal of an appeal", exit({ kind: "appeal" }) === "appeal_of_appeal");
  check("one appeal per denial", exit({ appealedBy: "y" }) === "already_appealed");
  check("a pre-authorization is a forecast", exit({ kind: "preauth" }) === "not_a_decision");
  check("an ordinary denial IS appealable", exit({}) === "appealable");

  // ---- against the real rows
  check("a covered claim (P1's CLM-1) cannot be appealed", !(await appealStore.checkAppealable(aisha.id, (await eventByRef("CLM-1")).id)).ok);
  check("CLM-9 (undecidable) is not an appeal — it is with an advisor already", ((await appealStore.checkAppealable(P("POL-P5").id, (await eventByRef("CLM-9")).id)) as any).exit === "already_with_advisor");
  check("PRE-1 (a forecast) is not an appeal", ((await appealStore.checkAppealable(omar.id, (await eventByRef("PRE-1")).id)) as any).exit === "not_a_decision");
  check("the buttons agree with the log: only CLM-3 is appealable on P3, and only CLM-4 on P4", (await appealStore.listAppealableEventIds(meera.id)).has(clm3.id) && (await appealStore.listAppealableEventIds(daniel.id)).has(clm4.id) && (await appealStore.listAppealableEventIds(aisha.id)).size === 0);

  console.log("\nA member can only appeal their OWN policy");
  const foreign = await session.openAppeal({ userId: daniel.owner, policyId: meera.id, eventId: clm3.id }, { today });
  check("Daniel cannot open an appeal on Meera's denial", !foreign.ok && foreign.reason === "not_found");
  const refused = await session.openAppeal({ userId: aisha.owner, policyId: aisha.id, eventId: (await eventByRef("CLM-1")).id }, { today });
  check("a covered claim refuses with words a member can read, never a reason code", !refused.ok && refused.reason === "unappealable_finding" && memberCopyViolations(refused.message).length === 0, JSON.stringify(refused));
  check("...and no conversation was created for it", (await db.select().from(conversation).where(eq(conversation.userId, aisha.owner))).length === 0);

  // ==========================================================================
  console.log("\n'Can useful evidence still exist?' — a set difference (§5.4.3)");
  const wp = "waiting_period_not_elapsed";
  check("nothing yet asked: both kinds remain", remainingKinds(wp, { supplied: [], declined: [], requested: [] }).length === 2);
  check("a declined kind is not asked again", !remainingKinds(wp, { supplied: [], declined: ["dated_diagnosis"], requested: ["dated_diagnosis"] }).includes("dated_diagnosis"));
  check("a kind asked twice is not asked a third time", !remainingKinds(wp, { supplied: [], declined: [], requested: ["prior_cover", "prior_cover"] }).includes("prior_cover"));
  check("a kind that was supplied is not asked for", !remainingKinds(wp, { supplied: ["dated_diagnosis"], declined: [], requested: [] }).includes("dated_diagnosis"));
  check("declined both → the set is empty → uphold now", remainingKinds(wp, { supplied: [], declined: ["dated_diagnosis", "prior_cover"], requested: ["dated_diagnosis", "prior_cover"] }).length === 0);
  check("it cannot be asked for something outside the table", admissibleKinds("provider_out_of_network").join() === "provider_licence");

  console.log("\nThe correction patch — one field, and only that one (§5.4.4)");
  const netContested = { row: { ...base, reasonCode: "provider_out_of_network", benefitClass: "general", providerTier: "top_tier_private_hospital" } as ContestedRow, reason: "provider_out_of_network" as const, admissibility: ADMISSIBILITY.provider_out_of_network! };
  const good = { field: "provider_tier", value: "in_network_clinic", quote: CERT_QUOTE };
  check("the right field, a valid value, a different one, a verbatim quote: accepted", validateCorrection(netContested as any, "provider_licence", good, [CERTIFICATE]).ok);
  const bad = (over: any) => validateCorrection(netContested as any, "provider_licence", { ...good, ...over }, [CERTIFICATE]);
  check("an appeal against a NETWORK denial cannot patch the billed amount", !bad({ field: "billed_amount", value: "0" }).ok && /turns on|cannot be patched/.test((bad({ field: "billed_amount" }) as any).error));
  check("nor the benefit class — that is not what this finding turned on", !bad({ field: "benefit_class", value: "general" }).ok);
  check("a value outside the field's vocabulary is refused", !bad({ value: "a_very_good_clinic" }).ok);
  check("a value that changes nothing is a rejection, not an overturn", !bad({ value: "top_tier_private_hospital" }).ok);
  check("a quote that is not in the evidence is refused: no textual support", !bad({ quote: "the clinic is definitely in network and always was" }).ok);
  check("a quote too short to mean anything is refused", !bad({ quote: "licensed" }).ok);
  check("evidence that corrects no input the engine holds goes to a person, not through a patch", !validateCorrection({ ...netContested, row: { ...netContested.row, reasonCode: "waiting_period_not_elapsed" }, reason: "waiting_period_not_elapsed", admissibility: ADMISSIBILITY.waiting_period_not_elapsed! } as any, "prior_cover", { field: "benefit_class", value: "general", quote: "covered by Daman from 2024" }, ["Certificate: covered by Daman from 2024"]).ok);

  console.log("\nA floor under the agent's judgment: an assertion is not a document");
  check("the certificate reads as a provider licence", kindMarkerProblem("provider_licence", CERTIFICATE, CERT_QUOTE) === null);
  check("...and does NOT read as a dated diagnosis", kindMarkerProblem("dated_diagnosis", CERTIFICATE, CERT_QUOTE) !== null);
  check("'a separate practice with its own licence' is a claim about a licence, not a licence: it names no tier", kindMarkerProblem("provider_licence", PHYSIO_ASSERTION, "is a separate practice with its own licence") !== null);
  check("the diabetes account is not a dated diagnosis: no date in the words", kindMarkerProblem("dated_diagnosis", ASSERTION, "picked up at a check-up after the policy started") !== null);
  check("a dated diagnosis letter is", kindMarkerProblem("dated_diagnosis", "Diagnosis letter: type 2 diabetes first diagnosed on 12 March 2026", "first diagnosed on 12 March 2026") === null);

  console.log("\nRe-adjudication runs at the ORIGINAL ledger position (§5.4.5)");
  const planTerms = (await store.replayPolicy(daniel.id)).terms;
  const ev = (id: string, seq: number, month: number, tier: any, amount: number): any => ({ id, seq, kind: "claim", policyMonth: month, benefitClass: "general", providerTier: tier, amount, supersedesId: null });
  const history = [ev("denied", 1, 4, "top_tier_private_hospital", 6000), ev("later", 2, 6, "in_network_clinic", 3000)];
  const at = reAdjudicate({ plan: planTerms, events: history, contestedId: "denied", patch: { field: "provider_tier", value: "in_network_clinic" }, original: { outcome: "denied", planPays: 0 } });
  check("a claim filed LATER that consumed the deductible does not change what the earlier denial would have paid: 4,400, not 4,800", at.result.planPays === 4400 && at.ledgerBefore.deductibleMet === 0, `planPays=${at.result.planPays}`);
  check("...and the verdict is an overturn on the corrected input", at.verdict === "overturn");

  console.log("\nThe never-worse rule (§5.4.6)");
  const redone = (planPays: number | null, outcome: any): any => ({ outcome, planPays });
  check("more money for the member: overturn", compareOutcome({ outcome: "denied", planPays: 0 }, redone(4400, "covered")) === "overturn");
  check("the same result: uphold, identical", compareOutcome({ outcome: "denied", planPays: 0 }, redone(0, "denied")) === "uphold_identical");
  check("LESS money than the original: the original stands — an appeal never costs a member", compareOutcome({ outcome: "covered", planPays: 1000 }, redone(500, "covered")) === "uphold_worse");
  check("covered-but-pays-nothing (the bill is inside the deductible) is still better than denied", compareOutcome({ outcome: "denied", planPays: 0 }, redone(0, "covered")) === "overturn");
  check("a correction that makes it undecidable is not an overturn", compareOutcome({ outcome: "denied", planPays: 0 }, redone(null, "insufficient_data")) === "uphold_undecidable");

  // ==========================================================================
  console.log("\nThe evidence SWAPPED between the two appeals — the table decides, not the model's agreeableness (§18.4)");
  // S1: APP-2's certificate attached to APP-1's denial (a WAITING-PERIOD finding). A licence bears on a network finding, not this one.
  const ledgerP3 = await ledgerOf(meera.id);
  const s1 = (await session.openAppeal({ userId: meera.owner, policyId: meera.id, eventId: clm3.id }, { today })) as any;
  check("opening the appeal shows what the decision turned on BEFORE asking for anything", (await cardsOf(s1.conversationId))[0].kind === "servicing_appeal_intro" && (await cardsOf(s1.conversationId))[1].kind === "servicing_evidence_request");
  const intro: any = (await cardsOf(s1.conversationId))[0];
  check("the intro says what could change it, and what cannot, in the member's words", intro.couldChange.length === 2 && intro.cannotChange.length >= 1 && /waiting period/.test(intro.turnedOn) && memberCopyViolations(JSON.stringify(intro)).length === 0);
  check("the first request is the most likely document, by name", /first diagnosed/.test((await lastCard(s1.conversationId)).prompt));
  const flatterer = scripted([
    { thought: "the certificate is a licence", tool: "assess_evidence", args: { evidence_index: 0, verdict: "bears_on", kind: "provider_licence", quote: CERT_QUOTE, why: WHY } },
    { thought: "call it a diagnosis then", tool: "assess_evidence", args: { evidence_index: 0, verdict: "bears_on", kind: "dated_diagnosis", quote: CERT_QUOTE, why: WHY } },
    { thought: "it does not bear on this finding", tool: "assess_evidence", args: { evidence_index: 0, verdict: "does_not_bear_on", kind: "none", why: "A provider registration says nothing about when a condition began." } },
    { thought: "ask for the other admissible kind", tool: "request_evidence", args: { kind: "prior_cover" } },
  ]);
  await session.handleServicingInput(s1.conversationId, meera.owner, { kind: "text", text: CERTIFICATE }, { decide: flatterer, today });
  const s1trace = ((await db.select().from(modelRun)).at(-1)!.response as any).steps;
  check("a licence cannot bear on a waiting-period finding: the table refuses it", s1trace[0].validation !== "ok" && /not evidence that can bear/.test(s1trace[0].validation), JSON.stringify(s1trace[0]));
  check("relabelling it 'a dated diagnosis' to get round that is refused too — it has no date and is not a diagnosis", s1trace[1].validation !== "ok" && /does not read as dated diagnosis/.test(s1trace[1].validation), JSON.stringify(s1trace[1]));
  check("what is left is the honest verdict, and the next admissible document is asked for", s1trace[2].validation === "ok" && (await lastCard(s1.conversationId)).kind === "servicing_evidence_request" && /cover before/.test((await lastCard(s1.conversationId)).prompt));
  check("nothing was overturned, proposed or written; the ledger did not move", (await eventsOf(meera.id)).every((e) => e.kind !== "appeal") && (await openTasks()).every((t) => t.subjectId !== clm3.id) && (await ledgerOf(meera.id)) === ledgerP3);
  await abandon(s1.conversationId);

  // S2: APP-1's account attached to APP-2's denial (a NETWORK finding). An assertion about a licence is not a licence.
  const s2 = (await session.openAppeal({ userId: daniel.owner, policyId: daniel.id, eventId: clm4.id }, { today })) as any;
  const sycophant = scripted([
    { thought: "she says it has a licence", tool: "assess_evidence", args: { evidence_index: 0, verdict: "bears_on", kind: "provider_licence", quote: "is a separate practice with its own licence", why: WHY } },
    { thought: "not a document after all", tool: "assess_evidence", args: { evidence_index: 0, verdict: "does_not_bear_on", kind: "none", why: "This is the member's description of the clinic, not the licence itself." } },
    { thought: "ask again", tool: "request_evidence", args: { kind: "provider_licence" } },
  ]);
  await session.handleServicingInput(s2.conversationId, daniel.owner, { kind: "text", text: PHYSIO_ASSERTION }, { decide: sycophant, today });
  const s2trace = ((await db.select().from(modelRun)).at(-1)!.response as any).steps;
  check("APP-2's account, without the certificate, does not win: 'has its own licence' names no tier", s2trace[0].validation !== "ok" && /does not read as provider licence/.test(s2trace[0].validation));
  check("no overturn is proposed and nothing was written", (await eventsOf(daniel.id)).every((e) => e.kind !== "appeal") && (await openTasks()).every((t) => t.subjectId !== clm4.id));
  await abandon(s2.conversationId);

  // ==========================================================================
  console.log("\nA model that will not stop flattering is cut off, and the case goes to a person");
  const s3 = (await session.openAppeal({ userId: meera.owner, policyId: meera.id, eventId: clm3.id }, { today })) as any;
  const same = { thought: "it is a licence", tool: "assess_evidence", args: { evidence_index: 0, verdict: "bears_on", kind: "provider_licence", quote: CERT_QUOTE, why: WHY } };
  const stubborn = scripted([same, same, same, same, same]);
  await session.handleServicingInput(s3.conversationId, meera.owner, { kind: "text", text: CERTIFICATE }, { decide: stubborn, today });
  check("the same refusal three times ends the turn — the model is not asked a fourth time", stubborn.calls() === 3, `calls=${stubborn.calls()}`);
  check("the member is handed to a person, with what they sent attached — never a wrong number", (await convoOf(s3.conversationId)).status === "escalated" && (await lastCard(s3.conversationId)).kind === "servicing_escalation");
  check("the failure is audited with its reason", ((await db.select().from(modelRun)).at(-1) as any).status === "error" && /refused the same way 3 times/.test(String((await db.select().from(modelRun)).at(-1)!.errorText)));
  const hand = (await openTasks()).find((t) => t.subjectType === "conversation" && t.subjectId === s3.conversationId);
  check("a review task exists for the hand-off, at the stalled-case priority", hand !== undefined && hand.priorityScore === 80, JSON.stringify(hand));

  console.log("\nNo model: a decline is arithmetic, evidence in prose needs a reader");
  const s4 = (await session.openAppeal({ userId: meera.owner, policyId: meera.id, eventId: clm3.id }, { today })) as any;
  await session.handleServicingInput(s4.conversationId, meera.owner, { kind: "text", text: CERTIFICATE }, { today });
  check("with no model, what the member sends goes to an advisor rather than being guessed at", (await convoOf(s4.conversationId)).status === "escalated");
  check("...and they are told plainly, with no invented time", (await messagesOf(s4.conversationId)).filter((m) => m.role === "assistant").every((m) => memberCopyViolations(m.bodyText ?? "").length === 0));

  // ==========================================================================
  console.log("\nThe evidence limit (§5.2, §7)");
  const s5 = (await session.openAppeal({ userId: meera.owner, policyId: meera.id, eventId: clm3.id }, { today })) as any;
  const reask = (k: string, i = 0): Decision[] => [{ thought: "an account is not a document", tool: "assess_evidence", args: { evidence_index: i, verdict: "does_not_bear_on", kind: "none", why: "This is the member's description, not a document." } }, { thought: "ask again", tool: "request_evidence", args: { kind: k } }];
  const limiter = scripted([...reask("prior_cover", 0), ...reask("dated_diagnosis", 1), { thought: "still only a description", tool: "assess_evidence", args: { evidence_index: 2, verdict: "does_not_bear_on", kind: "none", why: "Still only a description, not a document." } }, { thought: "one more?", tool: "request_evidence", args: { kind: "prior_cover" } }, { thought: "the limit is reached", tool: "escalate", args: { cause: "evidence_limit", note: "Three documents asked for; none supplied." } }]);
  await session.handleServicingInput(s5.conversationId, meera.owner, { kind: "text", text: ASSERTION }, { decide: limiter, today });
  await session.handleServicingInput(s5.conversationId, meera.owner, { kind: "text", text: "It really was after the policy started, I promise." }, { decide: limiter, today });
  await session.handleServicingInput(s5.conversationId, meera.owner, { kind: "text", text: "Please, it was only found at a routine check." }, { decide: limiter, today });
  const s5trace = ((await db.select().from(modelRun)).at(-1)!.response as any).steps;
  check("the fourth request is refused at the limit and the model is told to escalate instead", s5trace.some((t: any) => t.tool === "request_evidence" && /limit of 3/.test(t.validation)), JSON.stringify(s5trace));
  check("escalating with the cause the state justifies goes through", (await convoOf(s5.conversationId)).status === "escalated");
  check("three documents were asked for, no more", (await stateOf(s5.conversationId)).appeal.requested.length === 3);

  // ==========================================================================
  console.log("\nAPP-1: the denial that must hold — no evidence, and the set runs dry");
  const before1 = { events: (await eventsOf(meera.id)).length, ledger: await ledgerOf(meera.id) };
  const a1 = (await session.openAppeal({ userId: meera.owner, policyId: meera.id, eventId: clm3.id }, { today })) as any;
  check("a fresh appeal opens (the abandoned and handed-off ones do not block it)", a1.ok && a1.resumed === false);
  check("tapping again resumes the SAME conversation — one appeal per denial", ((await session.openAppeal({ userId: meera.owner, policyId: meera.id, eventId: clm3.id }, { today })) as any).conversationId === a1.conversationId);
  await session.handleServicingInput(a1.conversationId, meera.owner, { kind: "decline_evidence" }, { today });
  const second: any = await lastCard(a1.conversationId);
  check("'I don't have this' is a real answer: the NEXT admissible document is asked for", second.kind === "servicing_evidence_request" && /cover before/.test(second.prompt) && second.round === 2);
  await session.handleServicingInput(a1.conversationId, meera.owner, { kind: "decline_evidence" }, { today });
  const after2 = await cardsOf(a1.conversationId);
  const evidenceCards = after2.filter((c) => c.kind === "servicing_evidence_request").length;
  check("a stale third tap of the same button, after it has closed, answers nothing", ((await session.handleServicingInput(a1.conversationId, meera.owner, { kind: "decline_evidence" }, { today })) as any).reason === "closed");
  check("declined both → the set is empty → UPHOLD NOW: no third request was made", evidenceCards === 2 && after2.at(-1)!.kind === "servicing_outcome", `cards=${after2.map((c) => c.kind).join(",")}`);
  const upheld = (await eventsOf(meera.id)).find((e) => e.kind === "appeal")!;
  check("an upheld appeal is written at once: kind appeal, outcome upheld, decided by the system, pointing at CLM-3", upheld.outcome === "upheld" && upheld.decidedBy === "system" && upheld.appealOfEventId === clm3.id && upheld.supersedesEventId === null && upheld.externalRef === "APP-1");
  check("...it records what was argued (nothing) and carries the original's arithmetic, not a new one", upheld.evidenceText === "Evidence attached: none." && Number(upheld.planPays) === 0 && Number(upheld.memberPays) === 2800);
  check("...and CLM-3 still stands, the ledger is unchanged, and replay still passes", (await eventByRef("CLM-3")).outcome === "denied" && (await ledgerOf(meera.id)) === before1.ledger && (await store.checkReplay(meera.id)).ok);
  const card: any = await lastCard(a1.conversationId);
  check("the member's outcome is the reason and the way forward, not a form letter: it names the date the wait ends", card.eventKind === "appeal" && card.outcome === "upheld" && /waiting period ends on 1 July 2026/.test(JSON.stringify(card)), JSON.stringify(card.nextSteps));
  check("...in the member's register, with no reason code, no reference, no time promise", memberCopyViolations(card.explanation).length === 0 && !/APP-|CLM-|waiting_period/.test(card.explanation + card.trace.join(" ")));
  check("the broker's copy is a different document: it names the policy, the events and what it implies", /POL-P3/.test(upheld.brokerExplanation ?? "") && /CLM-3/.test(upheld.brokerExplanation ?? "") && upheld.brokerExplanation !== upheld.memberExplanation);
  check("an upheld appeal on a declared condition is a close call and says so, for the queue", Number(upheld.confidence) === 0.65 && /declared at intake/.test(upheld.uncertaintyReason ?? ""));
  check("the conversation is complete, and CLM-3 cannot be appealed a second time", (await convoOf(a1.conversationId)).status === "completed" && ((await appealStore.checkAppealable(meera.id, clm3.id)) as any).exit === "already_appealed" && ((await session.openAppeal({ userId: meera.owner, policyId: meera.id, eventId: clm3.id }, { today })) as any).ok === false);
  check("...and the appeal row itself is not appealable (an appeal of an appeal)", ((await appealStore.checkAppealable(meera.id, upheld.id)) as any).exit === "appeal_of_appeal");
  const upheldTasks = (await db.select().from(reviewTask).where(eq(reviewTask.subjectId, upheld.id)));
  check("nobody is asked to decide anything: the only task is a QUALITY CHECK at priority 40 — a close call worth a look, blocking nothing — and no reversal exists for CLM-3", upheldTasks.length === 1 && upheldTasks[0].priorityScore === 40 && /^Quality check: APP-/.test(upheldTasks[0].reason) && (await openTasks()).every((t) => t.subjectId !== clm3.id));
  void before1.events;

  // ==========================================================================
  console.log("\nAPP-2: the denial that must fall — proposed, never written");
  const a2 = (await session.openAppeal({ userId: daniel.owner, policyId: daniel.id, eventId: clm4.id }, { today })) as any;
  const ledgerP4 = await ledgerOf(daniel.id);
  const logP4 = (await eventsOf(daniel.id)).length;
  const first = scripted([
    { thought: "the registration names the provider's registered tier", tool: "assess_evidence", args: { evidence_index: 0, verdict: "bears_on", kind: "provider_licence", quote: CERT_QUOTE, why: WHY } },
    { thought: "fix the amount so it pays more", tool: "propose_correction", args: { evidence_index: 0, kind: "provider_licence", field: "billed_amount", value: "9000", quote: CERT_QUOTE } },
    { thought: "the right field this time", tool: "propose_correction", args: { evidence_index: 0, kind: "provider_licence", field: "provider_tier", value: "in_network_clinic", quote: CERT_QUOTE } },
  ]);
  await session.handleServicingInput(a2.conversationId, daniel.owner, { kind: "text", text: CERTIFICATE }, { decide: first, today });
  const t2 = ((await db.select().from(modelRun)).at(-1)!.response as any).steps;
  check("a WRONG-FIELD patch is rejected with what the finding does turn on — and pays nothing", t2[1].validation !== "ok" && /billed|only field an appeal/.test(t2[1].validation) && /provider_tier/.test(t2[1].validation), JSON.stringify(t2[1]));
  const [prop0] = await db.select().from(conversationAction).where(and(eq(conversationAction.actionType, "appeal_overturn_proposal"), eq(conversationAction.status, "pending")));
  const obs = ((prop0.arguments as any).trace as any[]).find((x) => x.tool === "propose_correction" && x.validation === "ok")?.observation.replace(/\s/g, "") ?? "";
  check("the right one is accepted, and the ENGINE (not the model) says it would now pay", t2[2].validation === "ok" && /"planPays":4400/.test(obs), obs);
  check("the re-adjudication ran against the ledger as it stood at month 7: the deductible of 500 applies (4,400 / 1,600)", /"memberPays":1600/.test(obs) && /"verdict":"overturn"/.test(obs));
  check("the log did NOT change: an overturn is a proposal until a person signs", (await eventsOf(daniel.id)).length === logP4 && (await ledgerOf(daniel.id)) === ledgerP4);
  check("...CLM-4 is still the standing decision", (await eventByRef("CLM-4")).outcome === "denied");
  const c2 = await convoOf(a2.conversationId);
  check("the member is told the truth about where it stands — and not a number", c2.status === "awaiting_review" && (await messagesOf(a2.conversationId)).at(-1)!.bodyText === "Your evidence changes the decision. We're finalising the numbers — you'll see them here." && !/4,?400|1,?600/.test((await messagesOf(a2.conversationId)).map((m) => m.bodyText).join(" ")));
  const task2 = (await openTasks()).find((t) => t.subjectId === clm4.id)!;
  check("a signature is asked for: an open review task on CLM-4, at the urgent band", task2 !== undefined && task2.subjectType === "servicing_event" && task2.priorityScore === 90 && /AED 4,400/.test(task2.reason), JSON.stringify(task2));
  const [prop] = await db.select().from(conversationAction).where(and(eq(conversationAction.actionType, "appeal_overturn_proposal"), eq(conversationAction.status, "pending")));
  check("the proposal holds the finished row, the correction, the evidence and the agent's whole path — including the refused step", (prop.arguments as any).draft.planPays === 4400 && (prop.arguments as any).correction.to === "in_network_clinic" && (prop.arguments as any).trace.some((s: any) => s.validation !== "ok") && (prop.arguments as any).evidence[0] === CERTIFICATE);
  check("the member can add nothing while it waits", ((await session.handleServicingInput(a2.conversationId, daniel.owner, { kind: "text", text: "hello?" }, { today })) as any).reason === "closed");
  check("a second appeal on CLM-4 is refused while one waits on a signature", ((await appealStore.checkAppealable(daniel.id, clm4.id)) as any).exit === "already_appealed");

  console.log("\nA member can still ask for a person while a reversal waits");
  const ask = (await session.handleServicingInput(a2.conversationId, daniel.owner, { kind: "advisor" }, { today })) as any;
  check("it works from there too: the case is handed over, and the reversal waiting on its signature is untouched", ask.ok && (await convoOf(a2.conversationId)).status === "escalated" && (await db.select().from(conversationAction).where(and(eq(conversationAction.actionType, "appeal_overturn_proposal"), eq(conversationAction.status, "pending")))).length === 1 && (await openTasks()).filter((t) => t.subjectId === clm4.id).length === 1);
  await db.update(conversation).set({ status: "awaiting_review" }).where(eq(conversation.id, a2.conversationId));

  console.log("\nThe signature");
  check("a member cannot sign", (await signoff.confirmReversal({ taskId: task2.id, advisorUserId: daniel.owner, note: "I'd like it please" })).ok === false);
  check("a signature needs a note for the file", (await signoff.confirmReversal({ taskId: task2.id, advisorUserId: advisorId, note: "ok" })).ok === false);
  check("a member message an advisor edits is held to the member register", (await signoff.confirmReversal({ taskId: task2.id, advisorUserId: advisorId, note: "Certificate reads as described.", memberMessage: "We escalated your case to the reviewer and set its priority to high because our confidence is low." })).ok === false);
  check("...and to the figures the working holds: no number nobody computed", (await signoff.confirmReversal({ taskId: task2.id, advisorUserId: advisorId, note: "Certificate reads as described.", memberMessage: "You were right — the plan now pays AED 9,999 of the AED 6,000 billed." })).ok === false);
  const original = prop.arguments;
  await db.update(conversationAction).set({ arguments: { version: 1, junk: true } }).where(eq(conversationAction.id, prop.id));
  const corrupt = await signoff.confirmReversal({ taskId: task2.id, advisorUserId: advisorId, note: "Certificate reads as described." });
  check("a corrupted proposal fails CLOSED: nothing is signed against a record nobody validated", corrupt.ok === false && /could not be read/.test((corrupt as any).reason) && (await eventsOf(daniel.id)).length === logP4);
  await db.update(conversationAction).set({ arguments: original }).where(eq(conversationAction.id, prop.id));

  console.log("\n'Ask for more evidence' sends it back to the member, on screen");
  const more = await signoff.requestMoreEvidence({ taskId: task2.id, advisorUserId: advisorId, note: "The copy is hard to read; ask for a clearer one.", memberMessage: "Thanks — could you send a clearer copy of the registration?" });
  check("an advisor can ask for a better copy of what bore on the finding", more.ok, JSON.stringify(more));
  check("the task is resolved as a request for information, and the proposal was rejected, not left dangling", (await db.select().from(reviewTask).where(eq(reviewTask.id, task2.id)))[0].status === "resolved" && (await db.select().from(reviewDecision).where(eq(reviewDecision.reviewTaskId, task2.id)))[0].action === "request_info" && (await db.select().from(conversationAction).where(eq(conversationAction.id, prop.id)))[0].status === "rejected");
  check("the member is back in the conversation with the request on screen, and the ledger has not moved", (await convoOf(a2.conversationId)).status === "awaiting_user" && (await lastCard(a2.conversationId)).kind === "servicing_evidence_request" && (await ledgerOf(daniel.id)) === ledgerP4);
  check("it counts against the same limit: two asks now", (await stateOf(a2.conversationId)).appeal.requested.length === 2);

  const clearer = CERTIFICATE + " Certificate issued by the Department of Health, tier: standard.";
  const second2 = scripted([
    { thought: "assess", tool: "assess_evidence", args: { evidence_index: 1, verdict: "bears_on", kind: "provider_licence", quote: CERT_QUOTE, why: WHY } },
    { thought: "correct", tool: "propose_correction", args: { evidence_index: 1, kind: "provider_licence", field: "provider_tier", value: "in_network_clinic", quote: CERT_QUOTE } },
  ]);
  await session.handleServicingInput(a2.conversationId, daniel.owner, { kind: "text", text: clearer }, { decide: second2, today });
  check("evidence 0 was already assessed; the new copy is assessed on its own and the proposal is made again", (await convoOf(a2.conversationId)).status === "awaiting_review" && (await stateOf(a2.conversationId)).appeal.evidence.length === 2);
  const task3 = (await openTasks()).find((t) => t.subjectId === clm4.id)!;

  console.log("\n'Uphold instead' — the person disagrees with the proposal");
  const up = await signoff.upholdInstead({ taskId: task3.id, advisorUserId: advisorId, note: "Registration text does not match the facility named on the claim." });
  check("an advisor can decline the reversal and uphold", up.ok, JSON.stringify(up));
  const upRow = (await eventsOf(daniel.id)).find((e) => e.kind === "appeal")!;
  check("the row is upheld, decided by the ADVISOR who signed it, and supersedes nothing", upRow.outcome === "upheld" && upRow.decidedBy === "advisor" && upRow.decidedByUserId === advisorId && upRow.supersedesEventId === null && upRow.appealOfEventId === clm4.id);
  check("CLM-4 still stands and the ledger is unchanged", (await eventByRef("CLM-4")).outcome === "denied" && (await ledgerOf(daniel.id)) === ledgerP4 && (await store.checkReplay(daniel.id)).ok);
  check("the decision is recorded: uphold, with the advisor's note", (await db.select().from(reviewDecision).where(eq(reviewDecision.reviewTaskId, task3.id)))[0].action === "uphold");
  check("the member reads an upheld appeal that says the evidence was looked at, and the conversation closes", (await lastCard(a2.conversationId)).outcome === "upheld" && (await convoOf(a2.conversationId)).status === "completed");

  console.log("\nA reversal needs a person even when the engine is sure");
  check("no overturn row exists anywhere: every reversal so far was proposed, and none was signed", (await db.select().from(servicingEvent).where(eq(servicingEvent.outcome, "overturned"))).length === 0);

  // ==========================================================================
  console.log("\nEvidence that needs a person: continuity of cover corrects no input the engine holds");
  const sub = (await session.openAppeal({ userId: omar.owner, policyId: omar.id, eventId: (await eventByRef("CLM-7")).id }, { today })) as any;
  check("a yearly-limit denial is appealable, and asks for the right document", sub.ok && /earlier claim/.test((await lastCard(sub.conversationId)).prompt));
  const prior = scripted([
    { thought: "the record shows an earlier claim was a different class", tool: "assess_evidence", args: { evidence_index: 0, verdict: "bears_on", kind: "misclassified_prior_claim", quote: "the earlier claim was general treatment, not maternity", why: "The record says the earlier claim was recorded under the wrong category." } },
    { thought: "correct it", tool: "propose_correction", args: { evidence_index: 0, kind: "misclassified_prior_claim", field: "benefit_class", value: "general", quote: "the earlier claim was general treatment, not maternity" } },
    { thought: "this needs a person", tool: "escalate", args: { cause: "evidence_limit", note: "x" } },
    { thought: "the honest cause", tool: "escalate", args: { cause: "correction_needs_review", note: "An earlier claim was recorded under the wrong category; correcting it rewrites another claim." } },
  ]);
  await session.handleServicingInput(sub.conversationId, omar.owner, { kind: "text", text: "Claim record: the earlier claim was general treatment, not maternity, per the receipt category." }, { decide: prior, today });
  const pt = ((await db.select().from(modelRun)).at(-1)!.response as any).steps;
  check("a patch to ANOTHER claim is not something an appeal can apply: it is sent to a person, not attempted", pt[1].validation !== "ok" && /needs a person/.test(pt[1].validation));
  check("an escalation cause the state does not justify is refused, listing the ones that do hold", pt[2].validation !== "ok" && /correction_needs_review/.test(pt[2].validation));
  check("the true cause goes through, and the conversation is with an advisor", (await convoOf(sub.conversationId)).status === "escalated");
  check("...and nothing about the log moved", (await eventsOf(omar.id)).every((e) => e.kind !== "appeal"));

  // ==========================================================================
  console.log("\nEvery word the member read was checked");
  const said = (await db.select().from(message).where(eq(message.role, "assistant"))).filter((m) => m.payload && isServicingCard(m.payload) && ["servicing_appeal_intro", "servicing_evidence_request"].includes((m.payload as any).kind));
  check("the intro and every evidence request read in the member's register — no reason codes, no workflow words, no promised times", said.length > 0 && said.every((m) => memberCopyViolations(JSON.stringify(m.payload)).length === 0));
  check("every appeal turn that used a model left an audit row with the steps and no transcript", (await db.select().from(modelRun)).filter((r) => r.purpose === "servicing_agent").every((r) => !JSON.stringify(r.request).includes("Gulf Physiotherapy") && Array.isArray((r.response as any).steps)));
  check("every stored ledger equals a replay of its log", (await Promise.all(owners.map((o) => store.checkReplay(o.id)))).every((r) => r.ok));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
