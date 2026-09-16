# Step 4 — Agentic plan recommendation

How an applicant goes from a cleared record to a plan they chose themselves,
without the model ever being handed the plan corpus, without it inventing a
single fact or assumption, and with every step of its reasoning written down.

## The shape

```
Applicant facts
      ↓
Deterministic constraints          ── field validation + constraint rules
      ↓
      ├──> constraint issue ──> HUMAN REVIEW 1 ──> approved ──┐
      ↓                                                       │
Authoritative catalogue tools  <──────────────────────────────┘
      ↓
    AGENT                            ── chooses only from closed vocabularies
      ├── identify what matters
      ├── decide what to investigate
      ├── choose valid criteria
      ├── choose valid weights
      ├── choose valid cost scenario
      ├── inspect evidence
      └── propose tradeoff
      ↓
Deterministic verification         ── vocabulary, relevance, arithmetic, citation
      ↓
Shortlist
      ↓
Applicant choice
      ↓
HUMAN REVIEW 2
      ↓
Policy
```

Every arrow into the agent is authoritative data. Every arrow out of it is
validated before it becomes a row. The agent's job is judgement — *what matters
for this person* — and nothing else.

---

## 1. The gap this closes

Today the pipeline stops dead after assessment:

```
intake ──> createApplication ──> validateAndClassify ──┬──> assessed      (gate: auto)
                                                       └──> in_review     (gate: needs_review / blocked)
                                                              │
                                                     advisor approves
                                                              │
                                                          assessed ──> (nothing)
```

`quote`, `recommendation`, `recommendation_rejection` and `policy` are declared in
the schema, read by `lib/queries.ts` and rendered by the application page — and
nothing writes a single row into any of them. The journey bar shows *Quoted* and
*Recommended* ticked because `in_review` sits after them in `APPLICATION_JOURNEY`
(`lib/domain.ts:48`), not because either step ran. The chat is also closed at
submit (`conversation.status = 'completed'`), so the applicant's thread ends at
the moment the system finally has something to say to them.

---

## 2. Where it sits in the lifecycle

### 2.1 The invariant

> **An application is only recommended once its record is clean.**
> Field validation runs first. If it raises a constraint issue, the application
> goes to an advisor and **the recommendation phase does not start** — not
> partially, not speculatively. It starts when, and only when, that review is
> approved.

Concretely: `runRecommendation` refuses any application whose status is
`in_review`, or which has an open `review_task` with `subjectType: 'application'`.
That refusal is a guard in `lib/ai/recommendation-session.ts`, not a convention
callers are trusted to follow — a recommendation built on a record an advisor is
still arguing with is worse than no recommendation, because it looks finished.

### 2.2 The two reviews are different things

They share a queue and they are not the same decision:

| | **Review 1 — the record** | **Review 2 — the recommendation** |
|---|---|---|
| `subjectType` | `application` | `recommendation` |
| Fires when | validation/constraint flags gate the assessment | a plan has been selected |
| The question | *Is this record right, and can we serve what it asks for?* | *Is this the right plan for this person?* |
| Gates | the recommendation phase | policy issuance |
| Already built | yes (`approveAssessment`, `editAssessment`, `requestInfo`, `rejectApplication`) | no |

### 2.3 The flow

```
        validateAndClassify  (field validation + constraint rules — deterministic)
                    │
        ┌───────────┴───────────┐
   gate = auto          gate = needs_review / blocked
        │                       │
        │                  status: in_review
        │                       │
        │              REVIEW 1 — advisor reads the record
        │                       │
        │        ┌──────────────┼──────────────┬──────────────┐
        │     approve         edit        request_info      reject
        │        │              │              │              │
        │        │              │        back to applicant   END
        │        │              │        (re-runs rules)
        │        └──────┬───────┘
        └───────────────┤   record is clean
                        ▼
        ╔═══════════ RECOMMENDATION PHASE ═══════════════════════╗
        ║  price all 3 plans (deterministic)  -> 'quoted'        ║
        ║  agent loop over tools              -> 'recommended'   ║
        ║  deterministic verification + trace recorded           ║
        ║  plan cards posted into the applicant's chat           ║
        ╚═══════════════════╤════════════════════════════════════╝
                            │
        ┌───────────────────┼───────────────────┐
  picks a plan     "none of these work"    goes quiet
        │                   │                   │
        │          round 2 (max 3) ──> exhausted ──> advisor
        ▼
  REVIEW 2 — advisor signs off the selection
        │
     approved ──> policy_issued + benefit ledger
```

