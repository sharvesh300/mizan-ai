// Policy-month arithmetic, in ISO dates and UTC.
//
// A policy month is a count of months elapsed since inception, from 0 (spec §4).
// The member never thinks in policy months, so anything shown to them turns one
// into a calendar date — "month 6" becomes "1 July 2026". Pure and
// timezone-free on purpose: `new Date(y, m, d)` would slide a day across a DST
// boundary or a server in another zone.

const pad = (n: number) => String(n).padStart(2, "0");

const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

function parts(iso: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) throw new RangeError(`not an ISO date: ${iso}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** `iso` plus `months` calendar months, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(iso: string, months: number): string {
  const { year, month, day } = parts(iso);
  const total = year * 12 + (month - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return `${y}-${pad(m)}-${pad(Math.min(day, daysInMonth(y, m)))}`;
}

/** The first day of a policy month. Month 0 is the inception date itself. */
export const policyMonthStart = (inceptionDate: string, policyMonth: number): string => addMonths(inceptionDate, policyMonth);

/** A waiting period of N months clears at month N (spec §4) — i.e. on the Nth monthly anniversary. */
export const waitClearsOn = (inceptionDate: string, waitMonths: number): string => addMonths(inceptionDate, waitMonths);

/** When the policy year containing `policyMonth` ends and the yearly limits start again. */
export const policyYearEndsOn = (inceptionDate: string, policyMonth: number): string =>
  addMonths(inceptionDate, 12 * (Math.floor(policyMonth / 12) + 1));

/** "1 July 2026" — the form a member reads. */
export function longDate(iso: string): string {
  const { year, month, day } = parts(iso);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
}

/** "September 2026" — for a policy month, where the day is not meaningful. */
export function monthYear(iso: string): string {
  const { year, month, day } = parts(iso);
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
}

/**
 * Whole months elapsed from inception to `iso`, from 0 — the `policy_month` the engine reads.
 *
 * A member says "last Tuesday"; the agent turns that into a DATE; this turns the date into a policy
 * month. The model never does the month arithmetic, because an off-by-one here silently moves a claim
 * across a waiting-period boundary. A date before inception has no policy month, and is an error.
 */
export function monthOfDate(inceptionDate: string, iso: string): number {
  const a = parts(inceptionDate);
  const b = parts(iso);
  const months = (b.year - a.year) * 12 + (b.month - a.month) - (b.day < a.day ? 1 : 0);
  if (months < 0) throw new RangeError(`${iso} is before the policy incepted on ${inceptionDate}`);
  return months;
}

/** True for a well-formed, real calendar date (rejects 2026-02-31). */
export function isRealDate(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}
