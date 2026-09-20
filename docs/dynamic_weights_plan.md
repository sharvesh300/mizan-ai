# Dynamic weight allocation, preference memory, and bounded negotiation

Rewrite of the recommendation phase so that weights are *derived* (default policy
+ preference signals + confidence) instead of picked freely by the agent inside a
±0.15 envelope, with signals that persist and improve across rounds, a
human-in-the-loop when confidence is low, and a negotiation loop that terminates.

Scope: `lib/recommendation/*`, `lib/ai/graph/*`, `lib/ai/tools/plans.ts`,
`lib/ai/recommendation-session.ts`, `db/schema/*`, plus one correctness fix in
the scenario-constant path that `verify` currently cannot catch.

---

## 0. Where the system is today (facts, not plan)

- `suggestDefaultWeights(record, cohort)` (`lib/recommendation/default-weights.ts`)
  returns ≤3 cohort priorities, clamped to `[0.05, 0.6]`, normalised, rounded.
- `score_plans` (`lib/ai/tools/plans.ts`) enforces: baseline must have been
  requested this round, the agent's criteria must overlap it, and every
  overlapping criterion must stay within `WEIGHT_DELTA = 0.15` of the baseline.
- `scorePlans` (`lib/recommendation/score.ts`) min-max normalises each criterion
  across the panel, then renormalises the weights to sum to 1.
- There is **no** preference-signal concept anywhere: no state channel, no table,
  no extractor. Applicant priorities exist only as free text
  (`application_priority.rawText`) and as the `clarify` answer.
- Rounds are unbounded. `previousRounds` is rebuilt from every
  `reject_shortlist` `conversation_action` row; nothing caps them and nothing
  argues back — a rejection re-runs the whole agent loop from scratch.
- Low confidence has exactly two outcomes today (`routeAfterVerify`): one
  clarifying question to the applicant (once, ever) or the advisor gate.

---

## 1. Preference signals become a first-class, closed vocabulary

**Problem with the shape in the prompt.** `dimension: "coverage" | "premium"` is
a *third* vocabulary alongside `CriterionId` (8 ids) and `BenefitClass` (4). A
signal that cannot be pointed at a criterion cannot move a weight, so it is
dead data. Also `{coverage: increase 0.9}` + `{premium: decrease 0.7, reason:
"willing to pay more"}` is self-contradictory: the reason says premium matters
*less*, the direction says cost should go *down*. That contradiction is exactly
what a closed vocabulary prevents.

**Decision:** `dimension` is a `CriterionId`. `direction` means *importance*, not
value direction (the value direction already lives in `CriterionDef.direction`).

```ts
// lib/recommendation/preference.ts (new)
export type PreferenceSignal = {
  dimension: CriterionId;                       // closed: the 8 scoring criteria
  direction: "increase" | "decrease";           // importance of this criterion
  strength: number;                             // 0..1, how hard to push
  confidence: number;                           // 0..1, how sure we are it was said
  source: "explicit" | "clarification" | "rejection" | "inferred";
  reason: string;                               // one line, quoted from or grounded in the record
  evidence: { table: string; id: string } | null; // provenance, same discipline as ScenarioProvenance
};
```

The example in the prompt maps to:
`{ dimension: "need_coverage", direction: "increase", strength: 0.9, confidence: 0.95, source: "explicit" }`
and `{ dimension: "premium_cost", direction: "decrease", strength: 0.7, confidence: 0.9, source: "explicit" }`
— "willing to pay more" = premium *matters less*.

**Extraction** — new node `signals` (`lib/ai/graph/nodes/signals.ts`):
- inputs: `record.priorities` (raw text), `record.needs`, the clarification
  answer, and this round's rejection reason (`previousRounds.at(-1)`).
- one `structuredCall`, `SIGNALS_PROMPT_VERSION = "signals-v1"`, output validated
  by zod against `CRITERION_IDS` and `isCriterionRelevant(dimension, record)`.
