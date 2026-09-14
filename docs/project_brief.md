# Build Challenge: AI-Augmented Health Insurance Flow

We're an AI-native health insurance brokerage working with a UAE broker partner. Your challenge: build a thin, end-to-end slice of an AI-augmented individual health insurance flow — from applicant intake, through to a recommended plan with reasoning, and on through servicing a claim once that policy is live.

## Timeline

- You have one week. Due by 17.09.2026
- Submit via email to bluehelmai@gmail.com

## The problem

Health insurance brokering today is manual and repetitive. An advisor collects an applicant's information, matches them against carrier plans, compares options, and recommends one — mostly by hand. Once the policy is live, the same manual loop runs again on every claim: someone reads the policy wording, works out what's payable, and explains it. The applicant usually re-explains things the broker already knows.

The friction is real: applicants wait for callbacks, get asked for the same information multiple times, and comparison is slow and inconsistent.

We think most of this work — intake, classification, quoting, comparison, recommendation, and routine claims servicing — can be handled by AI, leaving a human advisor to own only the judgment and the relationship.

This challenge is a thin slice of that idea. Not the full product — one clean pass through the core flow, and one pass back through it when a claim arrives.

## How it works today → how we want it to work

| Today (manual) | Target (AI-augmented) |
| --- | --- |
| Applicant fills a web form | Applicant information captured once, cleanly |
| 45 min – 2 hr wait for a callback | Processed immediately |
| Same information collected 2–3 times | Collected once, reused across every step |
| Advisor manually matches and compares plans | System classifies, quotes, and compares automatically |
| Advisor picks a plan from experience | System recommends a plan with clear reasoning, advisor reviews |
| Claim arrives, advisor reads the policy wording by hand | System adjudicates against plan terms and explains the outcome |
| Nobody revisits whether the plan still fits | System reassesses fit using what it now knows |

## What to build — the core flow

Build all five steps as a connected flow. Each step is deliberately thin — **a complete end-to-end slice beats one beautifully polished step.** A rough fifth step that connects is worth more to us than a polished four-step flow that stops at recommendation. We are comparing how teams approach the whole flow, not who built the nicest single screen.

**1. Intake.** Capture an applicant's health and demographic information. How you do this is entirely up to you — a form, a conversational interface, freeform parsing, anything — and we want to see that variation.

*Bonus, and closest to our real vision: voice intake.* The applicant speaks their information in a natural back-and-forth, and the system captures, transcribes, and logs it on the spot — no form-filling. A browser mic is completely fine; you do not need to wire up a real phone line. Treat this as a bonus, not a requirement — a plain form is a perfectly good answer if it buys you time for steps 4 and 5.

**2. Eligibility = classification, not a yes/no.** Assign each applicant to a risk cohort and surface relevant flags (e.g. age band, pre-existing conditions). This is not an approve/deny gate — it's about routing and matching. Flagged applicants must be visible to the reviewer.

**3. Quote.** Match the applicant against the supplied carrier plans and produce indicative pricing per plan. Premiums in the supplied data are flat per plan; if you want to apply age or risk loading, that's fine, but say so — it's not required and it's not where we want your effort.

**4. Comparison + recommendation, with reasoning.** Compare the plans and recommend one. Explain why that plan fits *this specific applicant*. This is the step that matters most to us — it's the closest proxy for what an AI advisor actually adds.

Read past the yes/no on every benefit. A plan that covers a benefit behind a waiting period the applicant can't wait out is not covering it in any way that helps them.

**Human checkpoint:** before a recommendation is finalized, a reviewer must be able to see the full applicant record and the system's reasoning, then approve or edit it. Flagged cases from step 2 surface to this same reviewer.

**5. Servicing — the live policy.** Once a recommendation is approved, a policy exists with an inception date and a benefit ledger. From there your system handles four operations:

- **Pre-authorization** — an applicant asks whether a planned treatment will be covered, and what it will cost them. A forecast, not a transaction.
- **Claim adjudication** — a completed treatment is submitted. Determine what the plan pays, what the member pays, and why.
- **Reimbursement** — the member already paid the provider and is claiming it back. Same adjudication, different settlement direction.
- **Appeals** — the applicant contests a denial with new evidence. Assess whether the evidence actually changes the finding, then uphold or overturn.

All four read from a shared **benefit ledger** that tracks what's been consumed — deductible met, annual limit used, sublimits used. Claims write to it; pre-authorization only reads. Without the ledger you cannot adjudicate a second claim correctly, so build it first.

Then, across all of it:

