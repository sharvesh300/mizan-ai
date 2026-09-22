# Step 5 — Agentic servicing: claims, pre-auth, reimbursement, appeals

How a live policy is serviced by an agent that decides what it still needs to
know, asks for exactly that and nothing more, never computes a number itself,
knows when the plan data cannot answer the question, and hands a complete case
to a human only when it genuinely cannot proceed.

This is a design document. Nothing here is implemented yet — §19 is the order
of work.

## The shape

```
Member says something ("I want to claim my physio")
      ↓
UNDERSTAND            ── what kind of operation is this, against which policy
      ↓
   ┌──────────────────────────────────────────────┐
   │  WHAT DO I ALREADY KNOW?                     │  ← intake record, policy,
   │  (re-collect nothing)                        │     event log, ledger
   └──────────────────────────────────────────────┘
      ↓
   ┌─> WHAT IS THE ONE THING I STILL NEED? ───────┐
   │        ├── a fact      → ask the member      │  (interrupt)
   │        ├── a document  → request evidence    │  (interrupt)
   │        ├── a conflict  → ask which is right  │  (interrupt)
   │        └── nothing     → adjudicate          │
   │                              ↓               │
   └──────── answer comes back ───┘               │
                                                  ↓
                              DETERMINISTIC ADJUDICATION
                              (lib/servicing/adjudicate.ts — pure, no model)
                                                  ↓
                              EXPLAIN, TWICE (member register / broker register)
                                                  ↓
                        ┌─────────────────────────┴─────────────────┐
                    settled                                    not settled
                        ↓                                           ↓
                   write + reassess fit                    appeal → evidence loop
                                                                    ↓
                                                            uphold / overturn
                                                                    ↓
                                                        still unresolved, or
                                                        insufficient_data, or
                                                        loop limit reached
                                                                    ↓
                                                        ADVISOR CASE PACKET
                                                        → queue, call, callback
```

The rule the whole design turns on: **the agent decides what to ask; it never
decides what anything costs.** Money is arithmetic over plan terms and the
ledger, and arithmetic belongs in a pure function that a test can pin.

---

## 0. Where the system is today — facts, not plan

Read before proposing changes; a surprising amount of step 5 is already in the
repo and must not be rebuilt.

**Already built and working:**

- The whole schema. [`db/schema/policy-ledger.ts`](db/schema/policy-ledger.ts)
  has `policy`, `servicing_event` (append-only, enforced by a trigger in
  [`db/triggers.sql`](db/triggers.sql)) and `benefit_ledger` with the
  projection comment already stating the architectural rule.
  [`db/schema/plan-fit.ts`](db/schema/plan-fit.ts) has reassessment.
- The vocabulary. [`db/schema/enums.ts`](db/schema/enums.ts) already carries
  `reasonCodeEnum` (all eight, verbatim from the spec), `eventOutcomeEnum`,
  `benefitClassEnum`, `claimProviderTierEnum` (the five real tiers **plus**
  `unknown_foreign`, with a comment explaining that the absence of a tier is
  not a sixth tier), and `geographyEnum` (`uae` / `abroad` / `unknown`,
  existing specifically so CLM-9 can be *seen* rather than guessed at).
- Customer-safe projection in SQL: `customer_policy_view` and
  `customer_event_view` in [`db/schema/views.ts`](db/schema/views.ts). The two
  registers are already enforced at the database boundary.
- Read-only servicing UI: [`app/policies/page.tsx`](app/policies/page.tsx) and
  [`app/policies/[id]/page.tsx`](app/policies/[id]/page.tsx) render ledger,
  event history and reassessments today.
- `listEvents` / `listReassessments` / `listPoliciesForUser` in
  [`lib/queries.ts`](lib/queries.ts).
- `review_task` / `review_decision` ([`db/schema/review.ts`](db/schema/review.ts))
  with `reviewSubjectEnum` already including `servicing_event` and
  `reassessment`, and `reviewActionEnum` already including `uphold` /
  `overturn` / `request_info`.
- The AI layer: `conversation` (purpose enum already includes `servicing`),
  `conversation_question`, `conversation_action`, `ai_decision` (type enum
  already includes `benefit_classification`, `evidence_classification`,
  `appeal_assessment`, `fit_reassessment`, `explanation_generation`),
  `model_run`, `extraction`.
- The agent pattern, proven twice: a closed-vocabulary tool registry
  ([`lib/ai/tools/plans.ts`](lib/ai/tools/plans.ts)), a JSON action loop with a
  step trace and a deterministic fallback
  ([`lib/ai/graph/nodes/recommendation.ts`](lib/ai/graph/nodes/recommendation.ts)),
  interrupt nodes that hand control back to a human
  ([`lib/ai/graph/nodes/clarify.ts`](lib/ai/graph/nodes/clarify.ts)), and
  session modules that rebuild graph state from rows on every turn
  ([`lib/ai/recommendation-session.ts`](lib/ai/recommendation-session.ts)).

**Missing — this document:**

- No `lib/servicing/` at all. There is no adjudication function, no ledger
  projection, no replay check. Two of the thirteen events (CLM-1, CLM-6) exist
  in [`db/seed/fixtures.json`](db/seed/fixtures.json) as *hand-written* rows
  with their arithmetic typed in by a human. Nothing computes them.
- No servicing tool registry, no servicing graph, no servicing session.
- No write surface: a member cannot submit a claim, ask a pre-auth question,
  or file an appeal from the UI.
- `listQueue` ([`lib/queries.ts`](lib/queries.ts)) hydrates only `application`
  and `recommendation` subjects. A `review_task` with
  `subject_type = 'servicing_event'` would appear as a bare row with
  `subject: null`.
- No advisor call / callback surface, no case packet.

---

## 1. Feature list

| # | Feature | Model or deterministic |
|---|---|---|
| F1 | Benefit ledger as a projection of the event log | deterministic |
| F2 | Replay: drop the ledger, rebuild from history, identical numbers | deterministic |
| F3 | Adjudication — the 12-step order of operations | deterministic |
| F4 | Pre-authorization — same logic, dry run, reads the ledger | deterministic |
| F5 | Reimbursement — same logic, settlement direction flips | deterministic |
| F6 | Appeals — evidence assessed against the contested reason code | agent proposes, deterministic re-adjudication |
| F7 | Conversational servicing intake, one question at a time | agent |
| F8 | Evidence request loop with an evidence-state machine | agent |
| F9 | Conflict detection and resolution | agent detects, member decides |
| F10 | Two-register explanations (member / broker) | agent, citation-checked |
| F11 | Plan-fit reassessment from the event log, not the counters | agent, history-grounded |
| F12 | `insufficient_data` → reviewer, never an invented rule | deterministic |
| F13 | Loop limits from config → escalation | deterministic |
| F14 | Advisor case packet, queue entry, call / callback | deterministic |
| F15 | Uncertainty surfaced per event (confidence + why) | agent proposes, floors are deterministic |
| F16 | Member servicing conversation in a drawer over the one member screen (§13.2) | agent, cards are typed |
| F17 | Broker case page: decision, packet, working, history (§13.3.2) | deterministic assembly |
| F18 | Two registers enforced at data, component and copy level (§13.4) | deterministic |
| F19 | Straight-through rate + escalation-cause breakdown (§13.3.5) | deterministic |
| F20 | Hindsight table — the same history replayed on each plan (§13.3.4, stretch) | deterministic |

---

## 2. The lifecycle

### 2.1 The invariant

**The event log is the source of truth. The ledger is a projection of it.**
Every write is an append. A reviewer override is a *new* record with
`decided_by: 'advisor'`. An overturned appeal *supersedes* the denial it
reverses and both stay on the record.

Two consequences the code must honour:

1. Nothing outside `lib/servicing/` may write `benefit_ledger`, and what it
   writes is always `project(plan, log)` (§3.2) — rebuilt from the log after
   each append, never incremented by hand at a call site.
2. `assertReplayable(policyId)` (phase 2) must find the stored ledger identical
   to the replayed one. This is the twenty-line check the spec asks for, and it
   runs in the seed script and in the UI's "rebuild" action.

### 2.2 The flow

```
policy_issued
   ↓
member opens a servicing conversation ── "I want to claim my physio"
   ↓
UNDERSTAND ── kind (claim | preauth | reimbursement | appeal), which policy
   ↓
LOAD ── intake record, plan terms, event log, ledger          (re-collect nothing)
   ↓
GAP CHECK ──┬── missing required fact ──> ASK      (interrupt, ≤ MAX_CLARIFICATION_ROUNDS)
            ├── needs evidence        ──> REQUEST  (interrupt, ≤ MAX_EVIDENCE_REQUEST_ROUNDS)
            ├── conflict              ──> RECONCILE(interrupt, counts as a clarification)
            └── complete              ──> ADJUDICATE
   ↓
ADJUDICATE ── pure function over (plan, ledger, event). One reason code out.
   ↓
EXPLAIN ── two registers, every figure traced to the calculation array
   ↓
GATE ──┬── insufficient_data              ──> ADVISOR (never auto-resolved)
       ├── appeal → overturn              ──> ADVISOR sign-off, then write
       ├── appeal → uphold                ──> auto, member may still escalate
       ├── reassessment → recommend_change──> ADVISOR sign-off
       └── everything else                ──> auto: append, project, notify
   ↓
REASSESS FIT ── reads the event log, not the counters
   ↓
member disagrees? ──> APPEAL (back into the evidence loop, once)
   ↓
limits exhausted / unresolved ──> CASE PACKET ──> call advisor | request callback
```

### 2.3 Where a human is, and is not

The brief asks us to decide, so: **sign-off is required where a decision
creates money or is unappealable-by-construction, and nowhere else.**

| Operation | Sign-off? | Why |
|---|---|---|
| Claim / reimbursement, clean outcome | **No** | Deterministic arithmetic over stated terms, with a printed trace. A human adds latency and no judgment. |
| Claim denied on a hard gate (waiting period, network, sublimit, annual limit) | **No** | Same: the gate is a fact about plan terms. The member's recourse is an appeal, which *is* the human path. |
| Pre-authorization | **No** | A forecast that writes nothing. Being wrong costs a re-quote, not money. It carries a "this is an estimate against today's ledger" caveat. |
| `insufficient_data` | **Always** | The spec's whole point. CLM-9 is not a low-confidence answer, it is the absence of one. |
| Appeal → **uphold** | **No** | Upholding changes nothing; the denial already stands. Auto-upholding with a written reason keeps the system honest under pressure (§5.4), and the member keeps the advisor escalation. |
| Appeal → **overturn** | **Yes** | An overturn moves money and rewrites ledger state at a past point. One advisor click, with the re-adjudication already computed and shown. |
| Reassessment → `confirm` | **No** | It tells the member nothing changes. |
| Reassessment → `recommend_change` | **Yes** | It is a sales act with a premium attached. |
| Any loop-limit exhaustion | **Always** | By definition the agent said it could not get there. |

Expected effect on the supplied thirteen events: **ten resolve with no human
at all**; CLM-9 escalates as `insufficient_data`; APP-2 computes the overturn
and waits for one click; APP-1 upholds automatically and writes the member a
straight answer.

---

## 3. The deterministic core — `lib/servicing/`

Build this first. The agent is worthless without it, and it is testable on its
own with zero model calls.

```
lib/servicing/
  types.ts        AdjudicationInput, AdjudicationResult, LedgerState, EvidenceState
  limits.ts       loop limits, read from env, defaulted (§7)
  network.ts      network_admits — the tier table from spec §6
  adjudicate.ts   the 12 steps. Pure. The only place money is computed.
  ledger.ts       emptyLedger, cloneLedger, compareLedgers — state helpers only
  replay.ts       effectOrder, replay, project — the ledger rebuilt from the log
                  (the database side, assertReplayable(policyId), is phase 2)
  appeal.ts       reason-code → { field it turns on, admissible evidence kinds },
                  remaining-admissibility set-difference, never-worse comparison
                  — the deterministic half of §5.4
  next-steps.ts   the dated, computed facts a denial can offer the member (§13.2.5)
  explain-template.ts  deterministic member + broker prose from those facts — the
                  seed's prose and the no-model fallback (§13.2.4)
  reassess.ts     the history features a reassessment is allowed to reason from
  index.ts        barrel, matching lib/assessment and lib/recommendation
```

### 3.1 `adjudicate.ts` — one function, twelve steps

```ts
export type AdjudicationInput = {
  plan: PlanTerms;                 // from the catalogue, never from the model
  ledger: LedgerState;             // projection as of the moment before this event
  policyStatus: PolicyStatus;
  policyMonth: number;
  benefitClass: BenefitClass;
  providerTier: ClaimProviderTier; // may be 'unknown_foreign'
  geography: Geography;            // 'abroad' | 'unknown' short-circuits to insufficient_data
  amount: number;                  // billed, or estimated for a pre-auth
  dryRun: boolean;                 // preauth: compute, never project
};

export type AdjudicationResult = {
  outcome: EventOutcome;
  reasonCode: ReasonCode;
  planPays: number | null;         // null only for insufficient_data
  memberPays: number | null;
  deductibleApplied: number;       // what this event worked off; a forecast on a dry run
  clippedBy: "sublimit" | "annual_limit" | null;
  calculation: string[];           // ordered arithmetic trace — kept verbatim
  ledgerBefore: LedgerState;
  ledgerAfter: LedgerState;        // never null; equals ledgerBefore when denied,
                                   // undecidable, or a dry run
};
```

Order, exactly as spec §4, stopping at the first denial:

```
0.  geography !== 'uae' or tier === 'unknown_foreign'
                                  ⇒ insufficient_data   (before everything else:
                                     we cannot even say whether the gate applies)
1.  policy active?           no   ⇒ policy_not_active
2.  benefit covered at all?  no   ⇒ benefit_excluded
3.  policy_month >= wait?    no   ⇒ waiting_period_not_elapsed
4.  tier admitted?           no   ⇒ provider_out_of_network
5.  sublimit exhausted?      yes  ⇒ sublimit_exhausted
6.  annual limit reached?    yes  ⇒ annual_limit_reached
7.  applied    = min(deductible - deductible_met, billed)
8.  after_ded  = billed - applied ; copay = after_ded × pct ; plan = after_ded - copay
9.  plan = min(plan, sublimit_remaining)     ← caps plan payment, after co-pay
10. plan = min(plan, annual_remaining)
11. member = billed - plan
12. append, then project: deductible_met += applied
                          annual_paid    += plan
                          sublimit_used  += plan   (if the class has one)
```

Step 0 is additive to the spec's list and is the honest reading of "the plan
data says nothing about geographic scope": an out-of-scope claim cannot be
denied `provider_out_of_network` (that would be inventing a rule) and cannot be
paid. It returns `insufficient_data` with `planPays: null`.

**Pre-auth is the same call with `dryRun: true`.** There is no second
implementation and no second code path. The one difference is the outcome
label, and it is worth being exact about because it is easy to get subtly
wrong: `approved_with_limit` is a **pre-auth** outcome, used when step 9 or 10
clipped the payment — it is what makes PRE-1 genuinely useful to P2, because it
says *the plan will pay 25,000 of the 40,000 and you should plan for 15,000*.
A **claim** capped the same way is still `covered`, because spec §5 defines
`covered` as "payable, in full or in part". So PRE-1 is `approved_with_limit`
and CLM-2, with identical arithmetic, is `covered`.

**Reimbursement is the same call.** Only the settlement prose differs:
`plan_pays` is described as *paid back to you* rather than *paid to the
provider*. That lives in the explanation layer, not here.

### 3.2 `replay.ts` — the projection and the replay check

```ts
/** Events in the order they take effect. */
export function effectOrder(events: ReplayEvent[]): ReplayEvent[];

/** Re-run the engine over the log, in effect order, from an empty ledger. */
export function replay(plan: PlanTerms, events: ReplayEvent[]): { ledger: LedgerState; steps: ReplayStep[] };

/** The ledger a history projects to. The ONLY way a LedgerState is ever produced from a log. */
export function project(plan: PlanTerms, events: ReplayEvent[]): LedgerState;
```

**Replay re-runs the engine; it does not sum stored numbers.** Found while
implementing, and worth stating because the obvious design is wrong twice over:

1. The log does not record the deductible each event consumed (there is no such
   column), and it cannot be recovered from `plan_pays` once a cap has clipped
   it. A fold over stored amounts cannot rebuild `deductible_met`.
2. The `ledger_before` / `ledger_after` snapshots on each row go stale. An
   overturn writes to the ledger at the *original* event's position (spec §2,
   rule 3), so every event after it now sees a different ledger than the one it
   stored. A fold over snapshots faithfully reproduces the stale numbers.

Re-running the engine over each row's inputs (class, tier, geography, month,
amount, status) gives the right ledger, and the drift check falls out of it:
compare what the replay decides against what each stored row says it decided.
One legitimate difference exists — an event *after* a mid-history overturn is
**restated**, not drifted — and the caller must be able to tell the two apart.

**Order is `seq` (submission order), not `policyMonth`.** Each original
adjudication saw the ledger as it stood at submission, so that is the order
that reproduces it. `policyMonth` is an *input* to the waiting-period gate, not
a clock; ordering by it would make a late-filed, early-dated claim rewrite the
history of every claim submitted before it.

`effectOrder` is where spec §2's third rule lives: *an overturned appeal writes
to the ledger at the point of the original event, not at the appeal date.* An
event with `supersedesId` takes the position of the first event in its
supersession chain, and the superseded event drops out of the fold (the denial
stays on the record; it just no longer counts). This is why P4's PRE-2 at
month 9 sees a deductible of 500 already met: APP-2 overturned CLM-4 *at
CLM-4's position*. An appeal that supersedes nothing (an upheld appeal) has no
effect on the ledger and takes no part. Pre-authorizations take part — they are
adjudicated against the ledger at their position, so the replay can check the
forecast — but never move it. Positions are resolved for every event *before*
anything is filtered, so a supersession cycle raises instead of silently
dropping its members.

**Known open item, decided in phase 6:** a row an *advisor* decides by hand
(an override, or the resolution of an `insufficient_data` case) has no engine
inputs that reproduce it, so replay-by-re-adjudication cannot rebuild it. Such a
row will need to carry its own consumed amounts (`deductible_applied` and
`plan_pays`) and be folded from them. That is the one place a stored number
becomes authoritative, and it should be a deliberate, visible exception rather
than a surprise.