### 2.4 Why the applicant chooses before Review 2

The brief requires a reviewer checkpoint "before a recommendation is finalized".
Applicant-first satisfies it, and is the better ordering here:

- A flagged application has already been through Review 1. Nothing risky reaches
  a plan card unreviewed — the constraint gate is the filter.
- Review 2 then guards *policy issuance*, which is the irreversible act. A card
  in a chat is not.
- It makes the applicant's choice load-bearing rather than decorative. An advisor
  approving a recommendation the applicant has not seen is approving a guess.

When the applicant picks something **other than** the agent's top-ranked plan,
that disagreement is written onto the Review 2 task reason. "Applicant chose
Balanced over the recommended Essential" is a better prompt for a human than a
queue row that looks like every other one.

---

## 3. The agent and its tools

Two constraints drive this section:

1. **The model is never given the plan corpus.** It gets a short summary index and
   tools that answer specific questions about specific plans.
2. **The model never supplies a value, only selects one.** Criteria, weights,
   directions, cost scenarios and plan ids are all closed vocabularies, validated
   before the tool runs. A number the agent typed is a number it invented.

### 3.1 Tool registry — `lib/ai/tools/plans.ts`

| Tool | Args | Returns | Why it exists |
|---|---|---|---|
| `read_applicant_record` | — | declared record, cohort, flags | *Re-collect nothing.* The agent reads what intake already captured. |
| `list_plan_summaries` | — | 3 rows: id, name, premium, deductible, network, copay %, annual limit, dental tier | The entry point. Tiny, so the agent orients without the corpus. |
| `get_plan_terms` | `planIds[]`, `benefitClasses[]` | only the requested slices of the requested plans | A slice, never a dump. The agent must *ask* for depth. |
| `check_need_against_plans` | `needId` \| `benefitClass` + `horizonMonths` | per plan: `covered`, `usable`, `waitMonths`, `whyNot` | **The read-past-the-yes/no tool.** Wraps `covers` / `clearsInTime` / `readNeeds` from `lib/assessment/constraint-rules.ts` — already written, already correct about event vs continuous needs. |
| `check_network_access` | `planId` | each expected provider: admitted / refused, and by which tier | Wraps `network_admits` + `admitsKey`. Network is access, not price. |
| `estimate_annual_cost` | `planId`, `scenarioId` **(enum only)** | the basket used, its provenance, and the arithmetic per plan | The agent **names** a scenario from a closed list. It supplies no numbers. See §3.3. |
| `previous_rounds` | — | prior shortlists, what the applicant rejected, and why | Round 2+ only. Stops the agent re-offering what was already refused. |
| `suggest_default_weights` | — | a deterministic, cohort-based starting weight set | The agent must call this before `score_plans`. It decides *from* a baseline, not from nothing. See §3.8. |
| `score_plans` | `criteria[]` — each `{ criterionId (enum), weight }` | per plan: weighted score, rank, **per-criterion contribution** | The agent decides *what matters and how much*, **anchored to the §3.8 baseline**. Direction and arithmetic are not its call. See §3.4. |
| `propose_shortlist` | `picks[]`, `rejections[]`, `confidence`, `uncertaintyReason` | validated proposal | Terminal. Ends the loop. Persistence is the caller's job. |

### 3.2 Where the line is drawn

**The agent decides** — which needs are binding for this applicant; which tools to
call and in what order; which criteria matter and what weight each carries; which
cost scenario is realistic; how many plans to shortlist; which tradeoff is worth
saying out loud; and both registers of the reasoning.

**Deterministic code decides** — eligibility (budget ceiling, network admission,
waiting-period usability); the contents of every cost scenario; the direction of
every criterion; the scoring arithmetic and the rank ordering; every currency
figure; and which plans a `block`-severity flag has ruled out. The agent may
*discuss* a ruled-out plan; it cannot shortlist one.

A model that picks the weights and a calculator that applies them is auditable in
a way that "the LLM said Balanced" never is.

### 3.3 Cost scenarios — `lib/recommendation/scenarios.ts`

The agent must not invent scenario inputs. This is not allowed:

> *"Assume the applicant has 12 outpatient visits and AED 20,000 of inpatient
> expense."*