- **Reassess fit.** Given what's now happened, does the plan still fit? Confirm it or recommend a change, with reasoning that references the actual events.
- **Re-collect nothing.** Anything already known about the applicant must be reused, not asked for again.

**`servicing_spec.md` defines the adjudication arithmetic exactly** — order of operations, reason codes, network tiers, ledger rules. Follow it precisely; we compare outputs across submissions and that only works if the math is identical. Everything else about how you build this is open.

Whether pre-authorizations, appeals, or reassessments need reviewer sign-off — and which ones — **is your call.** Tell us what you decided and why.

Two things worth stating plainly, because they cut both ways:

- **A denied or expensive claim does not automatically mean the plan was wrong.** Sometimes the applicant bought a known tradeoff and it came due exactly as expected.
- **A claim that pays out cleanly does not automatically mean the plan was right.** Check what it cost the member, not just whether it was covered.

The supplied events fall on both sides of that, and the same is true of the appeals: some should be upheld, some overturned.

## What the software has to be

This is working software, not a notebook of adjudication functions. Someone who has never seen your code should be able to sit down and run a whole applicant through it.

**Three surfaces:**

**1. Intake.** A real front end where an applicant's information is captured. This is the surface we most want to see variation in — form, conversational, freeform parsing, voice. Your choice entirely.

**2. Customer view — deliberately thin.** One screen. Their plan and what it covers, their utilization, their claim history and outcomes, anything pending, and a few actions: ask whether a planned treatment is covered, submit a claim or reimbursement, appeal a denial. **Do not over-build this.** It is mostly read-only over data that already exists, and we would rather you spent the time on the broker view. The one thing that matters here is that the writing is genuinely for a member — see below.

**3. Broker view — this is the substantial one.** Most of your interface effort belongs here.

A broker does not browse records one at a time. They work through a queue under time pressure, and the system's job is to make each decision fast and well-founded. Concretely:

- **A worklist.** Not a table of every applicant — a prioritised list of what actually needs a human decision right now: recommendations pending approval, flagged applicants, appeals awaiting assessment, anything the system returned `insufficient_data` on. **How you order that queue is a design decision we will read closely.** By urgency, by risk, by value, by how uncertain the system is? Tell us why.
- **The full record.** Cohort, flags and why they fired, quote comparison across all three plans, the recommendation and its reasoning, complete utilization and event history.
- **The rejected options.** Why the other two plans lost. A broker's job is judgment, and judgment needs the alternatives, not just the answer.
- **Decision surfaces.** Approve, edit, or override — on recommendations, on appeals, on anything routed for review. Every action is recorded with who took it.

### Surface the system's own uncertainty

Some decisions the system should make confidently. Some it genuinely should not.

CLM-9 cannot be resolved from the plan data at all. APP-1 is a judgment call about evidence. P3's recommendation is genuinely arguable between two plans. P1's is not — it's obvious.

**A broker view that presents all of these with the same confidence is worse than one that doesn't.** If everything looks equally settled, the broker either rubber-stamps everything or checks everything, and both defeat the purpose. Show the broker where to spend their attention.

How you express that — a confidence signal, a "why this needs you" line, queue ordering, something else — is up to you. That it happens at all is what we're looking for.

### What the two views must not be

**The same object with different styling.** They are two audiences, and the difference is the point.

Broker-only, never rendered in the customer view:

- Risk cohort assignment and the label attached to it
- Internal flags and the reasons they fired
- Reviewer notes, overrides, and the record of who decided what
- Any internal framing about the applicant as a risk

This is not about hiding things from customers — a broker would answer any of it honestly if asked. It's that classification vocabulary is an operational tool for routing and matching, not language you put in front of the person it describes. "High risk, multiple pre-existing conditions, route to reviewer" is a correct internal classification and a bad thing for a member to read about themselves.

The customer **does** see the recommendation and why it fits them, every adjudication outcome and the reasoning behind it, and their full history. Nothing about their own coverage is withheld.

### Same facts, two registers

Every explanation your system produces has two audiences. A denial for an exhausted maternity sublimit is, to the member: what it means for the visits they've already booked and what they can do now. To the broker: which applicant hit a cap, in which month, and whether it changes the renewal conversation. Same event, same facts, different job.

**This is the cheapest place to show whether your reasoning layer is real**, and it's the reason the customer view exists at all despite being thin. A system generating one explanation and reformatting it will read wrong in one of the two views. It costs you very little and it tells us a lot.

**What must actually work:**

- An applicant can go from intake to an approved recommendation without anyone touching a database by hand.
- Every servicing operation can be run from the UI and its result is visible in both views.
- Utilization and history are visible — not just the current balance, but what happened and when.
- A reviewer can see the system's reasoning and approve, edit, or override it, and their action is recorded.
- The record persists. Close the browser, come back, it's still there.