---

## 4. The agent and its tools — `lib/ai/tools/servicing.ts`

Same contract as the recommendation registry: **the model is never handed the
corpus, never supplies a number, and every argument is a closed vocabulary
validated before the tool runs.** A rejection comes back as a structured
`ToolResult` naming what was sent and what was expected, never as a throw.

### 4.1 Registry

| Tool | Reads | Returns | Vocabulary enforced |
|---|---|---|---|
| `read_policy` | `policy` + plan terms | cover, inception, status, premium | — |
| `read_ledger` | `benefit_ledger` (projected) | deductible met, annual paid, sublimits, **and what remains** | — |
| `read_event_history` | `servicing_event` | every prior event with outcome, reason code, amounts | — |
| `read_applicant_record` | intake record | declared conditions, dates, stated needs — **so nothing is asked twice** | — |
| `get_plan_terms` | catalogue | one plan's terms | `plan_id` ∈ catalogue |
| `check_network_admission` | `network.ts` | admitted / not, and which tiers are | tier ∈ `claimProviderTierEnum` |
| `classify_benefit` | — | records a proposed class + the declared condition it matches | class ∈ `benefitClassEnum`; `chronic_preexisting` **requires** naming a condition that exists on the intake record |
| `list_missing_facts` | state | which required fields are still unknown for this event kind | — |
| `ask_member` | — | poses exactly ONE question | `field_key` ∈ the required-field table for this kind |
| `request_evidence` | — | asks for ONE document, naming the reason code it must bear on | `reason_code` ∈ `reasonCodeEnum` |
| `flag_conflict` | — | two values for the same field, with both sources | `field_key`, both values quoted from sources |
| `adjudicate` | `lib/servicing/adjudicate.ts` | the full result + calculation trace | all inputs already validated; **the model cannot pass an amount it invented — the amount comes from the event row** |
| `assess_evidence` | `appeal.ts` | whether the evidence is admissible against the contested reason code | `reason_code` ∈ `reasonCodeEnum`; `verdict` ∈ `bears_on` / `does_not_bear_on`; the agent may **not** name an evidence kind outside the admissibility table (§5.4.2) |
| `propose_correction` | `appeal.ts` | the ONE input field an admissible piece of evidence corrects, then re-adjudicates | `field` **must** be the field the contested reason code turns on; `value` ∈ that field's enum and must differ from what is recorded; `quote` must be a verbatim span of the evidence (§5.4.4) |
| `propose_outcome` | — | the final answer + two explanations + confidence | called exactly once |
| `escalate` | — | ends the loop, builds the case packet | `cause` ∈ closed set (§7) |

`adjudicate` is the interesting one: the agent decides **when** it has enough
to adjudicate and **what the event is** (kind, class, tier, geography), and the
tool computes **what it costs**. The model never sees a co-pay percentage it
could multiply by.

**As built in phase 3** (`lib/ai/tools/servicing.ts`, 15 tools). The table above is
the design; four things changed on contact with the code:

- **Two tools were added.** `record_fact` — the design had a "validate" step
  (§5.1) with no home, and a fact has to enter the draft *somewhere* validated. It
  requires a **verbatim quote** from the member, checks that a "stated" amount or
  date literally appears in it, and rejects a future date, a pre-inception date and
  an impossible one. And `confirm_details`, which shows the confirm card; nothing is
  adjudicated until the member has confirmed it.
- **Three were deferred to phase 5 — and built there** (`lib/ai/tools/appeal.ts`, a separate
  registry the agent is handed *instead of* this one while a conversation is an appeal):
  `request_evidence`, `assess_evidence`, `propose_correction`. They validate against the admissibility table (§5.4.2), which
  is `appeal.ts`. A tool that validates against a table that does not exist is a stub,
  and a stub the model can call is worse than an absence.
- **`propose_outcome` refuses `insufficient_data`**, and `escalate` takes an optional
  `member_message` (required for that cause). The undecidable case is not a
  low-confidence answer, it is the absence of one, so there is nothing to *propose*;
  the only route is a person. The message stops a member landing on an escalation
  card unexplained, and is held to the same copy and figure rules as any other.
- **"Not sure" is a state, not an error.** A member who picks it for the provider
  type has given a legitimate answer. No tier is recorded or guessed; the agent asks
  for the provider's name once; if that does not settle it, `escalate` accepts
  `clarification_limit`, and not before.

What the registry *refuses* is the point of it. Each line is a rule from this plan,
enforced where it becomes true, and each has a test that breaks it: one question at
a time; never ask for what is known (and the known value is handed back); a question
may not cite a figure nobody stated; `adjudicate` has **no argument** to put an amount
in; `propose_outcome` may cite only figures an observation produced, must state what
the member pays, must be two different documents, and may not use classification
vocabulary or promise a time; an escalation cause is refused unless the state shows
it, and the refusal lists the causes that do hold.

### 4.2 Where the line is drawn

| Job | Owner | Why |
|---|---|---|
| Is this a claim, a pre-auth, a reimbursement or an appeal? | **agent** | It is language understanding over a member's sentence. |
| Which benefit class? | **agent proposes → deterministic validation** | "Is this condition one they declared at intake?" is a lookup; the *match* between a free-text treatment and a declared condition is judgment. `chronic_preexisting` is rejected unless it names a real row on the record. |
| Which provider tier? | **agent proposes → validated against the enum** | The member says "the hospital"; the tier vocabulary is closed. |
| Is the provider outside the UAE? | **agent flags → deterministic short-circuit** | Geography is the undefined case; seeing it is enough. |
| What is still missing, and what to ask next? | **agent** | This is the whole point of §5. |
| Does this evidence bear on this reason code? | **agent proposes → admissibility table checks** | §5.4.2. The agent judges relevance; it never judges payability. |
| Which input does that evidence correct? | **agent proposes ONE field → validated against the reason code** | §5.4.4. An appeal may patch the field its denial turned on and nothing else — not the amount, not the date. |
| Is the appeal upheld or overturned? | **deterministic, from re-adjudication** | §5.4.6. Nobody "decides" an overturn; it is what happens when the same arithmetic meets a corrected input. |
| Every amount | **deterministic, always** | Arithmetic is not a judgment call. |
| Uphold or overturn | **agent proposes → advisor signs an overturn** | §2.3. |
| The prose, in two registers | **agent, citation-checked** | Every figure must appear in `calculation`; a figure that does not is a hallucination and fails the turn. |
| Ledger movement | **deterministic, always** | Projection only. |

### 4.3 The loop

A JSON action loop matching
[`lib/ai/graph/nodes/recommendation.ts`](lib/ai/graph/nodes/recommendation.ts):
one tool call per turn, a `RecommendationTraceStep`-shaped trace row per step,
`MAX_TOOL_CALLS = 10`, and the same fail-closed discipline — three repeats of
the same rejected argument ends the turn, and a turn that ends without
`propose_outcome` falls back to the deterministic path (adjudicate on what is
known, or escalate if a required fact is missing). **A model failure never
produces a wrong number; it produces a human.**

---

## 5. The loops

This is the part the brief is really asking for. Each loop is the same shape —
observe state, name the single next gap, interrupt, fold the answer back in,
re-observe — and they differ only in what closes the gap.

**§5.4, the appeal loop, is the most important one in this document.** It is
where the agentic boundary is tightest and where a sloppy design does the most
damage: an appeal that routes straight to a human learns nothing from evidence,
and an appeal decided by a model learns the wrong thing from it. Read that one
closely.

### 5.1 The information loop

```
understand ──> loadContext ──> gapCheck ──┬── complete ──> (evidence loop)
                                  ▲       │
                                  │       └── missing ──> selectQuestion ──> ask
                                  │                                           │
                                  └──────── processAnswer <── INTERRUPT ──────┘
```

`selectQuestion` is agentic, not a script. There is a **required-field table**
per event kind (deterministic — it decides *whether* the loop continues), but
**which** gap to close next is the agent's call, and it must justify the choice
in its `thought`. Asking for the amount before knowing the treatment is legal
and sometimes right; asking four things at once is not — `ask_member` takes one
question.

The required-field table:

| Kind | Required | Derivable from the record (never asked) |
|---|---|---|
| `claim` | treatment description, date (→ `policy_month`), provider + tier, billed amount | benefit class (proposed from the treatment + declared conditions), policy, plan terms, ledger |
| `preauth` | planned treatment, provider + tier, estimated cost | as above; date defaults to today |
| `reimbursement` | as `claim`, plus confirmation the member already paid | as above |
| `appeal` | which event is contested, what the member says | the contested reason code, the original adjudication, the whole history |

**Re-collect nothing** is enforced structurally: `list_missing_facts` computes
its answer by subtracting what `read_applicant_record`, `read_policy` and
`read_event_history` already returned. A question about a field that is already
known is rejected by the tool with the known value attached — the agent is
handed the fact instead of the member being asked for it.

### 5.2 The evidence loop

Evidence is not present/absent. It is a state machine, and the agent may only
move it one step at a time:

```
missing ──> requested ──> provided ──> extracted ──> validated ──┬─> relevant ──┬─> sufficient ──> continue
                                           │                     │              └─> insufficient ─┐
                                           │                     └─> irrelevant ──────────────────┤
                                           └─> unreadable ───────────────────────────────────────>┤
                                                                                                   ↓
                                                                                    identify the remaining gap
                                                                                                   ↓
                                                                            request (≤ MAX_EVIDENCE_REQUEST_ROUNDS)
```

`irrelevant` is a first-class outcome and the one that keeps the system honest:
evidence that does not bear on the contested reason code does not change the
outcome, however reasonable the member sounds. The member is told *why* it did
not help and *what would*.

**Conversational evidence counts.** The system distinguishes three kinds of
input and stores them differently:

| Kind | Example | Stored as |
|---|---|---|
| `user_answer` | "It was last Tuesday" | `conversation_question.answer_raw` + an `extraction` row |
| `document_evidence` | an uploaded / pasted registration certificate | `servicing_event.evidence_text` (this build is text-in, no OCR — out of scope per the brief) |
| `structured_fact` | "yes, authorised, ref AUTH-882" | an `extraction` row with `method: 'stated'` |

A member who says "yes I have the authorisation" has given an *answer*, not
evidence; the agent's next move is to ask for the document or the reference
number, and the evidence state stays `requested`.

### 5.3 The conflict loop

Two sources disagreeing is not resolved by picking one.

```
flag_conflict(field, valueA from source A, valueB from source B)
        ↓
ask the member which is right — quoting both, naming both sources
        ↓                                  (counts against MAX_CLARIFICATION_ROUNDS)
answer ──> record with method 'stated', supersede the other, re-run gapCheck
        ↓
no answer / answer contradicts the record again ──> escalate(cause: 'unresolved_conflict')
```

Live example in the supplied data: APP-1. The member says the diabetes was
diagnosed *after* inception; the intake record says it was declared *at
application, stable and managed*. That is a conflict in the strict sense — and
notably, one the member cannot resolve by assertion, because the record is a
thing they themselves said. So the agent does not ask "which is right"; it
tells them what the record shows and asks whether they have evidence of a
diagnosis date after inception. No evidence arrives, so the finding stands
(§5.4).

### 5.4 The appeal loop — the one that matters most

An appeal is **not** `user unhappy → send to advisor`. That design has no
opinion, learns nothing from the evidence, and quietly teaches members that
persistence beats accuracy.

An appeal argues against **exactly one reason code**, and that is what makes it
assessable instead of a mood:

```
Appeal
  ↓
Identify contested reason_code           ── from the original event row, never the prose
  ↓
Assess evidence against that reason      ── AGENT judges; the table bounds it
  │
  ├── evidence doesn't address the reason
  │        ↓
  │    Can useful evidence still exist?  ── DETERMINISTIC set-difference (§5.4.3)
  │        ├── yes ──> request evidence ──> LOOP  (≤ MAX_EVIDENCE_REQUEST_ROUNDS)
  │        └── no  ──> UPHOLD, and say what would have changed it
  │
  └── evidence addresses the reason
           ↓
       Propose a correction               ── AGENT, one field, closed vocabulary (§5.4.4)
           ↓
       RE-ADJUDICATE                      ── DETERMINISTIC, at the original ledger position
           ↓
       Different outcome?
        ├── yes ──> OVERTURN ──> advisor sign-off ──> supersede + refold ledger
        └── no  ──> UPHOLD, explain why it still lands the same way
```

**The boundary is the whole point.** The agent reasons about *evidence* — does
this certificate bear on the finding that was made? The deterministic engine
performs the *re-adjudication*. Neither is allowed to do the other's job: the
agent cannot decide that a claim is now payable, and the engine cannot decide
whether a document is relevant. An overturn is therefore never the model being
persuaded; it is the model correcting one input, and the same arithmetic that
denied the claim paying it.

#### 5.4.1 Identify the contested reason code

Taken from `servicing_event.reason_code` on the contested row — **never** from
the member's prose. The member names a grievance ("this isn't fair, the clinic
is independent"); the row names a finding (`provider_out_of_network`). Only the
finding can be argued with.

Five cases are not appeals at all, and each exits before the loop starts:

| Contested row | Why it is not an appeal | Exit |
|---|---|---|
| `reason_code = 'covered'` | There is no adverse finding. The member is disputing an *amount*, which is arithmetic over terms they can see in the trace | advisor, cause `unappealable_finding` |
| `reason_code = 'insufficient_data'` | Already with a human. The system never made a finding to contest | attach the evidence to the **existing** `review_task`; no second task |
| `reason_code = 'policy_not_active'` | Admissible evidence exists in principle (proof of payment) but billing is out of scope for this build | advisor, cause `unappealable_finding` |
| The row is already superseded | An earlier overturn already changed it. The record has moved on | show the superseding record |
| The row is itself an appeal | An appeal of an appeal is a second opinion, not new evidence | advisor, cause `appeal_of_appeal` |

Structurally: `appeal_of_event_id` must point at a row whose `outcome` is
`denied`, which is not already superseded, and which has no prior appeal. The
tool enforces all three; the agent cannot route around them.

#### 5.4.2 Admissibility — what could change this finding, and which input it turns on

The deterministic half of the loop. Each reason code was produced by **one**
step of the order of operations, and that step reads **one** input. So each
reason code has exactly one field an appeal can legitimately target — which is
what turns "assess the evidence" into a bounded question:

| Contested code | The input it turns on | Admissible evidence | Not admissible |
|---|---|---|---|
| `waiting_period_not_elapsed` | `benefit_class`, via the onset date of the condition | a dated diagnosis placing onset **after** inception; proof of prior continuous cover | the member's assertion against their own intake declaration; sympathy; cost; urgency |
| `provider_out_of_network` | `provider_tier` | the provider's licence showing a different registered tier | the provider's location, prestige, convenience, or being inside another building |
| `sublimit_exhausted` | the `benefit_class` of a **prior** event that consumed the cap | proof a prior event was misclassified into that class | need; appointments already booked; the cap being too low |
| `annual_limit_reached` | the `benefit_class` or amount of prior events | as above | as above |
| `benefit_excluded` | `benefit_class` | proof the treatment belongs to a class the plan does cover | the plan being a bad plan |
| `insufficient_data` | `geography` / `provider_tier` | anything that resolves the undefined term | — (but see §5.4.1: this routes to the advisor, not the loop) |

The "not admissible" column is not decoration. It is the list of things that
sound like arguments and are not, and the agent is shown it — because the
failure mode of a language model in an appeal is agreeing with a well-written
paragraph.

#### 5.4.3 "Can useful evidence still exist?" — a set-difference, not a judgment

This branch decides whether the member is asked for one more document or told
no. Leaving it to the model's sense of possibility would make it unbounded in
both directions — endless requests for a member who will never have the
document, or a premature uphold for one who would have produced it.

So it is computed:

```ts
remaining = admissibleKinds(contestedReasonCode)
          − kindsAlreadySupplied(appeal)
          − kindsTheMemberSaidTheyDoNotHave(appeal)
          − kindsAlreadyRequested(appeal, times: 2)
```

- `remaining` non-empty **and** under `LIMITS.evidenceRequestRounds` → request
  the single most likely item by name, with what it must show.
- `remaining` empty → **uphold now.** Asking again would be theatre.

The agent chooses *which* remaining kind to ask for and how to phrase it. It
cannot invent a kind outside `admissibleKinds` — `request_evidence` rejects it
— which means the system can never ask a member for a document that could not
have changed the answer even if they produced it.

APP-1 is the case: the admissible kinds are a dated post-inception diagnosis or
proof of prior cover; the member has supplied nothing and their own intake
record asserts the opposite. One request is warranted. If it comes back empty —
as it does — `remaining` is exhausted and the denial stands.

#### 5.4.4 The correction patch — one field, and only the one

Evidence that bears on the finding does **not** re-open the claim. It corrects
exactly one input and nothing else:

```ts
propose_correction({
  field: "provider_tier",           // ∈ the field this reason code turns on (§5.4.2)
  value: "in_network_clinic",       // ∈ that field's enum
  evidenceId: "...",                // which document
  quote: "independently licensed outpatient facility ... standard network tier",
})
```

Validation, before the engine is touched:

1. `field` **must** be the one the contested reason code turns on. An appeal
   against a network denial cannot patch the billed amount.
2. `value` must be a member of that field's closed enum.
3. `value` must differ from what is recorded — a patch that changes nothing is
   a rejection, not an overturn.
4. `quote` must be a verbatim span of the supplied evidence. A correction with
   no textual support in the document fails the turn.

Everything else about the event is **immutable under appeal**: billed amount,
date, `policy_month`, policy, member. Those are facts about what happened, not
findings about it, and an appeal is not a route to restating them. This single
restriction is what keeps an appeal from degenerating into "describe the claim
again, differently, until it pays."

#### 5.4.5 Re-adjudication — deterministic, at the original ledger position

```ts
const before = project(plan, eventsBefore(original));   // everything submitted before it, superseded rows dropped
const redone = adjudicate({ ...originalInput, ...patch, ledger: before });
```

Two things that are easy to get wrong and both change the numbers:

- The re-adjudication runs against the ledger **as it stood before the original
  event**, not against today's. APP-2 must be adjudicated against P4's empty
  ledger at month 7, which is why its deductible of 500 applies.
