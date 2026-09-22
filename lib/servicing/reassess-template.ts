// The reassessment's two documents, built from `FitFeatures` and citing events (plan §5.5, §13.3.4).
//
// Deterministic, like `explain-template.ts` and `appeal-commit.ts`'s prose: nothing here is a model call, and
// every sentence is a function of a feature that was actually computed. A citation is never parsed back out of
// the prose after the fact — every event a sentence mentions is pushed onto `citations` as it is written, so
// the two can never drift apart, and the UI renders a chip from that list, not from a regex over the text.

import type { ReasonCode } from "@/db/schema/enums";
import type { PlanTerms } from "@/lib/assessment";
import { benefitClassPhrase } from "./labels";
import type { Citable, FitFeatures, HindsightRow, Verdict } from "./reassess";

const num = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en") : n.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const aed = (n: number) => `AED ${num(n)}`;

/** What denied it, in words a member reads — never the reason code itself. */
const MEMBER_REASON_PHRASE: Partial<Record<ReasonCode, string>> = {
  benefit_excluded: "wasn't a benefit this plan covers",
  provider_out_of_network: "was at a provider outside this plan's network",
  sublimit_exhausted: "went over this plan's yearly limit for that benefit",
  annual_limit_reached: "went over this plan's yearly limit",
};

const describe = (c: Citable): string => c.description ?? `your month ${c.policyMonth} ${c.reasonCode ? "claim" : "event"}`;

export type Citation = { eventId: string; ref: string; description: string };

export type ReassessmentProse = { member: string; broker: string; citations: Citation[] };

function cite(list: Citation[], c: Citable | { id: string; ref: string; description: string | null; policyMonth: number }): Citation {
  const entry: Citation = { eventId: c.id, ref: c.ref, description: c.description ?? describe(c as Citable) };
  if (!list.some((x) => x.eventId === entry.eventId)) list.push(entry);
  return entry;
}

export function buildReassessmentProse(input: { features: FitFeatures; verdict: Verdict; plan: PlanTerms; recommendedPlan: PlanTerms | null; policyRef: string }): ReassessmentProse {
  const { features: f, verdict, plan, recommendedPlan, policyRef } = input;
  const citations: Citation[] = [];
  const member: string[] = [];
  const broker: string[] = [`${policyRef} reassessed.`];

  // --- what happened, in the order it is most informative ------------------------------------------------

  for (const { benefitClass, denied, laterPaid } of f.waitingPeriodsCleared) {
    const d = cite(citations, denied);
    const l = cite(citations, laterPaid);
    member.push(`${d.description} wasn't covered while the wait for ${benefitClassPhrase[benefitClass]} was still running; once it cleared, ${l.description} was paid under your plan's usual terms.`);
    broker.push(`${d.ref} denied on the ${benefitClass} wait; ${l.ref} paid once it cleared at month ${laterPaid.policyMonth} — not a fit signal, the tradeoff behaving as sold.`);
  }

  for (const a of f.appealAttempts) {
    const contested = f.standing.find((c) => c.ref === a.contestsRef) ?? { id: a.id, ref: a.contestsRef, description: null, policyMonth: a.policyMonth, outcome: null, reasonCode: null, benefitClass: null, planPays: null, memberPays: null, billedAmount: null };
    const c = cite(citations, contested);
    cite(citations, a);
    if (a.verdict === "upheld") {
      member.push(`You asked us to look again at ${c.description}, and after a second look the decision stood.`);
      broker.push(`${a.ref} upheld ${c.ref} on appeal.`);
    } else {
      member.push(`You asked us to look again at ${c.description}, and we reversed the decision.`);
      broker.push(`${a.ref} overturned ${c.ref} on appeal.`);
    }
  }

  const persistingReasons = f.repeatedDenialReasons.filter((r) => MEMBER_REASON_PHRASE[r]);
  for (const reason of persistingReasons) {
    const events = f.denialsByReasonCode[reason] ?? [];
    const cited = events.map((e) => cite(citations, e));
    const n = cited.length;
    member.push(`${n === 2 ? "Twice" : `${n} times`} this year, a claim ${MEMBER_REASON_PHRASE[reason]}.`);
    broker.push(`${reason} denied ${n} time${n === 1 ? "" : "s"}: ${cited.map((c) => c.ref).join(", ")}.`);
  }

  for (const c of f.outOfNetworkEpisodes.filter(() => !persistingReasons.includes("provider_out_of_network"))) {
    const cited = cite(citations, c);
    member.push(`${cited.description} fell outside your plan's network, so your share for that one was the full amount.`);
    broker.push(`${cited.ref} out of network, isolated — one episode is not a pattern by itself.`);
  }

  const capNote = f.capsHit.find((c) => c.event.outcome === "approved_with_limit");
  if (capNote) {
    const cited = cite(citations, capNote.event);
    member.push(`${cited.description} was paid, but up to your plan's yearly limit for ${benefitClassPhrase[capNote.benefitClass]} — the rest was yours.`);
    broker.push(`${cited.ref} clipped by the ${capNote.benefitClass} cap.`);
  }

  // --- the verdict, last -----------------------------------------------------------------------------------

  const cost = `${aed(f.premiumVsPaid.premium)} in premium and ${aed(f.premiumVsPaid.memberPaid)} towards your care this year`;
  if (verdict.verdict === "confirm") {
    member.unshift(member.length ? "Your plan still looks like the right fit." : "Nothing here changes how well your plan fits you.");
    member.push(`So far you've paid ${cost}.`);
    broker.push(`Confirmed: ${plan.name} remains the better fit given the history above. Premium ${aed(f.premiumVsPaid.premium)}, plan paid ${aed(f.premiumVsPaid.planPaid)}, member paid ${aed(f.premiumVsPaid.memberPaid)}.`);
  } else {
    // The member NEVER reads this until an advisor approves it (a plan change is a sales act with a premium
    // attached, §2.3) — the session withholds `member` from the query until the review task is signed off, the
    // same discipline an appeal overturn already gets before its numbers are shown.
    member.unshift("Based on what's happened, it may be worth looking at whether this is still the best plan for you. An advisor will be in touch.");
    member.push(`So far you've paid ${cost}.`);
    const names = recommendedPlan ? recommendedPlan.name : "an alternative";
    broker.push(`Recommends moving to ${names}: it would have resolved ${verdict.reasonCodes.join(", ")} for this history, at no higher total cost. Premium ${aed(f.premiumVsPaid.premium)}, plan paid ${aed(f.premiumVsPaid.planPaid)}, member paid ${aed(f.premiumVsPaid.memberPaid)}.`);
  }

  return { member: member.join(" "), broker: broker.join(" "), citations };
}

// ---------------------------------------------------------------------------
// The hindsight table, as a member-safe caption and a broker-safe caption
// ---------------------------------------------------------------------------

export const hindsightCaption = (rows: HindsightRow[]): string => {
  const current = rows.find((r) => r.current);
  return current ? `Had this history run against every plan, from the start — labelled that way because a real switch restarts waiting periods.` : "";
};
