# CRM UI plan — advisor console + applicant surface

The product is a CRM for a health-insurance brokerage. The AI pipeline, the
Drizzle schema and every server action stay exactly as they are: this plan
changes what is on screen, how it is laid out, and how records are navigated.
The one place it touches logic is where the UI is currently rendering a number
that means nothing to a reader (see §5).

Decisions taken before writing this: UI/UX only; the sidebar and the theme
toggle survive untouched in behaviour; the applicant gets a floating chat
launcher on every page; the advisor gets a Clients 360 plus a pipeline board;
the dashboard carries operational and commercial numbers together.

---

## 1. What is wrong today

Read off the current screens, not from theory.

**There is no advisor home.** `/` renders `AdvisorOverview` — a list of open
review tasks and a list of policies. That is two more lists on top of a product
that is already four lists. An advisor opening the console cannot answer "what
is the state of my book this morning" without visiting three pages.

**There is no person.** The schema has 13 `person` rows against 43
applications, and nothing in the UI is keyed on a person. An advisor cannot see
that the applicant they are about to call has six other open applications —
except as a flag fired inside one of them (`duplicate_open_application`, visible
in the screenshots). That is the single most CRM-shaped hole in the product.

**The queue prints the same sentence twice.** `app/queue/page.tsx` renders
`task.reason` as the row title and `subject.uncertaintyReason` underneath it.
For most rows these are the same string, so the row reads as a stutter.

**Internal strings reach the screen raw.** "tool-call budget exhausted with no
shortlist proposed" and "need_class_excluded_at_budget: Maternity within 12
months cannot be met…" are engine vocabulary rendered as if they were written
for a reader.

**"Fit score 0.00", three times.** `lib/recommendation/quote.ts` stores
`1 / (1 + totalOutlay)` — for an 8,900 premium that is 0.000112, printed with
`.toFixed(2)`. Three plans, three zeroes, in the one panel where the advisor is
comparing plans.

**The plan rows are capitalised by CSS.** `Row` in the plan comparison applies
`capitalize` to every value, which turns "AED 10,000 after 12 months" into "AED
10,000 After 12 Months".

**The record page buries its own best material.** Rejection reasoning (61 rows
in the database, genuinely good broker-register prose) and the weights the
recommendation was scored under (in `ai_decision.output`, never rendered at all)
sit below the fold or nowhere.

---

## 2. Information architecture

Sidebar stays `collapsible="icon"`, same header, same footer switcher, same
theme toggle. Only the item list changes, and it gains group labels.

### Advisor

| Route | Purpose | State |
| --- | --- | --- |
| `/` | Dashboard — the morning read | rebuild |
| `/queue` | Worklist: what needs a human now | reformat |
| `/pipeline` | Applications by stage, board view | new |
| `/clients` | Every person, one row each | new |
| `/clients/[id]` | Client 360 + unified timeline | new |
| `/applications` | Full table, filterable | upgrade |
| `/applications/[id]` | The record | reformat |
| `/policies`, `/policies/[id]` | Live cover and utilisation | upgrade |

Grouped in the sidebar as **Today** (Dashboard, Queue), **Pipeline**
(Pipeline, Applications), **Book** (Clients, Policies).

### Applicant

Routes unchanged — `/`, `/applications`, `/applications/new/*`, `/policies`.
What changes is the floating chat launcher, present on all of them (§6).

---

## 3. Advisor dashboard (`/`)

Four bands, top to bottom, densest first.

**Band 1 — five stat tiles.** Open queue items; oldest item still waiting (in
days, the SLA number); applications in flight; policies live; annualised premium
live. Each tile is a link to the filtered view behind it — a number an advisor
cannot click is a number they have to go and look up.

**Band 2 — "Needs you now".** The top five queue rows, in queue order, rendered
exactly as the queue renders them (one component, two mounts). Under them, a
link through to the full queue with the remaining count.

**Band 3 — two panels side by side.**
- *Pipeline funnel*: applications per stage as a horizontal bar set, with
  drop-off between stages. Reads off `application.status`.
- *Where the uncertainty is*: count of low / medium / high confidence records
  awaiting a decision. This is the brief's "show the broker where to spend their
  attention", answered at book level rather than row level.

**Band 4 — activity.** Decisions taken this week (from `review_action`), with
who took them; and applications that have not moved in more than N days, which
is the thing a queue sorted by priority will otherwise starve.

