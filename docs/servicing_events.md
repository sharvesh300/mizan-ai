# Servicing Events (Fictional)

Thirteen events across the five applicants — claims, pre-authorization requests, a reimbursement, and two appeals. All policies incept **2026-01-01**. All amounts in **AED**.

Process each applicant's events **in the order listed**. Later events depend on ledger state left by earlier ones.

Machine-readable versions are in `hackathon_data.json`.

**Note on the assumed plan.** Each applicant is on the plan named below. If your system recommended something different at step 4, adjudicate against the plan named here anyway so outputs stay comparable — then say so in your write-up. That difference is interesting to us, not a problem.

---

## P1 — Budget-driven young professional · **Essential (Plan A)**

**CLM-1** · claim · month 5
Fractured wrist — urgent care visit, X-ray, casting.
Outpatient · in-network clinic · benefit class `general` · **billed 3,200**

**CLM-6** · claim · month 8
Course of physiotherapy following the wrist fracture.
Outpatient · in-network clinic · benefit class `general` · **billed 1,800**

---

## P2 — Planning a family this year · **Comprehensive (Plan C)**

**PRE-1** · pre-authorization · month 6
Requesting approval for planned delivery at a private hospital.
Inpatient · private hospital · benefit class `maternity` · **estimated 40,000**

**CLM-2** · claim · month 9
Maternity — prenatal care and delivery.
Inpatient · private hospital · benefit class `maternity` · **billed 40,000**

**CLM-7** · claim · month 11
Postnatal follow-up consultations.
Outpatient · in-network clinic · benefit class `maternity` · **billed 3,000**

---

## P3 — Older applicant, managed chronic conditions · **Balanced (Plan B)**

**CLM-3** · claim · month 4
Endocrinology consultation, HbA1c panel, medication review — routine management of her existing type 2 diabetes.
Outpatient · in-network clinic · benefit class `chronic_preexisting` · **billed 2,800**

**APP-1** · appeal · month 4 · contests **CLM-3**
> "I'm appealing this. My diabetes was only picked up at a check-up after I took out the policy — I wasn't diagnosed before. It shouldn't count as pre-existing and I shouldn't have to wait six months."

Evidence attached: none.
On file from intake: type 2 diabetes declared as an existing condition, stable and managed on medication at the time of application.

**CLM-8** · claim · month 7
Follow-up endocrinology consultation and repeat labs — same condition.
Outpatient · in-network clinic · benefit class `chronic_preexisting` · **billed 2,600**

---

## P4 — Healthy mid-career, values access · **Balanced (Plan B)**

**CLM-4** · claim · month 7
Course of physiotherapy following a shoulder injury.
Outpatient · **top-tier private hospital** · benefit class `general` · **billed 6,000**

**APP-2** · appeal · month 7 · contests **CLM-4**
> "The physio clinic is inside the hospital building, but it isn't part of the hospital. It's a separate practice with its own licence. I've attached the registration."

Evidence attached: provider registration certificate showing **Gulf Physiotherapy Centre LLC** as an independently licensed outpatient facility registered at **standard** network tier, operating from a leased suite within the hospital building.

**PRE-2** · pre-authorization · month 9
Requesting approval for a planned shoulder arthroscopy.
Inpatient · private hospital · benefit class `general` · **estimated 28,000**

---

## P5 — Older applicant, high needs · **Comprehensive (Plan C)**

**CLM-5** · claim · month 3
Cardiac admission — chest pain, angiography, stent revision.
Inpatient · premium private hospital · benefit class `chronic_preexisting` · **billed 180,000**

**CLM-9** · reimbursement · month 6
While travelling overseas, the applicant had a cardiac follow-up consultation and collected repeat medication. He paid the provider directly and is claiming the cost back. Receipts attached.
Outpatient · **provider outside the UAE, tier unknown** · benefit class `chronic_preexisting` · **paid by member 4,500**

---

### Notes for builders

- **Order matters.** Every event reads the ledger left by the one before it. Processing them independently will produce wrong answers on the second claim for most applicants.
- **A denied claim does not consume the deductible.** The member paying out of pocket is not the plan applying a benefit.
- **Pre-authorization does not write to the ledger.** It is a forecast, not a transaction. But it must *read* the ledger — what's already been consumed changes what a member will pay.
- **One event cannot be resolved from the plan data.** Return `insufficient_data` and route it to the reviewer rather than inventing a rule.
