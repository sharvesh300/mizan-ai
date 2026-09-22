// The servicing tool registry and card contract, attacked (plan §4, §13.2.4).
//
//   bun run db/seed/check-servicing-tools.ts
//
// Two halves. First, the scripted conversations in scenarios.ts must reproduce the
// acceptance table THROUGH the tools — proof the registry, driven correctly, gets
// the same numbers as the engine. Then the harder half: every rule the registry
// claims to enforce is tested by breaking it. A rule with no failing test is a
// comment, and this registry is made of rules.
//
// No model, no database, no server.
import { adjudicate } from "@/lib/servicing";
import { runServicingTool, describeServicingTools, TOOL_NAMES, type ServicingToolContext } from "@/lib/ai/tools/servicing";
import {
  ESCALATION_CAUSES,
  isConfirmCard,
  isConflictCard,
  isEscalationCard,
  isEstimateCard,
  isAppealIntroCard,
  isEvidenceRequestCard,
  isFactsFormCard,
  isOutcomeCard,
  isQuestionCard,
  isServicingCard,
  INTERNAL_REF,
  isRealDate,
  memberCopyViolations,
  monthOfDate,
  numbersIn,
  type ServicingCard,
} from "@/lib/servicing";
import { EXPECTED } from "./acceptance";
import { allGalleryCards as galleryCards } from "./gallery";
import { SCENARIOS, factsFormFixture, runAll, runScenario, scenarioContext } from "./scenarios";