- **fails closed**: any invalid signal is dropped, not repaired; zero signals is
  a legal outcome and means the weights are the cohort baseline unchanged.
- deterministic floor: an explicit `application_priority` whose tag maps onto a
  criterion yields a signal even with no model (`isAgentEnabled() === false`),
  so the engine never depends on a live model to function.

---

## 2. The dynamic weight engine (pure, testable, no I/O)

`lib/recommendation/dynamic-weights.ts`:

```ts
export const MAX_SIGNAL_SHIFT = 0.25;   // the most one criterion can move, total
export const NEW_CRITERION_SEED = 0.15; // weight a signalled, unbaselined criterion enters at

export function calculateDynamicWeights(
  baseWeights: CriterionWeight[],      // suggestDefaultWeights(record, cohort)
  signals: PreferenceSignal[],
  record: AssessmentRecord,
): DynamicWeightResult
```

Algorithm, in order:

1. **Aggregate per dimension.** `effect = Σ ± strength × confidence` over signals
   for that criterion (`+` for increase, `−` for decrease), then
   `shift = clamp(effect, -1, 1) × MAX_SIGNAL_SHIFT`.
   Aggregating *before* clamping is what stops five weak repetitions from
   outweighing one strong, confident statement.
2. **Apply.** Criterion in the baseline → `base + shift`. Criterion not in the
   baseline but signalled with `effect > 0` and relevant to the record → enters
   at `NEW_CRITERION_SEED + shift`. Signalled `decrease` on an unbaselined
   criterion is a no-op (you cannot lower what was never weighted).
3. **Clamp** each to `[MIN_WEIGHT, MAX_WEIGHT]`, then **drop** anything at the
   floor that came only from a signal, then keep the top `MAX_CRITERIA (5)` by
   weight — the existing "an agent that weights everything has prioritised
   nothing" rule, enforced here instead of only at `scorePlans`.
4. **Renormalise to sum 1**, round to 2dp, and fix the rounding residue on the
   largest weight so the sum is exactly 1.
5. **Return the audit**, not just the numbers:

```ts
type DynamicWeightResult = {
  weights: CriterionWeight[];
  confidence: number;               // mean signal confidence, weighted by |shift|; 1 when no signal moved anything
  explanation: {
    criterionId: CriterionId;
    baseWeight: number; shift: number; finalWeight: number;
    drivenBy: PreferenceSignal[];   // every signal that touched this criterion
  }[];
};
```

**Known bug to fix while here:** `suggestDefaultWeights` clamps *after* dividing
by the sum, so when only two cohort priorities survive `isCriterionRelevant` the
returned weights need not sum to 1 (e.g. `standard_young_healthy` with
`annual_limit` dropped: `0.71 → 0.6` and `0.29`, sum `0.89`). Harmless today
because `scorePlans` renormalises, misleading the moment weights are shown to a
human or used as a base for shifts. Fix: clamp, then renormalise, then round.

---

## 3. The agent stops picking weights and starts being handed them

`score_plans`'s ±0.15-from-baseline rule exists because the agent's weights were
otherwise ungrounded. With a derived weight set that is no longer the guard it
was — the derivation *is* the grounding.

- `suggest_default_weights` → **`get_dynamic_weights`**: no args, returns
  `{ weights, confidence, explanation }` from `ctx.dynamicWeights` (computed by
  the `weights` node before the loop starts, not by the model).
- `score_plans` keeps `enforceWeightBaseline`, but the baseline is now
  `ctx.dynamicWeights` and `WEIGHT_DELTA` drops to **0.10** — the agent may
  fine-tune around a derived set, not re-litigate it.
- `plan-converse.ts` is unchanged (`enforceWeightBaseline: false`): "what if
  price mattered much more" stays answerable.