**What we are not asking for:** authentication, real user accounts, multi-tenancy, styling polish, responsive design, deployment, or test coverage. Unstyled and working beats attractive and hardcoded. If you're choosing between a nicer intake screen and a working appeal, build the appeal.

## In scope / out of scope

**In scope**

- Individual health insurance only
- The five-step flow above
- The reviewer checkpoint at recommendation, plus whatever servicing checkpoint you decide on

**Out of scope — do not build these:**

- Family or group/business plans
- Retention, win-back, or renewal flows
- Billing, premium collection, payments, or real transactions
- Procedure coding, prior authorization, medical necessity review, or appeals — a claim here is a description, a provider type, a date, and an amount; adjudication is against plan terms only
- Real carrier integrations
- Document/OCR processing
- Authentication, login, or real user accounts — a view toggle is all we want
- Anything production-grade — this is a thin proof of the flow, not a finished product

## What we'll give you

All data is fictional — there is no real client or carrier data involved. Provided as readable documents and as a single JSON file, so you don't spend time on data entry.

- **`carrier_plans.md`** — three fictional plans (Essential, Balanced, Comprehensive) with genuine tradeoffs across price, deductible, network, and coverage depth.
- **`applicant_profiles.md`** — five fictional applicants, designed to resolve to different plans.
- **`servicing_spec.md`** — **the precise part.** Adjudication order of operations, reason codes, ledger rules, network tier mapping, worked example. Read this before writing adjudication code.
- **`servicing_events.md`** — thirteen events across the five applicants: claims, pre-authorizations, a reimbursement, and two appeals.
- **`hackathon_data.json`** — all of the above, machine-readable.

**Use our plan schema as-is.** You can add fields, but don't rename or restructure the ones we've given you. We're reading several submissions side by side and that only works if the plan terms mean the same thing in every one.

`servicing_spec.md` settles the arithmetic that used to be ambiguous — deductible ordering, co-pay scope, how sublimits cap. **One thing remains genuinely undefined**, and you will hit it. When you do, return `insufficient_data` and route to the reviewer rather than inventing a rule. We'd rather see a system that knows the edge of its own data than one that produces a confident wrong number.

## Definition of done

A working system where a synthetic applicant can go all the way through:

- Information entered → classified and flagged → quoted against the provided plans → recommendation produced with reasoning → reviewer approves or edits → policy exists with an inception date → claim submitted → adjudicated against plan terms → plan fit reassessed.
- The applicant record persists across all of it and can be viewed in the UI, including full utilization and event history.
- The ledger is replayable from history — delete it, replay the events, get the same numbers back.
- It runs on all five supplied profiles and all thirteen supplied servicing events, in order.

## What to hand back

Please give us all of the following. The structure matters — we're reading several submissions against the same rows.

1. **A working demo** — live, or a 3-minute walkthrough video.
2. **Access to your code / repo.**
3. **All five applicants run end to end**, with outputs captured — cohort and flags, quotes, recommendation and reasoning, then every servicing event in order with its adjudication and the resulting ledger state. A folder of screenshots or JSON dumps is fine. For each event we compare four fields against ours: **outcome, plan_pays, member_pays, reason_code**.
4. **Four short written answers**, a paragraph each:
   - **Where did you use a model, and where did you use deterministic logic — and why did you draw the line there?**
   - What did you decide about reviewer sign-off — on pre-authorizations, appeals, and reassessments — and why?
   - How did you define your risk cohorts?
   - How is state stored, and can the ledger be rebuilt from history?
   - How did you decide what the customer view shows and what stays broker-only?
   - How is the broker's worklist ordered, and how does the system signal which decisions need real attention?
   - What did you build first, what did you cut, and what would you do next with more time?

## How we'll judge it (roughly in this order of weight)

1. **Quality of the recommendation reasoning** — is the "why" sound and specific to this applicant, and does it read past the surface of the plan terms?
2. **Servicing correctness and reasoning** — is the ledger wired in so later events see earlier ones? Are denials, appeals, and pre-auths explained in terms a member could act on? Does the system reuse what it already knows rather than re-collecting it?
3. **Completeness of the end-to-end slice** — does the whole flow connect?
4. **Sensible classification** — does the cohort/flagging logic make sense, and does the system know when *not* to answer?
5. **Clarity of approach** — is the thinking behind the build clear?

Note on #1 and #2: we read both views. Reassessment reasoning that draws on event history ("second denial for the same reason") beats reasoning from current balances, and explanations that are genuinely written for their audience beat one explanation shown twice.
