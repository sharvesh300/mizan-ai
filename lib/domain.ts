// The domain's display vocabulary, in one place.
//
// Every status, outcome, reason code and flag severity in the schema needs two
// things at the surface: a human label and a tone. Keeping both here means a
// status never gets a different colour on one screen than another, and the
// tone names line up with the semantic tokens registered in app/globals.css.

import { monthYear, policyMonthStart } from "@/lib/servicing/dates";
import type {
  ApplicationStatus,
  ConfidenceLevel,
  ConversationStatus,
  EventKind,
  EventOutcome,
  FlagSeverity,
  ReasonCode,
  RecoStatus,
  ReviewAction,
  ReviewStatus,
} from "@/db/schema";

/** Maps onto the --color-{success,warning,info,destructive,brand} tokens. */
export type Tone = "neutral" | "brand" | "success" | "warning" | "info" | "danger";

/** Badge/pill classes per tone — subtle fill, full-strength text. */
export const toneBadge: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  brand: "bg-brand-subtle text-brand",
  success: "bg-success-subtle text-success",
  warning: "bg-warning-subtle text-warning",
  info: "bg-info-subtle text-info",
  danger: "bg-destructive-subtle text-destructive",
};

/** Solid dot, for timelines and list rows where a full badge is too loud. */
export const toneDot: Record<Tone, string> = {
  neutral: "bg-muted-foreground/40",
  brand: "bg-brand",
  success: "bg-success",
  warning: "bg-warning",
  info: "bg-info",
  danger: "bg-destructive",
};

// ---------------------------------------------------------------------------
// Application lifecycle
// ---------------------------------------------------------------------------

/**
 * The happy path, in order — only statuses a real code path actually writes.
 * `quoted` and `approved` never do (pricing and the recommendation are one
 * transaction — see `persistRecommendation`, lib/ai/recommendation-session.ts
 * — and Review 2's approve verb jumps straight to `policy_issued`), so they
 * are folded into the milestone that subsumes them rather than kept as
 * permanently-unreachable steps. Drives the progress stepper.
 */
export const APPLICATION_JOURNEY = [
  "in_intake",
  "submitted",
  "assessed",
  "recommended",
  "plan_selected",
  "policy_issued",
] as const satisfies readonly ApplicationStatus[];

/** Statuses that sit outside the journey — no step index, shown as-is. */
const TERMINAL: ApplicationStatus[] = ["withdrawn", "declined", "expired"];

export const applicationStatusLabel: Record<ApplicationStatus, string> = {
  draft: "Draft",
  in_intake: "In intake",
  submitted: "Submitted",
  confirmed: "Confirmed",
  assessed: "Assessed",
  quoted: "Plans ready",
  recommended: "Plans ready",
  in_review: "With an advisor",
  approved: "Plan chosen",
  plan_selected: "Plan chosen",
  policy_issued: "Policy active",
  withdrawn: "Withdrawn",
  declined: "Declined",
  expired: "Expired",
};

export const applicationStatusTone: Record<ApplicationStatus, Tone> = {
  draft: "neutral",
  in_intake: "info",
  submitted: "info",
  confirmed: "info",
  assessed: "info",
  quoted: "brand",
  recommended: "brand",
  in_review: "warning",
  approved: "brand",
  plan_selected: "brand",
  policy_issued: "success",
  withdrawn: "neutral",
  declined: "danger",
  expired: "neutral",
};

/**
 * 0-based index into APPLICATION_JOURNEY, or null for draft/terminal states.
 *
 * Every status maps onto a milestone that has genuinely happened by then —
 * `in_review` parks on Submitted (Review 1 only fires when assessment ran but
 * was gated, so nothing past Submitted is real yet), `confirmed`/`quoted`
 * share `submitted`/`recommended`'s position, and `approved` (Review 2's
 * verbs resolve straight to `policy_issued` today, but the mapping stays
 * honest if that ever changes) shares `plan_selected`'s.
 */