- The prompt line changes from "you are not picking weights from nothing" to
  "these weights were derived from this applicant's stated preferences; the
  explanation tells you which statement moved which criterion — use it in
  `brokerReasoning`."

---

## 4. Signals persist and improve over time

New table, `db/schema/preference.ts`:

```
application_preference_signal
  id, application_id → application(id) cascade
  dimension            text  (CriterionId)
  direction            text  ('increase' | 'decrease')
  strength             real  (0..1, CHECK)
  confidence           real  (0..1, CHECK)
  source               text  ('explicit'|'clarification'|'rejection'|'inferred')
  reason               text
  evidence_table, evidence_id   text  (nullable provenance)
  round                integer       (which recommendation round produced it)
  superseded_at        integer ts    (nullable — never UPDATE a signal, supersede it)
  created_at
  index (application_id, superseded_at)
```

- **Append-only.** A round that re-extracts the same dimension writes a new row
  and stamps `superseded_at` on the old one. The history is the learning record;
  an advisor can see the applicant went from "coverage at any price" to "actually
  this is too expensive" across three rounds.
- `loadRecommendationInputs` loads live signals (`superseded_at IS NULL`) into
  `state.preferenceSignals`, exactly as it already rebuilds `previousRounds` and
  `clarificationAsked` from rows — **nothing in the checkpointer**.
- `persistRecommendation` writes the round's signals and the
  `dynamicWeights` audit into `ai_decision.request/response` so the weight set
  behind a live recommendation is reconstructable after the fact.
- **Decay:** a signal older than `SIGNAL_DECAY_ROUNDS = 3` rounds has its
  `confidence` multiplied by `0.5` at load time (not in the DB) — stale
  preferences fade instead of anchoring round 6 to what was said in round 1.

---

## 5. Low confidence → human in the loop (extend, don't replace)

`routeAfterVerify` gains one input: the weight engine's confidence.

```
fallback | verifyFailed                        → advisor gate     (unchanged)
recoConfidence low  ─ never asked              → clarify          (unchanged)
                    ─ already asked            → advisor gate     (unchanged)
weightConfidence < WEIGHT_CONFIDENCE_FLOOR (0.5)
   and never asked                             → clarify, target = the criterion
                                                 with the largest |shift| and the
                                                 weakest signal confidence
   and already asked                           → advisor gate
```

This reuses `clarify` wholesale — closed `CriterionId` target, deterministic
`validateClarification`, one question per application ever, enforced by the
`one_clarify_asked_per_application` partial unique index. The only new thing is
a second *reason* to reach it. The clarification answer comes back in as a
`source: "clarification"` signal with `confidence: 0.95`, which is the loop that
actually closes: a question asked because a weight was uncertain directly
raises that weight's confidence next round.

---

## 6. Negotiation: the agent argues its case, exactly twice

Today a `reject_shortlist` silently re-runs everything. New node
`negotiate` (`lib/ai/graph/nodes/negotiate.ts`), entered when a rejection exists
and the round budget is not spent.

```
MAX_NEGOTIATION_TURNS = 2   // times the agent may defend the current shortlist
MAX_RECOMMENDATION_ROUNDS = 3 // times a NEW shortlist may be built
```

Per rejection:

1. `signals` extracts signals from the rejection reason (`source: "rejection"`).
2. `negotiate` decides, with the **read-only** tool registry (every tool except
   `propose_shortlist`), between two outcomes:
   - **`convince`** — the objection is answerable from plan facts the applicant
     has not weighed (the cheaper plan's waiting period does not clear their
     horizon; the premium gap is smaller than the out-of-pocket gap under their
     own scenario). Returns grounded prose + the same citation check `verify`
     applies: every figure must trace to an observation this turn. Shortlist
     unchanged, `negotiationTurns += 1`.
   - **`concede`** — the objection is a genuine preference change. Re-enters the
     `price` ∥ `weights` fan-out with the new signals folded in, `round += 1`.
