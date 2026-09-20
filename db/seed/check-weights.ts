// Deterministic checks for dynamic weight allocation, preference-signal
// persistence, and the bounded negotiation loop.
//
//   bun run --conditions=react-server db/seed/check-weights.ts
//
// `--conditions=react-server` is required for the same reason check-clarify.ts
// needs it: this imports modules marked `import "server-only"`.
//
// Tests 1-5 are pure functions, no DB and no model. Tests 6-8 exercise the
// session layer against a throwaway synthetic application, built through the
// real intake/assessment pipeline and torn down afterwards.
//
// What this file deliberately does NOT attempt: whether a live model reads a
// preference correctly out of free text, or whether it argues WELL. Neither
// is deterministic. What is tested here is everything that must hold no
// matter what the model says — the arithmetic, the invariants, the
// persistence, and above all that the loop terminates.

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  aiDecision,
  application,
  applicationPreferenceSignal,
  appUser,
  conversation,
  conversationAction,
  quote,
  recommendation,
  reviewTask,
} from "@/db/schema";
import { deriveRecord, emptyRecord, isDerivedNeedId, splitPriorities, type AssessmentRecord, type Catalogue } from "@/lib/assessment";
import { loadCatalogue, validateAndClassify } from "@/lib/ai/assessment-session";
import { routeAfterVerify, weakestWeightTarget, WEIGHT_CONFIDENCE_FLOOR } from "@/lib/ai/graph/nodes/clarify";
import {
  MAX_NEGOTIATION_TURNS,
  MAX_RECOMMENDATION_ROUNDS,
  routeAfterSignals,
} from "@/lib/ai/graph/nodes/negotiate";
import { verify } from "@/lib/ai/graph/nodes/recommendation";
import type { RecommendationStateType } from "@/lib/ai/graph/state";
import { loadRecommendationInputs, openTradeOffQuestion, persistNegotiation, recordTradeOffAnswer } from "@/lib/ai/recommendation-session";
import { createApplication, emptyDraft } from "@/lib/intake";
import {
  calculateDynamicWeights,
  describeTradeOff,
  detectTradeOff,
  isCriterionRelevant,
  isEligible,
  MAX_SIGNAL_SHIFT,
  MAX_WEIGHT,
  MIN_WEIGHT,
  priceAllPlans,
  readTradeOffAnswer,
  scenarioForRecord,
  scorePlans,
  signalsForChoice,
  signalsFromRecord,
  suggestDefaultWeights,
  validateSignals,
  type CriterionWeight,
  type PreferenceSignal,
} from "@/lib/recommendation";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

const sum = (weights: CriterionWeight[]) => Math.round(weights.reduce((s, w) => s + w.weight, 0) * 100) / 100;
const weightOf = (weights: CriterionWeight[], id: string) => weights.find((w) => w.criterionId === id)?.weight ?? 0;

const signal = (patch: Partial<PreferenceSignal> & Pick<PreferenceSignal, "dimension">): PreferenceSignal => ({
  direction: "increase",
  strength: 0.6,
  confidence: 0.9,
  source: "explicit",
  reason: "test",
  evidence: null,
  ...patch,
});

/** A record the four commonly-weighted criteria are all relevant to. */
function testRecord(): AssessmentRecord {
  return {
    ...emptyRecord(),
    applicationId: "test",
    age: 32,
    needs: [{ id: "need-1", rawText: "maternity cover within the year", benefitClass: "maternity", horizonMonths: 10 }],
    providers: [{ id: "prov-1", providerName: "Test Clinic", tier: "private_hospital" }],
  };
}

function baseState(catalogue: Catalogue, patch: Partial<RecommendationStateType> = {}): RecommendationStateType {
  return {
    record: testRecord(),
    catalogue,
    context: { today: new Date().toISOString().slice(0, 10), openApplicationsForPerson: 0 },
    cohort: null,
    fired: [],
    verdict: null,
    narrated: [],
    queueLine: null,
    servedBy: null,
    latencyMs: 0,
    previousRounds: [],
    quotes: [],
    trace: [],
    shortlist: [],
    rejections: [],
    brokerReasoning: null,
    memberReasoning: null,
    recoConfidence: "high",
    recoUncertaintyReason: null,
    fellBackTo: null,
    verifyFailed: false,
    clarificationAsked: false,
    clarification: null,
    tradeOffAsked: false,
    assessmentOnly: false,
    preferenceSignals: [],
    extractedSignals: [],
    signalsDropped: [],
    baseWeights: [],
    dynamicWeights: [],
    weightExplanation: [],
    weightConfidence: 1,
    round: 1,
    negotiationTurns: 0,
    negotiationReply: null,
    negotiationOutcome: null,
    ...patch,
  };
}