Money: premium in pipeline = sum of the recommended quote's `annual_premium`
across applications at `recommended` or `plan_selected`. Premium live = sum of
`policy.annual_premium` where status is active. Both stated as annualised, both
labelled as indicative — they are quotes, not bookings.

New read-only query: `getAdvisorDashboard()` in `lib/queries.ts`. One function,
one round of parallel counts, no schema change.

---

## 4. Clients 360 (`/clients`, `/clients/[id]`)

**List.** One row per `person`: name, age, the label for their current state
(in intake / with advisor / recommended / covered), applications count, policies
count, live premium, last activity. Sorted by last activity. A search box over
name and reference, and a segment filter (all / active applications / covered /
no cover).

**Profile.** Header: name, contact facts, current cover if any, and the advisor
who owns the newest application.

Then four panels:
1. **Cover** — active policies, plan terms, utilisation bars (reuse
   `UtilizationBar`).
2. **Applications** — every application this person appears on, with stage and
   progress. This is where the duplicate-application problem becomes visible as
   a fact rather than as a flag buried in one record.
3. **Conversations** — every intake/plan conversation, openable.
4. **Timeline** — the merged one. Application created, submitted, assessed,
   flags fired, recommendation produced, review actions taken and by whom,
   policy issued, servicing events, reassessments. Reverse chronological,
   grouped by day, each entry carrying its actor.

The timeline is assembled in a new `getClientTimeline(personId)` — a read over
tables that already exist (`application`, `assessment`, `assessment_flag`,
`recommendation`, `review_action`, `policy`, `servicing_event`,
`plan_fit_reassessment`, `conversation`), normalised into one sorted array of
`{ at, kind, title, detail, actor }`.

**Broker-only vocabulary stays broker-only.** Cohort labels, flag codes, reviewer
notes and confidence appear on this page because it is an advisor page. The
applicant has no route to it.

---

## 5. The formatting pass

Each item below is a specific edit, not a direction.

1. **Queue row stutter** — `app/queue/page.tsx`. Render `task.reason` as the
   title; render `uncertaintyReason` underneath *only when it differs*, and
   label it ("why this needs you"). One row, one voice.

2. **Raw engine strings** — add a presentation mapper to `lib/domain.ts`:
   rule code → human sentence, with the code itself kept as a mono chip beside
   it. `need_class_excluded_at_budget` becomes "No plan inside the budget covers
   this need in time", with the code still readable for anyone who wants it.
   Sentence-case anything arriving lower-cased from the engine.

3. **Fit score** — stop printing `quote.score`. The plan comparison shows
   **rank** and **estimated annual outlay** (premium + expected out-of-pocket for
   the modelled year), which is the number that actually differentiates the
   three plans. `lib/recommendation/quote.ts` keeps writing its score; the UI
   stops pretending it is a 0–1 fit measure.

4. **Weights, finally rendered** — a "What this was scored on" panel on the
   record's recommendation tab, reading `weights.base` and `weights.dynamic`
   from `ai_decision.output` for the live `plan_recommendation` decision. Each
   criterion as a labelled bar, with the base→dynamic delta shown when the
   negotiation moved it. This is the best evidence in the system that the
   reasoning layer is real, and it is currently invisible.

5. **`capitalize` on plan values** — remove it from `Row` in both
   `app/applications/[id]/page.tsx` and `components/plan-card.tsx`; format the
   strings correctly at source instead.

6. **Progress header** — the journey card renders what reads as two stacked
   bars. Collapse to one track, with the step list beneath it and the step
   counter aligned to the same baseline as the status label.

7. **Sidebar footer** — the avatar and the name overlap at the collapsed
   boundary. Fix the grid so the avatar is `shrink-0` and the label column
   truncates, and hide the label cleanly in icon mode.

8. **Review tab** — each entry becomes a structured card: action badge
   (approve / edit / override / reject), who, when, what changed, and the note.
   Today they are two paragraphs and a green dot.

9. **Typography and numbers** — one scale for section titles, one for metadata
   lines; `tabular-nums` on every money and percentage; one date helper
   everywhere; consistent 4/6/8 spacing rhythm on cards.

10. **Empty, loading and error states** — every new list and panel gets all
    three. The dashboard and clients list get skeletons via `loading.tsx`.

---

## 6. The applicant chat launcher

