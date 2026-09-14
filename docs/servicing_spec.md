# Servicing Specification

This document is the precise part of the brief. The rest of the challenge is deliberately open — how you build intake, where you put the model, what the UI looks like. **This part is not.** Adjudication arithmetic has to be identical across submissions or the outputs aren't comparable, so the rules below are exact.

Read this before writing adjudication code.

---

## 1. The four servicing operations

| Operation | Input | Output | Mutates the ledger? |
|---|---|---|---|
| **Pre-authorization** | Planned treatment, estimated cost | Approve / decline / approve-with-limit, plus expected member cost | **No** — dry run |
| **Claim adjudication** | Completed treatment, billed amount | Plan pays / member pays / reason code | **Yes** |
| **Reimbursement** | Same as a claim, but member already paid | Same, plus amount payable back to member | **Yes** |
| **Appeal** | A prior denied event + new evidence | Uphold or overturn; if overturned, re-adjudicate | **Only if overturned** |

Pre-authorization and claim adjudication run the **same decision logic**. The only differences are that pre-auth uses an estimate and does not write to the ledger. Do not implement these twice.

Reimbursement is a claim where the member has already paid the provider. The adjudication is identical; only the settlement direction changes. `plan_pays` becomes the amount reimbursed to the member instead of paid to the provider.

---

## 2. The benefit ledger

Every policy has a ledger. It is the single source of truth for everything consumed so far, and **every operation reads it**. Without it you cannot adjudicate a second claim correctly.

```json
{
  "policy_id": "POL-P1",
  "profile_id": "P1",
  "plan_id": "plan_a",
  "inception_date": "2026-01-01",
  "status": "active",
  "deductible_met": 1500,
  "annual_paid": 2450,
  "sublimit_used": { "maternity": 0, "dental_optical": 0 },
  "events": ["CLM-1", "CLM-6"]
}
```

Three rules that decide most of the test cases:

1. **Only payable claims consume the deductible.** A denied claim does not move `deductible_met`, no matter how much the member paid out of pocket.
2. **Sublimits track plan payment, not billed amount.** If the plan pays 25,000 on a 40,000 bill, `sublimit_used` increases by 25,000.
3. **An overturned appeal writes to the ledger at the point of the original event**, not at the appeal date.

The ledger is derived state — see §2b. The event log below is what's authoritative.

---

## 2b. History — the event log

The ledger tells you **how much is left**. It cannot tell you **what happened**. Both are required.

Every operation writes one immutable history record:

```json
{
  "event_id": "CLM-6",
  "policy_id": "POL-P1",
  "kind": "claim",
  "policy_month": 8,
  "benefit_class": "general",
  "provider_tier": "in_network_clinic",
  "billed_amount": 1800,

  "outcome": "covered",
  "reason_code": "covered",
  "plan_pays": 1260,
  "member_pays": 540,
  "calculation": [
    "deductible applied 0 (remaining was 0)",
    "co-pay 30% of 1800 = 540"
  ],

  "ledger_before": { "deductible_met": 1500, "annual_paid": 1190, "sublimit_used": {...} },
  "ledger_after":  { "deductible_met": 1500, "annual_paid": 2450, "sublimit_used": {...} },

  "decided_by": "system",
  "reviewer_action": null,
  "supersedes": null
}
```

**Records are append-only. Nothing is edited or deleted.**

- A reviewer overriding a decision writes a **new** record with `decided_by: "reviewer"`, not an edit to the old one.
- An **overturned appeal supersedes** the original denial — `supersedes: "CLM-4"` — it does not erase it. The denial happened; the appeal reversed it; both are true and both stay on the record.
- `calculation` is the arithmetic trace. Keep it. It's what lets a member or a reviewer see *why*, and it's what makes a wrong number debuggable instead of mysterious.

### The architectural rule

**The event log is the source of truth. The ledger is a projection of it.**

You should be able to delete the ledger, replay the history from inception, and get the identical ledger back. If you can't, the two have drifted and one of them is lying. The reference implementation includes this replay check — it's twenty lines, and it catches an entire class of bug.