- Everything after the original event is then **refolded**, because the
  overturn injects consumption into the middle of the history. This is
  `effectOrder` from §3.2 doing its job, and it is why PRE-2 at month 9
  forecasts against a met deductible rather than a fresh one.

`assertReplayable` runs immediately after. An overturn that breaks replay is a
bug in `effectOrder`, and it is caught at the moment it is introduced rather
than three events later.

#### 5.4.6 "Different outcome?" — and the never-worse rule

Compare the tuple `(outcome, reason_code, plan_pays)`:

| Result | Action |
|---|---|
| Better for the member | **overturn** → advisor sign-off (§2.3) |
| Identical | **uphold** — but with a *new* explanation: we looked again, with your document, and here is why it still lands the same way |
| Worse for the member | **uphold the original.** The appeal is closed at no cost to them |

The last row is a deliberate rule, not an oversight: **an appeal can never cost
a member money.** If a correction that helps on one gate hurts on another, the
original stands. A member who supplies honest evidence must never be punished
for it, and without this rule a sufficiently thorough re-adjudication
eventually would.

An uphold-after-admissible-evidence is also the most under-built outcome in
most systems and the one most worth writing well. The member did the work, sent
the document, and still lost; the explanation owes them the reason and the
arithmetic, not a form letter.

#### 5.4.7 Writing an overturn — supersede, never edit

One new append-only row:

```
kind:                appeal
outcome:             overturned
reason_code:         the RE-ADJUDICATED code (usually `covered`)
plan_pays/member_pays: from the re-adjudication
calculation:         the new trace, plus the correction that caused it
appeal_of_event_id:  CLM-4      ── what was contested
supersedes_event_id: CLM-4      ── what it replaces in the ledger fold
decided_by:          advisor    ── after sign-off; the system never self-signs an overturn
```

The denial stays on the record. Both are true: it was denied, and the appeal
reversed it. The ledger fold takes the superseding row at the superseded row's
position (§3.2) and the denial drops out of the fold — it does not double-count
and it does not vanish.

An upheld appeal writes a row too (`outcome: 'upheld'`, no `supersedes`, no
ledger movement). Appeals that changed nothing are still part of the history,
and the reassessment loop reads them — "denied, appealed, upheld, then paid once
the wait cleared" is exactly the P3 narrative the brief says it is looking for.

#### 5.4.8 The two supplied appeals, traced

**APP-1 — the denial that must hold.**

```
contested row      CLM-3, reason_code = waiting_period_not_elapsed
member says        "diagnosed after I took out the policy — shouldn't be pre-existing"
evidence attached  none
on file            type 2 diabetes, DECLARED at application, stable, managed

read_applicant_record  → the declaration, in the member's own intake
assess_evidence        → does_not_bear_on
                         (an assertion contradicting one's own declaration is
                          listed as not admissible; nothing was supplied)
can useful evidence exist?  remaining = { dated post-inception diagnosis,
                                          proof of prior cover }  → request one
member returns nothing      remaining exhausted
                       → UPHOLD

member register    Your diabetes was recorded as an existing condition when you
                   applied, so the six-month wait applies and this visit isn't
                   covered. What would change it is a dated diagnosis showing
                   the condition was first found after 1 January 2026. The wait
                   clears at month 6 either way — treatment from July is covered
                   normally, and your follow-up in month 7 will be.
broker register    POL-P3, chronic wait contested at month 4 with no evidence
                   against a declared condition. Upheld. Balanced's 6-month
                   chronic wait is the binding term; it clears at month 7 and
                   CLM-8 pays. Not a fit signal — the tradeoff is behaving as sold.
```

Note what makes the member explanation good: it is not "no." It tells them the
denial is temporary and names the date it stops being true.

**APP-2 — the denial that must fall.**

```
contested row      CLM-4, reason_code = provider_out_of_network
member says        "the physio clinic is inside the hospital but isn't part of it"
evidence attached  registration certificate — Gulf Physiotherapy Centre LLC,
                   independently licensed outpatient facility, STANDARD tier

assess_evidence     → bears_on
                      (the contested code turns on provider_tier; a licence
                       naming a different registered tier is exactly the
                       admissible kind)
propose_correction  → { field: provider_tier,
                        value: in_network_clinic,
                        quote: "independently licensed outpatient facility" }
                      validated: right field, valid enum member, differs, quoted
re-adjudicate       → ledger before CLM-4 = empty
                      deductible min(500, 6000) = 500 → 5,500
                      co-pay 20% = 1,100 → plan 4,400, member 1,600
different outcome?  → denied/0 → covered/4,400.  OVERTURN
advisor sign-off    → one click, with the arithmetic already shown
write               → supersedes CLM-4 at month 7; refold; replay check passes

member register    You were right — the certificate shows the physiotherapy
                   centre is licensed in its own right, not as part of the
                   hospital, so it's inside your network. We've reversed the
                   decision: the plan pays 4,400 of the 6,000 and your share is
                   1,600 (your 500 deductible, then the 20% share). Your
                   deductible is now met for the year.
broker register    POL-P4 CLM-4 overturned on provider licensing evidence;
                   tier corrected top_tier_private_hospital → in_network_clinic.
                   Plan pays 4,400, ledger rewritten at month 7 — PRE-2's month-9
                   forecast now assumes a met deductible. One out-of-network
                   episode, and it was a recording error rather than member
                   behaviour: not a pattern, no fit implication.
```

#### 5.4.9 Why this holds under pressure

The model never decides the outcome of an appeal. It decides **admissibility**
and proposes **one field**, and both are checked against a table derived from
the order of operations. A beautifully argued appeal with no admissible
evidence gets a considered, well-written *no*; a badly written one with a
licence certificate attached wins. That is the correct ordering, and it is
structural rather than a matter of how the prompt is worded on the day.

The test that proves it is in §18: swap the evidence between APP-1 and APP-2
and the outcomes must swap with it.

### 5.5 The reassessment loop

Reassessment runs after every ledger-mutating event and reads the **event
log**, not the counters. `lib/servicing/reassess.ts` extracts the history
features the agent is allowed to reason from, so the reasoning cannot be
generic:

```ts
type FitFeatures = {
  denialsByReasonCode: Record<ReasonCode, ServicingEvent[]>;  // "second denial for the same reason"
  repeatedDenialReasons: ReasonCode[];
  capsHit: { benefitClass: BenefitClass; eventId: string; policyMonth: number }[];
  waitingPeriodsCleared: { benefitClass: BenefitClass; deniedEventId: string; laterPaidEventId: string }[];
  outOfNetworkEpisodes: ServicingEvent[];                     // count, not vibe
  memberShareRatio: number;                                   // what it COST them, not just cover
  premiumVsPaid: { premium: number; planPaid: number; memberPaid: number };
};
```

The agent must cite at least one feature by event id. A reassessment whose
prose contains no event reference fails verification and is not written —
exactly the citation rule
[`lib/ai/graph/nodes/recommendation.ts`](lib/ai/graph/nodes/recommendation.ts)
already applies to figures.

This is what lets the system say, for P3, *"the tradeoff came due and then
resolved: CLM-3 was denied at month 4, the appeal was upheld, and CLM-8 paid at
month 7 once the wait cleared — switching plans now would restart a waiting
period you have already served"* rather than *"annual_paid is 1,680."*

---

## 6. Wait states — replay, not resume

The user-facing spec describes interrupts as "resume the same graph thread."
**This repo deliberately does not do that**, and the servicing graph must not
be the one place that does.

[`lib/ai/graph.ts`](lib/ai/graph.ts) compiles with `new MemorySaver()` **per
invocation** and discards it. An `interrupt()` is a control-flow exit, not a
suspended process. Durable state is the rows; the next turn loads them, rebuilds
the state annotation and invokes the graph again from `START`.

Why keep that here:

- A member can answer a question three days later, from a different device,
  after a server restart. An in-memory checkpointer loses that; rows do not.
- The `conversation_question` row is already the wait state, with
  `status: 'asked' | 'answered'` and an `ask_count <= 2` database check that
  makes "never ask the same thing three times" structural rather than hoped-for.
- It keeps one rule for the whole codebase.

The three human interaction points, and what each is durably:

| Interaction | Durable row | Resumed by |
|---|---|---|
| Ask the member a fact | `conversation_question` (`status: 'asked'`) | the member's next message; the session loads open questions and folds the answer in |
| Request evidence | `conversation_action` (`action_type: 'evidence_requested'`) + a pending `servicing_event` in `draft` | evidence arriving on the same conversation |
| Advisor gate | `review_task` (`subject_type: 'servicing_event' \| 'reassessment'`) | `review_decision`, which triggers the write |

So `interrupt()` still appears in the nodes — it is how a node says *"this turn
ends here and a human owns the next move"* — but nothing depends on the
checkpointer surviving the request.

---

## 7. Loop limits and escalation

From config, never hardcoded at a call site — `lib/servicing/limits.ts`:

```ts
export function readLimits(env = process.env): Limits;  // testable with any environment
export const limits: () => Limits;                       // memoized; read at first use, never at import
```

The defaults match the values in the brief's example; they are defaults, not
constants. Counters are **rebuilt from rows** each turn (count the
`conversation_question` rows for this event, count the `evidence_requested`
actions), never carried in graph memory — same discipline as
`clarificationAsked` in
[`lib/ai/graph/nodes/clarify.ts`](lib/ai/graph/nodes/clarify.ts).

Escalation causes, a closed set on `escalate`:

```
insufficient_data            the plan terms do not decide this        (CLM-9)
unresolved_conflict          two sources disagree and no answer settled it
clarification_limit          asked our allowance, still short a required fact
evidence_limit               asked for what we needed, it did not arrive
appeal_overturn              computed, needs one signature
reassessment_change          a plan change recommendation needs a human
model_failure                the loop did not complete; fall back, do not guess
member_requested             the member asked for a person — always available (§13.2.1)
```

Every one of them produces the same artefact: a **case packet**.

---

## 8. Advisor escalation, call and callback

Escalation is not only something the agent does *to* the member. **Talk to an
advisor** is on screen from the first message (§13.2.1), and pressing it builds
exactly the packet below with `cause: member_requested` — the design goal is
that it is rarely pressed, not that it is hard to find.

```
escalate(cause)
   ↓
build packet ──> review_task { subject_type: 'servicing_event', priority_score, reason }
   ↓
broker queue (ordered, §12) ── advisor resolves ──> review_decision ──> new event row, decided_by 'advisor'
   ↓
member sees: a reference, what happens next, and two buttons
```

The packet is not a new table — it is a query, assembled from what already
exists, so nothing can drift out of sync with the record:

```
conversation transcript        message
facts collected                extraction + conversation_question
evidence + its state           servicing_event.evidence_text + conversation_action
the adjudication attempted     servicing_event (draft) + calculation trace
prior decisions + reason codes servicing_event history
appeal attempts                servicing_event where appeal_of_event_id is set
reassessment attempts          plan_fit_reassessment
unresolved questions           conversation_question where status = 'asked'
why it escalated               review_task.reason + servicing_event.uncertainty_reason
```

What the member sees — no internal vocabulary, no cohort, no flags:

```
We couldn't settle this one automatically.

Your claim and everything you've told us is with an advisor — you
won't need to repeat any of it.

Reference: CLM-9

[ Call an advisor ]   [ Request a callback ]
```

The number comes from `process.env.ADVISOR_PHONE` via a config module, never
from the model and never hardcoded in a component. "Request a callback" writes
a `conversation_action` row (`action_type: 'callback_requested'`) that surfaces
on the same queue task — no telephony integration, which is out of scope.

**The member loses no progress.** Because every answer was written as it
arrived, the advisor opens a complete case and the member is never asked a
second time.

---

## 9. Graph state — `lib/ai/graph/state.ts`

Added as a third annotation alongside `IntakeState` and `AssessmentState`, same
last-write-wins reducers, same rule: *the graph holds one turn's thinking; the
rows hold the truth.*

```ts
export const ServicingState = Annotation.Root({
  // --- loaded fresh every turn, never carried ---
  policy:         latest<PolicyContext | null>(() => null),
  planTerms:      latest<PlanTerms | null>(() => null),
  record:         latest<AssessmentRecord>(emptyRecord),   // re-collect nothing
  history:        latest<ServicingEventRow[]>(() => []),
  ledger:         latest<LedgerState>(() => EMPTY),

  // --- this turn's understanding ---
  transcript:     latest<{ role: "member" | "assistant"; text: string }[]>(() => []),
  intent:         latest<EventKind | null>(() => null),
  draft:          latest<EventDraft>(emptyEventDraft),     // the event being assembled
  knownFacts:     latest<Record<string, FactValue>>(() => ({})),
  missingFacts:   latest<string[]>(() => []),
  conflicts:      latest<Conflict[]>(() => []),

  // --- evidence ---
  evidence:       latest<EvidenceItem[]>(() => []),        // each with its EvidenceState
  evidenceGaps:   latest<EvidenceGap[]>(() => []),

  // --- the answer ---
  adjudication:   latest<AdjudicationResult | null>(() => null),
  memberExplanation: latest<string | null>(() => null),
  brokerExplanation: latest<string | null>(() => null),
  confidence:     latest<number>(() => 0),
  uncertaintyReason: latest<string | null>(() => null),

  // --- appeal ---
  appealOfEventId: latest<string | null>(() => null),
  contestedReasonCode: latest<ReasonCode | null>(() => null),
  appealVerdict:  latest<"uphold" | "overturn" | null>(() => null),

  // --- counters, rebuilt from rows each turn (§7) ---
  clarificationCount:  latest<number>(() => 0),
  evidenceRequestCount:latest<number>(() => 0),
  reassessmentCount:   latest<number>(() => 0),

  // --- exits ---
  escalation:     latest<Escalation | null>(() => null),
  trace:          latest<RecommendationTraceStep[]>(() => []),  // reused shape
  servedBy:       latest<string | null>(() => null),
  latencyMs:      latest<number>(() => 0),
});
```

Note what is **not** here: no `decision`, no `resolution`, no `advisorCase`
object. Those are rows — `servicing_event`, `review_task`, `review_decision` —
and putting a copy in graph state would create a second truth.

---

## 10. Graph topology — `lib/ai/graph.ts`

Wired in the one file that holds every topology, matching the comment block at
its head.

```
  SERVICING — the main flow (claim, pre-auth, reimbursement)

    understand ──> loadContext ──> gapCheck ──┬──> askMember        (interrupt)
                        ▲                     ├──> requestEvidence  (interrupt)
                        │                     ├──> reconcile        (interrupt)
                        │                     └──> adjudicate
                        │                              ↓
                        │                           explain
                        │                              ↓
                        │                            gate ──┬──> servicingGate (interrupt: advisor)
                        │                                   │         ↓
                        │                                   └──────> commit ──> reassess ──> END
                        └── processResponse <── INTERRUPT

    escalate ──> END   (from gapCheck, identifyContested, or any exhausted limit;
                        the session builds the case packet)
```

And the appeal sub-graph — entered from `understand` when `kind = appeal`,
rejoining at `commit`:

```
  APPEAL (§5.4)

    identifyContested ──[not appealable: §5.4.1]──> escalate
            │
            ▼
      assessEvidence ────────────────────────────┐
            │ bears_on                           │ does_not_bear_on
            ▼                                    ▼
      proposeCorrection                  evidenceStillPossible
            │                                    │
            │ valid ──> reAdjudicate             │ remaining ──> requestEvidence
            │                │                   │                  (interrupt, ≤ limit)
            │                ▼                   │                        │
            │          compareOutcome            │                        ▼
            │                │ better ──> OVERTURN                 processResponse
            │                │ same   ──> UPHOLD  │                       │
            │                │ worse  ──> UPHOLD  │                       ▼
            │                                     │              assessEvidence  (LOOP)
            │ invalid ──> UPHOLD                  │ exhausted ──> UPHOLD

    OVERTURN ──> servicingGate (interrupt: an advisor signs every overturn — §2.3)
                      │
                      ▼
    UPHOLD ──────> explain ──> commit ──> reassess ──> END

    UPHOLD   writes an `upheld` row; no ledger movement; the history keeps it (§5.4.7)
    OVERTURN writes a superseding row at the ORIGINAL event's position (§5.4.5)
```

Nodes, one file each under `lib/ai/graph/nodes/servicing/`:

| Node | Model? | What it does |
|---|---|---|
| `understand` | yes | classifies the member's opening into an `EventKind` + which policy |
| `loadContext` | no | policy, plan terms, intake record, history, projected ledger |
| `gapCheck` | no | required-field table minus known facts → `missingFacts`; detects conflicts |
| `selectQuestion` | yes | picks *which* gap to close, justifies it |
| `askMember` | — | `interrupt()`; writes a `conversation_question` row |
| `requestEvidence` | yes → validated | names the document **and the reason code it must bear on**; `interrupt()` |
| `reconcile` | yes | states both values and both sources; `interrupt()` |
| `processResponse` | yes | extracts facts / classifies evidence state; folds into `knownFacts` |
| `adjudicate` | no | the pure function. Dry run for pre-auth |
| `identifyContested` | no | reads the contested row's `reason_code`; refuses the five non-appeals in §5.4.1 |
| `assessEvidence` | yes → table | admissibility only (§5.4.2) — never payability |
| `evidenceStillPossible` | no | the set-difference of §5.4.3: request again, or uphold now |
| `proposeCorrection` | yes → validated | one field, from the closed set the contested code turns on (§5.4.4) |
| `reAdjudicate` | no | `adjudicate` against the ledger **as of the original event**, then refold (§5.4.5) |
| `compareOutcome` | no | better / identical / worse → overturn / uphold / uphold-original (§5.4.6) |
| `explain` | yes → citation-checked | both registers; every figure must appear in `calculation` |
| `gate` | no | §2.3's table. Routes to `servicingGate` or `commit` |
| `servicingGate` | — | `interrupt()`; writes `review_task` |
| `commit` | no | appends the event, re-projects the ledger, asserts replayable |
| `reassess` | yes → feature-cited | writes `plan_fit_reassessment` |
| `escalate` | no | builds the packet, `review_task`, member-facing reference |

Conditional edges:

```
gapCheck      ──> "ask" | "evidence" | "reconcile" | "adjudicate" | "escalate"
                  (escalate when a counter has hit its limit)
understand    ──> "identifyContested" when kind = appeal, else "loadContext"
identifyContested ──> "assessEvidence" | "escalate"   (§5.4.1's five non-appeals)
assessEvidence──> "proposeCorrection"            (bears_on)
                | "evidenceStillPossible"        (does_not_bear_on)
evidenceStillPossible ──> "requestEvidence" | "uphold"
proposeCorrection ──> "reAdjudicate" | "uphold"  (a patch that fails validation is not an overturn)
reAdjudicate  ──> "compareOutcome"
compareOutcome──> "overturn" | "uphold"
gate          ──> "servicingGate" | "commit"
explain       ──> "gate"
commit        ──> "reassess" | END  (denied events still reassess; pre-auths do not commit)
```

Compiled and invoked by `lib/ai/servicing-session.ts`, which mirrors
[`lib/ai/recommendation-session.ts`](lib/ai/recommendation-session.ts): load
inputs from rows → invoke → inspect `snapshot.tasks[].interrupts` → persist
what the turn produced → return a view model.

---

## 11. Persistence — what is written, and where

| Produced | Table | Note |
|---|---|---|
| Every member / assistant turn | `message` | `conversation.purpose = 'servicing'` |
| Each question asked | `conversation_question` | `ask_count <= 2` is a DB check |
| Each fact extracted | `extraction` | with the span the member actually said |
| Evidence requested | `conversation_action` | `action_type: 'evidence_requested'` |
| The event itself | `servicing_event` | append-only; trigger-enforced |
| Ledger | `benefit_ledger` | projection; rewritten by `commit`, never incremented |
| Model call | `model_run` | model id + prompt version, per existing convention |
| Classification / appeal / reassessment judgments | `ai_decision` | types already in the enum |
| Escalation | `review_task` | `subject_type: 'servicing_event'` |
| Advisor's action | `review_decision` + a **new** `servicing_event` | `decided_by: 'advisor'`; never an edit |
| Fit verdict | `plan_fit_reassessment` | |

**Schema changes required: none.** Every column this design needs already
exists, including `confidence`, `uncertainty_reason`, `geography`,
`appeal_of_event_id` and `supersedes_event_id`. Two additive TS-only tuple
widenings may be wanted and cost no migration (SQLite stores these as text):
`conversationActionTypeEnum` gaining `evidence_requested` / `callback_requested`
if it is a closed tuple today, and nothing else.

---

## 12. The two views, and the queue

### 12.1 Registers

Enforced structurally: the customer surface reads `customer_event_view` and
`customer_policy_view`, which cannot project `confidence`,
`uncertainty_reason`, `decided_by`, cohort or flags. The broker surface reads
the tables.

The prose is **written twice, not filtered** — `explain` produces both in one
call and the verification requires them to differ in more than length:

- **CLM-7 to the member:** the maternity benefit paid 25,000 of the 25,000 it
  covers this year, so the postnatal visits are not covered — here is what the
  three appointments already booked will cost, and the benefit resets on
  1 Jan 2027.
- **CLM-7 to the broker:** POL-P2 hit the maternity cap at month 9 on CLM-2 and
  the first post-cap event landed at month 11. Comprehensive's 25,000 cap was
  the binding constraint, not the network or the co-pay — worth naming at
  renewal.

### 12.2 Queue ordering

The bands below are the sort key *within* a group. How servicing tasks map onto
the queue's existing groups — and why that order — is §13.3.1.

`listQueue` must learn to hydrate `servicing_event` and `reassessment`
subjects. Priority score, highest first:

| Band | Score | What |
|---|---|---|
| Undecidable | 100 | `insufficient_data` — the system explicitly refused to answer (CLM-9) |
| Money waiting on a signature | 90 | appeal overturns computed and ready (APP-2) |
| Member blocked | 80 | loop limit hit, member is waiting with no answer |
| Judgment | 60 | reassessment recommending a plan change |
| Quality check | 40 | low-confidence adjudications that still resolved |
| Informational | 20 | callback requested on a resolved case |

Within a band, oldest first — a member waiting three days outranks one waiting
three minutes.

And the thing the brief says it will read closely: **every queue row carries
"why this needs you"** from `uncertainty_reason`, and a confidence signal.
CLM-9 reads *"the plan says nothing about treatment outside the UAE — this
cannot be decided from the plan terms"*; a clean claim never reaches the queue
at all. Those two must not look alike, and the cheapest way to guarantee it is
that the second one is simply absent.

---

## 13. UI/UX

The engine and the agent are only worth what a member and a broker can see of
them. This section designs both surfaces, and it is built into every phase in
§17 rather than saved for the end: a phase is not done until a person can use
what it built.

### 13.0 Principles

Seven rules. Each one exists because the brief or the existing product already
took a position, and the design below is these rules applied.

1. **Ask nothing you know — and show that you know it.** Re-collecting nothing
   is a promise the member can only believe if they can see it kept. Every
   servicing conversation opens with what is already on file, and every card
   pre-fills from it.
2. **One question at a time, and the answer is the shortest possible input.**
   A closed vocabulary becomes tappable chips; a free fact becomes a sentence;
   a fact the agent inferred becomes a *confirm* card, never a silent guess. The
   member types only when only typing will do.
3. **The member never leaves the one screen.** The brief says the customer view
   is deliberately thin. Every servicing flow opens in the drawer over
   `/policies/[id]`; there is no `/claim` page, no `/appeal` page, no wizard.
4. **Every wait state is designed.** Waiting on the member, on a document, on an
   advisor, and on the model each have their own look and their own sentence.
   A spinner is only ever the model thinking, and only for as long as it is.
5. **The verdict comes first, then the number, then the why, then what to do.**
   A denial that ends at "not covered" has failed; it ends at a dated next step.
6. **The two registers are two things, not one thing filtered.** Enforced at the
   data layer, the component layer and the copy layer (§13.4) — three
   independent fences, because prose discipline alone is the one that fails at
   2am.
7. **The human is always one tap away, and never the first resort.** "Talk to an
   advisor" is on screen from the first message, not unlocked by failure. The
   design goal is that it is rarely pressed, not that it is hard to find.

### 13.1 What exists, and what this reuses

More of the UI exists than the phase-1 plan assumed. Reuse first.

| Already built | Where | Used for |
|---|---|---|
| Advisor console: sidebar groups, dashboard, queue, pipeline, clients, timeline | `app/`, [components/crm/](components/crm/) | The broker surface; servicing rows join the same queue and timeline |
| Queue row, one component mounted twice, with priority band, confidence badge, "why" line | [components/crm/queue-row.tsx](components/crm/queue-row.tsx) | Servicing rows |
| Queue grouped by *kind of attention* (Blocked / Genuinely uncertain / Needs a decision) | [app/queue/page.tsx](app/queue/page.tsx) | The ordering the brief says it reads closely |
| Timeline with `servicing` and `reassessment` kinds already defined | [components/crm/timeline.tsx](components/crm/timeline.tsx), `getClientTimeline` reads `servicing_event` | Client 360 needs no new work |
| Applicant chat drawer as an *intercepted route* (deep-linkable, back button works, reload falls back to a page) | `app/@chat/`, [components/chat/](components/chat/) | The servicing drawer — same mechanism, new route |
| Interactive message payloads with type guards (questionnaire, clarify, trade-off card) | `lib/ai/intake-session.ts`, [components/trade-off-card.tsx](components/trade-off-card.tsx) | The servicing card vocabulary (§13.2.4) |
| Composer with echoed message, typing indicator, quick-reply chips | [components/chat-composer.tsx](components/chat-composer.tsx) | Servicing composer |
| Four-verb decision forms; two-text rule (broker note + member message) | [components/recommendation-review.tsx](components/recommendation-review.tsx), `app/applications/[id]/actions.ts` | Servicing decisions |
| `UtilizationBar`, `StatusBadge`/`Tone`, `SectionCard`, `Empty`, skeletons, `loading.tsx` per route | `components/` | Everything |
| Member-register labels for outcomes and reason codes | [lib/domain.ts](lib/domain.ts) (`outcomeLabel`, `reasonCodeLabel`) | Extended, not replaced |
| `conversation.status` values `awaiting_user`, `awaiting_review`, `escalated`, with labels | `db/schema/enums.ts`, `lib/domain.ts` | The state machine of §13.2.3 — the states already exist |

Three findings that change the plan:

**F1 — The customer SQL views are never used. Fixed in phase 2.** `customer_event_view` and
`customer_policy_view` were written to enforce the two registers in SQL, and
nothing reads them. [app/policies/[id]/page.tsx](app/policies/[id]/page.tsx)
loads the full `servicing_event` row for a member — `confidence`,
`uncertainty_reason`, `broker_explanation`, `decided_by` included — and picks
what to print with `isAdvisor ?` inside the JSX. That is the brief's "same
object with different styling", and the only thing between a member and the
broker's uncertainty note is a conditional that a refactor can drop. Phase 2
fixed it before servicing multiplied it (§13.4). It was also wider than first
read: `lib/queries.ts` opens by promising that "the applicant-facing helpers
never select a broker-only column", and `listReassessments` broke that promise
too — every member's page loaded the broker's fit reasoning. Both reads are now
split into member and broker functions.

**F4 — The calculation trace is member-facing, and it leaked. Found in phase 2.**
Spec §4b lists the trace as visible to the customer, so it is a member string
like any other — and the first scan of member copy covered only the
explanation. Browsing P5 as a member showed CLM-9's trace reading *"provider tier
unknown_foreign … routed to a reviewer"*: an enum token and workflow vocabulary.
Other denial traces carried `top_tier_private_hospital` and `chronic_preexisting`,
and the appeal rows carried `CLM-4`. Fixed at the source (the engine now words
its traces in member language) and the scan now covers every trace line. The
general rule: **every string a member can read is scanned, not the ones we
remembered to.**

**F2 — `subjectHref` is a stub.** `subjectHref("servicing_event", …)` returns
`"/policies"`, and `listQueue` hydrates only `application` and `recommendation`
subjects, so a servicing task today would render as a bare row with no subject.
Phase 6 replaces both.

**F3 — The launcher is intake-only.** `ChatLauncher` links to
`/applications/new/chat` and `chatAttention` counts only `active` intake
conversations. A member with an evidence request waiting would see no dot.
Phase 4 extends both to servicing conversations in `awaiting_user`.

### 13.2 The member surface — one screen

#### 13.2.1 The screen

`/policies/[id]` stays the single member screen. It gains an action bar and a
"what's in progress" strip, and loses nothing.

```
┌─ Balanced · POL-P3 ─────────────────────────────────────  [ Talk to an advisor ] ─┐
│  Active since 1 January 2026 · month 7                                              │
│                                                                                     │
│  [ Is this covered? ]   [ Claim, or get money back ]                                │
│                                                                                     │
│  In progress ─────────────────────────────────────────────────────────────────────  │
│  ◔ Your appeal — endocrinology visit, month 4.  We're checking it.        [ Open ]  │
│                                                                                     │
│  What you've used                       Your cover                                  │
│  Deductible  ▓▓▓▓▓▓▓▓▓▓ 500 of 500      Premium · deductible · co-pay · network …   │
│  Annual      ▓░░░░░░░░░ 1,680 of 500k                                               │
│                                                                                     │
│  Does this plan still fit?   Still the right plan                                   │
│  Your existing-condition wait ended at month 6 — your month-7 visit was paid.       │
│  Switching now would start that wait again.                                         │
│                                                                                     │
│  What's happened ─────────────────────────────────────────────────────────────────  │
│  ● Follow-up endocrinology · month 7            Covered      You pay 920            │
│  ● Endocrinology consultation · month 4         Not covered  You pay 2,800  [Appeal]│
│      The waiting period hadn't finished. It finishes at month 6 (1 July 2026).      │
│      ▸ How this was worked out                                                      │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

- The two action buttons start a servicing conversation and open the drawer.
  **Claim and reimbursement are one entry point**: "have you already paid?" is a
  fact the agent asks, not a fork the member has to understand up front.
- **Appeal is contextual, not a third top-level button.** It appears on the row
  of a denial that can be appealed, and nowhere else — which is also how the
  loop is pre-loaded with the contested event (§5.4.1). It is absent on `covered`
  rows, on `insufficient_data` rows (already with a person), on a row already
  superseded, and on a row already appealed, which instead says what came of it.
- **"Talk to an advisor" is always in the header** — never behind a failure.
  Pressing it builds the same case packet as an automatic escalation
  (`cause: member_requested`, added to §7).
- The brief's "anything pending" is the **In progress** strip. It shows open
  servicing conversations and appeals in flight, in the member's words (below).

**The pending-review tension, decided.** Spec §4b says *"pending-review status
and why"* is broker-only, and the brief asks for the customer view to show
"anything pending". Both hold if the member is told **that** something is
unfinished and **who they can reach**, and never told the review workflow: not
the task, not the queue position, not why the system routed it, not who is
assigned, not the note. So a member sees *"We're checking your evidence"*,
*"We're finalising this"* (an overturn awaiting a signature — true, and not the
word "sign-off"), or *"An advisor is looking at this"* with Call / Callback
(§13.2.7) — the last because the escalation the plan promises is only usable if
it is visible.

#### 13.2.2 Entry, and the opening message

The two buttons submit a server action that creates a `conversation`
(`purpose: 'servicing'`, bound to the policy, with a kind hint) and redirects to
`/policies/[id]/service/[conversationId]`. The `@chat` slot intercepts it, so it
opens as a drawer over the screen; a reload or a shared link renders the same
component as a page. This is `@chat/(.)applications/new/chat/[id]` again, one
route over. (AGENTS.md: this Next.js differs from training data — read
`node_modules/next/dist/docs/` on intercepting routes before writing the route.)

The **opening message is deterministic, not generated.** No model latency, and it
is where "re-collect nothing" is stated aloud:

> Tell me about the treatment. I already have your plan and what you've used so
> far, so I'll only ask for what I'm missing.

#### 13.2.3 The conversation is a state machine, and the states already exist

| `conversation.status` | Means | The drawer shows | Launcher |
|---|---|---|---|
| `active` | The agent is working | typing indicator, composer disabled | — |
| `awaiting_user` | A question, document or confirmation is open | the card + composer | **dot** |
| `awaiting_review` | An advisor owns the next move | "With an advisor" banner, no spinner, composer stays open for messages | — |
| `escalated` | The agent could not resolve it safely | the escalation card: reference, Call, Callback (§13.2.7) | **dot** when an advisor has replied |
| `completed` | An outcome was reached | the outcome card, pinned; composer offers "another claim" | — |

`awaiting_review` is not a dead end: the member can still add a message or a
document, which lands in the packet the advisor is reading.

#### 13.2.4 The card vocabulary

Every agent move is one of six cards, so the UI is a small closed set the same
way the agent's tools are. Each card is a typed payload with a type guard
(matching `isRecommendationTradeOffPayload`), and each maps 1:1 to a tool in §4.1
— the tool's return value *is* the payload, so nothing is translated.

| Card | Produced by | What the member does | Notes |
|---|---|---|---|
| **Question** | `ask_member` | types, or taps a chip | Closed vocabularies are chips: provider type, "have you already paid?", benefit category |
| **Confirm** | `classify_benefit`, tier / geography proposal | "Looks right", or edits a field | Shows the agent's *reading*, in plain words, before any money is computed |
| **Evidence request** | `request_evidence` | pastes or describes the document, or taps **"I don't have this"** | The button is load-bearing: it feeds §5.4.3's "declined" set |
| **Conflict** | `flag_conflict` | picks one of two quoted values | Both sources named, neither pre-selected |
| **Outcome** | `propose_outcome` | reads; taps a next step | §13.2.5 |
| **Escalation** | `escalate` | Call, or Request a callback | §13.2.7 |

**Provider type is a chip question, not free text.** There is no provider
directory in the data, so "ABC Hospital" cannot be resolved to a network tier,
and a model guessing one would be inventing a fact that decides whether the
claim is paid. The member picks *Clinic / General hospital / Private hospital /
Top-tier private hospital / Premium private hospital / Outside the UAE*, in
those words, with the provider's name captured separately for the record. "Not
sure" is a chip too: it asks once for the provider's name and type, and if that
still does not settle it, escalates with the packet rather than guessing.
"Outside the UAE" is what routes CLM-9 to `insufficient_data` honestly — from
the member's own answer, not the model's suspicion.

**The confirm card is where the model's reading meets the member's knowledge.**

```
  Here's what I've got — is it right?
  ┌─────────────────────────────────────────────────────┐
  │ Treatment   Physiotherapy after your wrist fracture │
  │ When        Month 8 — August 2026                    │
  │ Provider    Al Noor clinic · Clinic                  │
  │ Amount      AED 1,800                                │
  │ Paid        Not yet — the clinic will bill the plan  │
  │ Counts as   Routine treatment                        │
  │                                                      │
  │  [ Looks right ]              [ Change something ]   │
  └─────────────────────────────────────────────────────┘
```

Every field is one the agent extracted or inferred; "Counts as" is the benefit
class in member words (*Routine treatment / Maternity / An existing condition /
Dental & optical*). An `existing condition` reading names the condition from the
member's own application ("your type 2 diabetes"), which is also the visible
proof of re-collect-nothing. Nothing here is broker vocabulary: no cohort, no
flag, no risk.

**No-model mode.** Free models throttle without warning (the OpenRouter
fallback list in `.env.example` exists for this). A servicing conversation must
never dead-end on a model failure: with no key or a failed turn, the agent's
question renders as a **small form card** listing exactly the missing fields
from the required-field table (§5.1), in the same thread. Slower to fill in, and
it always works — and it means the acceptance run (§14) can be driven from the
UI with no model at all.

#### 13.2.5 The outcome card

Verdict → numbers → why → what to do → how it was worked out.

```
  ┌ Physiotherapy · month 8 ─────────────────────────────── ✔ Covered ─┐
  │  Billed  1,800        Plan pays  1,260        You pay  540          │
  │                                                                     │
  │  Your deductible was already met this year, so you only pay your    │
  │  30% share of this one.                                             │
  │                                                                     │
  │  What happens next                                                  │
  │  The plan pays the clinic directly. Nothing for you to do.          │
  │                                                                     │
  │  ▸ How this was worked out                                          │
  └─────────────────────────────────────────────────────────────────────┘