3. **Thresholds, hard:**
   - `negotiationTurns >= MAX_NEGOTIATION_TURNS` → `concede` is forced. The
     agent may not argue a third time.
   - `round >= MAX_RECOMMENDATION_ROUNDS` → no new shortlist. Run the
     **compromise** path: `fallbackRecommend` over the panel scored with the
     *latest* dynamic weights, present it as "the closest thing on this panel to
     what you've described", and open an advisor `review_task`
     (`reason: "negotiation exhausted"`). The applicant always ends with a plan
     in front of them and a person attached — never a loop, never nothing.

Termination is structural, not prompt-dependent: both counters are derived from
`conversation_action` row counts at load time, so a restarted process, a retried
job, or a second worker cannot reset them.

`plan-converse.ts`'s `intent: "reject_shortlist"` is what feeds this; the
negotiation reply is posted through the existing
`announceRecommendationOutcome` path.

---

## 7. Graph topology after the change

`signals` runs once, then **`price` and `weights` fan out in parallel** and
fan back in at `recommend`:

```
START ──(verdict exists?)──┬── validate → classify → narrate → route ─┬─ gate (interrupt)
                           │                                          ├─ END (assessmentOnly)
                           │                                          └─ signals
                           └── signals

                           ┌──→ price ───────┐
                           │                 │
signals ──(negotiating?)───┤ no              ▼
           │               │           recommend
           │               └──→ weights ─────┘
           │ yes
           └──→ negotiate ─┬─ convince → END
                           └─ concede ──→ (back into price ∥ weights)

recommend → verify ─┬─ clarify            (interrupt: applicant owns one question)
                    ├─ recommendationGate (interrupt: advisor owns it)
                    └─ END                (present)
```

Why the fan-out is safe and why it is worth doing:

- **They are independent.** `price` is `priceAllPlans(catalogue, record)` —
  deterministic, no model, reads nothing `signals` or `weights` writes.
  `weights` is `calculateDynamicWeights(baseWeights, signals, record)` — pure,
  no I/O, reads nothing `price` writes. Sequencing them was incidental, not
  required.
- **Disjoint channels.** `price` writes only `quotes`; `weights` writes only
  `dynamicWeights` / `weightExplanation` / `weightConfidence`. No channel is
  written by both branches, so the `latest<T>` last-write-wins reducers never
  have to arbitrate — the fan-in is deterministic regardless of which branch
  finishes first.
- **`recommend` waits for both.** LangGraph's superstep fan-in holds `recommend`
  until every inbound branch has completed, so the tool loop is never entered
  with quotes but no weights, or the reverse.
- **The win is the latency that matters.** `weights` may make a model call
  (`signals` does; `weights` itself is pure but sits behind it), while `price`
  is pure arithmetic over the panel — running them together takes the max of the
  two instead of the sum, and the cost/limit figures are ready the moment the
  agent's first `list_plan_summaries` lands.

**The one real constraint this imposes:** `negotiate` must sit *before* the
fan-out, not after it. If `negotiate` hung off `weights` and chose `convince`
(END), the parallel `price` branch would still trigger `recommend` on its own
edge and build a shortlist nobody asked for. Branching at `signals` — negotiate,
or fan out — keeps exactly one path live per round and makes "the agent argued
and the shortlist stands" a real terminal state instead of a race.

New `AssessmentState` channels: `preferenceSignals`, `baseWeights`,
`dynamicWeights`, `weightExplanation`, `weightConfidence`, `negotiationTurns`,
`round`, `negotiationReply`, `negotiationOutcome`. All `latest<T>` like every
existing channel — durable state stays in SQLite.

## 8. The scenario-constant verification gap