Those are facts, arriving without evidence, dressed as an assumption. So
`estimate_annual_cost` takes a **`scenarioId` from a closed enum** and nothing
else. The basket behind each id is a declared constant, version-stamped, and
either fixed or derived server-side from the applicant's own rows.

| `scenarioId` | Basket | Derived from | Selectable when |
|---|---|---|---|
| `LOW_OUTPATIENT` | 3 outpatient visits, no inpatient | fixed constant | always |
| `MEDIUM_OUTPATIENT` | 8 outpatient visits, no inpatient | fixed constant | always |
| `HIGH_OUTPATIENT` | 18 outpatient visits, chronic benefit class | fixed constant | **only when the record declares a chronic / pre-existing condition** |
| `EXPECTED_INPATIENT` | 8 outpatient visits + 1 inpatient admission | fixed constant | always |
| `CUSTOM_FROM_APPLICANT` | built from the declared needs — benefit class, horizon, and the plan's own limit for that class | `application_need` / `application_condition` rows | **only when ≥1 declared need carries a benefit class and a horizon** |

`CUSTOM_FROM_APPLICANT` is assembled **server-side from structured applicant
data**. The agent names it; it passes no basket, no counts, no amounts. The tool
returns the basket it built *and what it built it from*, so the provenance is in
the trace:

```jsonc
{
  "scenarioId": "CUSTOM_FROM_APPLICANT",
  "basket": { "outpatientVisits": 8, "inpatientAdmissions": 0,
              "benefitClasses": ["maternity"], "maternityEvent": true },
  "derivedFrom": [{ "table": "application_need", "id": "…", "benefitClass": "maternity",
                    "horizonMonths": 9 }],
  "constantsVersion": "scenarios-v1"
}
```

**The unit costs are declared, not assumed silently.** `OUTPATIENT_VISIT_COST` and
`INPATIENT_ADMISSION_COST` are named constants in the same file, version-stamped,
and **rendered in the broker view next to every figure they produced**. The brief
says premiums are flat and loading is not wanted, so these exist only to make two
plans comparable on out-of-pocket exposure — a modelling assumption, labelled as
one, shown to the person being asked to trust it. A hidden assumption is the same
failure as an invented one.

> **Reviewed.** These two constants stay fixed. Raised as an open question
> during a design review of §3.4/§7's criteria (calibration, curve shapes,
> basket sizes) — resolved to keep them as-is, since they're already declared
> and cited as a modelling assumption rather than silently baked in. That
> review's other findings (§3.4's `total_annual_outlay` → `out_of_pocket_exposure`
> rename, `annual_limit_headroom` → `annual_limit`, and §3.8's weight baseline)
> did lead to code changes; the unit costs did not.

A `scenarioId` outside the enum, or one whose selectability predicate fails
(`HIGH_OUTPATIENT` with no chronic condition on the record), is rejected before
the tool runs — see §3.5.

### 3.4 Criteria and weights — `lib/recommendation/score.ts`

Same discipline. The agent selects criteria from a closed set and assigns each a
weight. It does not name criteria, and it does not choose direction — *"higher
premium is better"* must be unstateable.

| `criterionId` | Direction (fixed) | Relevant only when |
|---|---|---|
| `premium_cost` | lower is better | always |
| `out_of_pocket_exposure` | lower is better | always |
| `need_coverage` | higher is better | ≥1 declared need |
| `waiting_period_fit` | higher is better | ≥1 declared need with a horizon |
| `network_access` | higher is better | ≥1 expected provider declared |
| `chronic_depth` | higher is better | ≥1 declared condition |
| `annual_limit` | higher is better | always |
| `dental_optical` | higher is better | declared as a priority |

`out_of_pocket_exposure` (formerly `total_annual_outlay`) is deliberately scoped
to the deductible actually spent plus the co-pay on what's left — **it excludes
the premium**. The original shape included premium in both this criterion and
`premium_cost`; on the seeded catalogue the two came out correlated at r≈0.98
under `MEDIUM_OUTPATIENT`, because premium dominates the total and the
deductible/co-pay term is small next to it. Weighting both was close to
weighting premium twice. Scoped to the non-premium term, the two are
independent: two plans with the same premium can still differ here on
deductible and co-pay design.