export function journeyStep(status: ApplicationStatus): number | null {
  if (status === "draft" || TERMINAL.includes(status)) return null;
  const normalised =
    status === "confirmed"
      ? "submitted"
      : status === "in_review"
        ? "submitted"
        : status === "quoted"
          ? "recommended"
          : status === "approved"
            ? "plan_selected"
            : status;
  const i = APPLICATION_JOURNEY.indexOf(normalised as (typeof APPLICATION_JOURNEY)[number]);
  return i === -1 ? null : i;
}

export function journeyProgress(status: ApplicationStatus): number {
  const step = journeyStep(status);
  if (step === null) return status === "draft" ? 0 : 100;
  return Math.round(((step + 1) / APPLICATION_JOURNEY.length) * 100);
}

/** True only at Review 1 — the record itself is gated, before anything downstream can run. */
export function isWithAdvisor(status: ApplicationStatus): boolean {
  return status === "in_review";
}

/** What the applicant is waiting on, in their own register. */
export const applicationStatusHint: Record<ApplicationStatus, string> = {
  draft: "Not sent yet — pick up where you left off whenever you like.",
  in_intake: "We have some of your details. Finish up and we will take it from there.",
  submitted: "Received. We are reading through your details now.",
  confirmed: "Your details are confirmed and we are matching plans.",
  assessed: "We have looked at your health and cover needs.",
  quoted: "We have priced all three plans for you.",
  recommended: "We've picked a plan for you — have a look and choose.",
  in_review: "An advisor is reviewing this personally. No action needed from you.",
  approved: "Approved. Your policy is being issued.",
  plan_selected: "An advisor is signing off your choice.",
  policy_issued: "Your cover is active.",
  withdrawn: "This application was withdrawn.",
  // The advisor's own message to them sits directly below this on the page —
  // saying "we could not offer cover" here as well delivers the bad news twice
  // and leaves the specific, useful version looking like a repeat.
  declined: "An advisor has closed this application. Their note is below.",
  expired: "This application expired before it was completed.",
};

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export const conversationStatusLabel: Record<ConversationStatus, string> = {
  active: "In progress",
  awaiting_user: "Waiting on you",
  awaiting_review: "With an advisor",
  escalated: "Escalated",
  completed: "Sent to an advisor",
  abandoned: "Abandoned",
  expired: "Expired",
};

export const conversationStatusTone: Record<ConversationStatus, Tone> = {
  active: "info",
  awaiting_user: "warning",
  awaiting_review: "info",
  escalated: "warning",
  completed: "success",
  abandoned: "neutral",
  expired: "neutral",
};

// ---------------------------------------------------------------------------
// Servicing
// ---------------------------------------------------------------------------

export const eventKindLabel: Record<EventKind, string> = {
  claim: "Claim",
  preauth: "Pre-authorisation",
  reimbursement: "Reimbursement",
  appeal: "Appeal",
};

export const outcomeLabel: Record<EventOutcome, string> = {
  covered: "Covered",
  denied: "Not covered",
  approved_with_limit: "Approved with a limit",
  insufficient_data: "Needs a person to look",
  upheld: "Decision stands",
  overturned: "Decision reversed",
};

export const outcomeTone: Record<EventOutcome, Tone> = {
  covered: "success",
  denied: "danger",
  approved_with_limit: "warning",
  insufficient_data: "warning",
  upheld: "neutral",
  overturned: "success",
};

/** Member register. The broker register is written per-event, not templated. */
export const reasonCodeLabel: Record<ReasonCode, string> = {
  covered: "Covered by your plan",
  policy_not_active: "Your policy was not active on this date",
  benefit_excluded: "Your plan does not include this benefit",
  waiting_period_not_elapsed: "The waiting period had not finished yet",
  provider_out_of_network: "This provider is outside your plan's network",
  sublimit_exhausted: "This benefit's yearly limit is used up",
  annual_limit_reached: "Your annual limit is used up",
  insufficient_data: "We cannot answer this from your plan terms alone",
};

// ---------------------------------------------------------------------------
// Broker-only vocabulary — never rendered in an applicant-facing view
// ---------------------------------------------------------------------------