```

The three variants that matter:

- **Not covered** — the reason in member language, then a **What you can do**
  list of dated, specific options: the date a waiting period ends, which
  provider types the plan does cover, the date a yearly limit resets, and
  *Appeal this decision*. These facts are computed, not written: a new
  deterministic `lib/servicing/next-steps.ts` (phase 2) derives them from the
  plan terms and result, so the agent phrases dates it was handed and cannot
  invent them (same citation rule as every figure).
- **Estimate** (pre-authorization) — dashed border and an **Estimate** badge, so
  it cannot be mistaken for a decision. *"If this goes ahead as planned, the plan
  would pay about 25,000 and you'd pay about 15,000."* Then the two lines that
  matter: **why** (*"your maternity limit of 25,000 caps what the plan pays"*)
  and **the caveat** (*"Based on what you've used so far. Nothing has been
  claimed or set aside."*). It also says when the answer would change: after the
  next claim moves the balance.
- **Reimbursement** — the settlement sentence flips to *"The plan pays you back
  1,260"* and the card shows *Paid by you · Paid back to you · Your cost*, so the
  member can check it against their receipt. The arithmetic is identical; only
  the direction of the sentence changes (spec §1).

The calculation trace is a native `<details>` element — no new dependency (the
component library has no accordion), keyboard-accessible, and closed by default
because the trace is for the member who wants to check, not the one who wants
the answer. Amounts use `money()` and `tabular-nums`, AED stated once.

#### 13.2.6 The appeal, as the member meets it

The loop in §5.4 is invisible to the member except in three places, and each one
is designed to make the loop fair rather than merely functional.

**Start — tell them what the decision turned on, and what could change it.**
This is the admissibility table (§5.4.2) shown in the member's words, *before*
they write anything. It is the most valuable screen in the flow: it stops them
sending a document that cannot help and tells them which one can.

```
  You're appealing: Endocrinology consultation · month 4 · Not covered

  This decision turned on:  the waiting period for existing conditions.

  What could change it
   • A record showing the condition was first diagnosed after 1 January 2026
   • Proof that you had cover before this policy

  What can't change it on its own
   • Your description of when it started — your application already records it,
     so we'd need a document to look again.

  Tell me why you'd like this looked at again.
