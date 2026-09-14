// The domain's display vocabulary, in one place.
//
// Every status, outcome, reason code and flag severity in the schema needs two
// things at the surface: a human label and a tone. Keeping both here means a
// status never gets a different colour on one screen than another, and the
// tone names line up with the semantic tokens registered in app/globals.css.

import type {
  ApplicationStatus,
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

/** The happy path, in order. Drives the progress stepper. */
export const APPLICATION_JOURNEY = [
  "in_intake",
  "submitted",
  "assessed",
  "quoted",
  "recommended",
  "in_review",
  "approved",
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
  quoted: "Quoted",
  recommended: "Recommended",
  in_review: "With an advisor",
  approved: "Approved",
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
  quoted: "info",
  recommended: "brand",
  in_review: "warning",
  approved: "success",
  policy_issued: "success",
  withdrawn: "neutral",
  declined: "danger",
  expired: "neutral",
};

/** 0-based index into APPLICATION_JOURNEY, or null for draft/terminal states. */
export function journeyStep(status: ApplicationStatus): number | null {
  if (status === "draft" || TERMINAL.includes(status)) return null;
  // `confirmed` is a sub-step of `submitted` and shares its position.
  const normalised = status === "confirmed" ? "submitted" : status;
  const i = APPLICATION_JOURNEY.indexOf(normalised as (typeof APPLICATION_JOURNEY)[number]);
  return i === -1 ? null : i;
}

export function journeyProgress(status: ApplicationStatus): number {
  const step = journeyStep(status);
  if (step === null) return status === "draft" ? 0 : 100;
  return Math.round(((step + 1) / APPLICATION_JOURNEY.length) * 100);
}

/** What the applicant is waiting on, in their own register. */
export const applicationStatusHint: Record<ApplicationStatus, string> = {
  draft: "Not sent yet — pick up where you left off whenever you like.",
  in_intake: "We have some of your details. Finish up and we will take it from there.",
  submitted: "Received. We are reading through your details now.",
  confirmed: "Your details are confirmed and we are matching plans.",
  assessed: "We have looked at your health and cover needs.",
  quoted: "We have priced all three plans for you.",
  recommended: "We have picked a plan for you — an advisor is checking it over.",
  in_review: "An advisor is reviewing this personally. No action needed from you.",
  approved: "Approved. Your policy is being issued.",
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
};

export const reviewActionTone: Record<ReviewAction, Tone> = {
  approve: "success",
  edit: "info",
  override: "info",
  reject: "danger",
  uphold: "neutral",
  overturn: "success",
  request_info: "warning",
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

export const monthsLabel = (months: number | null | undefined): string =>
  months == null ? "—" : months === 0 ? "No wait" : `${months} month${months === 1 ? "" : "s"}`;

export const dateLabel = (value: Date | string | null | undefined): string => {
  if (value == null) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(d);
};