export const flagSeverityLabel: Record<FlagSeverity, string> = {
  block: "Blocking",
  review: "Needs review",
  warn: "Worth noting",
};

export const flagSeverityTone: Record<FlagSeverity, Tone> = {
  block: "danger",
  review: "warning",
  warn: "info",
};

export const reviewStatusLabel: Record<ReviewStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
};

export const reviewStatusTone: Record<ReviewStatus, Tone> = {
  open: "warning",
  in_progress: "info",
  resolved: "success",
};

/** What an advisor did, in the broker register. */
export const reviewActionLabel: Record<ReviewAction, string> = {
  approve: "Approved",
  edit: "Edited",
  override: "Overridden",
  reject: "Rejected",
  uphold: "Upheld",
  overturn: "Overturned",
  request_info: "Asked the applicant for more",
  reply: "Replied in the thread",
  resolve: "Resolved",
  hand_off: "Handed to a colleague",
  called: "Called the member",
  approve_payment: "Approved the payment",
  mark_paid: "Marked as paid",
};

export const reviewActionTone: Record<ReviewAction, Tone> = {
  approve: "success",
  edit: "info",
  override: "info",
  reject: "danger",
  uphold: "neutral",
  overturn: "success",
  request_info: "warning",
  reply: "info",
  resolve: "success",
  hand_off: "neutral",
  called: "info",
  approve_payment: "success",
  mark_paid: "success",
};

export const recoStatusLabel: Record<RecoStatus, string> = {
  pending_review: "Pending review",
  approved: "Approved",
  edited: "Edited by advisor",
  overridden: "Overridden by advisor",
  superseded: "Superseded",
};

export const recoStatusTone: Record<RecoStatus, Tone> = {
  pending_review: "warning",
  approved: "success",
  edited: "info",
  overridden: "info",
  superseded: "neutral",
};

/** Cohort slugs are free text in the schema; title-case whatever arrives. */
export const cohortLabel = (cohort: string): string =>
  cohort.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

// Member-language names for the engine's vocabulary live next to the engine; re-exported so a
// surface imports its labels from one place.
export { benefitClassLabel, providerTypeLabel } from "@/lib/servicing/labels";