/* eslint-disable @typescript-eslint/no-explicit-any */
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${!ok && detail ? `\n         ${detail}` : ""}`);
};

type R = ReturnType<typeof runServicingTool>;
/** The call was refused, and the refusal says something an agent could correct from. */
const refused = (r: R, pattern: RegExp) => !r.ok && pattern.test(r.error);
const why = (r: R) => (r.ok ? "it was ACCEPTED" : `error was: ${r.error}`);

const spec = (id: string) => SCENARIOS.find((s) => s.spec.id === id)!;
const fresh = (id = "claim-clm6") => scenarioContext(spec(id).spec);
/** A conversation played up to, but not including, its final call. */
const upToLast = (id: string) => runScenario(spec(id).spec, spec(id).turns.slice(0, -1)).ctx;

const say = (ctx: ServicingToolContext, text: string) => void ctx.memberMessages.push(text);
const call = (ctx: ServicingToolContext, tool: string, args?: unknown) => runServicingTool(ctx, tool, args);
const fact = (ctx: ServicingToolContext, field_key: string, value: unknown, quote: string, basis = "stated") => call(ctx, "record_fact", { field_key, value, basis, quote });

// ---------------------------------------------------------------------------

console.log("\nScripted conversations reproduce the acceptance table — through the tools");
{
  const runs = runAll();
  for (const r of runs) {
    const bad = r.steps.filter((s) => !s.result.ok);
    check(`${r.spec.id}: all ${r.steps.length} tool calls accepted on the first try`, bad.length === 0, bad.map((b) => `${b.tool}: ${(b.result as any).error}`).join(" | "));
  }
  const by = (id: string) => runs.find((r) => r.spec.id === id)!;
  const outcome = (id: string, ref: string) => {
    const res = by(id).ctx.result!;
    const want = EXPECTED[ref];
    return res.outcome === want.outcome && res.planPays === want.planPays && res.memberPays === want.memberPays && res.reasonCode === want.reasonCode;
  };
  check("claim-clm6 → CLM-6: covered, plan 1,260, member 540", outcome("claim-clm6", "CLM-6"));
  check("reimbursement-clm6: the same arithmetic as a claim, and a reimbursement card", by("reimbursement-clm6").ctx.result!.planPays === 1260 && (by("reimbursement-clm6").cards.at(-1)!.card as any).eventKind === "reimbursement");
  check("estimate-pre1 → PRE-1: approved with a limit, 25,000 / 15,000, on an ESTIMATE card", outcome("estimate-pre1", "PRE-1") && isEstimateCard(by("estimate-pre1").cards.at(-1)!.card));
  check("denied-clm3 → CLM-3: denied on the waiting period, and the card is appealable with a dated next step", outcome("denied-clm3", "CLM-3") && (by("denied-clm3").cards.at(-1)!.card as any).appealable === true);
  {
    const card = by("denied-clm3").cards.at(-1)!.card as any;
    const everything = `${card.explanation} ${card.nextSteps.join(" ")}`;
    check("...and the date the member can act on is on the card exactly once — in the prose, never repeated as a bullet", (everything.match(/1 July 2026/g) ?? []).length === 1);
    check("...a denial has no settlement footer: the plan pays nothing, so there is nothing to settle", card.settlement === null);
  }
  check("undecidable-clm9 → CLM-9: insufficient_data, no amounts, ends in an escalation card", by("undecidable-clm9").ctx.result!.outcome === "insufficient_data" && by("undecidable-clm9").ctx.result!.planPays === null && isEscalationCard(by("undecidable-clm9").cards.at(-1)!.card));

  const direct = adjudicate(by("claim-clm6").ctx.result!.input);
  check("the tool's numbers ARE the engine's: adjudicate through the registry equals a direct call on the same input", JSON.stringify({ o: direct.outcome, p: direct.planPays, m: direct.memberPays, c: direct.calculation }) === JSON.stringify({ o: by("claim-clm6").ctx.result!.outcome, p: by("claim-clm6").ctx.result!.planPays, m: by("claim-clm6").ctx.result!.memberPays, c: by("claim-clm6").ctx.result!.calculation }));
  check("the deterministic template explanation passes every check the tool applies to a model's prose", by("claim-clm6").steps.at(-1)!.result.ok && by("denied-clm3").steps.at(-1)!.result.ok && by("estimate-pre1").steps.at(-1)!.result.ok);
}

console.log("\nRe-collect nothing, one question at a time");
{
  const c = fresh();
  say(c, "physiotherapy for my wrist, it cost 1,800");
  fact(c, "amount", 1800, "1,800");
  check("asking for something already known is refused — and the known value is handed back", refused(call(c, "ask_member", { field_key: "amount", question: "How much was it in total?" }), /already known: 1800/), why(call(c, "ask_member", { field_key: "amount", question: "How much was it in total?" })));
  check("the refusal tells the agent what to do instead: never ask for what is known — use it", refused(call(c, "ask_member", { field_key: "amount", question: "How much was it in total?" }), /use it/));
  const first = call(c, "ask_member", { field_key: "provider_type", question: "What kind of place was it?" });
  check("a first question is accepted and yields a question card", first.ok && isQuestionCard(first.ok && first.card));
  check("a second question while one is open is refused (one at a time)", refused(call(c, "ask_member", { field_key: "treatment_date", question: "What day was it?" }), /one question at a time/));
  const d = fresh();
  check("a question with two question marks is refused", refused(call(d, "ask_member", { field_key: "provider_type", question: "What kind of place was it? And how much?" }), /ONE question/));
  check("a question citing a figure nobody stated is refused", refused(call(d, "ask_member", { field_key: "amount", question: "Was it more than AED 2,500 in total?" }), /2500.*nobody stated/));
  say(d, "it was 1,800");
  fact(d, "amount", 1800, "1,800");
  check("...but a figure the member did give may be repeated back", call(d, "ask_member", { field_key: "provider_type", question: "Was the 1,800 for a clinic or a hospital?" }).ok);
  check("a question a member should not read is refused (classification vocabulary)", refused(call(fresh(), "ask_member", { field_key: "provider_type", question: "Is this a high risk condition?" }), /not fit for a member/));
  check("a field this kind of request does not need is refused (paid_by_member on a pre-authorization)", refused(call(fresh("estimate-pre1"), "ask_member", { field_key: "paid_by_member", question: "Have you already paid for it?" }), /not something this request needs/));
  check("the closed vocabulary comes back as chips, including an honest 'Not sure'", (() => { const r = call(fresh(), "ask_member", { field_key: "provider_type", question: "What kind of place was it?" }); return r.ok && isQuestionCard(r.card) && (r.card as any).chips.length === 7 && (r.card as any).chips.some((x: any) => x.value === "unsure") && (r.card as any).input === "choice"; })());
}

console.log("\nThe member's own words");
{
  const c = fresh();
  say(c, "It was 1,800 for physio last week");
  check("a quote that is not verbatim from the member is refused", refused(fact(c, "amount", 1800, "I paid a lot for it"), /verbatim/));
  check("an amount 'stated' but absent from its quote is refused — the digits must be in the member's words", refused(fact(c, "amount", 2000, "physio last week"), /does not appear in the quote/));
  check("...and the refusal points at the honest alternative (basis inferred)", refused(fact(c, "amount", 2000, "physio last week"), /inferred/));
  check("a real date that is not in the future and after inception is accepted (inferred, from a relative phrase)", fact(c, "treatment_date", "2026-09-14", "physio last week", "inferred").ok);
  check("a relative date claimed as 'stated' is refused: it is a reading, not a fact", refused(fact(fresh(), "treatment_date", "2026-09-14", "last week"), /verbatim|relative/) || (() => { const d = fresh(); say(d, "last week"); return refused(fact(d, "treatment_date", "2026-09-14", "last week"), /relative date/); })());
  const f = fresh();
  say(f, "on 1 October");
  check("a treatment date in the future is refused, and the refusal names the right request type", refused(fact(f, "treatment_date", "2026-10-01", "1 October"), /future.*pre-authorization/), why(fact(f, "treatment_date", "2026-10-01", "1 October")));
  const g = fresh();
  say(g, "on 31 December");
  check("a date before the policy incepted is refused", refused(fact(g, "treatment_date", "2025-12-31", "31 December"), /before the policy incepted/));
  check("an impossible date (31 February) is refused by the value check", refused(fact(g, "treatment_date", "2026-02-31", "31 December", "inferred"), /real calendar date/));
  const h = fresh();
  say(h, "a hospital");
  check("a provider type outside the closed set is refused and the set is shown", refused(fact(h, "provider_type", "hospital", "a hospital"), /general_hospital|Invalid option/));
  check("a field that does not apply to this request is refused, with the ones that do", refused(fact(fresh("estimate-pre1"), "paid_by_member", true, "yes"), /does not apply.*treatment, provider_type, amount/));
  check("an unknown field key is refused", refused(call(fresh(), "record_fact", { field_key: "policy_month", value: 8, basis: "stated", quote: "x" }), /field_key/));
  check("an unknown extra argument is refused, not ignored (strict)", refused(call(fresh(), "record_fact", { field_key: "amount", value: 1, basis: "stated", quote: "1", confidence: 0.99 }), /confidence|unrecognized|Unrecognized/i));
}

console.log("\nA reading is not a fact");
{
  const ctx = upToLast("claim-clm6"); // everything done and adjudicated, propose not yet called
  const c = fresh();
  say(c, "physiotherapy for my wrist on 4 September, 1,800, at a clinic, I haven't paid");
  fact(c, "treatment", "Physiotherapy", "physiotherapy for my wrist");
  fact(c, "treatment_date", "2026-09-04", "4 September");
  fact(c, "amount", 1800, "1,800");
  fact(c, "provider_type", "in_network_clinic", "at a clinic", "inferred");
  fact(c, "paid_by_member", false, "I haven't paid", "inferred");
  call(c, "classify_benefit", { benefit_class: "general" });
  check("adjudicate is refused until the member has confirmed the details", refused(call(c, "adjudicate"), /has not confirmed/));
  check("confirm_details is accepted once the draft is complete", call(c, "confirm_details").ok);
  check("...and asking a new question while the confirm card is on screen is refused", refused(call(c, "ask_member", { field_key: "provider_name", question: "What is the clinic called?" }), /confirm card/));
  c.draft.confirmed = true;
  c.awaitingConfirmation = false;
  // Seen live (2026-09-22): the member tapped "Looks right" and was shown the IDENTICAL confirm card again. The
  // model had re-run classify_benefit on the confirm turn, which un-confirmed the draft, so confirm_details had
  // nothing to refuse. Both halves of that are fenced here — the model decides WHEN, but not whether to ask the
  // same question twice.
  // Read through a widened local: assigning `confirmed = true` just above narrows it to the literal `true`, so a
  // direct comparison here would be a tautology to the compiler even though the tool really does mutate it.
  const confirmedNow = (): boolean => c.draft.confirmed;
  check(
    "re-stating the SAME classification is not a change, so the member's confirmation still stands",
    (() => {
      const r = call(c, "classify_benefit", { benefit_class: "general" });
      return r.ok && confirmedNow() === true && c.awaitingConfirmation === false;
    })(),
  );
  check("confirm_details is refused on a draft the member has already confirmed — the card would be identical", refused(call(c, "confirm_details"), /already confirmed/));
  check("once confirmed, adjudicate runs", call(c, "adjudicate").ok && c.result !== null);
  check(
    "a classification that genuinely CHANGES still withdraws the confirmation — the member has not seen the new reading",
    (() => {
      c.draft.confirmed = true;
      const r = call(c, "classify_benefit", { benefit_class: "dental_optical" });
      return r.ok && confirmedNow() === false;
    })(),
  );
  check("...and confirm_details is allowed again once it has been withdrawn", call(c, "confirm_details").ok);
  c.draft.confirmed = true;
  c.awaitingConfirmation = false;
  call(c, "classify_benefit", { benefit_class: "general" });
  c.draft.confirmed = true;
  c.awaitingConfirmation = false;
  fact(c, "amount", 1900, "1,800"); // a correction: stated digits do not match, so refused — then a proper correction
  say(c, "sorry, it was 1,900");
  check("a member correcting themselves replaces the earlier answer", (() => { const r = fact(c, "amount", 1900, "1,900"); return r.ok && (r.data as any).status === "updated" && (r.data as any).was === 1800; })());
  check("...and any change withdraws the confirmation: nothing is computed against a reading they have not re-checked", refused(call(c, "adjudicate"), /has not confirmed/));
  void ctx;
  const d = fresh();
  say(d, "physiotherapy for my wrist");
  fact(d, "treatment", "Physiotherapy for my wrist", "physiotherapy for my wrist");
  call(d, "classify_benefit", { benefit_class: "general" });
  say(d, "actually it was a dental cleaning");
  fact(d, "treatment", "Dental cleaning", "dental cleaning");
  check("changing what the treatment IS clears its classification — it must be re-classified", d.draft.benefitClass === null);
}

console.log("\nClassification is checked against what the member declared");
{
  const p3 = fresh("denied-clm3");
  say(p3, "my diabetes review");
  fact(p3, "treatment", "Diabetes review", "my diabetes review");
  check("chronic_preexisting without naming a condition is refused, and the declared ones are listed", refused(call(p3, "classify_benefit", { benefit_class: "chronic_preexisting" }), /type 2 diabetes.*hypertension|hypertension.*type 2 diabetes/));
  check("naming a condition the member never declared is refused — it would be general", refused(call(p3, "classify_benefit", { benefit_class: "chronic_preexisting", declared_condition: "asthma" }), /not a condition the member declared/));
  check("a declared condition is accepted, and matched to the member's own wording", (() => { const r = call(p3, "classify_benefit", { benefit_class: "chronic_preexisting", declared_condition: "diabetes" }); return r.ok && (r.data as any).declaredCondition === "type 2 diabetes"; })());
  check("declared_condition on a non-chronic class is refused as inconsistent", refused(call(p3, "classify_benefit", { benefit_class: "general", declared_condition: "type 2 diabetes" }), /only applies to chronic_preexisting/));
  const p1 = fresh();
  say(p1, "physio");
  fact(p1, "treatment", "Physio", "physio");
  check("a member who declared nothing can never be classified chronic_preexisting", refused(call(p1, "classify_benefit", { benefit_class: "chronic_preexisting", declared_condition: "anything" }), /declared no conditions/));
  check("classifying before the treatment is known is refused", refused(call(fresh(), "classify_benefit", { benefit_class: "general" }), /record the treatment first/));
}

console.log("\nConflicts are asked about, never silently resolved");
{
  const run = runScenario(spec("conflict-date").spec, spec("conflict-date").turns);
  check("a member's statement does not overwrite a document: it opens a conflict", run.steps[0].result.ok && (run.steps[0].result as any).data.status === "conflict");
  const card = run.cards[0]?.card as any;
  check("the conflict card names both sources and quotes both, in the member's terms", isConflictCard(card) && card.options[0].source === "Your document" && card.options[1].source === "What you told me" && /10 September/.test(card.options[0].display));
  check("neither option is pre-selected (there is no `selected` field, and both are present)", card.options.length === 2 && !("selected" in card));
  check("resolving the conflict by choosing one of the two clears it", run.ctx.draft.conflicts.every((c) => c.resolved) && run.ctx.draft.facts.treatment_date?.value === "2026-09-04");
  const c = scenarioContext(spec("conflict-date").spec);
  say(c, "It was 4 September");
  fact(c, "treatment_date", "2026-09-04", "4 September");
  check("a disputed field is not 'missing' — asking for it is refused and flag_conflict is named", refused(call(c, "ask_member", { field_key: "treatment_date", question: "What day was it?" }), /disputed.*flag_conflict/));
  say(c, "the 12th of September");
  check("a conflict is resolved by one of its two values, not a third", refused(call(c, "record_fact", { field_key: "treatment_date", value: "2026-09-12", basis: "stated", quote: "the 12th of September", resolves_conflict: true }), /one of its two values/));
  check("flag_conflict on a field with no conflict is refused", refused(call(fresh(), "flag_conflict", { field_key: "amount" }), /no open conflict/));
}

console.log("\nMoney never comes from the agent");
{
  const c = upToLast("claim-clm6");
  check("adjudicate has nowhere to put an amount: an extra argument is refused", refused(call(fresh(), "adjudicate", { amount: 999999 }), /takes no arguments/));
  check("adjudicate before the draft is complete lists exactly what is missing", refused(call(fresh(), "adjudicate"), /missing: \[treatment, treatment_date, provider_type, amount, paid_by_member\]/));
  check("propose_outcome before adjudicate is refused", refused(call(fresh(), "propose_outcome", { member_explanation: "x".repeat(50), broker_explanation: "y".repeat(50), confidence: "high" }), /call adjudicate first/));

  const tpl = c.result!.template;
  const good = { member_explanation: tpl.member, broker_explanation: tpl.broker, confidence: "high" };
  check("an explanation citing a figure no observation produced is refused, naming the figure", refused(call(c, "propose_outcome", { ...good, member_explanation: tpl.member.replace("AED 1,260", "AED 9,999") }), /9,999.*no observation/));
  check("two identical explanations are refused: the broker's is a different document", refused(call(c, "propose_outcome", { ...good, broker_explanation: tpl.member }), /identical/));
  check("a member explanation with classification vocabulary is refused", refused(call(c, "propose_outcome", { ...good, member_explanation: tpl.member + " Your case was flagged for review." }), /not fit for a member/));
  check("a member explanation that names an internal reference is refused", refused(call(c, "propose_outcome", { ...good, member_explanation: tpl.member + " Ref CLM-6." }), /not fit for a member/));
  check("a member explanation that promises a time is refused (the system has no SLA)", refused(call(c, "propose_outcome", { ...good, member_explanation: tpl.member + " We will confirm within 24 hours." }), /time promise/));
  check("a broker explanation that names no policy or event is refused", refused(call(c, "propose_outcome", { ...good, broker_explanation: "Deductible was already met on this one and the co-pay applied to the remainder of the bill." }), /must name the policy or event/));
  check("a member explanation that omits what the member pays is refused: the prose must agree with the card", refused(call(c, "propose_outcome", { ...good, member_explanation: "This is covered under your plan, and the plan pays its share of the bill directly to the provider today." }), /must say what the member pays/));
  check("confidence below high needs a reason", refused(call(c, "propose_outcome", { ...good, confidence: "medium" }), /needs uncertainty_reason/));
  const ok = call(c, "propose_outcome", good);
  check("the honest proposal is accepted, and is terminal", ok.ok && ok.terminal === "outcome" && isOutcomeCard(ok.card));
  check("after a terminal call, no further tool calls are accepted", refused(call(c, "read_policy"), /already ended/));

  // The estimate caveat is guaranteed in ONE place: the explanation or the footer, never both, never neither.
  const pre = upToLast("estimate-pre1");
  const preTpl = pre.result!.template;
  const withoutCaveat = preTpl.member.replace(/ Nothing has been claimed[\s\S]*$/, "");
  const preOk = call(pre, "propose_outcome", { member_explanation: withoutCaveat, broker_explanation: preTpl.broker, confidence: "high" });
  check("an estimate whose explanation omits the caveat still carries it, as a footer", preOk.ok && isEstimateCard(preOk.card) && /Nothing has been claimed/.test((preOk.card as any).caveat ?? ""), why(preOk));
  const pre2 = upToLast("estimate-pre1");
  const preFull = call(pre2, "propose_outcome", { member_explanation: preTpl.member, broker_explanation: preTpl.broker, confidence: "high" });
  check("...and one whose explanation already says it does not repeat it", preFull.ok && (preFull.card as any).caveat === null);
  const covered = call(upToLast("claim-clm6"), "propose_outcome", { member_explanation: (runAll().find((r) => r.spec.id === "claim-clm6")!.ctx.result!.template.member).replace(" The plan settles its share with the provider; the rest is yours to pay them.", ""), broker_explanation: runAll().find((r) => r.spec.id === "claim-clm6")!.ctx.result!.template.broker, confidence: "high" });
  check("a covered claim whose explanation omits who is paid gets the settlement footer; the template's already says it", covered.ok && /settles its share/.test((covered.card as any).settlement ?? ""));

  const u = upToLast("undecidable-clm9");
  check("propose_outcome is refused for insufficient_data, and escalate is named", refused(call(u, "propose_outcome", { member_explanation: "x".repeat(50), broker_explanation: "POL-P5 CLM-9 " + "y".repeat(50), confidence: "low", uncertainty_reason: "the plan data does not decide this at all" }), /escalate/));
}

console.log("\nEscalation causes are only ever true");
{
  const c = fresh();
  const notYet = call(c, "escalate", { cause: "insufficient_data", member_message: "x".repeat(50) });
  check("insufficient_data is refused when the state does not show it, and the causes that DO hold are listed", refused(notYet, /Causes that hold right now: \[model_failure, member_requested\]/), why(notYet));
  for (const cause of ["evidence_limit", "appeal_overturn", "reassessment_change", "unresolved_conflict", "clarification_limit"] as const) {
    check(`${cause} is unreachable on a fresh conversation`, refused(call(fresh(), "escalate", { cause }), /cannot escalate/));
  }
  check("member_requested is always available: the human is never behind a failure", (() => { const r = call(fresh(), "escalate", { cause: "member_requested" }); return r.ok && r.terminal === "escalation" && isEscalationCard(r.card); })());
  check("model_failure is always available", call(fresh(), "escalate", { cause: "model_failure" }).ok);

  const u = upToLast("undecidable-clm9");
  check("insufficient_data needs a member_message: nobody lands on a card unexplained", refused(call(u, "escalate", { cause: "insufficient_data" }), /needs a member_message/));
  check("the member_message obeys the same copy rules", refused(call(u, "escalate", { cause: "insufficient_data", member_message: "This case was escalated to a reviewer because the plan defines no cover abroad at all." }), /not fit for a member/));
  check("...and the same figure rule", refused(call(u, "escalate", { cause: "insufficient_data", member_message: "We can't decide this from your plan terms, and the plan would pay AED 7,777 if it could." }), /7777|7,777/));
  const done = call(u, "escalate", { cause: "insufficient_data", member_message: u.result!.template.member });
  check("the honest escalation is accepted", done.ok && done.terminal === "escalation");
  const cardKeys = done.ok ? Object.keys(done.card as object).sort().join(",") : "";
  check("the cause is on the result for the broker — and NOT on the member's card", done.ok && (done.data as any).cause === "insufficient_data" && !("cause" in (done.card as object)) && cardKeys === "callbackWindows,kind,reference,summary", cardKeys);

  const lim = fresh();
  lim.limits = { ...lim.limits, clarificationRounds: 1 };
  check("the first question is accepted", call(lim, "ask_member", { field_key: "provider_type", question: "What kind of place was it?" }).ok);
  say(lim, "Clinic");
  fact(lim, "provider_type", "in_network_clinic", "Clinic");
  check("past the configured limit a question is refused, and escalate(clarification_limit) is named", refused(call(lim, "ask_member", { field_key: "treatment", question: "What was the treatment for?" }), /clarification limit reached.*clarification_limit/));
  check("...and that cause is now justified", call(lim, "escalate", { cause: "clarification_limit" }).ok);

  const uns = fresh();
  say(uns, "Not sure");
  const r = call(uns, "record_fact", { field_key: "provider_type", value: "unsure", basis: "stated", quote: "Not sure" });
  check("'Not sure' is a legitimate answer: recorded as a STATE, and no tier is guessed", r.ok && (r.data as any).status === "unsure" && (r.data as any).recorded === false && uns.draft.facts.provider_type === undefined && uns.providerUnsure);
  check("...escalation as clarification_limit is refused until the provider's name has been asked for", refused(call(uns, "escalate", { cause: "clarification_limit" }), /cannot escalate/));
  say(uns, "Al Noor");
  fact(uns, "provider_name", "Al Noor", "Al Noor");
  check("...and justified once the name is known and the type is still unplaced", call(uns, "escalate", { cause: "clarification_limit" }).ok);
}

console.log("\nEvery tool survives garbage");
{
  const garbage: unknown[] = [undefined, null, {}, 42, "x", [], { field_key: 5 }, { cause: {} }, { benefit_class: null }, { plan_id: [] }];
  const threw: string[] = [];
  const badShape: string[] = [];
  for (const tool of TOOL_NAMES) {
    for (const g of garbage) {
      try {
        const r = call(fresh(), tool, g) as any;
        if (typeof r?.ok !== "boolean") badShape.push(`${tool}(${JSON.stringify(g)})`);
      } catch (e) {
        threw.push(`${tool}(${JSON.stringify(g)}): ${(e as Error).message}`);
      }
    }
  }
  check(`no tool throws on garbage input (${TOOL_NAMES.length} tools × ${garbage.length} inputs)`, threw.length === 0, threw.slice(0, 3).join(" | "));
  check("every result is a well-formed { ok } — a refusal is data the agent can read, never an exception", badShape.length === 0, badShape.slice(0, 3).join(" | "));
  check("an unknown tool is refused with the list of valid ones", refused(call(fresh(), "delete_claim", {}), new RegExp(`valid tools: ${TOOL_NAMES[0]}`)));
}

console.log("\nThe descriptions come from the live vocabulary");
{
  const p3 = describeServicingTools(fresh("denied-clm3"));
  const p1 = describeServicingTools(fresh());
  check("every tool has a description", TOOL_NAMES.every((t) => p3[t] && p3[t].length > 20));
  check("classify_benefit names THIS member's declared conditions", /type 2 diabetes/.test(p3.classify_benefit) && /hypertension/.test(p3.classify_benefit));
  check("...and, for a member who declared none, says chronic_preexisting can never apply", /declared none/.test(p1.classify_benefit));
  check("the closed vocabularies are spelled out in full: provider types, plan ids, escalation causes", /unknown_foreign/.test(p1.check_network_admission) && /plan_a, plan_b, plan_c/.test(p1.get_plan_terms) && ESCALATION_CAUSES.every((c) => p1.escalate.includes(c)));
  check("a pre-authorization's fields exclude the ones it cannot have", !/paid_by_member/.test(describeServicingTools(fresh("estimate-pre1")).record_fact));
}

console.log("\nCard payloads: valid ones pass, malformed ones are refused");
{
  const gallery = galleryCards().map((g) => g.card);
  const samples: Record<string, ServicingCard> = {};
  for (const run of runAll()) for (const c of run.cards) samples[c.card.kind] ??= c.card;
  samples.servicing_facts_form = factsFormFixture();
  samples.servicing_appeal_intro = galleryCards().find((g) => g.card.kind === "servicing_appeal_intro")!.card;
  samples.servicing_evidence_request = galleryCards().find((g) => g.card.kind === "servicing_evidence_request")!.card;
  const guards: Record<string, (p: unknown) => boolean> = {
    servicing_question: isQuestionCard,
    servicing_confirm: isConfirmCard,
    servicing_facts_form: isFactsFormCard,
    servicing_evidence_request: isEvidenceRequestCard,
    servicing_appeal_intro: isAppealIntroCard,
    servicing_conflict: isConflictCard,
    servicing_outcome: isOutcomeCard,
    servicing_estimate: isEstimateCard,
    servicing_escalation: isEscalationCard,
  };
  check("every one of the eight card kinds has a real sample", Object.keys(guards).every((k) => samples[k]), Object.keys(guards).filter((k) => !samples[k]).join(", "));
  check("every gallery card is a valid card", gallery.every(isServicingCard));
  for (const [kind, guard] of Object.entries(guards)) {
    const sample = samples[kind] as any;
    const others = Object.entries(guards).filter(([k]) => k !== kind).every(([, g]) => !g(sample));
    check(`${kind}: its own guard accepts it and no other guard does`, guard(sample) && isServicingCard(sample) && others);
    const drops = Object.keys(sample).filter((k) => k !== "kind").map((k) => { const { [k]: _omit, ...rest } = sample; void _omit; return guard(rest); });
    check(`${kind}: removing any one required field makes it invalid (${drops.length} fields)`, drops.every((accepted) => !accepted));
    check(`${kind}: an undeclared key is refused — broker-only data cannot ride on a member's card`, !guard({ ...sample, confidence: 0.9 }) && !guard({ ...sample, cause: "insufficient_data" }) && !guard({ ...sample, uncertaintyReason: "x" }));
  }
  const q = samples.servicing_question as any;
  const o = samples.servicing_outcome as any;
  const cf = samples.servicing_conflict as any;
  check("a question card with too many chips, or an unknown input kind, is refused", !isQuestionCard({ ...q, chips: Array.from({ length: 9 }, (_, i) => ({ label: `c${i}`, value: `v${i}` })) }) && !isQuestionCard({ ...q, input: "slider" }));
  check("an outcome card with an unknown outcome, a non-numeric figure, or too many next steps is refused", !isOutcomeCard({ ...o, outcome: "approved" }) && !isOutcomeCard({ ...o, figures: { ...o.figures, plan: { label: "x", value: "1,260" } } }) && !isOutcomeCard({ ...o, nextSteps: Array(7).fill("a step") }));
  check("a conflict card must have exactly two options", !isConflictCard({ ...cf, options: [cf.options[0]] }) && !isConflictCard({ ...cf, options: [...cf.options, cf.options[0]] }));
  check("an evidence request cannot remove the way to say no", !isEvidenceRequestCard({ ...(samples.servicing_evidence_request as any), canDecline: false }));
  check("an escalation card must offer at least one callback window and something the advisor will have", !isEscalationCard({ ...(samples.servicing_escalation as any), callbackWindows: [] }) && !isEscalationCard({ ...(samples.servicing_escalation as any), summary: [] }));
  check("null, a number, a string, an array and an unknown kind are all refused", [null, 5, "servicing_outcome", [], {}, { kind: "servicing_unknown" }].every((x) => !isServicingCard(x)));
}