**Shape.** A round button, bottom-right, fixed, on every applicant page. It
carries an unread/attention dot when a conversation is waiting on the applicant
(an open questionnaire, a trade-off question, or a shortlist to choose from).

**Open state.** A right-side drawer (`components/ui/sheet.tsx`, already in the
project) at about 420px, full-width on mobile, with two levels:
- *List* — every conversation for this user, newest first, each with its person
  name, status badge, last-message preview and time. Plus "Start a new chat".
- *Thread* — the selected conversation: full history, the questionnaire /
  trade-off / plan cards when one is open, and the live composer.

**Reuse, not rewrite.** The thread renders the same `Message`, `ChatComposer`,
`ChatQuestionnaire`, `TradeOffCard` and `PlanCard` components the full-page chat
uses, and posts to the same server actions. `/applications/new/chat/[id]` stays
as the full-screen experience and as the deep-link target — "open full view" in
the drawer header goes there.

**Mechanics.** The launcher is a client component mounted in the applicant
branch of the root layout. The conversation list and thread are fetched through
the existing server actions/route reads; the drawer keeps its open conversation
in component state, and the attention dot is computed server-side and passed in
as a prop so a closed drawer costs nothing.

**Not for advisors** in this phase — the advisor already reads conversations
inside the record, and a second surface would fragment where they look.

---

## 7. Shared component work

New, under `components/crm/`:
- `stat-tile.tsx` — label, value, delta/sub-line, optional href.
- `section-card.tsx` — title, description, optional action; the one card
  wrapper every panel uses, so spacing stops drifting per page.
- `filter-bar.tsx` — search + segmented filters, URL-state driven.
- `timeline.tsx` — the shared entry renderer for client and record history.
- `criterion-bars.tsx` — the weight breakdown.
- `funnel.tsx` — the pipeline funnel.
- `queue-row.tsx` — extracted from the queue page so the dashboard can mount it.

Under `components/chat/`: `chat-launcher.tsx`, `chat-drawer.tsx`,
`conversation-list.tsx`.

---

## 8. Order of work

| Phase | Contents | Why here |
| --- | --- | --- |
| 1 | Nav restructure, `components/crm/` primitives, formatting pass §5 items 1–3, 5, 7 | Everything after this sits on these primitives; the visible bugs stop being visible on day one |
| 2 | Advisor dashboard | The biggest gap, and it only needs the primitives |
| 3 | Clients list + 360 + timeline | The CRM spine |
| 4 | Pipeline board; applications table filters | Cheap once the timeline reader exists |
| 5 | Record page reformat — weights panel, review cards, rejection prominence (§5 items 4, 6, 8) | Deepest page, benefits from everything above |
| 6 | Applicant chat launcher | Self-contained; independent of 2–5 |
| 7 | Polish — empty/loading states, responsive, dark and light verification, a11y pass | Last, over a finished surface |

Each phase is verified in the browser against the dev server before the next
one starts, light theme and dark, at desktop and phone width.

### Progress

- **Phase 1 — done.** `engineNote`/`sameNote` in lib/domain.ts; `components/crm/`
  (section-card, stat-tile, queue-row); the queue rebuilt on the shared row;
  fit score replaced by modelled year cost (`getQuoteOutlays`, which needed the
  record loader extracted to lib/assessment/load.ts); `capitalize` removed;
  sidebar grouped; switcher collapse fixed.
- **Phase 2 — done.** `getAdvisorDashboard` and the four-band dashboard, with
  `components/crm/funnel.tsx`.
- **Phase 3 — done.** `listClients` / `getClient` / `getClientTimeline`;
  `/clients` and `/clients/[id]`; `components/crm/timeline.tsx` and
  `filter-bar.tsx`. The applications table's stat tiles and filters were
  pulled forward from phase 4 into this pass.
- **Also fixed in passing:** `components/ui/progress.tsx` rendered its default
  track *on top of* whatever children a caller passed, and every caller passes
  a track — so every progress bar in the product was drawn twice, one under the
  other. Visible in the applications table and the record's Progress card.
- **Left in phase 4:** the pipeline board.

## 9. Explicitly not in this plan

- The step-5 servicing surfaces (claims, pre-auth, reimbursement, appeals) and
  their adjudication engine. The schema supports them; no UI exists. Separate
  piece of work, separate decision.
- Any change to the agent graph, prompts, scoring or weights logic.
- Authentication. The cookie switcher stays.