async function main() {
  const catalogue = await loadCatalogue();
  const record = testRecord();

  // ---------------------------------------------------------------------
  // 1. suggestDefaultWeights — the sum-to-1 guarantee it always claimed
  // ---------------------------------------------------------------------
  console.log("\n1. suggestDefaultWeights");
  for (const cohort of ["maternity_planning", "standard_young_healthy", "chronic_complex_senior", "not_a_real_cohort"]) {
    const weights = suggestDefaultWeights(record, cohort);
    check(`${cohort}: sums to exactly 1`, sum(weights) === 1, `got ${sum(weights)}`);
    check(`${cohort}: every weight in range`, weights.every((w) => w.weight >= MIN_WEIGHT && w.weight <= MAX_WEIGHT));
  }
  // The regression this fix exists for: a cohort whose third priority is
  // filtered out as irrelevant used to return a set summing to 0.89.
  const bare = { ...emptyRecord(), age: 26 };
  const twoOnly = suggestDefaultWeights(bare, "standard_young_healthy");
  check("clamped baseline still sums to 1", sum(twoOnly) === 1, `got ${sum(twoOnly)} from ${JSON.stringify(twoOnly)}`);

  // The conflict case: `maternity_planning` on a record with no needs leaves
  // ONE criterion, which cannot both sum to 1 and stay under MAX_WEIGHT. The
  // cap has to win, because `scorePlans` refuses an out-of-range weight and
  // renormalises a short set without complaint — assert against the engine
  // itself rather than against the arithmetic.
  const single = suggestDefaultWeights(bare, "maternity_planning");
  check("a lone criterion caps at MAX_WEIGHT rather than reaching 1", single.length === 1 && single[0].weight === MAX_WEIGHT, JSON.stringify(single));
  let scoreAccepted = true;
  try {
    scorePlans(catalogue.plans, bare, catalogue, single);
  } catch {
    scoreAccepted = false;
  }
  check("...and scorePlans accepts it", scoreAccepted);
  check(
    "the same holds after the weight engine runs",
    calculateDynamicWeights(single, [signal({ dimension: "premium_cost", strength: 1, confidence: 1 })], bare).weights.every(
      (w) => w.weight <= MAX_WEIGHT && w.weight >= MIN_WEIGHT,
    ),
  );

  // ---------------------------------------------------------------------
  // 2. calculateDynamicWeights — the engine's invariants
  // ---------------------------------------------------------------------
  console.log("\n2. calculateDynamicWeights");
  const base = suggestDefaultWeights(record, "maternity_planning");

  const none = calculateDynamicWeights(base, [], record);
  check("no signals reproduces the baseline exactly", JSON.stringify(none.weights) === JSON.stringify(base), JSON.stringify(none.weights));
  check("no signals means full confidence", none.confidence === 1);
  check("no signals means nothing claims to have moved", none.explanation.every((e) => e.shift === 0));

  // The example from the brief, in the vocabulary the engine actually uses:
  // "comprehensive cover matters" + "I'll pay more for it" = need_coverage up,
  // premium_cost DOWN (it matters less), never premium_cost up.
  const brief = calculateDynamicWeights(
    base,
    [
      signal({ dimension: "need_coverage", strength: 0.9, confidence: 0.95 }),
      signal({ dimension: "premium_cost", direction: "decrease", strength: 0.7, confidence: 0.9 }),
    ],
    record,
  );
  check("brief example: sums to exactly 1", sum(brief.weights) === 1, `got ${sum(brief.weights)}`);
  check("brief example: need_coverage rose", weightOf(brief.weights, "need_coverage") > weightOf(base, "need_coverage"));
  check("brief example: premium_cost fell", weightOf(brief.weights, "premium_cost") < weightOf(base, "premium_cost"));
  check("brief example: every weight in range", brief.weights.every((w) => w.weight >= MIN_WEIGHT && w.weight <= MAX_WEIGHT));
  check(
    "brief example: confidence reflects the signals that moved things",
    brief.confidence > 0.85 && brief.confidence <= 1,
    `got ${brief.confidence}`,
  );

  // Contradiction must CANCEL, not compound — the same dimension pushed both
  // ways by equal force is an applicant who has not decided, not one who
  // cares twice as much.
  const contradicted = calculateDynamicWeights(
    base,
    [
      signal({ dimension: "premium_cost", direction: "increase", strength: 0.8, confidence: 0.9 }),
      signal({ dimension: "premium_cost", direction: "decrease", strength: 0.8, confidence: 0.9, source: "rejection" }),
    ],
    record,
  );
  check(
    "equal-and-opposite signals cancel",
    weightOf(contradicted.weights, "premium_cost") === weightOf(none.weights, "premium_cost"),
    `got ${weightOf(contradicted.weights, "premium_cost")} want ${weightOf(none.weights, "premium_cost")}`,
  );

  // Five weak mentions must not outrank one strong, confident statement.
  const manyWeak = calculateDynamicWeights(
    base,
    Array.from({ length: 5 }, (_, i) =>
      signal({ dimension: "premium_cost", strength: 0.2, confidence: 0.3, source: "inferred", reason: `weak ${i}`, evidence: { table: "t", id: `w${i}` } }),
    ),
    record,
  );
  const oneStrong = calculateDynamicWeights(base, [signal({ dimension: "premium_cost", strength: 1, confidence: 1 })], record);
  check(
    "five weak signals do not out-push one strong one",
    weightOf(manyWeak.weights, "premium_cost") <= weightOf(oneStrong.weights, "premium_cost"),
    `weak ${weightOf(manyWeak.weights, "premium_cost")} vs strong ${weightOf(oneStrong.weights, "premium_cost")}`,
  );
  check(
    "a single maximal signal cannot move a weight past the cap",
    Math.abs(oneStrong.explanation.find((e) => e.criterionId === "premium_cost")!.shift) <= MAX_SIGNAL_SHIFT + 1e-9,
  );

  // A criterion the record cannot be scored on is not weightable, whatever
  // was said about it.
  const irrelevant = calculateDynamicWeights(base, [signal({ dimension: "chronic_depth", strength: 1, confidence: 1 })], record);
  check("irrelevant dimension never enters the weight set", !irrelevant.weights.some((w) => w.criterionId === "chronic_depth"));

  // A criterion outside the baseline can be RAISED into it, but not lowered
  // into it — you cannot de-prioritise what was never weighted.
  const added = calculateDynamicWeights(base, [signal({ dimension: "network_access", strength: 0.9, confidence: 0.9 })], record);
  check("a signalled new criterion joins the set", added.weights.some((w) => w.criterionId === "network_access"));
  const lowered = calculateDynamicWeights(base, [signal({ dimension: "network_access", direction: "decrease", strength: 0.9, confidence: 0.9 })], record);
  check("a decrease on an unweighted criterion is a no-op", !lowered.weights.some((w) => w.criterionId === "network_access"));

  check("never more than MAX_CRITERIA weighted", added.weights.length <= 5);

  // ---------------------------------------------------------------------
  // 3. Signal extraction and validation — the closed vocabulary
  // ---------------------------------------------------------------------
  console.log("\n3. signalsFromRecord / validateSignals");
  const tagged: AssessmentRecord = {
    ...record,
    priorities: [
      { id: "p1", rawText: "keep the premium down", tag: "premium" },
      { id: "p2", rawText: "dental cover would be good", tag: "other" },
      { id: "p3", rawText: "ongoing condition cover", tag: "chronic_depth" },
    ],
  };
  const deterministic = signalsFromRecord(tagged);
  check("a tagged priority becomes a signal with no model", deterministic.some((s) => s.dimension === "premium_cost"));
  check("the signal carries its provenance row", deterministic.find((s) => s.dimension === "premium_cost")?.evidence?.table === "application_priority");
  check(
    "an irrelevant tag produces nothing (no declared condition)",
    !deterministic.some((s) => s.dimension === "chronic_depth"),
  );
  // `dental_optical` is the one criterion with no tag of its own in
  // `priorityTagEnum`, so it is read from the words — the same read
  // `isCriterionRelevant` performs, kept in step with it.
  check(
    "dental/optical is read from the words, since it has no tag of its own",
    deterministic.some((s) => s.dimension === "dental_optical"),
  );
  check(
    "...and is absent when nobody mentioned it",
    !signalsFromRecord({ ...tagged, priorities: [{ id: "p1", rawText: "keep the premium down", tag: "premium" }] }).some(
      (s) => s.dimension === "dental_optical",
    ),
  );
  check("re-extraction does not stack duplicates", signalsFromRecord(tagged).length === deterministic.length);

  const { signals: valid, dropped } = validateSignals(
    [
      { dimension: "coverage", direction: "increase", strength: 0.9, confidence: 0.95 },
      { dimension: "chronic_depth", direction: "increase", strength: 0.9, confidence: 0.9 },
      { dimension: "premium_cost", direction: "sideways", strength: 0.5, confidence: 0.5 },
      { dimension: "premium_cost", direction: "decrease", strength: 5, confidence: -2 },
    ],
    record,
  );
  check('the brief\'s "coverage" dimension is dropped, not repaired', dropped.some((d) => d.includes("coverage")));
  check("an irrelevant dimension is dropped", dropped.some((d) => d.includes("chronic_depth")));
  check("an unknown direction is dropped", dropped.some((d) => d.includes("sideways")));
  check("out-of-range strength/confidence are clamped, not dropped", valid.length === 1 && valid[0].strength === 1 && valid[0].confidence === 0);

  // ---------------------------------------------------------------------
  // 4. The two thresholds — termination is structural
  // ---------------------------------------------------------------------
  console.log("\n4. routeAfterSignals (negotiation thresholds)");
  const rounds = (n: number) => Array.from({ length: n }, (_, i) => ({ round: i + 1, rejectedPlanIds: ["plan_a"], reason: "too expensive" }));
  const routeLabel = (r: ReturnType<typeof routeAfterSignals>) => (Array.isArray(r) ? r.join("+") : r);

  const cases: [string, Partial<RecommendationStateType>, string][] = [
    ["round 1, nothing rejected -> build", { previousRounds: [], round: 1 }, "price+weights"],
    ["rejection, turns left -> negotiate", { previousRounds: rounds(1), round: 2, negotiationTurns: 0 }, "negotiate"],
    ["rejection, one turn used -> negotiate", { previousRounds: rounds(1), round: 2, negotiationTurns: 1 }, "negotiate"],
    ["negotiation budget spent -> forced rebuild", { previousRounds: rounds(2), round: 3, negotiationTurns: MAX_NEGOTIATION_TURNS }, "price+weights"],
    ["round budget spent -> compromise", { previousRounds: rounds(MAX_RECOMMENDATION_ROUNDS), round: MAX_RECOMMENDATION_ROUNDS + 1, negotiationTurns: 0 }, "compromise"],
    ["round budget spent beats an unspent negotiation budget", { previousRounds: rounds(9), round: 10, negotiationTurns: 0 }, "compromise"],
  ];
  for (const [label, patch, want] of cases) {
    const got = routeLabel(routeAfterSignals(baseState(catalogue, patch)));
    check(label, got === want, `got "${got}" want "${want}"`);
  }

  // The property that actually matters: an applicant who rejects everything,
  // forever, reaches a terminal state. Walk the thresholds the way the
  // session layer does — rejections accumulate, turns accumulate — and assert
  // it lands on `compromise` in a bounded number of steps.
  let state = baseState(catalogue, { previousRounds: [], round: 1, negotiationTurns: 0 });
  let steps = 0;
  let terminal = false;
  while (steps++ < 50) {
    const route = routeAfterSignals(state);
    if (route === "compromise") {
      terminal = true;
      break;
    }
    const negotiated = route === "negotiate";
    const rejections = state.previousRounds.length + (negotiated ? 0 : 1);
    state = baseState(catalogue, {
      previousRounds: rounds(Math.max(1, rejections)),
      round: Math.max(1, rejections) + 1,
      // A negotiate turn is counted; a rebuild does not reset it.
      negotiationTurns: state.negotiationTurns + (negotiated ? 1 : 0),
    });
  }
  check("an applicant who rejects everything terminates", terminal, `after ${steps} step(s)`);
  check("and terminates well inside the budget", steps <= (MAX_RECOMMENDATION_ROUNDS + 1) * (MAX_NEGOTIATION_TURNS + 1), `${steps} steps`);

  // ---------------------------------------------------------------------
  // 5. Low weight-confidence reaches the applicant, and verify's derived figures
  // ---------------------------------------------------------------------
  console.log("\n5. routeAfterVerify (weight confidence) and verify (derived figures)");
  const shaky = {
    weightConfidence: 0.3,
    weightExplanation: [
      { criterionId: "premium_cost" as const, baseWeight: 0.3, shift: 0.2, finalWeight: 0.5, drivenBy: [signal({ dimension: "premium_cost", confidence: 0.2 })] },
      { criterionId: "need_coverage" as const, baseWeight: 0.4, shift: 0.05, finalWeight: 0.45, drivenBy: [signal({ dimension: "need_coverage", confidence: 0.9 })] },
    ],
  };
  check("confident shortlist on shaky weights asks the applicant", routeAfterVerify(baseState(catalogue, shaky)) === "clarify");
  check("...but only once", routeAfterVerify(baseState(catalogue, { ...shaky, clarificationAsked: true })) === "gate");
  check("a fallback still outranks it", routeAfterVerify(baseState(catalogue, { ...shaky, fellBackTo: "x" })) === "gate");
  check(
    "weights above the floor present as normal",
    routeAfterVerify(baseState(catalogue, { ...shaky, weightConfidence: WEIGHT_CONFIDENCE_FLOOR + 0.01 })) === "present",
  );
  check("the question targets the weakest-evidence criterion", weakestWeightTarget(baseState(catalogue, shaky)) === "premium_cost");

  // The scenario `out_of_pocket_exposure` is measured under is the RECORD's
  // own, not a fixed middle. This is the criterion `verify` can never check,
  // because the figure never passes through a tool — so it is checked here.
  check(
    "a record with declared needs is scored on its own basket",
    scenarioForRecord(record) === "CUSTOM_FROM_APPLICANT",
    scenarioForRecord(record),
  );
  check(
    "a record with a declared condition is scored on the chronic basket",
    scenarioForRecord({ ...emptyRecord(), conditions: [{ id: "c1", rawText: "asthma", conditionCode: null, stability: "managed" }] }) === "HIGH_OUTPATIENT",
  );
  check("a bare record falls back to the neutral middle", scenarioForRecord(emptyRecord()) === "MEDIUM_OUTPATIENT");
  const exposureScored = scorePlans(catalogue.plans, record, catalogue, [
    { criterionId: "premium_cost", weight: 0.5 },
    { criterionId: "out_of_pocket_exposure", weight: 0.5 },
  ]);
  check(
    "the basket behind the score travels out with it",
    exposureScored.exposureScenario?.id === "CUSTOM_FROM_APPLICANT",
    JSON.stringify(exposureScored.exposureScenario),
  );
  check(
    "...and is absent when that criterion was not weighted",
    scorePlans(catalogue.plans, record, catalogue, [{ criterionId: "premium_cost", weight: 0.5 }]).exposureScenario === null,
  );

  const eligiblePlan = catalogue.plans[0];
  const verifyState = baseState(catalogue, {
    record: { ...emptyRecord(), applicationId: "test", age: 30 },
    shortlist: [{ planId: eligiblePlan.id, rank: 1 }],
    trace: [
      {
        step: 1,
        thought: "",
        tool: "estimate_annual_cost",
        args: null,
        validation: "ok",
        observationSummary: JSON.stringify({ outpatientVisits: 8, unitCost: 350, annualPremium: 4200, deductible: 1500 }),
        latencyMs: 1,
      },
    ],
  });
  const derived = verify({ ...verifyState, brokerReasoning: "8 visits at 350 comes to 2800, on top of the 4200 premium", memberReasoning: "" });
  check("a figure the trace can reproduce (8 x 350 = 2800) is accepted", derived.verifyFailed === false, derived.recoUncertaintyReason ?? "");
  const invented = verify({ ...verifyState, brokerReasoning: "this plan costs about 9999 a year", memberReasoning: "" });
  check("a figure nothing can reproduce is still rejected", invented.verifyFailed === true);

  // ---------------------------------------------------------------------
  // 5b. deriveRecord — the precondition everything below depends on
  // ---------------------------------------------------------------------
  console.log("\n5b. deriveImplicitNeeds / splitPriorities");

  // The shape the real failing record had: a declared condition, NO need row,
  // and two priorities crammed into one `other`-tagged row. Before
  // `deriveRecord`, `isEligible` was vacuously true for every plan on a
  // record like this, so the plan that does not cover the condition was never
  // ruled out and no trade-off could be detected.
  const undeclared: AssessmentRecord = {
    ...emptyRecord(),
    applicationId: "undeclared",
    age: 41,
    conditions: [{ id: "c1", rawText: "High blood pressure", conditionCode: null, stability: "managed" }],
    needs: [],
    priorities: [{ id: "p1", rawText: "Good hospital access, Low co-pay or deductible", tag: "other" }],
  };

  check("5b. a record with a condition and no need had NO ineligible plan", catalogue.plans.every((p) => isEligible(p, undeclared)));
  check("5b. ...so no trade-off could be detected", detectTradeOff({ record: undeclared, catalogue, quotes: priceAllPlans(catalogue, undeclared), currentPlanId: "plan_b", objection: "can we go for essential" }) === null);
  check("5b. ...and need_coverage could never be weighted", !isCriterionRelevant("need_coverage", undeclared));
  check("5b. ...and the deterministic signal floor produced nothing", signalsFromRecord(undeclared).length === 0);

  const readRecord = deriveRecord(undeclared);
  check("5b. the declared condition now implies a need", readRecord.needs.length === 1 && readRecord.needs[0].benefitClass === "chronic_preexisting", JSON.stringify(readRecord.needs));
  check("5b. the derived need is marked as derived, not passed off as a row", isDerivedNeedId(readRecord.needs[0].id), readRecord.needs[0].id);
  check("5b. it claims no horizon nobody stated", readRecord.needs[0].horizonMonths === null);
  check("5b. the plan that does not cover it is now ineligible", isEligible(catalogue.plans.find((p) => p.id === "plan_a")!, readRecord) === false);
  check("5b. the plans that do cover it stay eligible", ["plan_b", "plan_c"].every((id) => isEligible(catalogue.plans.find((p) => p.id === id)!, readRecord)));
  check("5b. need_coverage becomes weightable", isCriterionRelevant("need_coverage", readRecord));
  check(
    "5b. waiting_period_fit stays irrelevant — covered-after-a-wait is a scoring question, not eligibility",
    !isCriterionRelevant("waiting_period_fit", readRecord),
  );
  check(
    "5b. and the trade-off now fires on the same objection",
    detectTradeOff({ record: readRecord, catalogue, quotes: priceAllPlans(catalogue, readRecord), currentPlanId: "plan_b", objection: "can we go for essential" })?.cheaperPlanId === "plan_a",
  );

  // Several conditions are still ONE need: every gate asks "does this plan
  // cover pre-existing conditions", which is one test, and `need_coverage`
  // counts needs served — so one per diagnosis would triple-count one fact.
  const multi = deriveRecord({
    ...undeclared,
    conditions: [
      { id: "c1", rawText: "High blood pressure", conditionCode: null, stability: "managed" },
      { id: "c2", rawText: "Type 2 diabetes", conditionCode: null, stability: "managed" },
      { id: "c3", rawText: "Asthma", conditionCode: null, stability: "unknown" },
    ],
  });
  check("5b. three conditions still derive exactly one need", multi.needs.length === 1, `${multi.needs.length}`);
  check("5b. and it names them all", multi.needs[0].rawText.includes("High blood pressure") && multi.needs[0].rawText.includes("Asthma"));

  // Never override what the applicant actually stated.
  const stated: AssessmentRecord = {
    ...undeclared,
    needs: [{ id: "real", rawText: "cover my BP from day one", benefitClass: "chronic_preexisting", horizonMonths: 0 }],
  };
  check("5b. an explicit chronic need is never duplicated", deriveRecord(stated).needs.length === 1 && deriveRecord(stated).needs[0].id === "real");
  check("5b. a record with no conditions is left alone", deriveRecord({ ...emptyRecord(), applicationId: "x" }).needs.length === 0);

  // Priorities.
  check("5b. a comma-joined priority is split", readRecord.priorities.length === 2, JSON.stringify(readRecord.priorities.map((p) => p.rawText)));
  check("5b. each fragment is tagged on its own words", readRecord.priorities.map((p) => p.tag).join(",") === "network_access,outpatient_terms", readRecord.priorities.map((p) => p.tag).join(","));
  check("5b. fragment ids stay traceable to the row they came from", readRecord.priorities.every((p) => p.id.startsWith("p1#")));
  check("5b. and the floor now produces signals where it produced none", signalsFromRecord(readRecord).length > 0, signalsFromRecord(readRecord).map((sig) => sig.dimension).join(", "));

  const alreadyTagged = splitPriorities([{ id: "p9", rawText: "Lowest premium", tag: "premium" }]);
  check("5b. a single priority is left exactly as it was", alreadyTagged.length === 1 && alreadyTagged[0].id === "p9" && alreadyTagged[0].tag === "premium");
  const statedTag = splitPriorities([{ id: "p8", rawText: "cheap cover, wide network", tag: "premium" }]);
  check("5b. a tag the applicant actually chose is never re-derived from prose", statedTag.every((p) => p.tag === "premium"), statedTag.map((p) => p.tag).join(","));

  // ---------------------------------------------------------------------
  // 6. The trade-off — the transcript this whole branch exists for
  // ---------------------------------------------------------------------
  console.log("\n6. detectTradeOff / describeTradeOff / signalsForChoice");

  // The real case: 18, diabetes (managed), declared a need for cover for it,
  // and told us their priority is the lowest premium. Essential is the
  // cheapest plan on the panel and does not cover pre-existing conditions at
  // all, so `isEligible` strips it — no weighting can ever put it in front of
  // them, and "could we go for Essential?" has no answer a rebuild can give.
  const conflicted: AssessmentRecord = {
    ...emptyRecord(),
    applicationId: "conflicted",
    age: 18,
    conditions: [{ id: "c1", rawText: "Diabetes", conditionCode: null, stability: "managed" }],
    needs: [{ id: "n1", rawText: "cover for my diabetes", benefitClass: "chronic_preexisting", horizonMonths: 6 }],
    priorities: [{ id: "pr1", rawText: "Lowest premium", tag: "premium" }],
  };
  const conflictedQuotes = priceAllPlans(catalogue, conflicted);

  const detected = detectTradeOff({
    record: conflicted,
    catalogue,
    quotes: conflictedQuotes,
    currentPlanId: "plan_b",
    objection: "Could we reduce the price a bit, could we go for essential ?",
  });
  check("6. the conflict is detected at all", detected != null);
  check("6. it names the plan the applicant actually asked for", detected?.cheaperPlanId === "plan_a", detected?.cheaperPlanId);
  check("6. it knows what that plan fails", detected?.notCoveredAtAll === true && detected.requirement.includes("condition"), detected?.requirement);
  check("6. it states the real saving", detected?.saving === 8900 - 4200, `${detected?.saving}`);

  // No conflict when the cheaper plan is merely worse rather than ruled out:
  // that is an ordinary price objection and rebuilding is the right answer.
  const healthy = { ...emptyRecord(), applicationId: "healthy", age: 26 };
  check(
    "6. a cheaper ELIGIBLE plan is not a trade-off",
    detectTradeOff({ record: healthy, catalogue, quotes: priceAllPlans(catalogue, healthy), currentPlanId: "plan_c", objection: "too expensive" }) === null,
  );
  check(
    "6. and neither is an objection about something other than a cheaper plan",
    detectTradeOff({ record: conflicted, catalogue, quotes: conflictedQuotes, currentPlanId: "plan_a", objection: "the network is too small" }) === null,
  );

  if (detected) {
    const described = describeTradeOff(detected);
    check("6. the question names both plans and both sides", described.question.includes("Essential") && described.question.includes("Balanced"));
    check("6. every figure in it is a plan term, so nothing needs citing", described.question.includes("4,200") && described.question.includes("4,700"), described.question);

    // The point of the whole thing: the answer MOVES THE WEIGHTS, by a route
    // decided before the applicant ever saw the question.
    const cohortBase = suggestDefaultWeights(conflicted, "chronic_managed_adult");
    const keptCover = calculateDynamicWeights(cohortBase, signalsForChoice("requirement", detected), conflicted);
    const choseCheap = calculateDynamicWeights(cohortBase, signalsForChoice("premium", detected), conflicted);
    check(
      "6. choosing cover raises the coverage criteria",
      weightOf(keptCover.weights, "chronic_depth") > weightOf(cohortBase, "chronic_depth"),
      `${weightOf(cohortBase, "chronic_depth")} -> ${weightOf(keptCover.weights, "chronic_depth")}`,
    );
    check(
      "6. choosing the premium raises premium_cost",
      weightOf(choseCheap.weights, "premium_cost") > weightOf(cohortBase, "premium_cost"),
      `${weightOf(cohortBase, "premium_cost")} -> ${weightOf(choseCheap.weights, "premium_cost")}`,
    );
    check("6. the two answers pull in opposite directions", weightOf(choseCheap.weights, "premium_cost") > weightOf(keptCover.weights, "premium_cost"));
    check("6. an answer carries the highest confidence the system issues", keptCover.confidence >= 0.9, `${keptCover.confidence}`);
  }

  // Reading the reply. Fails SAFE: anything ambiguous keeps the cover.
  const answers: [string, "premium" | "requirement"][] = [
    ["yes essential is fine, I want the cheapest", "premium"],
    ["I don't need the condition cover, just make it cheap", "premium"],
    ["the lower premium matters more", "premium"],
    ["no, I need my diabetes covered", "requirement"],
    ["keeping the cover matters more", "requirement"],
    ["cover is more important than price", "requirement"],
    ["hmm", "requirement"],
    ["not sure", "requirement"],
    ["", "requirement"],
  ];
  for (const [text, want] of answers) {
    const got = readTradeOffAnswer(text);
    check(`6. "${text || "(empty)"}" reads as ${want}`, got === want, `got ${got}`);
  }

  // And the router: this fires BEFORE negotiate, and only once.
  const conflictState = baseState(catalogue, {
    record: conflicted,
    quotes: conflictedQuotes,
    previousRounds: [{ round: 1, rejectedPlanIds: ["plan_b"], reason: "Could we reduce the price a bit, could we go for essential ?" }],
    round: 2,
  });
  check("6. the router asks instead of arguing", routeLabel(routeAfterSignals(conflictState)) === "tradeOff");
  check(
    "6. and never asks twice",
    routeLabel(routeAfterSignals({ ...conflictState, tradeOffAsked: true })) === "negotiate",
  );

  // ---------------------------------------------------------------------
  // 7. The backstop: a price objection answered with a costlier plan
  // ---------------------------------------------------------------------
  console.log("\n7. verify (price objection guard)");
  const wentUp = verify(
    baseState(catalogue, {
      record: conflicted,
      quotes: conflictedQuotes,
      previousRounds: [{ round: 1, rejectedPlanIds: ["plan_b"], reason: "could we reduce the price" }],
      shortlist: [{ planId: "plan_c", rank: 1 }],
      brokerReasoning: "Comprehensive is the better fit",
      memberReasoning: "Comprehensive is the better fit",
      recoConfidence: "high",
      fellBackTo: null,
    }),
  );
  // plan_a is ineligible here, so nothing cheaper than plan_b was actually
  // available — not a failure, but it cannot be presented as a confident
  // match either.
  check("7. going up with nothing cheaper available is flagged, not failed", wentUp.verifyFailed === false && wentUp.recoConfidence === "low", `${wentUp.recoUncertaintyReason}`);
  check("7. and the reason says nothing cheaper exists", (wentUp.recoUncertaintyReason ?? "").includes("Nothing cheaper"), wentUp.recoUncertaintyReason ?? "");

  const hadCheaper = verify(
    baseState(catalogue, {
      record: healthy,
      quotes: priceAllPlans(catalogue, healthy),
      previousRounds: [{ round: 1, rejectedPlanIds: ["plan_b"], reason: "too expensive, something cheaper please" }],
      shortlist: [{ planId: "plan_c", rank: 1 }],
      brokerReasoning: "Comprehensive is the better fit",
      memberReasoning: "Comprehensive is the better fit",
      recoConfidence: "high",
      fellBackTo: null,
    }),
  );
  check("7. going up when something cheaper WAS eligible is a verify failure", hadCheaper.verifyFailed === true, hadCheaper.recoUncertaintyReason ?? "");
  check("7. and it routes to a person", routeAfterVerify(baseState(catalogue, { ...hadCheaper, verifyFailed: true } as Partial<RecommendationStateType>)) === "gate");

  const wentDown = verify(
    baseState(catalogue, {
      record: healthy,
      quotes: priceAllPlans(catalogue, healthy),
      previousRounds: [{ round: 1, rejectedPlanIds: ["plan_c"], reason: "too expensive" }],
      shortlist: [{ planId: "plan_a", rank: 1 }],
      brokerReasoning: "Essential is cheaper",
      memberReasoning: "Essential is cheaper",
      recoConfidence: "high",
      fellBackTo: null,
    }),
  );
  check("7. answering a price objection with something cheaper passes", wentDown.verifyFailed === false);

  // ---------------------------------------------------------------------
  // 8-10. Session layer
  // ---------------------------------------------------------------------
  const [testUser] = await db.select({ id: appUser.id, fullName: appUser.fullName }).from(appUser).where(eq(appUser.role, "applicant")).limit(1);
  if (!testUser) {
    console.log("\nno seeded applicant user found — skipping 8-10 (run `bun run db:seed` first)");
  } else {
    await sessionTests(testUser, catalogue, conflicted, conflictedQuotes);
  }

  console.log(`\n${failures === 0 ? "all checks pass" : `${failures} check(s) failed`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

const draft = (age: number) => ({ ...emptyDraft(), age, budget: "comfortable" as const, maritalStatus: "single" as const, smoker: false, emirate: "Dubai" });

async function newSyntheticApplication(testUser: { id: string; fullName: string }, age: number) {
  const applicationId = await createApplication(testUser, draft(age), "web_form");
  try {
    await validateAndClassify(applicationId);
  } catch (error) {
    // `validateAndClassify` auto-schedules recommendation through Next's
    // `after()`, which only exists inside a request. The assessment row it
    // needs is already written by then — same accommodation check-clarify.ts
    // makes, for the same reason.
    if (!(error instanceof Error) || !error.message.includes("outside a request scope")) throw error;
  }
  const [row] = await db.select({ personId: application.personId }).from(application).where(eq(application.id, applicationId)).limit(1);
  const [convo] = await db
    .insert(conversation)
    .values({ channel: "web_chat", purpose: "intake", status: "active", userId: testUser.id, personId: row!.personId, applicationId })
    .returning();
  return { applicationId, conversationId: convo.id };
}

async function wipeApplication(applicationId: string, conversationId: string | null) {
  await db.delete(applicationPreferenceSignal).where(eq(applicationPreferenceSignal.applicationId, applicationId));
  await db.delete(conversationAction).where(eq(conversationAction.subjectId, applicationId));
  await db.delete(aiDecision).where(eq(aiDecision.subjectId, applicationId));
  await db.delete(quote).where(eq(quote.applicationId, applicationId));
  await db.delete(recommendation).where(eq(recommendation.applicationId, applicationId));
  if (conversationId) await db.delete(conversation).where(eq(conversation.id, conversationId));
  await db.run(sql`pragma foreign_keys = off`);
  try {
    await db.delete(application).where(eq(application.id, applicationId));
  } finally {
    await db.run(sql`pragma foreign_keys = on`);
  }
}

async function liveSignals(applicationId: string) {
  return db
    .select()
    .from(applicationPreferenceSignal)
    .where(and(eq(applicationPreferenceSignal.applicationId, applicationId), isNull(applicationPreferenceSignal.supersededAt)));
}

async function sessionTests(
  testUser: { id: string; fullName: string },
  catalogue: Catalogue,
  conflicted: AssessmentRecord,
  conflictedQuotes: ReturnType<typeof priceAllPlans>,
) {
  console.log("\n8-10. signal persistence, decay, and the negotiation counter");
  const { applicationId, conversationId } = await newSyntheticApplication(testUser, 29);

  try {
    // --- 8: append-only, supersede-on-contradiction ---
    const now = new Date();
    const insert = (patch: Partial<PreferenceSignal> & Pick<PreferenceSignal, "dimension">, round: number) =>
      db.insert(applicationPreferenceSignal).values({
        applicationId,
        dimension: patch.dimension,
        direction: patch.direction ?? "increase",
        strength: patch.strength ?? 0.6,
        confidence: patch.confidence ?? 0.9,
        source: patch.source ?? "explicit",
        reason: patch.reason ?? "test",
        evidenceTable: patch.evidence?.table ?? null,
        evidenceId: patch.evidence?.id ?? null,
        round,
      });

    await insert({ dimension: "need_coverage", direction: "increase" }, 1);
    check("8. a signal is live once written", (await liveSignals(applicationId)).length === 1);

    // The applicant changes their mind in a later round.
    await db
      .update(applicationPreferenceSignal)
      .set({ supersededAt: now })
      .where(and(eq(applicationPreferenceSignal.applicationId, applicationId), eq(applicationPreferenceSignal.dimension, "need_coverage")));
    await insert({ dimension: "need_coverage", direction: "decrease", source: "rejection" }, 3);

    const live = await liveSignals(applicationId);
    check("8. only the newest reading of a dimension is live", live.length === 1 && live[0].direction === "decrease");
    const all = await db.select().from(applicationPreferenceSignal).where(eq(applicationPreferenceSignal.applicationId, applicationId));
    check("8. the superseded row is kept, not deleted", all.length === 2, `${all.length} row(s) on file`);

    // --- 9: decay applies at load, and only to old signals ---
    await insert({ dimension: "premium_cost", confidence: 0.8 }, 1);
    const inputs = await loadRecommendationInputs(applicationId);
    check("9. loadRecommendationInputs returns live signals", inputs != null && inputs.preferenceSignals.length === 2);
    if (inputs) {
      const old = inputs.preferenceSignals.find((s) => s.dimension === "premium_cost");
      const recent = inputs.preferenceSignals.find((s) => s.dimension === "need_coverage");
      // round is 1 here (no rejections on file), so nothing is old enough to
      // decay yet — which is itself the assertion worth making.
      check("9. a fresh signal is not decayed", old?.confidence === 0.8, `got ${old?.confidence}`);
      check("9. the superseded reading is not loaded", recent?.direction === "decrease");
      check("9. round is derived from rejections, not recommendation versions", inputs.round === 1, `got ${inputs.round}`);
      check("9. negotiation turns start at zero", inputs.negotiationTurns === 0);
    }

    // --- 10: the negotiation counter survives, because it is a row count ---
    await persistNegotiation(
      applicationId,
      {
        outcome: "convince",
        reply: "The cheaper plan's wait does not clear your horizon.",
        turnsUsed: 1,
        forced: false,
        extractedSignals: [signal({ dimension: "premium_cost", direction: "increase", source: "rejection", reason: "too expensive" })],
        servedBy: null,
        latencyMs: 0,
      },
      2,
      conversationId,
    );

    const afterNegotiation = await loadRecommendationInputs(applicationId);
    check("10. a negotiation turn is counted from its row", afterNegotiation?.negotiationTurns === 1, `got ${afterNegotiation?.negotiationTurns}`);
    check(
      "10. the objection's own signal was written down",
      (await liveSignals(applicationId)).some((s) => s.dimension === "premium_cost" && s.source === "rejection"),
    );
    check(
      "10. no recommendation row was written by a convince turn",
      (await db.select().from(recommendation).where(eq(recommendation.applicationId, applicationId))).length === 0,
    );

    // --- 10b: the trade-off answer, as the card actually sends it ---
    const tradeOffApp = await newSyntheticApplication(testUser, 19);
    try {
      const detectedForApp = detectTradeOff({
        record: conflicted,
        catalogue,
        quotes: conflictedQuotes,
        currentPlanId: "plan_b",
        objection: "could we go for essential",
      })!;
      const describedForApp = describeTradeOff(detectedForApp);

      await db.insert(conversationAction).values({
        conversationId: tradeOffApp.conversationId,
        actionType: "recommendation_tradeoff_asked",
        arguments: { round: 2, question: describedForApp.question, options: describedForApp.options, tradeOff: detectedForApp },
        subjectType: "application",
        subjectId: tradeOffApp.applicationId,
        status: "succeeded",
        actorKind: "system",
        completedAt: new Date(),
      });

      const readBack = await openTradeOffQuestion(tradeOffApp.applicationId);
      check("10b. the question is readable back off its own row", readBack?.options.premium === describedForApp.options.premium);

      // The button path: an explicit choice, so nothing is interpreted.
      const first = await recordTradeOffAnswer(
        tradeOffApp.applicationId,
        tradeOffApp.conversationId,
        describedForApp.options.premium,
        { userId: testUser.id },
        "premium",
      );
      check("10b. a pressed button records the choice", first.recorded && first.choice === "premium");
      check("10b. choosing the premium over a declared need goes to an advisor", first.needsAdvisor);

      const written = await liveSignals(tradeOffApp.applicationId);
      check(
        "10b. the bound signals are written, not interpreted",
        written.some((s) => s.dimension === "premium_cost" && s.direction === "increase" && s.confidence === 0.95) &&
          written.some((s) => s.dimension === "chronic_depth" && s.direction === "decrease"),
        written.map((s) => `${s.dimension}:${s.direction}`).join(", "),
      );

      const advisorTasks = await db
        .select({ id: reviewTask.id })
        .from(reviewTask)
        .where(and(eq(reviewTask.subjectType, "application"), eq(reviewTask.subjectId, tradeOffApp.applicationId)));
      check("10b. an advisor task is open on it", advisorTasks.length >= 1);

      // A double-click, or a stale tab: the partial unique index means the
      // second press writes nothing rather than a second set of signals.
      const second = await recordTradeOffAnswer(
        tradeOffApp.applicationId,
        tradeOffApp.conversationId,
        describedForApp.options.requirement,
        { userId: testUser.id },
        "requirement",
      );
      check("10b. a second press writes nothing", second.recorded === false);
      const afterSecondPress = await liveSignals(tradeOffApp.applicationId);
      check(
        "10b. and cannot reverse the signals already written",
        afterSecondPress.length === written.length &&
          afterSecondPress.every((s) => written.some((w) => w.id === s.id)),
      );
    } finally {
      // `ai_decision.review_task_id` is a real FK, so the decisions have to go
      // before the tasks they point at — `wipeApplication` deletes the former
      // but runs after this, which is what makes the order matter here.
      await db.delete(aiDecision).where(eq(aiDecision.subjectId, tradeOffApp.applicationId));
      await db.delete(reviewTask).where(and(eq(reviewTask.subjectType, "application"), eq(reviewTask.subjectId, tradeOffApp.applicationId)));
      await wipeApplication(tradeOffApp.applicationId, tradeOffApp.conversationId);
    }

    // Counted a second time, it is a second turn — nothing resets.
    await persistNegotiation(
      applicationId,
      { outcome: "concede", reply: "", turnsUsed: 2, forced: true, extractedSignals: [], servedBy: null, latencyMs: 0 },
      3,
      conversationId,
    );
    const afterSecond = await loadRecommendationInputs(applicationId);
    check("10. a second turn does not reset the budget", afterSecond?.negotiationTurns === 2, `got ${afterSecond?.negotiationTurns}`);
    check(
      "10. the budget is now spent, so the next round rebuilds rather than argues",
      afterSecond != null && afterSecond.negotiationTurns >= MAX_NEGOTIATION_TURNS,
    );
  } finally {
    await wipeApplication(applicationId, conversationId);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