console.log("\nEvery string on every card is fit for a member");
{
  const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.entries(v).filter(([k]) => !["kind", "fieldKey", "value", "eventKind", "outcome", "input", "origin", "reference"].includes(k)).flatMap(([, x]) => strings(x)) : []);
  const leaks = galleryCards().flatMap((g) => strings(g.card).flatMap((s) => memberCopyViolations(s).map((v) => `${g.label}: ${v} in "${s.slice(0, 60)}"`)));
  check("no card carries classification vocabulary, a raw enum, an internal reference or a time promise — traces and chips included", leaks.length === 0, leaks.slice(0, 4).join("; "));
  // The escalation reference is the ONE deliberate member-visible handle: it is what they quote on a call
  // (plan §13.2.7). The rule against internal references is about prose; every other string is scanned above.
  const esc = galleryCards().find((g) => isEscalationCard(g.card))!.card as any;
  check("the escalation card's reference is the one member-visible reference, and it is a handle the advisor can find", INTERNAL_REF.test(esc.reference) && esc.summary.every((x: string) => !INTERNAL_REF.test(x)));
  check("the card copy that reaches a member states no figure the engine did not produce (outcome + estimate cards)", galleryCards().filter((g) => isOutcomeCard(g.card) || isEstimateCard(g.card)).every((g) => { const c = g.card as any; const shown = new Set<number>([c.figures.billed.value, c.figures.plan.value, c.figures.member.value].filter((x) => x !== null)); return numbersIn(c.explanation).some((n) => shown.has(n)) || c.outcome === "insufficient_data" || (c.eventKind === "appeal" && c.outcome === "upheld"); }));
  check("...and an upheld appeal, which changes no money, states none (a date is not a figure)", galleryCards().filter((g) => (g.card as any).eventKind === "appeal" && (g.card as any).outcome === "upheld").every((g) => numbersIn((g.card as any).explanation.replace(/\b\d{1,2} [A-Z][a-z]+ \d{4}\b/g, "")).length === 0));
}

console.log("\nSupporting pieces");
{
  check("monthOfDate: the 6th monthly anniversary is month 6, the day before is month 5", monthOfDate("2026-01-01", "2026-07-01") === 6 && monthOfDate("2026-01-15", "2026-07-14") === 5 && monthOfDate("2026-01-15", "2026-07-15") === 6);
  check("monthOfDate: a date before inception is an error, not a negative month", (() => { try { monthOfDate("2026-01-01", "2025-12-31"); return false; } catch { return true; } })());
  check("isRealDate rejects 31 February and malformed strings", !isRealDate("2026-02-31") && !isRealDate("4 September") && isRealDate("2028-02-29") && !isRealDate("2026-02-29"));
  check("numbersIn reads figures the way prose writes them", JSON.stringify(numbersIn("AED 1,190 on 1 July 2026, 30%")) === JSON.stringify([1190, 1, 2026, 30]));
  check("memberCopyViolations names each rule a string breaks", memberCopyViolations("Flagged by the reviewer, CLM-4, within 24 hours").length >= 4 && memberCopyViolations("This is covered. The plan pays AED 1,260.").length === 0);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