`annual_limit` (formerly `annual_limit_headroom`) is renamed to what it actually
computes: the plan's stated annual limit, full stop. "Headroom" implies limit
*minus* expected utilisation, which nothing here subtracts — computing real
headroom would need a utilisation estimate this criterion has no basis for (it
runs once across the whole panel, not against one cost scenario), so the name
was fixed to match the arithmetic rather than the arithmetic stretched to match
the name.

Weight rules, enforced by the tool:

- each weight in `0.05 … 0.60` — nothing decisive on its own, nothing that is
  noise pretending to be a factor
- **at most 5 criteria** — an agent that weights everything has prioritised
  nothing, which is the failure mode this cap exists to prevent
- weights are normalised to sum to 1 server-side; the agent's raw values and the
  normalised ones both land in the trace
- **relevance gate:** a criterion whose predicate is unmet is rejected. Weighting
  `chronic_depth` for an applicant with no declared condition is the model
  reaching for a fact the record does not contain.
- **baseline-anchored:** `score_plans` also requires a `suggest_default_weights`
  baseline established earlier in the round, at least one submitted criterion
  overlapping it, and every overlapping criterion's weight within `±0.15` of its
  baseline value. See §3.8.

### 3.5 Deterministic validation of every agent choice

Each tool call passes a zod schema *and* a semantic check before it executes.
Failures come back to the agent as a structured error it can act on — not an
exception, and not silence.

| Agent choice | Vocabulary | Deterministic check | On failure |
|---|---|---|---|
| which tool | the 10 registered names | name exists in the registry | error: unknown tool + the list |
| `planIds` | live `plan.id` values | every id exists in the catalogue | error naming the unknown ids |
| `needId` | this application's `application_need` rows | id belongs to **this** application | error: unknown need for this record |
| `benefitClasses` | `benefitClassEnum` | membership | error + the valid set |
| `horizonMonths` | integer 0…120 | range, and matches the need's own horizon when `needId` given | error: horizon disagrees with the record |
| `scenarioId` | the 5 scenario ids | membership **and** selectability predicate (§3.3) | error: why that scenario is not available for this record |
| `criterionId` | the 8 criterion ids | membership **and** relevance predicate (§3.4) | error: nothing on the record supports that criterion |
| `weight` | number | 0.05…0.60, ≤5 criteria | error + the bounds |
| `picks[].planId` | shortlistable plans | passes eligibility; no `block` flag | stripped server-side, regardless of what the agent returned |
| prose figures | — | **citation check** (§4.3) | confidence → `low`, routes to an advisor |

Two rejections on the same tool and the loop stops — the deterministic fallback
takes over rather than burning the applicant's time watching a model fail to
guess a vocabulary.

### 3.6 The loop — `lib/ai/graph/nodes/recommend.ts`

`lib/ai/openrouter.ts` is explicit that the free models in the chain advertise
neither strict structured output nor reliable tool calling, which is why the
codebase uses prompt + `extractJson` + zod throughout. The recommendation agent
respects that: **tool calling is a JSON action loop**, not native function calling.

```
system prompt: the tool catalogue, the vocabularies, the rules, the output shape
  │
  ├─ model emits { "thought": "...", "tool": "estimate_annual_cost",
  │                "args": { "planId": "plan_b", "scenarioId": "CUSTOM_FROM_APPLICANT" } }
  ├─ runtime validates (§3.5), executes, appends the observation, records the step
  ├─ repeat, budget-capped
  └─ model emits { "tool": "propose_shortlist", "args": {...} }  ──> loop ends
```

Built on the existing `structuredCall`, so it inherits the fallback model chain,
the reasoning-off switch, the truncation retry and the defensive parse. Point
`OPENROUTER_MODEL` at a tool-capable model later and the *same registry* binds
natively via `bindTools` — the tools are the contract, the transport is not.

**Guardrails, all load-bearing:**

- **Call budget.** Max 8 tool calls per round. On exhaustion the agent is asked
  once for a decision with what it has; failing that, the fallback runs.
- **Argument validation.** §3.5, on every call, before execution.
- **Citation check.** §4.3, before anything is persisted.
- **Hard filter.** A plan failing a `block` flag is stripped from `picks`
  server-side regardless of what the agent returned.
- **Deterministic fallback.** No key, unparseable output, repeated validation
  failure, or budget exhausted → a rule-based recommender ranks on `readNeeds`
  usability + `MEDIUM_OUTPATIENT` cost, writes the shortlist with
  `confidence: low`, and routes to an advisor. Same principle `lib/intake.ts`
  already holds: the app runs end to end with no model configured.