`out_of_pocket_exposure` (`lib/recommendation/score.ts:58`) hardcodes
`buildScenario("MEDIUM_OUTPATIENT", record)` — 8 visits × `OUTPATIENT_VISIT_COST
(350)` — for **every** applicant, including one whose own record says
`CUSTOM_FROM_APPLICANT` (maternity event, 1 admission) or who has a declared
chronic condition (`HIGH_OUTPATIENT`, 18 visits). The criterion that is supposed
to be the independent, non-premium cost signal is therefore measured under a
basket that may contradict the applicant's own record, and `verify` cannot catch
it: `verify` only checks that numbers in the agent's *prose* appeared in a tool
observation, and this figure never passes through a tool at all.

**Fix:** pick the scenario from the record — `CUSTOM_FROM_APPLICANT` when
`isScenarioSelectable` allows it, else `HIGH_OUTPATIENT` when conditions are
declared, else `MEDIUM_OUTPATIENT` — and return the chosen `scenarioId` and
`constantsVersion` in `ScoreResult`, so `score_plans`'s observation carries the
basket that produced the number. Then extend `verify` to check the *derived*
figures too: any number in the prose must match an observation **or** be a
product/sum the trace can reproduce (`visits × unit cost`, `premium + deductible
+ copay`), which is exactly the class of number the agent legitimately computes
and `verify` currently rejects as uncited.

> **Open question — the ×140.** I could not find a literal `140` anywhere in
> `lib/`, `db/` or `app/` (only CSS transition timings in
> `docs/diagrams/chatbot-pipeline.html` and a UUID fragment in the fixtures), and
> no constant path in `cost.ts` / `scenarios.ts` / `score.ts` produces it against
> the seeded panel. Tell me where you're seeing it — a branch, a log line, a
> screenshot — and I'll fold the exact case into this section instead of the
> general derived-figure rule above.

---

## 9. Order of work

| # | Change | Files | Risk |
|---|---|---|---|
| 1 | `PreferenceSignal` type + deterministic priority→criterion mapping | `lib/recommendation/preference.ts` | none, additive |
| 2 | `calculateDynamicWeights` + the `suggestDefaultWeights` normalisation fix | `lib/recommendation/dynamic-weights.ts`, `default-weights.ts` | pure, unit-testable |
| 3 | Migration + schema for `application_preference_signal` | `db/schema/preference.ts`, `drizzle/` | additive table |
| 4 | `signals` and `weights` nodes; parallel `price` ∥ `weights` fan-out into `recommend`; new state channels | `lib/ai/graph/nodes/signals.ts`, `weights.ts`, `graph.ts`, `graph/state.ts` | medium |
| 5 | `get_dynamic_weights` replaces `suggest_default_weights`; `WEIGHT_DELTA → 0.10` | `lib/ai/tools/plans.ts`, `nodes/recommendation.ts` | prompt + vocabulary change, bump `recommend-v3` |
| 6 | Load/persist signals, decay, round counters | `lib/ai/recommendation-session.ts` | medium |
| 7 | `weightConfidence` branch into `clarify` | `nodes/clarify.ts` | small |
| 8 | `negotiate` node (branching at `signals`, ahead of the fan-out) + thresholds + compromise path | `nodes/negotiate.ts`, `graph.ts`, `plan-chat-session.ts` | highest |
| 9 | Scenario selection in `out_of_pocket_exposure` + derived-figure `verify` | `score.ts`, `nodes/recommendation.ts` | changes existing scores — re-baseline fixtures |

## 10. Verification

Extend the existing suite (the one added in `e74cce6`) with:

- **Weight engine (pure, no model):** the prompt's two-signal example produces
  `need_coverage` up and `premium_cost` down, sums to 1, every weight in range;
  contradictory signals cancel rather than compound; five weak signals do not
  outrank one strong one; an irrelevant dimension is dropped; empty signals
  reproduce `suggestDefaultWeights` exactly (the regression guard for step 2).
- **Persistence:** re-extraction supersedes rather than updates; decay applies at
  load; a restarted run reloads identical signals from rows alone.