Store the ledger if you want it for speed. Just never treat it as authoritative.

### Why this matters for the reasoning

Plan-fit reassessment — the thing we weight most — is not answerable from counters:

- **P2:** "Comprehensive was right" only holds if you can see CLM-2 paid to the cap *and* CLM-7 was then denied for exhausting it. Two events, read together.
- **P3:** "Don't switch plans" only holds as the sequence CLM-3 denied → APP-1 upheld → CLM-8 paid once the wait cleared. The tradeoff came due and resolved. A counter showing `annual_paid: 1680` tells you none of that.
- **P4:** "One out-of-network episode isn't a pattern" is a statement about history by definition.

A system reasoning from `deductible_met` and `annual_paid` alone will produce generic advice. A system reasoning from the event log can say something specific to this person. That difference is most of what we're judging.

---

## 3. Benefit classes

Every claim belongs to exactly one class. The class determines which waiting period and which sublimit apply.

| Class | Waiting period source | Sublimit |
|---|---|---|
| `general` | none | none |
| `maternity` | `maternity.waiting_period_months` | `maternity.limit` |
| `chronic_preexisting` | `chronic_preexisting.waiting_period_months` | none |
| `dental_optical` | none | none (tier-based: none / basic / full) |

A claim is `chronic_preexisting` if it treats a condition the applicant declared at intake. Treatment for a condition that first arose *after* inception is `general`.

---

## 4. Order of operations

Run these in order. Stop at the first denial.

```
1.  Policy active?                    → no  ⇒ DENY  policy_not_active
2.  Benefit covered by plan at all?   → no  ⇒ DENY  benefit_excluded
3.  Waiting period elapsed?
       policy_month >= waiting_months → no  ⇒ DENY  waiting_period_not_elapsed
4.  Provider tier in plan's network?  → no  ⇒ DENY  provider_out_of_network
5.  Sublimit already exhausted?       → yes ⇒ DENY  sublimit_exhausted
6.  Annual limit already reached?     → yes ⇒ DENY  annual_limit_reached
7.  Apply remaining deductible:
       applied     = min(deductible - deductible_met, billed)
       after_ded   = billed - applied
8.  Apply co-pay to the remainder:
       member_copay = after_ded × copay_pct
       plan_pays    = after_ded - member_copay
9.  Cap plan_pays at remaining sublimit for the class
10. Cap plan_pays at remaining annual limit
11. member_pays = billed - plan_pays
12. Append history record, then update the ledger projection:
                     deductible_met += applied
                     annual_paid    += plan_pays
                     sublimit_used  += plan_pays  (if class has one)
```

**Explicitly settled, so nobody has to guess:**

- Deductible comes **before** co-pay.
- The co-pay percentage applies to **inpatient and outpatient alike**. The plan data labels it "outpatient co-pay"; treat it as the general co-pay rate.
- Sublimits cap **plan payment**, and are applied **after** the co-pay.
- `policy_month` is months elapsed since inception, starting at month 0. A 6-month wait clears at month 6.

**One thing is deliberately undefined**, and you will hit it. The plan data says nothing about geographic scope — whether treatment received outside the UAE is covered at all. When you hit this, the correct behaviour is to return `insufficient_data` and route to the reviewer. **Do not invent a rule.** Recognising the edge of your data is worth more to us than a confident wrong answer.

---

## 4b. Field visibility

Every history record and applicant record has two audiences. Tag fields rather than building two data models.

| Field | Customer | Broker |
|---|---|---|
| Plan, coverage terms, premium | ✅ | ✅ |
| Utilization (deductible met, limits used) | ✅ | ✅ |
| Event history, outcomes, amounts | ✅ | ✅ |
| `reason_code` and its explanation | ✅ | ✅ |
| `calculation` trace | ✅ | ✅ |
| Recommendation and why it fits them | ✅ | ✅ |
| Quote comparison across all three plans | ✅ | ✅ |
| **Risk cohort assignment** | ❌ | ✅ |
| **Internal flags and firing reasons** | ❌ | ✅ |
| **Reviewer notes, overrides, `decided_by`** | ❌ | ✅ |
| **Pending-review status and why** | ❌ | ✅ |

