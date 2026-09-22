// The appeal cards, as the REAL appeal tools return them.
//
// Same rule as scenarios.ts: nothing in the gallery is a hand-drawn fixture. The two supplied appeals are driven through
// `runServicingTool` with the appeal registry attached, on the supplied history MINUS the appeals themselves (so CLM-3
// and CLM-4 are still denied), and every card is whatever a tool or a builder returned. The gallery therefore cannot show
// a shape the loop cannot produce.
//
// Dev/test only. Nothing in a production path imports this.
import fixtures from "./fixtures.json";
import { buildServicingSeed, logForProfile, toPlanTerms } from "./servicing";
import { scenarioContext } from "./scenarios";
import { turnFromResult } from "@/lib/ai/graph/nodes/servicing";
import { runServicingTool, type ServicingToolContext } from "@/lib/ai/tools/servicing";
import { ADMISSIBILITY, appealIntroCard, identifyContested, reAdjudicate, type ServicingCard } from "@/lib/servicing";
import { appealOutcomeCard } from "@/lib/servicing/appeal-commit";
import { contestedRowOf } from "@/lib/servicing/appeal-store";

/* eslint-disable @typescript-eslint/no-explicit-any */
const fx = fixtures as any;

export type AppealGalleryCard = { group: string; label: string; note: string; card: ServicingCard };

function appealContext(profile: string, contestedRef: string): ServicingToolContext {
  const rows = buildServicingSeed(fx, { appeals: "pending" }).events;
  const events = logForProfile(profile).filter((e) => e.kind !== "appeal");
  const ctx = scenarioContext({
    id: `appeal-${contestedRef}`,
    title: `Appeal of ${contestedRef}`,
    description: "",
    profile,
    intent: "claim",
    today: "2026-09-20",
    eventRef: "APP-1",
    historyRefs: events.map((e) => e.id),
  });
  const row = contestedRowOf(rows as any, rows.find((r) => r.externalRef === contestedRef)!.id!);
  if (!row) throw new Error(`no ${contestedRef}`);
  const found = identifyContested(row);
  if (!found.ok) throw new Error(`${contestedRef} is not appealable: ${found.exit}`);
  const policy = fx.policy.find((p: any) => p.external_ref === `POL-${profile}`);
  const plan = fx.plan.map(toPlanTerms).find((p: any) => p.id === policy.plan_id);
  // `events` carry external refs as ids in this harness; the contested row carries its seed id, so map it across.
  const replayEvents = events.map((e) => (e.id === contestedRef ? { ...e, id: row.id } : e));
  const original = reAdjudicate({
    plan,
    events: replayEvents,
    contestedId: row.id,
    patch: found.contested.admissibility.turnsOn === "provider_tier" ? { field: "provider_tier", value: row.providerTier! } : { field: "benefit_class", value: row.benefitClass! },
    original: { outcome: row.outcome, planPays: row.planPays },
  }).result;
  ctx.appeal = {
    state: { contestedEventId: row.id, contestedRef, contestedReason: found.contested.reason, evidence: [], assessments: [], supplied: [], declined: [], requested: [], openRequest: null, pendingCorrection: null, begun: false },
    contested: found.contested,
    events: replayEvents,
    original,
    declaredAtIntake: row.benefitClass === "chronic_preexisting",
    appealRef: "APP-1",
    result: null,
  };
  return ctx;
}

const call = (ctx: ServicingToolContext, tool: string, args: unknown) => {
  const r = runServicingTool(ctx, tool, args);
  if (!r.ok) throw new Error(`${tool}: ${r.error}`);
  return r;
};

export function appealGalleryCards(): AppealGalleryCard[] {
  const out: AppealGalleryCard[] = [];
  const group = "Appeals (phase 5)";

  // ---- APP-1: the denial that must hold -----------------------------------------------------------------------
  const a1 = appealContext("P3", "CLM-3");
  const c1 = a1.appeal!.contested.row;
  const intro1 = appealIntroCard({ title: c1.description ?? c1.ref, policyMonth: c1.policyMonth, inceptionDate: a1.policy.inceptionDate, decision: "Not covered", admissibility: a1.appeal!.contested.admissibility });
  out.push({ group, label: "Appeal — what the decision turned on, and what could change it", note: "Shown BEFORE the member writes a word: the admissibility table in their words. It stops them sending a document that cannot help.", card: intro1 });
  const ask1 = call(a1, "request_evidence", { kind: "dated_diagnosis" });
  out.push({ group, label: "Evidence request — the most likely document, by name", note: "\"I don't have this\" is an action, not silence: it feeds the set-difference that decides whether to ask again.", card: ask1.card! });
  a1.appeal!.state.declined.push("dated_diagnosis");
  a1.appeal!.state.openRequest = null;
  const ask2 = call(a1, "request_evidence", { kind: "prior_cover" });
  out.push({ group, label: "Evidence request — the next admissible kind, after a decline", note: "One at a time, and only from what could still exist. Round 2 of at most three.", card: ask2.card! });
  a1.appeal!.state.declined.push("prior_cover");
  a1.appeal!.state.openRequest = null;
  const end1 = call(a1, "conclude_appeal", {});
  const turn1 = turnFromResult("conclude_appeal", end1 as any, a1);
  out.push({ group, label: "Appeal outcome — upheld, with the reason and the way forward (APP-1)", note: "The member did the work and lost. They get the reason, the date the wait ends, and what would have changed it — never a form letter.", card: turn1.messages[0].card! });

  // ---- APP-2: the denial that must fall -----------------------------------------------------------------------
  const a2 = appealContext("P4", "CLM-4");
  const c2 = a2.appeal!.contested.row;
  out.push({
    group,
    label: "Appeal — a network finding",
    note: "The same card, a different finding: what could change it is a licence naming a different tier.",
    card: appealIntroCard({ title: c2.description ?? c2.ref, policyMonth: c2.policyMonth, inceptionDate: a2.policy.inceptionDate, decision: "Not covered", admissibility: ADMISSIBILITY.provider_out_of_network! }),
  });
  const certificate = "Provider registration: Gulf Physiotherapy Centre LLC, independently licensed outpatient facility, registered at standard network tier, leased suite within the hospital building.";
  const quote = "independently licensed outpatient facility, registered at standard network tier";
  a2.appeal!.state.evidence.push(certificate);
  call(a2, "assess_evidence", { evidence_index: 0, verdict: "bears_on", kind: "provider_licence", quote, why: "The registration names the provider's own registered category and tier." });
  const done = call(a2, "propose_correction", { evidence_index: 0, kind: "provider_licence", field: "provider_tier", value: "in_network_clinic", quote });
  if (done.ok && done.terminal !== "appeal_overturn") throw new Error("the certificate should overturn CLM-4");
  const res = a2.appeal!.result;
  if (res?.kind !== "overturn") throw new Error("no overturn draft");
  out.push({ group, label: "Appeal outcome — reversed (APP-2), once signed", note: "\"You were right — …\" with the new numbers and what they mean for the year. Shown only AFTER a person signs.", card: appealOutcomeCard(res.draft, a2.plan, a2.policy.inceptionDate) });
  return out;
}
