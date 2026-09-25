// UAE PASS identity verification — MOCKED for the MVP.
//
// The real integration is an OAuth 2.0 authorization-code flow against
// https://id.uaepass.ae: redirect to /authorize with a `state`, the user
// approves on the UAE PASS phone app, UAE PASS redirects back with a `code`,
// and the server swaps it for a token and reads /userinfo. This module stands
// in for the provider side of that exchange: `mockUserInfo` returns the claims
// /userinfo would, derived deterministically from what we already hold about
// the account holder, so the same user always gets the same Emirates ID.
//
// Everything downstream — the table, the badges, the prefill — reads the
// stored claims, so replacing this file with a real client is the whole swap.

import "server-only";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "@/db/client";
import { identityVerification, person, type UaePassAssurance } from "@/db/schema";
import type { SessionUser } from "@/lib/session";

export type UaePassVerification = typeof identityVerification.$inferSelect;

/** The subset of UAE PASS /userinfo claims we keep. Names follow the real response. */
export type UaePassUserInfo = {
  uuid: string;
  userType: UaePassAssurance;
  idn: string; // Emirates ID, unmasked — never stored as-is
  fullnameEN: string;
  dob: string | null;
  mobile: string | null;
  email: string;
};

/** The scopes we ask the user to release, as the consent screen lists them. */
export const UAE_PASS_SCOPES = [
  { claim: "fullnameEN", label: "Full name (English)" },
  { claim: "idn", label: "Emirates ID number" },
  { claim: "dob", label: "Date of birth" },
  { claim: "mobile", label: "Mobile number" },
  { claim: "email", label: "Email address" },
] as const;

export const assuranceLabel: Record<UaePassAssurance, string> = {
  SOP1: "Basic account",
  SOP2: "Verified account",
  SOP3: "Verified in person",
};

// ---------------------------------------------------------------------------
// The OAuth `state` round-trip

/**
 * Kept in an HttpOnly cookie for ten minutes. It carries where to send the
 * user afterwards, and it is what stops a stale or forged callback from
 * writing a verification — the same job `state` does against the real UAE
 * PASS /authorize endpoint.
 */
export const UAE_PASS_STATE_COOKIE = "mizan_uaepass_state";

export type UaePassPendingState = { state: string; returnTo: string; userId: string };

export async function readPendingState(): Promise<UaePassPendingState | null> {
  const raw = (await cookies()).get(UAE_PASS_STATE_COOKIE)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UaePassPendingState;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mock provider

/** FNV-1a — small, stable, and enough to make the mock deterministic per user. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (const ch of input) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Luhn check digit, which is what the last digit of a real Emirates ID is. */
function luhnDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

/** `784-YYYY-NNNNNNN-C`: country code, birth year, a serial, a check digit. */
function mockEmiratesId(userId: string, dob: string | null): string {
  const year = dob?.slice(0, 4) ?? String(1970 + (hash(`${userId}:year`) % 35));
  const serial = String(hash(`${userId}:idn`) % 10_000_000).padStart(7, "0");
  return `784-${year}-${serial}-${luhnDigit(`784${year}${serial}`)}`;
}

/** Keep the last five digits and the check digit; nothing else leaves the provider. */
export function maskEmiratesId(idn: string): string {
  const [country, , serial, check] = idn.split("-");
  return `${country}-••••-••${serial.slice(-5)}-${check}`;
}

/**
 * What UAE PASS /userinfo would return for this account holder.
 *
 * The date of birth comes from their own person record when there is one — a
 * real verification would agree with it, and the prefill downstream relies on
 * it — and the account is always SOP3, because a sandbox has no weaker path.
 */
export async function mockUserInfo(user: SessionUser): Promise<UaePassUserInfo> {
  const [self] = await db
    .select({ dateOfBirth: person.dateOfBirth })
    .from(person)
    .where(and(eq(person.ownerUserId, user.id), eq(person.relationshipToOwner, "self")))
    .limit(1);
  const dob = self?.dateOfBirth ?? null;

  return {
    uuid: `sbx-${hash(`${user.id}:uuid`).toString(16).padStart(8, "0")}-${hash(user.email).toString(16).padStart(8, "0")}`,
    userType: "SOP3",
    idn: mockEmiratesId(user.id, dob),
    fullnameEN: user.fullName,
    dob,
    mobile: user.phone,
    email: user.email,
  };
}

/** Whole years between a `YYYY-MM-DD` birth date and today — what the intake form prefills. */
export function ageFromDob(dob: string, today = new Date()): number {
  const [y, m, d] = dob.split("-").map(Number);
  const hadBirthday = today.getMonth() + 1 > m || (today.getMonth() + 1 === m && today.getDate() >= d);
  return today.getFullYear() - y - (hadBirthday ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Reads

/** The user's current verification: newest un-revoked row, rowid breaking a same-second tie. */
export async function getVerification(userId: string): Promise<UaePassVerification | null> {
  const [row] = await db
    .select()
    .from(identityVerification)
    .where(and(eq(identityVerification.userId, userId), isNull(identityVerification.revokedAt)))
    .orderBy(desc(identityVerification.verifiedAt), desc(sql`rowid`))
    .limit(1);
  return row ?? null;
}

/** Current verification per user, for pages that badge several people at once. */
export async function getVerifications(userIds: string[]): Promise<Map<string, UaePassVerification>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(identityVerification)
    .where(and(inArray(identityVerification.userId, userIds), isNull(identityVerification.revokedAt)))
    .orderBy(desc(identityVerification.verifiedAt), desc(sql`rowid`));
  const out = new Map<string, UaePassVerification>();
  for (const row of rows) if (!out.has(row.userId)) out.set(row.userId, row);
  return out;
}

/** Every verification ever recorded for a user, including revoked ones — the client timeline reads this. */
export async function listVerificationHistory(userId: string): Promise<UaePassVerification[]> {
  return db
    .select()
    .from(identityVerification)
    .where(eq(identityVerification.userId, userId))
    .orderBy(desc(identityVerification.verifiedAt), desc(sql`rowid`));
}