/** How sure the system was, as a band. Broker-only vocabulary. */
export function confidenceBand(value: number | null): ConfidenceLevel | null {
  if (value == null) return null;
  if (value >= 0.9) return "high";
  if (value >= 0.6) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const aed = new Intl.NumberFormat("en-AE", {
  style: "currency",
  currency: "AED",
  maximumFractionDigits: 0,
});

export const money = (value: number | null | undefined): string =>
  value == null ? "—" : aed.format(value);

export const percent = (value: number | null | undefined): string =>
  value == null ? "—" : `${value}%`;

/**
 * A policy month as a member would place it: "Month 8 · September 2026". Members do not think in
 * months since inception, so the calendar date always travels with the number.
 */
export const monthWithDate = (inceptionDate: string, month: number): string =>
  `Month ${month} · ${monthYear(policyMonthStart(inceptionDate, month))}`;

export const monthsLabel = (months: number | null | undefined): string =>
  months == null ? "—" : months === 0 ? "No wait" : `${months} month${months === 1 ? "" : "s"}`;

export const dateLabel = (value: Date | string | null | undefined): string => {
  if (value == null) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(d);
};

// ---------------------------------------------------------------------------
// Engine prose, made readable
// ---------------------------------------------------------------------------
//
// Three kinds of string reach the queue and the record from inside the system,
// and all three used to render as if a person had written them for a reader:
//
//   1. A rule-prefixed note   "duplicate_open_application: Nine open …"
//   2. An internal failure    "tool-call budget exhausted with no shortlist …"
//   3. A *negative* note      "No uncertainty — plan_c is the only plan …"
//
// (3) is the one that actually misleads: rendered under a heading like "why
// this needs you", a sentence that says nothing is wrong reads as though
// something is. So the parsing below does not just tidy text — it reports what
// KIND of note this is, and the caller decides how loudly to say it.

/** An engine note, split into the parts a UI wants to render separately. */
export type EngineNote = {
  /** The rule that produced it, when the note named one. Render as a chip. */
  code: string | null;
  /** The prose, without its code prefix, sentence-cased. */
  text: string;
  /**
   * `concern` — a real reason a human is needed.
   * `reassurance` — the system saying it found nothing troubling. Never render
   *   this under a "needs your attention" heading.
   * `failure` — the system did not finish. The advisor is unblocking a
   *   machine, not exercising judgement, and the wording should say so.
   */
  kind: "concern" | "reassurance" | "failure";
};

/** `some_rule_code: the rest` — the prefix the graph nodes write. */
const CODE_PREFIX = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*[:—-]\s*([\s\S]+)$/;

/** Openers that mean "nothing here", in the several ways the models phrase it. */
const REASSURANCE = /^no\s+(material|significant|real|particular)?\s*uncertainty\b|^no\s+uncertainty\b|^nothing\s+(here|in this)\b/i;

/**
 * Strings that were never addressed to a reader, and what to say instead. The
 * raw text stays available to the caller — an advisor debugging a stuck record
 * wants it — but it is not what the row leads with.
 *
 * Each entry states its own kind, because "the model could not be reached" and
 * "the rules placed this without a model" read almost identically and mean
 * opposite things: one is a machine to unblock, the other is the system
 * working exactly as designed.
 */
const REWRITES: { match: RegExp; text: string; kind: EngineNote["kind"] }[] = [
  {
    match: /tool[- ]call budget exhausted/i,
    text: "The system ran out of steps before it could propose a shortlist. Nothing is wrong with the record — it needs re-running or deciding by hand.",
    kind: "failure",
  },
  {
    match: /model call failed|rate limit exceeded|free-models-per-day/i,
    text: "The model could not be reached while this was being worked out. The record is intact; the recommendation step did not complete.",
    kind: "failure",
  },
  {
    match: /rejected twice|invalid option: expected one of/i,
    text: "The system could not read one of its own tool results and gave up on that step. This needs a human decision rather than a retry.",
    kind: "failure",
  },
  {
    match: /scoring could not be completed/i,
    text: "Scoring did not complete, so the ranking below came from plan terms alone rather than from the weighted comparison.",
    kind: "failure",
  },
  {
    match: /no model judgement was applied/i,
    text: "Placed by the rules alone — no model judgement was involved.",
    kind: "reassurance",
  },
];

const sentenceCase = (text: string): string =>
  text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);

/**
 * Read one engine-authored string into something a queue row can render.
 *
 * Deliberately conservative: prose the system wrote for a reader is passed
 * through untouched apart from its code prefix. The only strings this rewrites
 * are the ones that were never addressed to anybody.
 */
export function engineNote(raw: string | null | undefined): EngineNote | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  const prefixed = CODE_PREFIX.exec(trimmed);
  const code = prefixed?.[1] ?? null;
  const body = (prefixed?.[2] ?? trimmed).trim();

  const rewrite = REWRITES.find((r) => r.match.test(body));
  if (rewrite) return { code, text: rewrite.text, kind: rewrite.kind };

  return {
    code,
    text: sentenceCase(body),
    kind: REASSURANCE.test(body) ? "reassurance" : "concern",
  };
}

/**
 * Do these two engine strings say the same thing?
 *
 * A review task's `reason` and the decision's `uncertaintyReason` are written
 * by the same pass and are frequently identical, so a row that renders both
 * stutters. Compared on their parsed text, because one of them usually
 * carries a rule-code prefix the other does not, and on a prefix match,
 * because one is often the other truncated.
 */
export function sameNote(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = engineNote(a)?.text.replace(/\s+/g, " ").toLowerCase();
  const right = engineNote(b)?.text.replace(/\s+/g, " ").toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;

  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.length >= 40 && longer.startsWith(shorter.slice(0, Math.min(shorter.length, 80)));
}