### 3.7 Graph topology

A third graph alongside `intakeGraph` and `assessmentGraph` in `lib/ai/graph.ts`:

```
RECOMMENDATION (the record is clean)
  price ──> agent ⟲ tools ──> verify ──> register ──┬──> present  (to the applicant)
                                                    └──> gate     (interrupt: an advisor owns it)
```

- `price` — deterministic. One `quote` row per plan, `eligible` set, premium
  frozen at quote time. Status → `quoted`.
- `agent` — the loop above, accumulating the trace.
- `verify` — citation check and hard filter.
- `register` — splits the proposal into the two registers, member and broker.
- `gate` / `present` — low confidence or a failed verify goes to an advisor first.

`runRecommendation()` returns the outcome and writes nothing, exactly as
`runAssessment()` does. Persistence lives in `lib/ai/recommendation-session.ts`,
keeping the whole thing runnable against `fixtures.json` with no database — the
same split that lets `db/seed/check-assessment.ts` exist.

### 3.8 Default weight baseline — `lib/recommendation/default-weights.ts`

Every other closed vocabulary in this section is a set the agent picks *from*.
Weight assignment was the one exception: within the `score_plans` bounds
(§3.4), the agent could land on any distribution with no deterministic floor
under it — free judgement, not selection from a vocabulary. `suggest_default_weights`
closes that gap the same way everything else here is closed: not by removing
the agent's judgement, but by giving it something concrete to start from and
bounding how far it may move away.

```
suggest_default_weights (no args)
  → COHORT_PRIORITY[cohort] ?? DEFAULT_PRIORITY
  → filtered to criteria relevant to THIS record (same isRelevant gate §3.4 uses)
  → top BASELINE_MAX_CRITERIA (3) kept, renormalised to sum to 1
  → { cohort, weights, rule }  — ctx.suggestedWeights set for this round
```

This is not new judgement. `COHORT_PRIORITY` is the same rationale
`assignCohort` (`lib/assessment/cohort.ts`) already states in prose per
cohort, and `pickByCohort` (`lib/recommendation/fallback.ts`) already reads as
a tie-break rule — a third reading of one underlying judgement about what each
cohort turns on, not a fourth one invented here.

`score_plans` then enforces the anchor:

- **must have a baseline.** Calling `score_plans` before `suggest_default_weights`
  this round is rejected outright.
- **must overlap it.** At least one submitted `criterionId` must be one the
  baseline named — the agent may not discard the baseline entirely and
  substitute its own distribution from scratch.
- **must stay within `WEIGHT_DELTA` (±0.15)** of the baseline weight, for every
  submitted criterion the baseline also named. A criterion the agent adds that
  the baseline did NOT name is unconstrained by delta (still subject to the
  normal relevance/bounds checks) — the baseline anchors the agent's read of
  what the *cohort* already says matters; it does not forbid noticing something
  cohort-level reasoning can't see (a specific named provider, a specific
  declared priority).

