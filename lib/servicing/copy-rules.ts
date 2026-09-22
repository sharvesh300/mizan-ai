// The rules for anything a member can read — as executable checks.
//
// One definition, used three places: the seed check scans every string the seed
// writes, the `propose_outcome` tool refuses an explanation that breaks them, and
// the card gallery is scanned against them. They were a private list inside the
// check script; a tool that has to enforce them at runtime needs them importable.
//
// The brief: classification vocabulary is an operational tool for routing, not
// language to put in front of the person it describes.

/** Internal vocabulary a member must never read: classification, workflow, raw enum tokens. */
export const MEMBER_BANNED: RegExp[] = [
  /\bcohort\b/i,
  /\brisk\b/i,
  /\bflag/i,
  /review task/i,
  /\bpriority\b/i,
  /\bconfidence\b/i,
  /\boverrid/i,
  /\breviewer\b/i,
  /\bescalat/i,
  /insufficient_data|waiting_period_not_elapsed|provider_out_of_network|sublimit_exhausted|annual_limit_reached|benefit_excluded|policy_not_active/,
  /chronic_preexisting|top_tier_private_hospital|premium_private_hospital|private_hospital|general_hospital|in_network_clinic|unknown_foreign/,
];

/** The system has no SLA, so no string may state one. */
export const TIME_PROMISES: RegExp[] = [/\bwithin\b/i, /\bhours?\b/i, /\bshortly\b/i, /\busually\b/i, /\bby tomorrow\b/i, /\bsoon\b/i];

/** A policy, claim, appeal or pre-authorization reference — for the broker, never the member. */
export const INTERNAL_REF = /\b(POL|CLM|APP|PRE)-[A-Z0-9]+\b/;

const matches = (text: string, patterns: RegExp[]) => patterns.filter((p) => p.test(text)).map((p) => String(p));

/** Every rule a string breaks, by name. Empty means it is fit for a member to read. */
export function memberCopyViolations(text: string): string[] {
  return [
    ...matches(text, MEMBER_BANNED).map((m) => `internal vocabulary ${m}`),
    ...matches(text, TIME_PROMISES).map((m) => `time promise ${m}`),
    ...(INTERNAL_REF.test(text) ? ["internal reference"] : []),
  ];
}