```

**During — the evidence request, and an honest way out of it.**

```
  Do you have a record that shows when your diabetes was first diagnosed?

  [ Paste or describe what it says ______________________________ ]  [ Send ]
  [ I don't have this ]                        [ Talk to an advisor ]
  ○ Asked   ○ Received   ○ Checked
```

The document arrives as text: the brief puts document/OCR processing out of
scope, and the supplied evidence (APP-2's registration) is a sentence. The
three-step track is `requested → provided → validated` of §5.2, shown so the
member knows where their evidence is. **"I don't have this" is a real action** —
without it the only way to say no is silence, and the set-difference in §5.4.3
would have to wait out a timeout instead of resolving.

**End — three outcomes, none of them a form letter.**

| Outcome | What the member reads |
|---|---|
| **Upheld** | *"We looked again with what you sent. The decision stands, because …"* — then what would have changed it, and what happens next in their own timeline (*"The waiting period ends at month 6, so your month-7 follow-up is covered."*) |
| **Reversed** | *"You were right — …"* with the new numbers and what they mean for the year. |
| **Reversed, awaiting confirmation** | *"Your evidence changes the decision. We're finalising the numbers — you'll see them here."* A real interim state with no workflow words in it. |

An upheld appeal is the outcome most systems write worst: the member did the
work and lost. It gets the same care as a win — the reason, the arithmetic,
the way forward.

#### 13.2.7 Escalation, call and callback

Shown when the conversation is `escalated`, when the member presses **Talk to an
advisor**, or when a loop limit is reached. It is deliberately calm: nothing has
gone wrong from the member's side.

```
  We couldn't settle this one automatically.

  Your claim and everything you've told us is with an advisor — you
  won't need to repeat any of it.

  Reference   CLM-9

  [ Call an advisor ]        [ Request a callback ]

  ▸ What your advisor will have
     Your claim · what you told us · the receipts you described ·
     what we could and couldn't work out from your plan
```

- **The number is not in the component.** `ADVISOR_PHONE` is read server-side
  from configuration and passed down as a prop; the model never sees it and
  never writes it. On a phone it is a `tel:` link; on desktop it shows the
  number with a copy button, because a `tel:` link on a laptop does nothing.
- **Callback re-collects nothing.** The phone number is pre-filled from the
  member's profile and editable; the only question is a window
  (*Morning / Afternoon / Evening*). Confirmation states what happened —
  *"Request received. An advisor will call you."* — and **promises no time**:
  the system has no SLA and the UI must not invent one.
- **"What your advisor will have"** expands to the actual packet summary. It is
  the member's own information, so showing it costs nothing and it is what makes
  "you won't need to repeat any of it" believable.
- When an advisor replies, it arrives as a message in the **same thread** with
  the launcher dot lit and a toast — the thread is the one place the member ever
  has to look.

### 13.3 The broker surface

The brief says the broker view is where most interface effort belongs, and that
a broker "does not browse records one at a time — they work through a queue
under time pressure". Everything here serves one question: **where should my
next minute go?**

#### 13.3.1 The queue

Servicing joins the existing queue; it does not get a page of its own. The
existing groups are defined by *kind of attention*, and servicing tasks map onto
them honestly rather than into a parallel taxonomy:

| Group (top to bottom) | Existing meaning | Servicing tasks that land here |
|---|---|---|
| **Undecidable from the plan** *(new, first)* | — | `insufficient_data`. The system refused to answer, so nothing else can resolve it. CLM-9 |
| **Blocked** | Cannot move until you act | An escalation: a loop limit, an unresolved conflict, a member-requested handoff. The member is waiting |
| **Genuinely uncertain** | Close calls | A quality check on something the system *did* resolve but that turned on judgment. **APP-1** is the case: upheld automatically, no evidence attached, but the call rested on reading a declared condition — the brief's "judgment call about evidence". It blocks nothing; it is there so it is not invisible |
| **Needs a decision** | The system has an answer and won't act alone | An overturn awaiting signature (APP-2); a reassessment recommending a change |

**Why this order** (the brief says it will read this closely). Urgency and need
for judgment are different questions with different answers. *Undecidable* is
first because it is the only category where the system has told you it has no
answer, so the alternative to your attention is a member with no outcome.
*Blocked* is next because a member is stalled. *Needs a decision* is last among
the urgent ones because the work is already done — the arithmetic is computed
and shown, and it is one informed click. *Genuinely uncertain* sits between:
nothing is stalled, but it is the work a rubber-stamp would ruin. Within a
group: priority band (§12.2), then oldest first, so nothing starves. A clean
claim never appears at all — its absence from the queue **is** its confidence
signal.

**The row** is the existing `QueueRow` with a servicing subject:

```
  [ Undecidable ]  [ low confidence ]
  Overseas cardiac follow-up can't be decided from the plan terms
  The plan defines no cover for treatment outside the UAE, and the provider
  couldn't be placed in a network tier.
  Khalid Farouk · POL-P5 · CLM-9 · reimbursement, AED 4,500 · abroad
                                                            [ Open the case → ]
```

Two rules carried over from the existing row: the second line appears only when
it says something the first did not (`sameNote`), and a decline is never a
single click from a list. One extension: an overturn moves money, so its row
expands **inline** to show `denied 0/6,000 → covered 4,400/1,600` with a
*Confirm reversal* button — one click, but only after seeing the arithmetic —
rather than opening the record.

#### 13.3.2 The case page — where a decision gets made

`/policies/[id]/events/[eventId]`, **broker-only** (a member gets a 404; the
member surface stays one screen). It mirrors the application record's tab
pattern so a broker already knows how to read it.

```
┌ CLM-9 · Reimbursement · AED 4,500 · Khalid Farouk · POL-P5 ────────────────────────┐
│ ⚠ Why this needs you                                              [Undecidable]    │
│   The plan defines no geographic scope, and this was treated abroad.  Confidence: —│
│                                                                                    │
│ [ Decision ] [ Packet ] [ Working ] [ History ]                                    │
│ ─────────────────────────────────────────────────────────────────────────────────  │
│ What the system did          │ What the member was told                           │
│  insufficient_data           │ "We can't work this out from your plan terms       │
│  no amount computed          │  alone — a person needs to look. Nothing you've    │
│  ▸ trace (3 lines)           │  sent has been lost."                              │
│                              │                                                    │
│ Your decision                                                                      │
│  ( Cover it ) ( Don't cover it ) ( Ask the member ) ( Hand to a colleague )        │
│  Note for the file (broker)     [                                        ]         │
│  Message to the member          [ pre-drafted, editable                  ]         │
│                                                          [ Record decision ]      │
└────────────────────────────────────────────────────────────────────────────────────┘
```

- **What the member was told is shown to the broker, verbatim.** It is the direct
  answer to the brief's "a system that generates one explanation and reformats
  it will read wrong in one of the two views": the broker can read the two side by
  side and see they are two documents. It also lets a broker catch a member
  message that reads badly *before* deciding, not after.
- **Every verb that speaks to the member takes two texts** — a broker note and a
  member message — exactly as `app/applications/[id]/actions.ts` already
  requires. The member message is pre-drafted by the agent and editable.
- **Verbs by task type:**

| Task | Verbs | Notes |
|---|---|---|
| `insufficient_data` | Cover it · Don't cover it · Ask the member · Hand off | "Cover it" has the advisor supply the *missing input* (which tier to treat it as) and the engine computes the money — an advisor never types an amount. Data-model consequence: §3.2's open item, decided in phase 6 |
| Appeal overturn | **Confirm reversal** · Uphold instead · Ask for more evidence | Arithmetic diff and ledger effect shown first |
| Reassessment `recommend_change` | Approve · Edit reasoning · Dismiss | §13.3.4 |
| Escalation (limit, conflict, member-requested) | Reply in thread · Resolve · Hand off | The advisor replies *in the member's thread* |
| Callback requested | Mark called · Reply in thread | Shows the phone number and window |

- **Packet** — the conversation, facts collected (each with the sentence it came
  from), evidence with its state, unresolved questions, prior decisions and
  reason codes, appeal attempts. Read-only, assembled by query (§8), so it
  cannot disagree with the record.
- **Working** — calculation, ledger before/after as a two-column diff, and the
  agent's **step trace** (reusing the recommendation trace renderer): thought,
  tool, validation, observation. For an appeal this is the whole §5.4 path —
  contested code, admissibility verdict, remaining evidence kinds, correction
  patch, re-adjudication, never-worse comparison.
- **History** — this event's supersession chain (*CLM-4 denied → APP-2
  overturned, supersedes CLM-4*), never collapsed: the denial happened and both
  stay visible.

#### 13.3.3 The policy record, broker branch

The same `/policies/[id]` route, rendered by **separate broker components**
(§13.4), gains what the brief lists under "the full record" and "utilization and
history … not just the current balance":

- **Running ledger** — a table, one row per event in effect order: month, kind,
  outcome, billed, plan, member, and *deductible met / annual / sublimit after*.
  Utilization *over time*, so a broker can see the month a cap was hit.
- **Replay chip** — `Ledger rebuilt from history ✓ 21 Sep, 09:14` with a
  **Rebuild** action that runs `assertReplayable` and shows a field-level diff if
  it has drifted. The brief's "delete it, replay the events, get the same numbers
  back" becomes something a reviewer can press.
- **Restated markers** — an event that sits after a mid-history overturn is
  labelled *restated after the reversal of CLM-4*, so a legitimate difference
  between a stored row and its replay (§3.2) reads as an explanation, not a bug.
- **Decided-by on every row** — *system* or the advisor's name, broker-only.

#### 13.3.4 Reassessment, and the hindsight table

Reassessment reasoning must cite events (§5.5), and the UI makes the citations
usable: each event reference is an inline chip that scrolls to that row in the
history. A member reads chips as the event's plain description (*"your month-4
endocrinology visit"*); a broker reads them as `CLM-3`.

For a `recommend_change` the broker also gets a **hindsight table**, produced by
running the same history through the pure engine on each plan (`replay(plan,
events)` — possible only because phase 1 made replay pure):

P3's history (CLM-3, CLM-8), replayed on each plan — these are the real figures:

```
                          Essential     Balanced (current)   Comprehensive
  Premium                    4,200            8,900              16,500
  You paid on claims         5,400            3,720                 540
  Total                      9,600           12,620              17,040
  Claims the plan refused   2 of 2            1 of 2              0 of 2
  Covers what you declared     ✗                ✓                   ✓
```

The last two rows are not decoration. **Essential is the cheapest column only
because it excludes her diabetes entirely** — both claims come back
`benefit_excluded`, so its 9,600 is a price for cover she does not have. A table
that led with the total would nudge toward exactly the plan the applicant cannot
use, which is the false economy the brief tells us to read past. And
Comprehensive costs 4,420 more than Balanced for a benefit whose wait she has
already served, which is P3's reassessment in one line: *don't switch*.

It is labelled as what it is — *"had you been on this plan from the start"* —
because a real switch restarts waiting periods, and presenting it as a forecast
would be the confident-wrong-number the brief warns about. **Stretch for
phase 7**, and cheap for that reason.

#### 13.3.5 The dashboard, and the number that measures the goal

The goal of this feature is *fewer humans in the loop*, so the dashboard should
say whether it is working. One new band on `/`:

```
  Straight-through this week        Waiting on you now
    11 of 13   85%                    Undecidable 1 · Signatures 1 · Quality checks 1 · Callbacks 0

  Why the other 2 needed a person
    insufficient_data ▓  appeal_overturn ▓
```

Straight-through = servicing events with `decided_by: 'system'` over all
servicing events. The breakdown uses the closed escalation-cause set from §7, so
each cause is countable and the two numbers together answer the question that
matters: *is the agent earning its keep, and where is it still failing?*

### 13.4 Two registers, enforced three ways

The brief: the two views must not be "the same object with different styling".
Prose discipline alone is the fence that fails, so there are three independent
ones.

1. **Data.** A member's server component reads only `customer_event_view` and
   `customer_policy_view` (finding F1). It cannot load `confidence`,
   `uncertainty_reason`, `broker_explanation` or `decided_by` because the query
   cannot select them. Two query functions, `listMemberEvents` and
   `listBrokerEvents`, replace the single `listEvents`; the member one is typed
   to the view's columns. A leak then requires *editing a query and a type*, not
   forgetting a conditional.
2. **Components.** `MemberEventCard` and `BrokerEventRow` are separate components
   with a small shared set of *primitives* (`Money`, `CalculationTrace`,
   `OutcomeBadge`). **No shared component takes a `role` prop or contains
   `isAdvisor ?`** — that pattern is what the current policy page is, and it
   is what this rule bans.
3. **Copy.** `explain` produces both registers in one call, and verification
   requires that they differ in more than length. Concretely, checked in §18: a
   **banned-vocabulary scan** over every member-facing string the acceptance run
   produces (`cohort`, `risk`, `flag`, `review task`, `priority`, `confidence`,
   `override`, `reviewer`, `escalat…`, and raw reason-code strings), and a
   **register-difference check** that the broker text carries an entity the
   member text must not (a policy or event reference, a month, an implication)
   and vice versa.

The one shared string is the `reason_code`, deliberately (spec §4b): the member
label comes from `reasonCodeLabel`, the broker sees the code itself.

### 13.5 Copy rules

Write once, apply to every card.

- **Verdict first, in one sentence.** Then the number. Then why. Then what to do.
- **"You pay", not "member pays". "Not covered", not "denied".** (`outcomeLabel`
  already does this; extend it, don't route around it.)
- **A month is also a date.** *Month 6* becomes *month 6 (1 July 2026)*, via a
  `monthToDate(inception, month)` helper. Members do not think in policy months.
- **Every denial ends at something dated or something doable.** If it cannot,
  it ends at *Talk to an advisor* — never at a dead end.
- **No invented numbers or promises.** No SLAs, no "usually within a day". The
  system has none, so the UI cannot state one. Every figure traces to the
  calculation array.
- **Explain a term the first time it appears** — *deductible* gets its half-line
  (the existing `UtilizationBar` hints already do this).
- **The trace is member copy too.** It is shown to the member (spec §4b), so it is
  worded like everything else: no enum tokens, no `CLM-4`, no workflow words.
- **No blame.** *"Your application already records it"*, not *"you told us
  otherwise"*.

Same event, both registers — CLM-7 (the maternity limit is used up):

> **Member** — *This one isn't covered. Your maternity benefit pays up to 25,000 a
> year and you've used all of it on your delivery, so the plan can't pay for these
> follow-up visits. Any you've already booked will cost you the full price until
> the benefit resets on 1 January 2027. If you want to talk through options,
> an advisor can help.*
>
> **Broker** — *POL-P2 reached the 25,000 maternity cap at month 9 (CLM-2); CLM-7
> at month 11 is the first event past it. The cap, not the co-pay or the network,
> was the binding constraint — worth raising at renewal.*

### 13.6 States, mobile, accessibility

- **Loading** — a `loading.tsx` skeleton for each new route, as every existing
  page has. Inside the thread, only the model's own thinking shows a typing
  indicator.
- **Empty** — reuse `Empty`. *"Nothing claimed yet"* becomes an invitation to
  ask whether something is covered before claiming it.
- **Error** — the existing `app/error.tsx` boundary keeps the shell. A failed
  turn in the thread degrades to the form card (§13.2.4) rather than an error
  page, and a member is never shown an engine string.
- **Mobile** — claims are submitted from phones. The drawer is already
  full-width below `sm`; chips and buttons are at least 44px tall; cards stack;
  the broker case page is desktop-first but its tab strip scrolls (the pattern
  the earlier phase already applied).
- **Accessibility** — new assistant messages announce through an
  `aria-live="polite"` region; focus moves to the first control of a card when
  it appears and returns to the composer after send; an outcome is a text badge,
  never colour alone; the trace is a real `<details>`; the launcher's attention
  ping respects `prefers-reduced-motion`; money uses `tabular-nums`.

### 13.7 Routes and files

| Route | Audience | What |
|---|---|---|
| `/policies/[id]` | both, **separate components** | The one member screen + the broker record (§13.2.1, §13.3.3) |
| `/policies/[id]/service/[conversationId]` | member | The servicing conversation as a page |
| `@chat/(.)policies/[id]/service/[conversationId]` | member | The same thing, intercepted into the drawer |
| `/policies/[id]/events/[eventId]` | broker only | The case page (§13.3.2) |
| `/queue`, `/` | broker | Servicing rows, the new group, the straight-through band |

| New component | Phase |
|---|---|
| `MemberEventCard`, `BrokerEventRow`, `LedgerTable`, `ReplayChip` | 2 |
| `ConfirmCard`, `QuestionCard`, `FactsFormCard`, `OutcomeCard` (outcome + estimate), `EvidenceRequestCard`, `ConflictCard`, `EscalationCard`, `ServicingCardView`, the gallery — **built in phase 3** | 3 |
| `ServicingThread` | 4 |
| `AppealIntro`, `EvidenceTrack` | 5 |
| `CasePage` + verb forms, `CitationChip`, `StraightThroughBand` | 6–7 |

`ServicingThread` is **new, not another branch inside `ChatThread`**: that
component already carries a dense set of intake-specific derived states, and its
own header says two copies of that logic drift within a week. It shares the
message primitives, `ChatAutoscroll` and `ChatRefresh`; `ChatComposer` takes its
send action as a prop instead of importing `sendChatMessage`.

### 13.8 The demo path

The brief asks for a working demo or a three-minute walkthrough. The UI should
tell the five stories the supplied data was built around, in this order, and the
phases in §17 are ordered so each one is demonstrable as soon as it lands:

| Story | What it shows | Surface |
|---|---|---|
| **P1 · CLM-6** | The ledger is wired in: *"you pay 540 — your deductible was already met"* | Member outcome card |
| **P2 · PRE-1 → CLM-2 → CLM-7** | Forecast vs decision; a sublimit running out, with a dated next step | Estimate card → outcome → member vs broker copy side by side |
| **P3 · CLM-3 → APP-1 → CLM-8** | An appeal that is *upheld*, honestly, with what would change it; then the wait clears and it pays | Appeal intro → upheld card → reassessment citing all three events |
| **P4 · CLM-4 → APP-2 → PRE-2** | An appeal that is *overturned*; the broker signs after seeing the arithmetic; the ledger changes at month 7 | Evidence card → queue row inline diff → case page → PRE-2 on a met deductible |
| **P5 · CLM-9** | The system knowing the edge of its own data | Escalation card → queue's *Undecidable* group → case page |

The queue is then the closing shot: five different confidence postures on one
screen, ordered by the reasoning in §13.3.1.

---

## 14. Expected outputs — the acceptance table

These are what the engine must produce for the thirteen supplied events, in
order, per policy. This is the table the build is verified against (the four
compared fields, plus the ledger after).

**P1 · Essential (plan_a) · deductible 1,500 · co-pay 30%**

| Event | Outcome | plan_pays | member_pays | reason_code | ledger after |
|---|---|---|---|---|---|
| CLM-1 m5 · 3,200 | covered | 1,190 | 2,010 | `covered` | ded 1,500 · annual 1,190 |
| CLM-6 m8 · 1,800 | covered | 1,260 | 540 | `covered` | ded 1,500 · annual 2,450 |

**P2 · Comprehensive (plan_c) · deductible 0 · co-pay 10% · maternity cap 25,000, 3-month wait**

| Event | Outcome | plan_pays | member_pays | reason_code | ledger after |
|---|---|---|---|---|---|
| PRE-1 m6 · est 40,000 | approved_with_limit | 25,000 | 15,000 | `covered` | **unchanged** (dry run) |
| CLM-2 m9 · 40,000 | covered | 25,000 | 15,000 | `covered` | annual 25,000 · maternity 25,000 |
| CLM-7 m11 · 3,000 | denied | 0 | 3,000 | `sublimit_exhausted` | unchanged |

**P3 · Balanced (plan_b) · deductible 500 · co-pay 20% · chronic 6-month wait**

| Event | Outcome | plan_pays | member_pays | reason_code | ledger after |
|---|---|---|---|---|---|
| CLM-3 m4 · 2,800 | denied | 0 | 2,800 | `waiting_period_not_elapsed` | unchanged |
| APP-1 m4 | upheld | 0 | 2,800 | `waiting_period_not_elapsed` | unchanged |
| CLM-8 m7 · 2,600 | covered | 1,680 | 920 | `covered` | ded 500 · annual 1,680 |

**P4 · Balanced (plan_b)**

| Event | Outcome | plan_pays | member_pays | reason_code | ledger after |
|---|---|---|---|---|---|
| CLM-4 m7 · 6,000 | denied | 0 | 6,000 | `provider_out_of_network` | unchanged |
| APP-2 m7 | overturned | 4,400 | 1,600 | `covered` | ded 500 · annual 4,400 **at month 7** |
| PRE-2 m9 · est 28,000 | covered | 22,400 | 5,600 | `covered` | unchanged (dry run) — nothing clipped, so not `approved_with_limit` |

**P5 · Comprehensive (plan_c)**

| Event | Outcome | plan_pays | member_pays | reason_code | ledger after |
|---|---|---|---|---|---|
| CLM-5 m3 · 180,000 | covered | 162,000 | 18,000 | `covered` | annual 162,000 |
| CLM-9 m6 · 4,500 | insufficient_data | null | null | `insufficient_data` | unchanged — routed to advisor |

Two of these are load-bearing tests of the design rather than of the
arithmetic:

- **APP-2's ledger writes at month 7**, which is why PRE-2 at month 9 forecasts
  against a met deductible. Get `effectOrder` wrong and PRE-2 quietly reports
  the wrong member cost.
- **CLM-9 returns nulls, not zeros.** A zero is an answer. This is the absence
  of one.

---

## 15. Deterministic vs agentic — the one-line answer

Everything that can be got wrong *quietly* is deterministic: amounts, ledger
movement, gate ordering, reason codes, admissibility, loop limits, field
visibility. Everything that requires reading a human being is the model:
understanding what happened, choosing the next question, judging whether a
document bears on a finding, and writing the two explanations. The seam is that
the agent can only ever hand the deterministic layer values from a closed
vocabulary, and the deterministic layer hands back results the agent may quote
but not alter.

---

## 16. Required services

- **Model**: the existing OpenRouter client
  ([`lib/ai/openrouter.ts`](lib/ai/openrouter.ts)), `structuredCall`, and
  `isAgentEnabled()` so the whole flow degrades to the deterministic path with
  no key present. The adjudication numbers are identical either way — only the
  prose and the question selection are lost.
- **Database**: existing SQLite + Drizzle. No new tables.
- **Config**: `SERVICING_MAX_*` limits, `ADVISOR_PHONE`. Added to
  [`.env.example`](.env.example).
- **No new dependency.** LangGraph, Zod and Drizzle are already here.

---

## 17. Milestones

Ordered so that every phase ends with something a person can use, and so the
ledger exists before anything depends on it (the brief's instruction). **Every
phase carries a UI/UX deliverable** — §13 is built incrementally alongside the
engine, not appended after it. A phase is done when its "done when" holds *and*
its UI has been driven in a browser, at desktop and 375px, and screenshotted.

### Phase 1 — The engine · **done**

- **Build.** `lib/servicing/` — types, network table, `adjudicate`, `replay` /
  `project` / `effectOrder`, limits.
- **UI/UX.** None. The acceptance table the script prints is the first captured
  output.
- **Done when.** `bun run db/seed/check-servicing.ts` replays all 13 events and
  matches §14 exactly, plus the ledger-wiring, replay-position and invariant
  checks. ✔

### Phase 2 — The database, and the foundation of the member and broker screens · **done**

- **Built.**
  - `lib/servicing/store.ts`: `replayPolicy` (read), `rebuildLedger` (the **only**
    writer of `benefit_ledger`), `checkReplay` (returns a report: ledger diffs,
    *drifted* events, *restated* events) and `assertReplayable` (throws on drift).
  - **All 13 events seeded through the engine** (`db/seed/servicing.ts`): outcome,
    amounts, trace, ledger snapshots and both explanations are computed, and the
    ledgers are rebuilt by `rebuildLedger`, not inserted. The seed then checks its
    own work — the ledger it wrote must equal a replay of the history it wrote —
    and exits non-zero if not. CLM-9's task is left open, and APP-2's signature is
    recorded as resolved by an advisor.
  - `next-steps.ts` (dated facts), `explain-template.ts` (deterministic prose in
    both registers), `labels.ts`, `dates.ts`.
- **UI/UX built.**
  - **F1 fixed.** `listMemberEvents` reads `customer_event_view`;
    `listBrokerEvents` reads the table. Same for reassessments. The policy page is
    a thin switch; `MemberPolicyView` and `BrokerPolicyView` are separate trees
    over shared primitives that take no role.
  - Member: dated next steps on every row, the **Estimate** treatment for
    pre-authorizations, reimbursement wording, a closed `<details>` trace, months
    shown as dates.
  - Broker: `ReplayChip` with a working **Rebuild**, `LedgerTable` (running
    balance in effect order), decided-by, confidence with a "why this is worth a
    look" note, the member's text shown beside the broker's, supersession chain
    (*Supersedes CLM-4* / *Superseded by APP-2*), restated markers.
  - `app/policies/[id]/loading.tsx`.
- **Verified.** `bun run check:servicing` — three scripts, 113 checks: the pure
  engine and prose (`check-servicing.ts`), the database (`check-ledger.ts`: seeds a
  throwaway DB, deletes every ledger and replays it, detects a nudged ledger and a
  drifted event, distinguishes *restated* from *drifted*, proves the log is
  append-only and a reseed is byte-identical), and the register fence
  (`check-registers.ts`). Then driven in a browser as a member and as a broker,
  at desktop and 375px.
- **Found while building** (each changed the design, and is recorded above or in §3.2):
  - F4 — the calculation trace is member-facing and leaked enum tokens (§13.1).
  - **Order comes from `created_at`, then rowid.** `servicing_event` has no
    sequence column and the log is append-only, so write order *is* submission
    order. rowid is only a tiebreaker inside one second; a `VACUUM` may renumber it
    but cannot reorder rows with different timestamps.
  - **A deductible that fills is good news.** `UtilizationBar` painted a met
    deductible solid red, on the line that says "Met for the year". It now takes
    `fullIsGood`.
  - The floating chat launcher covers the last card on a phone; the member view
    now reserves clearance for it.
  - Seeded events are dated by policy month, and months 9–11 fall after the
    fictional "today" — the supplied scenario runs a full year, so the timeline
    shows some events in the future. Cosmetic; noted so it is not mistaken for a bug.
- **Done when — all met.** `assertReplayable` passes for all 5 policies; CLM-1 and
  CLM-6 regenerate identically (ids, trace, ledger snapshots, amounts, dates); a
  member's page cannot select a broker-only column (a type error, and a scan);
  the vocabulary scan passes over every seeded member string **including traces**;
  both views render all five policies.

### Phase 3 — The tool registry, and the card contract · **done**

- **Built.**
  - `lib/ai/tools/servicing.ts` — the registry (§4.1, as built). Not `server-only`,
    so a script can drive it.
  - `lib/servicing/cards.ts` — eight **strict** zod schemas, one per card kind, with
    the type guards *derived* from them so the two cannot drift, and deterministic
    builders so a tool cannot hand the UI a shape it invented. Strict means a card
    carrying a key it does not declare — `confidence`, an escalation `cause`,
    a reviewer note — is **rejected**, which is the §13.4 fence applied to the payload.
  - `lib/servicing/facts.ts` (the closed set of things a claim conversation can know,
    what each request needs, and how a draft becomes an adjudication input),
    `copy-rules.ts` (the member-copy rules as executable checks, now shared with the
    tool that enforces them at runtime), `escalation.ts`, and `monthOfDate`: the
    model gives a *date* and the code derives the policy month, because an off-by-one
    there silently moves a claim across a waiting-period boundary.
  - **The fake-conversation harness** (`db/seed/scenarios.ts`): scripted members and
    a scripted agent issuing *real* tool calls, so every validation, refusal and card
    comes from production code. Seven conversations, each one of the supplied events.
    It reproduces the acceptance table through the tools (CLM-6 → 1,260 / 540, PRE-1 →
    approved with a limit, CLM-3 → denied with a dated next step, CLM-9 → an
    escalation), and the final `propose_outcome` is fed the engine's *template*
    explanation — proving the deterministic fallback passes every check a model's
    prose must.
- **UI/UX built.** Eight card components under `components/servicing/cards/` and one
  renderer that switches on `kind` (an unrecognised payload renders nothing, refused
  by the guard before any component sees it). Handlers are plain callbacks, so phase 4
  wires each to a server action without touching a component. The **dev gallery** is at
  `/dev/servicing-cards` (a 404 in production): 19 cards, every one **what a tool
  actually returned**, a phone/wide toggle, the raw payload beside each card, and a live
  log of what each card *reports* — which is only ever *which chip*, never a meaning.
- **Verified.** Five check scripts, **291 checks** (`bun run check:servicing`):
  `check-servicing-tools.ts` (142: the scenarios, then every rule in the registry
  broken on purpose), `check-cards.tsx` (36: every card server-rendered and read the way
  a member reads it), plus the three from phase 2. Then driven in a browser: light and
  dark, phone and wide, and every interaction.
- **Found while building** (each changed the code, and each was caught by a check or
  by looking):
  - **A tool description that told the model about a field the tool then rejects**
    (`paid_by_member` on a pre-authorization). Descriptions are now built from the
    fields *this kind of request* has.
  - **A rule I wrote collided with a deliberate exception.** The copy rule bans
    internal references like `CLM-9` in member text, but the escalation card shows the
    member "Reference CLM-9" to quote on a call. The rule is about references leaking
    into *prose*; the `reference` field is the one deliberate member-visible handle, and
    the check says so explicitly instead of weakening the rule.
  - **Three cards said the same thing twice** — the same stutter the CRM plan called out
    on the queue. The outcome and estimate cards each restated a sentence the
    explanation already contained. The footers (`settlement`, `caveat`) are now nullable
    and dedupe against the prose, and a check fails on any repeated sentence. A denial
    had a subtler version: the "what you can do" list restated the date the prose
    already gave, in different words, so a sentence-level check could not see it. Steps
    are now keyed on the figure that makes them specific and dropped when the prose
    already has it.
  - **A denial said "the plan settles its share with the provider".** A denial has
    nothing to settle. Not a redundancy: wrong. It now has no settlement footer.
  - **Layout bugs no static check can see**, found by measuring at 375px rather than by
    eye: the confirm card overflowed by 4px (a non-wrapping badge forced its grid row
    wider than the card), and on the estimate card a six-figure amount does not fit a third
    of a phone. Both, and the same latent problem in the phase-2 history card, now size
    to the *card* with container queries, so one card works in a phone screen, the chat
    drawer and a wide page.
  - **My test suite let three mutations through.** Breaking the components on purpose
    showed three assertions were checking a string typed into the test rather than the
    component's own, or a control that never rendered in any gallery card. Fixed, and the
    same mutations now fail.
- **Done when — all met.** Every tool rejects an out-of-vocabulary argument with a
  correctable message (and none throws on garbage: 15 tools × 10 hostile inputs); every
  card renders from its real tool output in light and dark at 375px and desktop with no
  overflow and no tap target under 44px; each guard rejects a malformed payload, a
  missing field, and an undeclared key.

### Phase 4 — The graph, and the member conversation · **done**

- **Built.**
  - **The graph** (`lib/ai/graph/nodes/servicing.ts`, `lib/ai/servicing-graph.ts`):
    `processResponse → agent → (wait | gate | escalate) → commit`. The graph holds *one
    turn*; the durable state is rows (§7), so a reload, a second tab and a server restart
    all resume from the database. The model is **injected** (`ServicingDecider`), never
    imported, for two reasons: `server-only` throws under Bun (where the suites run whole
    conversations), and nothing about a model call is ever serialised into a checkpoint.
    `lib/ai/servicing-model.ts` (server-only) is the one file where a real model meets it,
    wrapping `structuredCall` at temperature 0.2. The agent is a bounded tool loop with a
    *deterministic driver beneath it*: no key, a dead model, a step budget exhausted, or
    the same rejection three times all land on the driver, which asks for what is missing
    with a form, confirms, adjudicates, and either proposes the outcome or escalates.
  - **The session** (`lib/ai/servicing-session.ts`): `openServicing`,
    `handleServicingInput`, `requestCallback`, `readServicingThread`,
    `listOpenServicing`, `findWaitingServicing`. One write order per turn: extraction rows
    → `model_run` → **the commit** (serialised; event insert with a reference re-issued on
    collision; `rebuildLedger`; a `review_task` for an escalation) → assistant messages →
    state snapshot → conversation status. Stale acts (a double-tapped chip, a confirm with
    nothing to confirm) are ignored, and an exception in the graph becomes an apology
    with the member's message kept, never an error page.
  - **Server actions** (`app/policies/[id]/service/actions.ts`): every input is
    zod-validated (what a card reports is a claim about which button was pressed, never
    data), every action authorises the caller as the conversation's owner.
- **UI/UX built.**
  - Member policy screen: the **action bar** (*Is this covered?* / *Claim, or get money
    back*) and the **In progress** strip.
  - `ServicingThread` (a new component, not a branch of `ChatThread`): a card message *is*
    the card; a card is closed by the member's next message, which it then shows ("You
    said: Looks right"); a submitted form is replaced by the summary of what was given.
    A new message scrolls to its **start**, so a tall form shows its first field.
  - Routes: the full page and the intercepted drawer
    (`@chat/(.)policies/[id]/service/[conversationId]`), one server component behind both.
  - The composer is generalised (`onSend`) rather than copied; with no model it is not
    rendered at all (a box that cannot be read is worse than none).
  - Launcher: `href` prop; the layout lights the dot on a servicing `awaiting_user` and
    points the launcher at it; hidden on the servicing pages.
  - **Model failure and no key are the same experience**: the form, with one sentence
    saying why when the member had typed something.
- **Verified.**
  - **395 checks** (`bun run check:servicing`, six scripts): the new
    `check-servicing-session.ts` (102) drives whole conversations against a scratch DB —
    every no-model flow, a scripted model, a dead model, a cheating/spinning/early-proposing
    model, escalation, ownership, two conversations racing for one reference, and a final
    replay of every policy. Each new suite was mutation-tested.
  - **In a browser, against a live model key**: a claim typed in prose → the model
    extracted the facts, asked *one* chip question (provider type) → confirm → **covered,
    plan 1,260 / member 540**, exactly the engine's number and §13.8's story. With an
    **invalid** key (a real failure): a typed pre-authorization degraded to the form, and
    the form → denied (a private hospital is outside P1's restricted network). With **no
    key**: a claim by form → 960 / 240 on P4; a future date refused in plain language and
    only that field re-asked; *Talk to an advisor* → escalation card → callback (phone
    pre-filled) → the row lands in the advisor's queue as *High*. Also confirmed: reload
    resumes, back closes the drawer, deep link works, another member's policy is a 404
    inside the shell, the dot lights on `awaiting_user` and clears on completion, no
    horizontal overflow at 375px, focus lands on the first field.
  - Not exercised: a real model *finishing* a pre-authorization or an escalation
    end-to-end (the live run was a claim; the other model paths were exercised by the
    scripted decider), and a true keyboard-only Tab traversal (the harness cannot press
    Tab; tab order was checked structurally — native controls in DOM order, no positive
    `tabindex`).
- **Found while building** (each changed the code):
  - **`created_at` is the wrong order for the log.** The supplied year runs to month 11,
    so seeded events carry future dates and a claim submitted *today* sorted before them and
    replayed against the wrong ledger. Order is **write order** (SQLite `rowid`); two
    Phase-2 tests were restated around it.
  - **`ctx.draft` and `state.draft` were one object**, so `changedFacts(before, after)`
    compared a thing with itself and wrote no `extraction` rows. `structuredClone`.
  - **A dead end in the hand-off.** An escalation note over the 300-character limit
    (the driver passed the 330-character broker template) made the escalate tool refuse,
    and so did the last-resort `handOff`. The driver now passes a short note, the hand-off
    truncates, and if even that fails the member gets the confirm card back.
  - **"Change something" was silently dropped** when the model then failed: the fallback
    put the *old* confirm card back. `changing` is now persisted state; a fallback while
    it is set opens the **pre-filled** form. And an *invalid* edit now re-shows the field
    with its problem instead of putting the old value back as if nothing had been said.
  - **A `redirect()` from a server action skips the drawer interception** (it is applied as
    a fresh render of the target). `startServicing` returns the href and the client
    `router.push`es — a soft navigation, so the conversation opens in the drawer like every
    other link to it.
  - **The form's lead sentence ("let me get these a different way") was invisible**,
    because a card renders alone. It is now shown above the form unless it is only the
    card's own intro.
  - **The callback card said "received" before the server had answered.** It now waits for
    the result, and reads the recorded request so a reload does not offer it again.
  - Smaller: `providerUnsure`, `conditionName()` for a null condition code, the review
    subject `conversation` (a member who asks for a person before anything is adjudicated
    has no event to hang a task on), `classify_benefit` now records who chose the class.
- **Known rough edges, deliberately left.** The escalation card's title ("We couldn't
  settle this one automatically") is the plan's copy but reads oddly when the *member* asked
  for the advisor. The queue shows a hand-off as a bare row (subject `conversation` →
  `/policies`) until phase 6 builds the case packet. An answered question card keeps its
  full chip list on screen (locked, the chosen one marked) — history is taller than it needs
  to be. `ADVISOR_PHONE` is optional and documented in `.env.example`; unset, only the
  callback is offered — a number is never invented.
- **Done when — all met**, with the two "not exercised" items above stated rather than
  claimed.

### Phase 5 — The appeal loop, on both surfaces · **done**

- **Built.**
  - **The deterministic half** (`lib/servicing/appeal.ts`, `appeal-commit.ts`, `appeal-store.ts`): the admissibility table
    (§5.4.2) as data — each appealable reason code, the ONE input it turns on, the kinds of evidence that can bear on it in
    the order to ask, and what does *not* count; `identifyContested` with the §5.4.1 exits; `remainingKinds`, the
    set difference of §5.4.3; `validateCorrection` (right field, valid value, differs, verbatim quote); `reAdjudicate` at
    the **original ledger position** by effect order; `compareOutcome` and the never-worse rule; and the builders that turn a
    finished appeal into the row that would be written — from the engine's numbers, never typed.
  - **The appeal tool set** (`lib/ai/tools/appeal.ts`): `read_appeal`, `assess_evidence`, `request_evidence`,
    `propose_correction`, `conclude_appeal`, `escalate`. While a conversation is an appeal these are the registry — the
    agent is not handed the claim tools. Every argument is validated against the table before anything runs, and a refusal
    names what was sent and what would have worked. The agent judges *relevance* and proposes *one field*; the engine
    decides the outcome. Uphold is never chosen: it is what results from an empty set or a re-adjudication that does not help.
  - **The graph** (`lib/ai/graph/nodes/appeal.ts`): same topology as a claim, a second brain. A member's decline is fully
    handled with no model (a decline is arithmetic); evidence arriving as prose needs a reader, so with no model, or a failed
    one, it goes to an advisor with what they sent attached.
  - **Persistence.** An **upheld** appeal is written at once (`decided_by: system`). An **overturn is never written by the
    system**: the agent stops at a *proposal* — the finished row plus its whole trace — held as a pending
    `conversation_action`, with an open `review_task` in front of it. `lib/ai/servicing-signoff.ts` is what happens when a
    person answers: **confirm reversal** (appends the row at the denial's position, refolds the ledger, replay must still pass,
    tells the member), **uphold instead**, **ask for more evidence**. All in one transaction; the proposal is *parsed* out of
    its row (a corrupted one fails closed) and **re-adjudicated against the log as it stands** before it is signed.
  - **Seed:** `SEED_APPEALS=pending bun run db:seed` seeds the supplied history *without* its two appeals, so CLM-3 and CLM-4
    are still denied and appealable. That is the database the loop is demonstrated on; the default is the acceptance table.
- **UI/UX built.**
  - **Member:** *Appeal this decision* — on an outcome card and on the policy screen — appears only where the **log** says the
    decision can be appealed right now (a flag on a card was true when it was written, and is not necessarily true today).
    `AppealIntro` (the ninth card, rendered from the admissibility table in the member's words, before any request);
    `EvidenceRequestCard` with the **Asked → Received → Checked** track and **I don't have this**; the composer's words follow
    the conversation; the outcome card for an upheld appeal (*Decision stands*, the dated way forward) and a reversal
    (*Decision reversed*, the numbers); and the honest interim — *"Your evidence changes the decision. We're finalising the
    numbers — you'll see them here."* — with no number in it, because an unsigned reversal is not a promise.
  - **Broker:** the overturn's queue row shows its arithmetic **inline** (`Not covered 0 / 6,000 → Covered 4,400 / 1,600`, what
    was corrected, the deductible) with **Confirm reversal**, one click after seeing the sum; and the **case page**
    (`/policies/[id]/events/[eventId]`, 404 for a member) with **Decision** (what the system did beside what the member was
    told, verbatim; the proposal, the ledger diff, the three verbs, an editable member message), **Working** (the §5.4 path in
    six lines, then the agent's steps — a refusal is shown, with its reason) and **History** (the supersession chain, never
    collapsed). Servicing tasks are now hydrated in the queue with who/which policy/which event.
- **Verified.**
  - **566 checks** across eight scripts. Two new suites drive real appeals through the session and graph with a scripted
    model: `check-appeal.ts` (114) and `check-appeal-signoff.ts` (25); the card and register suites grew. Every rule was
    **mutation-tested** — equal money counted as a win, never-worse removed, any evidence kind admissible, the markers off, any
    field patchable, re-adjudicating on today's ledger, declines ignored, the signature skipping re-adjudication, the system
    signing its own reversal, ownership dropped — and each is caught.
  - **§18.4, all of it:** the evidence **swapped** between the two appeals swaps the outcomes (a certificate on the waiting
    period is refused by the table; an assertion on the network finding is refused by the marker floor); a **wrong-field patch**
    is rejected and pays nothing; **never-worse**; **exhausted admissibility upholds without asking again**; and **the overturn
    survives replay** — the ledger is *dropped and refolded* and P4's month-9 pre-authorization forecasts **22,400** against a
    met deductible where it forecast 22,000 before, and is *restated*, not drifted.
  - **In a browser**, on a scratch copy seeded with the appeals pending. *APP-2, live model:* Daniel appeals CLM-4 from his
    policy screen (the button is on CLM-4 and nowhere else); the drawer opens on the intro and the request; he pastes the
    certificate; the model assesses it, tries `value: "standard"`, is refused by the vocabulary, corrects, and proposes; the
    log does not move; the queue shows the reversal with its arithmetic; the case page shows the working; Karim signs; the row
    lands (`supersedes CLM-4`, decided by the advisor), the ledger is 500 / 4,400, replay passes, and Daniel's policy screen
    shows *Decision reversed*. *APP-1, no key:* Meera appeals CLM-3, declines both requests, and is told the decision stands and
    when the wait ends — no advisor involved. A member gets a 404 on the case page; nothing overflows at 375px.
  - Not exercised in a browser: *Uphold instead* and *Ask for more evidence* (covered by the suite against the real rows),
    and a real model on the *no-evidence-bears* path (the scripted model covers it).
- **Found while building** (each changed the code):
  - **An assertion can sound like a document.** The table bounds *which kind* a model may name, but "the clinic has its own
    licence" is a claim about a licence. A deterministic **floor** (`kindMarkerProblem`) now requires the text to look like the
    kind it is called: a licence must name a category or tier, a dated diagnosis must carry a date. It is deliberately crude —
    it cannot tell a real licence from a typed one; **that wall is the person who signs**, shown the quote.
  - **Two kinds of evidence are real but correct no input the engine holds** — continuity of cover, and a mis-recorded
    *earlier* claim (which rewrites another event). They go to a person under a new cause, `correction_needs_review`, not
    through a patch the engine cannot honestly apply.
  - **A failed patch is not an uphold.** The plan says a wrong-field correction "fails validation and upholds"; the build
    rejects it, pays nothing, and — if the model cannot produce a valid one — hands the case to a person. Upholding a denial
    because the model fumbled a patch would punish the member for a model failure.
  - **A request needs an order.** Kinds are asked least-asked first, then most-likely first, so a member who answers a request
    with an account is not asked the same thing again while another admissible kind remains.
  - **`redirect()`-style interception again:** the appeal opens with a client `router.push`, for the same reason as phase 4.
  - **Two draft bugs in my own check suite** (a "second tap" test that was really the second decline; a fixture with no next
    steps so an appeal-button mutation was equivalent) — found by mutating, fixed.
- **Known rough edges, deliberately left.**
  - The **prose of an appeal is the template's**, not a model's: `assess_evidence`'s reason and the trace are the model's words;
    the verdict the member reads comes from `explain`. Every figure in it is the engine's. A model-written verdict is a
    phase-7 question.
  - A reversal leaves the member's **pre-authorization estimate as recorded** (22,000); only the broker sees it *restated*.
    The estimate's own caveat says it moves with the ledger.
  - **Ask for more evidence** re-asks for a *better copy* of the kind that bore on the finding, so it can only be used while
    the per-kind and round limits allow; when nothing can be asked the button says so.
  - The queue groups are unchanged (Undecidable → Blocked → … is phase 6): a reversal sits in *Needs a decision*, which is
    where §13.3.1 puts it, but the escalation rows are still bare.
- **Done when — all met**, with the two browser gaps above stated rather than claimed.

### Phase 6 — Escalation, the queue, and the human handoff · **done**

- **Built.**
  - **The engine's open item, closed** (`lib/servicing/handoff.ts`, `replay.ts`): a claim the plan terms could not decide
    (CLM-9) is now decidable by a PERSON two ways. *Cover it* — the advisor supplies the one missing INPUT (which
    tier to treat the provider as); the ENGINE computes the money (`adjudicateAt`, extracted from the appeal loop's
    re-adjudication — one function, two callers) at the event's own position in the history, so replay reproduces
    it and no stored number is authoritative. *Don't cover it* — the one row whose stored result replay takes at
    its word (`handDenial`), and it can only ever be a zero: nothing paid, nothing consumed. Both supersede the
    undecidable row; both are `decided_by: advisor`; neither carries a confidence, because it is a person's
    decision, not a system's.
  - **The verbs** (`lib/ai/servicing-handoff.ts`): `coverIt`, `denyIt`, `replyInThread`, `resolveCase`, `handOff`,
    `markCalled`, `closeQualityCheck` — one transaction each, one `review_decision` each. Every message a person
    writes to a member goes through the SAME fence the agent's own prose does (`checkMemberMessage`): the member's
    register, and only figures that are actually on the case.
  - **The human thread.** With an advisor, a member's turn skips the graph entirely (`writeToAdvisor`) — no model,
    no cards, a person will read it — and asking for an advisor a second time is a no-op rather than a second task.
    `postAdvisor` writes the reply as its own message role; `findWaitingServicing` lights the dot for an unanswered
    question **or** an unanswered advisor reply, and `AdvisorReplyToast` fires once per reply (keyed on the message,
    de-duplicated in `localStorage`).
  - **The packet is a query** (`lib/servicing/packet.ts`), assembled from rows that already exist — the
    conversation verbatim, facts with their sentences, evidence and its state, what is still open, why it left the
    agent, the callback, every decision in order, the policy's whole history, appeals, plan-fit — so it cannot
    disagree with the record. A hand-off with no claim of its own (the member asked for a person before anything
    was adjudicated) gets its own case page (`/policies/[id]/conversations/[id]`) rather than being forced onto
    the event-shaped one.
  - **The queue** (`lib/servicing/queue.ts`, moved out of the `server-only` read layer so the checks can drive it):
    `servicingSubjects` hydrates who / which policy / which event, groups each row into the §13.3.1 band
    (`undecidable` / `blocked` / `uncertain` / `decide`), and carries the cause, the callback, and whether the
    MEMBER wrote last (so the row can say "waiting on you" honestly, not just "waiting"). `getStraightThrough` is
    the number for §13.3.5: each outcome counted once — a row a person replaced counts as the replacement, not
    twice — broken down by the closed cause set.
  - **The seed's Achilles' heel, fixed.** APP-1 (upheld, on a judgment call) used to have no task at all — the
    supplied acceptance data adjudicates it once and stops. It now raises the QUALITY CHECK the session already
    writes for the equivalent live case, at priority 40: it blocks nothing, and it is not invisible.
- **UI/UX built.**
  - **Member:** the escalation card's phone number gets a working **Copy** button (a `tel:` link does nothing on a
    laptop); a person's message renders as a distinct **"Your advisor"** bubble, never mistaken for the agent's;
    with an advisor, the composer is relabelled *("Write to your advisor…")* and posts straight to the human
    thread — no card handlers, no model.
  - **Broker:** the case page gains a **Packet** tab (`PacketTab`) and, for an undecidable claim or a hand-off, a
    **Decision** tab (`CaseDecision`) — radio-choose the tier with the engine's own money shown per choice, or
    decide the case is not covered, or reply / resolve / hand off / mark called, each behind a required note. The
    queue row for a hand-off shows who asked, whether the **member replied**, and the callback line; a resolved
    reversal's proposal cannot be signed twice. The dashboard's **`StraightThroughBand`** — the number that
    measures the goal, and the breakdown of why the rest needed a person.
- **Verified.**
  - **641 checks** across nine scripts (`bun run check:servicing`). The new `check-handoff.ts` (74) drives the
    queue order, asking for a person from three different points in a conversation (start, the confirm card, mid-
    appeal), the human thread, callback/mark-called/hand-off, both undecidable verbs against the real engine, a
    quality check, and the straight-through count — against the ACCEPTANCE TABLE exactly as supplied, not a bespoke
    fixture. Mutation-tested: replay ignoring a hand denial, the figure/register fences turned off, a second
    "talk to an advisor" not idempotent, the undecidable row landing in the wrong queue group, a member deciding
    their own case, a replaced row double-counted, quality tasks suppressed, `coverIt` computing abroad instead of
    in the UAE — each caught.
  - **In a browser**, on a scratch copy: the queue's order is exactly §13.3.1 (Undecidable → Genuinely uncertain,
    APP-1 present as a quality check → Needs a decision) and the dashboard's straight-through band, the escalation
    card's configured phone with a working Copy, and a real callback all render and post. A member wrote to their
    advisor from the human-thread composer, the advisor's reply landed as a distinct bubble, "Reply in thread" was
    refused for a promised time ("shortly") and went through once reworded, "Mark called" and "Hand off" both
    recorded, and "Resolve" closed the conversation with the advisor's own last word. **Cover it** on CLM-9, chosen
    with the engine's five-tier preview on screen, wrote a row the member's policy shows as *Covered* (4,050 back /
    450 cost) alongside the *original* "needs a person" event — both visible, append-only — and the annual-limit
    figure moved on the member's own cover card. No horizontal overflow at 375px.
  - Not exercised in a browser: `Don't cover it` and `closeQualityCheck` (both covered by the suite against the
    real rows).
- **Found while building** (each changed the code):
  - **The supersede banner lied for a hand decision.** `EventCase.supersededBy` carried only a reference, so the
    case page's copy always said *"reversed on appeal"* — true for an appeal, wrong and confusing for an advisor's
    `Cover it` / `Don't cover it`. It now carries the superseding row's kind and the banner reads accordingly.
    Found by actually clicking Cover it in the browser and reading what it produced, not by inspecting the diff.
  - **`servicingSubjects` and `getStraightThrough` lived in `lib/queries.ts`**, which is `server-only` — the exact
    trap the servicing session and graph were built to avoid from day one, and the one file in this phase that
    forgot. Moved to `lib/servicing/queue.ts` (not `server-only`) so `check-handoff.ts` can drive the real queue
    against a scratch database instead of a re-implementation of its logic.
  - **A close call the acceptance table adjudicates once has no natural task.** The seed originally wrote review
    tasks only for `insufficient_data` and appeal overturns; APP-1 (upheld with no evidence, on a declared
    condition) silently had no row in the broker's queue at all. It now writes the same quality-check task the
    session's own commit path writes for an equivalent live case — one seed, one code path, no special-casing the
    supplied data.
  - **A drift I mutation-tested into existence and then had to un-introduce twice**: my first cut of `coverIt`
    defaulted its preview to `geography: "abroad"` in one branch and `"uae"` in another, which the check caught
    (the point of mutation-testing forward as well as backward — I ran the mutation on my OWN draft before
    settling the code, not only on the finished version).
- **Known rough edges, deliberately left.**
  - `closeQualityCheck` and `Don't cover it` have no dedicated browser click in this phase's verification, only
    the suite's coverage against real rows — noted rather than claimed.
  - The case page's **Working** tab shows the agent's step trace only for an appeal's proposal; an undecidable
    claim's `Cover it` / `Don't cover it` verbs write a calculation trace but no step-by-step agent record, because
    neither verb runs the agent — a person is the one deciding, by design (§3.2).
  - `AdvisorReplyToast` is de-duplicated in `localStorage`, which is per-browser: a member who reads the reply on
    one device and opens another still gets the toast there once. The dot (server-derived, not `localStorage`)
    is the standing, reliable signal either way.
- **Done when — all met.** CLM-9 runs end to end on both surfaces; a member-requested hand-off works from any
  point; the queue order matches §13.3.1 on the seeded conditions with a clean claim absent and APP-1 present as a
  quality check; no time promise appears in any member-facing string, enforced in a live browser test as well as
  the suite.

### Phase 7 — Reassessment, both registers everywhere, and the demo · **done**

- **Built.**
  - **The reassessment engine** (`lib/servicing/reassess.ts`, pure, no DB, no model): `extractFitFeatures` reads
    features off `replay()`'s own steps — never a second reading of stored columns — pairing a waiting-period denial
    with a LATER paid claim of the *same benefit class only*, and crediting an appeal's upheld verdict as a feature
    even though it moved no ledger and produced no replay step. `computeVerdict` only recommends a change when a
    catalogue plan resolves EVERY originally-denied event (checked by that event's own outcome under the candidate,
    not a reduced denial *count* — a candidate that denies the same claims for a *different* reason is not a fix) at
    no greater total cost. A waiting period, however many times it is hit before it clears, is a clock, never a
    persisting reason — confirmed even against a cheaper, no-wait alternative sitting right there. `buildHindsightTable`
    (§13.3.4, stretch) replays the same history against every catalogue plan.
  - **The prose is a deterministic template, not a model call** (`lib/servicing/reassess-template.ts`) — a deliberate
    deviation from this doc's original "F11: agent, history-grounded" framing, made for the same reliability reason
    `explain-template.ts`, `appeal-commit.ts` and `handoff.ts` already are: a reassessment's citations are structured
    data built ALONGSIDE the sentences that cite them (`{eventId, ref, description}[]`, a new `citations` column on
    `plan_fit_reassessment`), never parsed back out of text after the fact, so a citation can never mismatch its own
    sentence. `recommend_change` withholds the plan name and every figure from the member text — only "an advisor
    will be in touch" — exactly the gate an appeal overturn already enforces on a sales act.
  - **Session wiring** (`lib/ai/servicing-reassess.ts`, not `server-only`): `reassessAfterEvent` runs after every
    ledger-mutating COMMIT (never a forecast — a pre-authorization does not trigger it) from three call sites
    (`servicing-session.ts`'s `persistTurn`, both signoff verbs, both hand-off verbs), replays the whole policy, and
    writes one row — best-effort, wrapped so a reassessment failure can never take down the claim decision it
    followed. A `recommend_change` raises ONE review task at priority 60 (§12.2: a judgment call, not a blocker); a
    later event that still recommends the same change does not raise a second one while the first is open, and a
    later event that now confirms closes the open task automatically. `approveReassessment` / `editReassessmentReasoning`
    / `dismissReassessment` are the broker's three verbs (§13.3.3) — each re-checks the caller is an advisor against
    the row (the `appUser.role` check a first draft omitted, caught by my own "a member cannot decide their own
    reassessment" test), and approve/edit both unlock the row for the member via `reassessmentApproved`.
  - **The queue** (`lib/servicing/queue.ts`): a dedicated `task: "reassessment"` kind (not folded into `"other"`),
    joined to `policy` / `person` / `plan` (current AND recommended) so the row carries the two premiums without a
    second query — the same "arithmetic before the click" reflex the overturn's queue row already uses.
  - **The read layer** (`lib/queries.ts`): `listMemberReassessments` returns the LATEST verdict only, and withholds
    a `recommend_change` one until its task is resolved with `approve` or `edit` — done as a plain join, so the read
    layer never reaches into `lib/ai`. `listBrokerReassessments` keeps the full history, all verdicts, both registers.
- **UI/UX built.**
  - **`CitationChip` / `CitationChips`** (`components/servicing/citation-chip.tsx`): the same citation, read two
    ways — a broker sees the reference the rest of their screen already uses (`CLM-3`), a member sees the plain
    description — both linking to the SAME `#event-<id>` anchor `MemberEventCard` / `BrokerEventRow` already render,
    so either register is one scroll from the row a sentence is standing on.
  - **The hindsight table** (`components/servicing/case/hindsight-table.tsx`, §13.3.4 stretch): one row per
    catalogue plan, the current one marked, in its own horizontally-scrolling container so it never forces the page
    to scroll sideways at 375px.
  - **The reassessment case page** (`/policies/[id]/reassess/[reassessmentId]`, broker only — a member gets a 404):
    both registers' prose with citation chips, the hindsight table, and — while a task is open — the three-verb
    decision panel (`ReassessmentDecision`); closed, it says so instead of showing stale controls.
  - **The queue row**: a `Plan-fit: recommends a change` badge and the two premiums inline (`Essential AED 4,200/yr
    → recommend Everyday Care AED 5,000/yr`), linking to the case page.
  - **Both policy views**: the existing "Does this plan still fit?" card (built ahead of this phase) now shows its
    citation chips; the broker's copy adds an "Open the case" link on a `recommend_change` row.
  - **The outputs dump** (`db/seed/dump-outputs.ts`, `bun run dump:outputs`, brief's deliverable 3): one JSON file
    per applicant (P1–P5) plus a `summary.json`, written from the same seeded data the acceptance table (§14) is
    checked against — cohort and flags, quotes, recommendation with both registers' reasoning and why the other
    two plans lost, and every servicing event in write order with its adjudication and the ledger state right
    after. Every event, including one that moved no ledger (an upheld appeal, a superseded denial), comes from
    `replayPolicy()` — a ledger-moving event takes its figures from the replay STEP, one with no step falls back to
    its own stored adjudication with the ledger simply carried forward, so the dump can never silently drift from
    what replay itself would produce. Checked by eye against §14: all 13 events across all five applicants match
    exactly, including the two load-bearing cases (APP-2's ledger write landing at month 7, so PRE-2 at month 9
    forecasts against an already-met deductible; CLM-9 as `null`s, not zeros).
  - **The 3-minute walkthrough** (`docs/demo_walkthrough.md`, §13.8, deliverable 1): the five stories in table
    order, timed, ending on the queue as the closing shot, plus a `recommend_change` reassessment as a 30-second
    "if there's time" beat. Every claim in it was checked against a live scratch copy of the DEFAULT seed while
    writing it — including correcting the original draft's assumption that P4's overturn is still pending in the
    default seed (it is not — the seed already has it confirmed, in the queue's "Recently resolved" rail — so that
    beat now opens the resolved case page directly, with a note on reseeding with `SEED_APPEALS=pending` for
    anyone who wants the live "click to sign" moment instead).
- **§18.8/§18.9 extended to reassessment prose.** `check-reassess.ts` now collects every `ReassessmentProse` its
  Part 1 fixtures build (plus the live row Part 2 writes through the real session) and runs the SAME
  `memberCopyViolations` scan `check-servicing.ts` runs over the 13 seeded events' explanations — banned
  vocabulary, raw enum tokens, a time promise, an internal reference — over every one, plus the register-difference
  assertion (the broker text names a reference the member's text never does; the two are never the same document).
  `check-registers.ts`, the static half of the same fence, gained a block for the reassessment case page (a member
  gets a 404, not a redirect; every verb checks the caller is an advisor at the door) and a check that
  `listMemberReassessments` actually withholds an unapproved `recommend_change` in its own source, not just at
  runtime.
- **Verified.**
  - **713 checks across ten scripts** (`bun run check:servicing`; `check-reassess.ts`'s own 67 folded in — needs
    `bun --conditions=react-server run db/seed/check-reassess.ts` when run alone, same as `dump:outputs`; see the
    file's own header and the memory note on why). Mutation-tested: the resolves-all check reduced to a denial
    *count*, `waiting_period_not_elapsed` added to the persisting set, waiting-period pairing matching ANY later
    event instead of the same benefit class, the queue's task kind / plan names / cause each wrong in turn, the
    advisor-role check removed from the three decision verbs, a reason code leaked into member prose (caught by
    BOTH the fixture scan and the live-row scan), the reassessment case page's advisor-only 404 removed, and
    `listMemberReassessments`'s withhold-until-approved gate removed — all caught.
  - **In a browser**, on a scratch copy, end to end: a synthetic policy (Essential, a declared chronic condition —
    none of the three supplied catalogue plans combine into a genuine `recommend_change` case, so this is the
    first check in the project to construct a whole synthetic POLICY rather than just synthetic events) drove two
    real claims through the session; the queue picked up the resulting task with the right badge and both
    premiums; the case page rendered both registers, the citation chips (clicking one scrolls to its history row),
    and the hindsight table (scrolls within its own box, not the page, at 375px); **Approve** went through and the
    member's policy screen updated from no card at all to "Consider moving to Everyday Care" with her own citation
    chips; **Dismiss**, on a second, freshly-raised recommendation, closed the task and correctly left the case
    page reading "closed — no open task"; **Edit reasoning**, on a third, replaced the broker text (verified via
    `javascript_tool` that the textarea held the clean replacement, not an interleaved duplicate) and unlocked the
    SAME member card with the recommendation still showing. The default seed's five-story walkthrough was
    separately checked live (see above).
- **Found while building** (each changed the code):
  - **`createdAt` is unix-SECOND precision, and two reassessments from the SAME request tie on it.** A commit that
    writes a `confirm` row and, from a later claim in the same policy month, a `recommend_change` row moments later
    can land in the same second; `ORDER BY desc(createdAt) LIMIT 1` then picks an implementation-defined winner. Live
    verification (not any check script) caught it: the member's policy screen showed the stale `confirm` card even
    though the true latest reassessment recommended a change. Fixed with a `rowid` tiebreak everywhere a query picks
    "the latest" `plan_fit_reassessment` row (`lib/queries.ts`, `lib/servicing/packet.ts`) — the same "write order,
    not wall-clock order" discipline `servicing_event` replay and `message.seq` already use — and added a dedicated
    regression check to `check-reassess.ts` that asserts the tie exists and that the read layer still resolves it
    correctly, both before and after approval.
  - **The reassessment case page re-offered a decided task.** `getReassessmentCase`'s task lookup had no `status`
    filter — ANY task for that row, not just an OPEN one — so after Dismiss the very next page load still showed
    the Decide panel with a blank note, as if nothing had happened. Live verification caught this (clicking
    Dismiss, then reloading); no check script had one, because none had driven a verb to completion and then
    reloaded the page. Fixed the same way `lib/servicing/case.ts`'s own event-task lookup already does
    (`eq(reviewTask.status, "open")`), and added a regression: dismiss a fresh task, assert `getReassessmentCase`
    returns `task: null` afterward.
  - **A dedicated `task: "reassessment"` queue kind, not `"other"`.** My own first check asserted the hydrated queue
    subject fell through to `"other"` — the simplest possible reading — but that throws away the chance to render
    the recommended plan and cost delta inline the way an overturn's arithmetic already is. Reconsidered explicitly
    while writing the hydration, not left as the path of least resistance.
  - **`lib/queries.ts` cannot be `bun run` directly.** It transitively imports a `server-only` module, which no-ops
    itself only under Next's `"react-server"` resolve condition — bun's default resolver doesn't set it, so any
    script that imports `lib/queries.ts` (the first time a check script has needed to, to test `listMemberReassessments`
    itself rather than a stand-in) throws on load unless run with `bun --conditions=react-server` — `dump-outputs.ts`
    inherited the same requirement for the same reason.
  - **An `rsync` re-sync clobbered the scratch DB mid-session.** Pushing a source edit into an already-running
    scratch copy with `rsync --exclude 'db/sqlite.db*' db/ scratch/db/` doesn't exclude anything — the pattern is
    relative to the SOURCE arg (`db/`), not the project root — so it silently overwrote the scratch DB with the
    real project's own `db/sqlite.db`. No harm reached the real DB (rsync only reads its source), but it broke the
    live `next dev` mid-write (`SQLITE_READONLY_DBMOVED`) and cost a re-seed. Recorded in the dev-environment
    memory; later syncs in this phase ran from the project root with the original clone's exclude list instead.
- **Known rough edges, deliberately left.**
  - The card-gallery-style rendering check (§18.10) was not extended with a dedicated reassessment "card" type —
    the reassessment card lives inline on the policy view and its own case page, not in the gallery's payload-type
    system, so there is nothing of that shape to add there.
  - The outputs dump reads from a throwaway seeded DB spawned fresh each run (the same discipline every other
    check/dump script in this project uses) — it does not read the user's own dev DB, so a hand run against real
    in-progress work would need a separate, explicit invocation someone chooses to make.
- **Done when — all met.** P3's reassessment names CLM-3, APP-1 and CLM-8 by id (broker) and by description
  (member), checked live; a broker can dismiss, edit, and approve a recommendation and watch the record and the
  member's screen change, each checked live; the outputs dump matches §14 exactly for all five applicants; the
  3-minute walkthrough is written and every beat checked against a live scratch copy; every item in §18 that
  applies to reassessment passes, including the two register/vocabulary scans extended to cover it.

---

## 18. Verification

1. **Replay**: `bun run db/seed/check-servicing.ts` — drop every ledger, refold
   from the log, assert identical. Twenty lines, matching the existing
   `db/seed/check-*.ts` convention.
2. **The acceptance table** (§14) as a fixture: 13 events, four fields each,
   plus the final ledger per policy.
3. **Order dependence**: running P2's events in the wrong order must fail the
   fixture — proof the ledger is actually wired in.
4. **The appeal asymmetry**: APP-1 upheld, APP-2 overturned, and — the real
   test — with the evidence **swapped** between them the outcomes swap too.
   This is what proves the admissibility table, not the model's
   agreeableness, decides appeals. Four more, all cheap and all guarding a
   specific way this loop rots:
   - **Wrong-field patch rejected**: an appeal against `provider_out_of_network`
     that proposes a correction to `billed_amount` fails validation and upholds.
   - **Never-worse**: a correction that improves one gate and worsens another
     leaves the original standing (§5.4.6).
   - **Exhausted admissibility upholds without asking again**: once the set in
     §5.4.3 is empty, no further evidence request is issued.
   - **Overturn survives replay**: drop P4's ledger after APP-2, refold, and
     month 9 still sees a met deductible — proof `effectOrder` placed the
     overturn at month 7 and not at the appeal date.
5. **`insufficient_data` is unreachable by accident**: no input other than a
   non-UAE geography or an unknown tier may produce it.
6. **Re-collect nothing**: a claim submitted by a member whose intake record
   already holds the condition must never ask about that condition. Asserted by
   counting `conversation_question` rows against the required-field table.
7. **No model, no wrong numbers**: with `OPENROUTER_API_KEY` unset, the
   acceptance table still passes end to end.

**The UI and the two registers** (§13). These are as much a part of "done" as
the arithmetic, and the first two are automated so they cannot rot.

8. **Banned-vocabulary scan.** Every member-facing string the acceptance run
   produces — explanations, **calculation traces**, next steps, card copy from the
   gallery — is scanned
   for `cohort`, `risk`, `flag`, `review task`, `priority`, `confidence`,
   `override`, `reviewer`, `escalat…`, and raw reason-code strings. Zero hits. A
   companion check greps the member components for `brokerExplanation`,
   `uncertaintyReason`, `confidence` and `decidedBy`: a member component that
   names one has already gone wrong.
9. **Register difference.** For each of the 13 events the broker text carries an
   entity the member text must not (a policy or event reference, a month, an
   implication for renewal or fit) and the member text carries what the broker's
   does not (a dated next step). Two documents, checked, rather than one
   reformatted.
10. **The card gallery.** Every payload type renders from its fixture in light and
    dark, at 375px and desktop; each type guard rejects a malformed payload.
11. **Keyboard and screen reader.** A claim, a pre-authorization and an appeal each
    complete keyboard-only; new assistant messages are announced; focus lands on
    the first control of each card and returns to the composer after send.
12. **375px.** The drawer, every card and the outcome states have no horizontal
    scroll; chips and buttons are at least 44px tall.
13. **Queue order.** On the seeded conditions the order is Undecidable → Blocked →
    Genuinely uncertain → Needs a decision, APP-1 appears as a quality check
    rather than vanishing, and a clean claim does not appear.
14. **No invented promises.** No member-facing string contains a time commitment
    (`within`, `hours`, `shortly`, `usually`, `by tomorrow`). The system has no
    SLA, so the UI cannot state one.
15. **No-model UI.** The 13 events can be driven through the drawer with no model
    key, entirely through FactsForm cards, and produce the same outputs as §14.
16. **Every state, screenshotted.** Each row of §13.2.3's table, each outcome
    variant, the escalation card, and the broker case page for each task type —
    the source for the brief's deliverable 3.

---

## 19. Open question for review

One thing in §2.3 is a genuine judgment call rather than a derivation, and it
is the one worth arguing about before implementation: **auto-upholding
appeals.** The case for it is that an uphold changes nothing and a fast, honest
"no, and here is exactly what would change it" beats a three-day wait for the
same answer. The case against is that an appeal is the moment a member has
said the system got it wrong, and a human reading that is cheap.

The design above auto-upholds and keeps the advisor button on the outcome, so
the member is never trapped. If that reads as too confident, the change is one
line in `gate` — it is deliberately isolated there for that reason.

What is *not* in question, and should not be traded away to settle it: an
overturn always takes a signature, and an uphold always states what would have
changed the answer (§5.4.3). An auto-uphold that just says no is the version of
this design worth objecting to.