- **Termination (the one that matters):** a scripted applicant who rejects
  everything, forever, terminates in ≤ `MAX_RECOMMENDATION_ROUNDS` rounds with a
  plan on screen and exactly one open advisor task. Assert on the row counts,
  not on the prose.
- **Fan-in:** `recommend` never starts with `quotes` empty or `dynamicWeights`
  unset, whichever branch finishes first; and a `convince` round leaves the
  shortlist byte-identical — no second `recommendation` row, no new `quote` rows.
- **Low-confidence loop closes:** a weak signal triggers `clarify` once, the
  answer re-enters as a `confidence: 0.95` signal, and round 2's
  `weightConfidence` is strictly higher.

---

## 11. The trade-off question (added after the first live transcript)

**What happened.** Applicant: 18, diabetes (managed), declared a need to cover
it, stated priority "lowest premium". Shown Balanced at AED 8,900. Asked *"could
we reduce the price a bit, could we go for essential?"* — and the next round came
back with **Comprehensive at AED 16,500**. They said so, plainly: *"I asked for
low budget but you suggested the plan which is costly than previous one."*

**Why no weighting could have fixed it.** Essential does not cover pre-existing
conditions at all, so `isEligible` strips it: it can never be shortlisted while
that need is on the record. Weights reorder *eligible* plans; they cannot admit
an ineligible one. The conflict was never between two criteria — it was between
a criterion and a **hard gate** — so every rebuild was guaranteed to return
something the applicant had not asked for, and `negotiate` arguing for the
current shortlist answered a question they had not asked.

**The fix: a third thing the system can do.**

- `detectTradeOff` (`lib/recommendation/tradeoff.ts`) — deterministic. Is there a
  cheaper plan that the applicant's own declared needs rule out? Prefers a plan
  they named; the record decides whether a conflict exists at all. A cheaper
  plan that is merely *worse* is not a trade-off — that is an ordinary price
  objection, and rebuilding is the right answer.
- `tradeOff` node — routed to from `signals`, **before** `negotiate` and before
  any rebuild, gated by `tradeOffAsked` (one question per application, from the
  row's existence, with a partial unique index behind it). **No model runs**: the
  question is composed from the two plans' own terms, so there is no prose for
  `verify` to citation-check.
- **Each answer is pre-bound to signals** (`signalsForChoice`) before the
  question is asked — the reply moves the weights by a route decided in advance,
  not by a model's reading of free text. Confidence 0.95, the highest the system
  issues, because they were asked precisely this and replied.
- `readTradeOffAnswer` **fails safe, asymmetrically**: anything ambiguous reads
  as *keep the cover*. Getting it wrong the other way moves someone off cover for
  a condition they declared, on a sentence we were not sure about.
- The `premium` answer does **not** silently re-score. Dropping a declared
  medical need is an amendment to the application, not a preference, so it writes
  the signals and opens an advisor task. Quietly re-weighting an applicant into a
  plan that does not cover their condition because they said "cheaper" is the one
  outcome this path exists to prevent.

**Backstop, for every other cause** — `priceObjectionViolated` in `verify`:
compares two premiums the quotes already hold, so no prompt wording can talk past
it.

| situation | outcome |
|---|---|
| price objection answered with a costlier plan, **something cheaper was eligible** | `verifyFailed` → advisor |
| costlier plan, **nothing cheaper eligible** | not a failure, but confidence forced to low and the reason states it |
| answered with something cheaper | passes |

**One defect found by the tests, worth recording.** The first version of
`signalsForChoice` signalled every plausibly-related criterion per answer. Because
weights normalise to sum 1, introducing criteria the baseline never weighted
*diluted the one the applicant had just chosen to protect*: "keep my condition
cover" came back with `chronic_depth` at **0.32, down from 0.35**. The signal set
is now derived from the blocked requirement itself (`blockedDimensions`) — the
same answer now moves it to **0.43**. Asserted in `check-weights.ts §6`.