The customer sees everything about their coverage and every decision affecting it. What they don't see is the internal classification vocabulary and the reviewer workflow around it.

A useful check: if a field would be strange to read about yourself but is necessary to route your case correctly, it's broker-only.

**Explanations are audience-specific, not filtered.** Don't write one explanation and strip sentences out of it for the customer. `reason_code` is shared; the prose around it is written twice, for two different jobs. CLM-7 to the member is what an exhausted maternity benefit means for the appointments they've already booked. To the broker it's which policy hit a cap, when, and what it implies at renewal.

---

## 5. Reason codes

Every adjudication returns exactly one. Use these strings verbatim.

| Code | Meaning |
|---|---|
| `covered` | Payable, in full or in part |
| `policy_not_active` | Lapsed, cancelled, or not yet incepted |
| `benefit_excluded` | Plan does not cover this benefit class at all |
| `waiting_period_not_elapsed` | Benefit exists but the wait has not cleared |
| `provider_out_of_network` | Provider tier not admitted by the plan's network |
| `sublimit_exhausted` | Class sublimit fully consumed |
| `annual_limit_reached` | Annual limit fully consumed |
| `insufficient_data` | Plan terms do not determine this case — route to reviewer |

Reason codes matter more than they look: **an appeal argues against a reason code.** Prose denials can't be appealed against systematically.

---

## 6. Network tiers

The plan documents describe networks in prose. Here is the machine-readable mapping.

| Plan network | Admits |
|---|---|
| `restricted` (Essential) | `in_network_clinic`, `general_hospital` |
| `standard` (Balanced) | the above + `private_hospital` |
| `wide` (Comprehensive) | the above + `top_tier_private_hospital`, `premium_private_hospital` |

Network is a **gate, not a discount**. A claim at a provider outside the plan's network is denied, not paid at a worse rate.

---

## 7. Appeals

An appeal is a request to re-examine a denied event **in light of new evidence**. Each supplied appeal carries a specific claim by the applicant plus whatever evidence they've attached.

Your system should:

1. Identify the reason code being contested.
2. Assess whether the new evidence actually changes that specific finding.
3. Uphold (denial stands) or overturn (re-adjudicate, then write to the ledger).
4. Explain the outcome to the applicant in terms they can act on.

**Some appeals should be upheld and some overturned.** An appeal is not a customer-service exercise in saying no politely, nor is it a mechanism for granting whatever a sympathetic applicant asks for. Evidence that doesn't bear on the reason code doesn't change the outcome, however reasonable the applicant sounds. We are specifically interested in whether your system holds a correct denial under pressure and reverses an incorrect one.

Decide for yourself whether appeals require reviewer sign-off, and tell us why.

---

## 8. Worked example

P1 is on Essential (deductible 1,500, co-pay 30%). Two claims, both in-network outpatient.

**CLM-1, month 5, billed 3,200.** Ledger starts empty.

```
deductible: min(1500 - 0, 3200)  = 1500 applied → after_ded 1700
co-pay:     1700 × 30%           = 510 member
plan_pays   1700 - 510           = 1190
member_pays 3200 - 1190          = 2010
ledger → deductible_met 1500, annual_paid 1190
```

**CLM-6, month 8, billed 1,800.** Deductible is already met.

```
deductible: min(1500 - 1500, 1800) = 0 applied → after_ded 1800
co-pay:     1800 × 30%             = 540 member
plan_pays   1800 - 540             = 1260
member_pays 1800 - 1260            = 540
ledger → deductible_met 1500, annual_paid 2450
```

If your CLM-6 output says the member pays 1,590, you re-applied the deductible and your ledger isn't wired in.

---

## 9. What we check

For each event in `servicing_events.md`, we compare your output against ours on four fields: **outcome**, **plan_pays**, **member_pays**, **reason_code**. Then we check that the final ledger matches, and that your history is complete and replayable.

The arithmetic is the easy half. The explanation is what we're actually judging — whether a member reading it would understand what happened and what to do next, and whether your reassessment reasoning draws on the history rather than just the current balance.