`enforceWeightBaseline` on `ToolContext` gates this — `true` for the real
shortlist-building loop (`recommend.ts`), `false` for read-only exploratory
re-scoring (`plan-converse.ts`, §5's "the conversation does not stop"). An
applicant asking *"what if price mattered a lot more"* about a plan already
recommended should be answerable without first re-deriving a cohort baseline
for it — the baseline exists to anchor a **commitment**, not to constrain
every hypothetical the applicant might ask about afterward.

---

## 4. Recorded reasoning

A recommendation whose reasoning cannot be reconstructed is not reviewable, and
Review 2 is the point of the whole exercise. Four rows carry it; the tables
already exist.

### 4.1 What is written, and where

| Row | Answers | Contents |
|---|---|---|
| `model_run` (1 per round) | *What did the machine actually do?* | provider, `model_id` **as served** (the fallback chain means it is not always the one asked for), `prompt_version`, latency, tokens, cost, status — and `response` = **the full step trace** |
| `ai_decision` (1 per round) | *What did it claim, and how sure was it?* | `output` = picks + rejections + the criteria and weights chosen (raw **and** normalised) + per-criterion contributions + the scenario used and its provenance + the citation-check result; `summary`; `confidence`; `uncertainty_reason`; `requires_review`; `applied_to_id` → the recommendation |
| `recommendation` | *Why this plan, for this person?* | `broker_reasoning` and `member_reasoning` — the two durable registers, already two columns |
| `recommendation_rejection` | *Why did the others lose?* | one row per rejected plan, broker register |

### 4.2 The step trace

Each step appends one entry to `model_run.response.trace`:

```jsonc
{
  "step": 3,
  "thought": "Maternity is the binding need — check which plans clear the wait.",
  "tool": "check_need_against_plans",
  "args": { "benefitClass": "maternity", "horizonMonths": 9 },
  "validation": "ok",
  "observationSummary": "plan_a: not covered · plan_b: covered, 12m wait, not usable in 9m · plan_c: covered, 3m wait, usable",
  "observationRef": { "table": "plan", "ids": ["plan_a", "plan_b", "plan_c"] },
  "latencyMs": 1840
}
```

Rejected calls are recorded too, with `validation` carrying the reason. An agent
that tried to weight `chronic_depth` on a record with no conditions is something
the advisor should be able to see.

**PHI never goes in the trace in the clear.** `model_run.request` already carries
the schema's own warning ("redacted or a pointer; never PHI in the clear"), and
`read_applicant_record` returns health information by definition. PHI-bearing
observations are stored as a *reference* — `{ table, ids }` — plus a
non-identifying summary. The broker view re-reads the live rows through
`observationRef` and renders them there, where the audience is already entitled to
see them. The trace records *what was consulted*, not a second copy of the record.

### 4.3 Prose must trace to evidence

`verify` enforces the link between argument and observation: every currency figure
and waiting-period month in `broker_reasoning` / `member_reasoning` must appear in
an observation the agent actually received. A figure with no matching observation
is a hallucination — confidence drops to `low` and it routes to an advisor instead
of the applicant.

This is the same discipline `lib/assessment` already applies to `narrate`: the
model may improve the wording, it may not change what was found. Here it may build
the argument, but it may not introduce a fact.

### 4.4 Rounds accumulate; nothing is overwritten

Round 2 does not edit round 1. It writes its own `model_run` and `ai_decision`, and
supersedes the previous `recommendation` via `version` (already on the table;
`superseded` already in `recoStatusEnum`). The advisor can read *what changed
between rounds and why* — usually the most informative thing on the screen, and
impossible if the earlier attempt were overwritten.

### 4.5 The fallback records its reasoning too

When no model runs, **no `model_run` row is written.** `persistAssessment` already
holds this line: "a record with nothing flagged never reaches the model, and
inventing a run row for it would put a model's name on a decision it had no part
in." The `ai_decision` row is still written, with the rule-based rationale and
which rules produced the ranking — recorded either way, and honest about having
come from arithmetic rather than a model.

---

## 5. The conversation does not stop

Today `finishOrAmendAgent` sets `conversation.status = 'completed'` and closes the
thread. Instead:

- The conversation stays open — `awaiting_review` while an advisor holds it,
  `awaiting_user` once cards are posted. One conversation row per application, so
  the applicant's history reads straight through.
- The shortlist arrives as an **assistant message with a payload**, exactly how
  the codebase already distinguishes questionnaires (`isQuestionnairePayload`) and
  advisor decisions (`{ kind: 'advisor_decision' }`):

  ```ts
  { kind: 'recommendation_shortlist', round: 1, recommendationId, picks: [...] }
  ```

  No schema change. The chat page already branches on the last assistant
  message's payload.
- Replay stays honest. The draft replays from `extraction` rows; the shortlist
  replays from the `recommendation` rows the payload points at. Nothing is held in
  memory between requests.

### Round 2 — "none of these work for me"

The objection is captured as a `conversation_action` row —
`actionType: 'reject_shortlist'`, `arguments: { planIds, reason }` — which is
precisely what that table is for. The `previous_rounds` tool reads it.

**A hard limit, stated plainly:** the panel has three plans. An agent that offers
to "look again" indefinitely over three plans is lying. Round 2 can legitimately
re-weight, surface a tradeoff that was not raised, or re-scope the cost scenario.
By round 3 the honest answer is usually *"nothing on this panel fits what you are
asking for, and here is exactly which requirement is unservable"* — which routes
to an advisor with that sentence as the queue reason. Capping at 3 and escalating
is the design, not a limitation of it.

### Selection

Applicant taps a card → `conversation_action` (`select_plan`) → the chosen plan's
`recommendation` becomes the live one, siblings `superseded` → Review 2 opens →
advisor approves/edits/overrides → `approved` → `policy` row with inception date,
and the benefit ledger initialised from the plan terms.

---

## 6. What the two views show

The registers are already two columns. The discipline is in what surrounds them.

**Customer (in-chat plan cards, `components/plan-card.tsx`)** — plan name, annual
premium, the one thing that makes it fit *this* applicant, the one tradeoff worth
knowing, what they would pay in a realistic year **with the scenario named in
plain words** ("about eight GP visits, no hospital stay"), and a *Choose this
plan* button. Plus *None of these fit*, which opens the objection.

Never rendered here: the cohort, the flags, the confidence, the uncertainty
reason, the weights, or the trace.

**Broker (the existing `Quotes & recommendation` tab)** — everything above, plus
the criteria and weights the agent chose with per-criterion contributions, the
scenario and its provenance and the constants version behind every figure, all
three quotes side by side, why the other two lost in the broker register, the
confidence and what makes it a close call, the round history with what the
applicant objected to, and **the step trace including rejected calls.** That last
one is the difference between reviewing a recommendation and trusting one.

---

## 7. Queue ordering

Review 2 rows join the existing worklist, ordered by `priority_score`:

| Situation | Score | Why it is where it is |
|---|---|---|
| Agent found nothing servable / rounds exhausted | 90 | The applicant is stuck and nobody is coming |
| Verify failed — a figure no tool returned | 85 | The system does not trust its own output |
| Fell back to the rule-based recommender | 80 | No model judgement was applied at all |
| Confidence `low` — genuinely arguable placement | 70 | This is the case that needs judgement |
| Applicant chose against the top-ranked plan | 55 | Worth a look; usually fine, occasionally revealing |
| Applicant selected the recommended plan, high confidence | 20 | Sign-off, not analysis |

Same principle the assessment queue already uses: if every row looks equally
settled, the advisor either rubber-stamps everything or re-checks everything.

---

## 8. Build order

1. **`lib/recommendation/`** — pure, no DB, no model.
   `scenarios.ts` (the 5 baskets, the unit-cost constants, the selectability
   predicates), `cost.ts` (outlay arithmetic), `score.ts` (the 8 criteria with
   fixed directions, weight bounds, relevance predicates, weighted scoring + rank
   + contributions), `quote.ts` (price all three), `eligibility.ts` (hard filters
   over `lib/assessment`).
   *First, because everything else calls it and it is the fallback.*
2. **`db/seed/check-recommendation.ts`** — all five profiles through the
   deterministic path against `fixtures.json`, no server. Mirrors
   `check-assessment.ts`; deliverable #3 in the brief.
3. **`lib/ai/tools/plans.ts`** — the registry and the §3.5 validation layer, each
   tool a thin wrapper over (1).
4. **`lib/ai/graph/nodes/recommend.ts`** — the loop, the trace accumulator, and
   `verify`; wire `recommendationGraph` into `lib/ai/graph.ts`.
5. **`lib/ai/recommendation-session.ts`** — **the `in_review` guard first**, then
   load inputs and persist `quote` / `recommendation` / `recommendation_rejection`
   / `ai_decision` / `model_run` / `review_task` in one transaction. Mirrors
   `assessment-session.ts`.
6. **Trigger points** — after `validateAndClassify` when `gate === 'auto'`, and at
   the end of `approveAssessment` / `editAssessment` once Review 1 clears.
7. **Chat continuation** — stop completing the conversation at submit; post the
   shortlist payload; handle `select_plan` and `reject_shortlist`.
8. **UI** — `plan-card.tsx` in chat; weights, scenario provenance, step trace and
   round history on the broker tab; the new queue rows.
9. **Policy issuance** on Review 2 approval, where step 5 picks up.

### Schema changes

**None required.** `quote`, `recommendation` (with `version`, `confidence`,
`uncertainty_reason`, both reasoning columns), `recommendation_rejection`,
`conversation_action` (with `tool_name`, `arguments`, `result`), `ai_decision`,
`model_run` and `review_task` already carry everything.
`aiDecisionTypeEnum` already has `plan_recommendation`; `reviewSubjectEnum`
already has `recommendation`; `conversationStatusEnum` already has
`awaiting_review`.

One optional addition, TS-only in SQLite: if the scoring breakdown should become a
first-class row rather than living inside `ai_decision.output`, add
`quote.score_breakdown` as JSON. Defer until the broker tab is built and the shape
is known.
