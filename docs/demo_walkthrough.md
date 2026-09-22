# The 3-minute walkthrough

Rehearsed against §13.8's five stories, in that order, ending on the queue as the closing shot. Each beat names
who's signed in, what to click, and what to say — timed to land under three minutes end to end. Switch users with
the sidebar's own switcher (desktop width only); nothing here needs a model key — every beat runs the same on the
deterministic path.

Setup: seed a scratch copy (`bun run db:seed`, or a fresh scratch DB per the dev-environment note — never the
running dev server's own DB), start it, sign in as **Karim Youssef** (advisor) to begin.

---

## 0:00 – 0:10 — Cold open: the queue

**Advisor console → Review queue.**

> "This is everything the system would not decide alone, right now — grouped by what kind of attention it wants,
> not by when it arrived."

Point at the four bands without opening anything yet: *Undecidable*, *Blocked*, *Genuinely uncertain*, *Needs a
decision*. Say the last line of this beat once, hold it for the close: "we'll come back here."

## 0:10 – 0:40 — P1 · CLM-6: the ledger is wired in

**Switch to an applicant on P1's policy → My cover.**

Open the policy. Scroll to CLM-6 (the second outpatient claim).

> "540 dirhams, not 900 — because the deductible was already met by the first claim. The card says exactly that:
> *'your deductible was already met.'* Nothing here is a canned line; it's read off the ledger."

## 0:40 – 1:10 — P2 · PRE-1 → CLM-2 → CLM-7: forecast vs decision, a sublimit running out

**Same session, P2's policy.**

Open PRE-1 (a pre-authorization): *"an estimate — nothing has been claimed yet."* Then CLM-2, the real claim at
the same figures. Then CLM-7: denied, sublimit exhausted, with the date it clears.

> "A pre-auth never moves the ledger — it's a forecast. The real claim does. And when the yearly limit for this
> benefit runs out, the member is told the date it resets, not just 'no.'"

## 1:10 – 1:45 — P3 · CLM-3 → APP-1 → CLM-8: an honest uphold, then reassessment

**P3's policy, member side, then broker.**

Open CLM-3 (denied, waiting period), then APP-1: *"upheld — and here's what would change it."* Then CLM-8, paid
once the wait cleared. Scroll to **"Does this plan still fit?"**

> "This wasn't a mismatch — a wait is a clock, not a verdict on the plan. The reassessment says so, citing both
> claims and the appeal by name, in the member's own words."

Switch to **Karim Youssef**, open the same policy's broker view: same card, but the broker reads `CLM-3`, `APP-1`,
`CLM-8` by reference, and the citation chips scroll straight to each row in the history below.

## 1:45 – 2:20 — P4 · CLM-4 → APP-2 → PRE-2: an overturn, signed

**Broker session.** The default seed's APP-2 is already confirmed (it's in the queue's *Recently resolved* rail,
not waiting) — open its case page directly (`/policies/[P4's id]/events/[APP-2's id]`) rather than the queue.

> "Denied at 0/6,000, provider out of network. The member sent a registration certificate showing it's actually
> in-network under a different name. Overturned: 4,400 paid, 1,600 the member's. And it's not a guess at where
> the money landed: PRE-2, a pre-authorization at month 9, already forecasts against the deductible the overturn
> met at month 7."

Open PRE-2 to show it.

*To show the live "one click to sign" moment instead of the already-resolved record: reseed with
`SEED_APPEALS=pending bun run db:seed` (omits APP-1/APP-2, so CLM-4 is still appealable), submit the appeal as
Daniel Fischer with the certificate as evidence, then the queue row carries the inline arithmetic and **Confirm
reversal** is a live click.*

## 2:20 – 2:45 — P5 · CLM-9: the system knowing its own edge

**Broker session, queue → Undecidable band.**

> "CLM-9 is treatment outside the UAE. The plan defines no geographic scope, so this isn't a low-confidence guess
> — it's a `null`, not a `0`. The system refused to invent an answer and routed it to a person."

Open the case page briefly: the tier picker an advisor chooses from, each option priced by the engine — never typed
in by hand.

## 2:45 – 3:00 — Close: the queue, again

**Back to Review queue.**

> "Five different confidence postures, one screen, ordered by what actually needs a human: the plan couldn't
> decide it, a member's waiting on a person, a close call worth a second look, or — like P4's overturn and any
> plan-fit recommendation — the system already worked it out and needs one signature. That's the whole loop."

---

## If there's 30 seconds left

Show a `recommend_change` reassessment (seed one via `db/seed/check-reassess.ts`'s own synthetic scenario, or
drive two real claims against a declared condition the current plan excludes): the queue row's two premiums
inline, the case page's hindsight table (*"had this policy been on each plan from the start"*), and — the point of
the whole gate — that the member's policy screen shows nothing about it until Approve or Edit reasoning is clicked.

## Timing notes

- Every beat above is real data from `bun run db:seed`'s default fixtures — no scripting needed beyond clicking
  through, so a re-run never drifts from what's on screen.
- If asked "does this need a model key?": no — everything shown here is the deterministic engine and template
  prose; the model only drives the conversational intake surface, not shown in this walkthrough.
- Full output for all five applicants, every field compared in the table above: `outputs/` (`bun run dump:outputs`
  to regenerate).
