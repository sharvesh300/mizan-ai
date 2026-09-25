"use server";

import { and, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { identityVerification } from "@/db/schema";
import { getCurrentUser } from "@/lib/session";
import {
  maskEmiratesId,
  mockUserInfo,
  readPendingState,
  UAE_PASS_STATE_COOKIE,
  type UaePassPendingState,
} from "@/lib/uae-pass";

const STATE_TTL = 60 * 10;

/** Only same-origin paths; `//evil.example` is a protocol-relative URL, not a path. */
const safeReturnTo = (value: FormDataEntryValue | null): string =>
  typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";

/** Step 1 — the "Verify with UAE PASS" button. Mints a state and sends the user to the (mock) authorize screen. */
export async function startUaePassVerification(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/");

  const pending: UaePassPendingState = {
    state: crypto.randomUUID(),
    returnTo: safeReturnTo(formData.get("returnTo")),
    userId: user.id,
  };
  (await cookies()).set(UAE_PASS_STATE_COOKIE, JSON.stringify(pending), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: STATE_TTL,
  });

  redirect(`/verify/uae-pass?state=${pending.state}`);
}

/**
 * Step 2 — the callback. In the real flow UAE PASS redirects here with a code
 * we exchange for /userinfo; the mock reads the claims straight off
 * `mockUserInfo`. The Emirates ID is masked before it is written.
 */
export async function completeUaePassVerification(formData: FormData): Promise<void> {
  const pending = await readPendingState();
  const user = await getCurrentUser();
  const jar = await cookies();
  jar.delete(UAE_PASS_STATE_COOKIE);

  // A mismatched state, or a user switch mid-flow, is a request we did not start.
  if (!pending || !user || pending.state !== formData.get("state") || pending.userId !== user.id) {
    redirect("/verify/uae-pass?error=expired");
  }

  const info = await mockUserInfo(user);

  await db.run(sql`begin`);
  try {
    // One live verification per user: the new one supersedes any earlier row.
    await db
      .update(identityVerification)
      .set({ revokedAt: new Date() })
      .where(and(eq(identityVerification.userId, user.id), isNull(identityVerification.revokedAt)));
    await db.insert(identityVerification).values({
      userId: user.id,
      provider: "uae_pass",
      subject: info.uuid,
      assuranceLevel: info.userType,
      emiratesIdMasked: maskEmiratesId(info.idn),
      fullNameEn: info.fullnameEN,
      dateOfBirth: info.dob,
      mobile: info.mobile,
      email: info.email,
    });
    await db.run(sql`commit`);
  } catch (error) {
    await db.run(sql`rollback`);
    throw error;
  }

  revalidatePath("/", "layout");
  redirect(pending.returnTo);
}

/** The user backed out on the consent screen or declined on their phone. Nothing is written. */
export async function cancelUaePassVerification(): Promise<void> {
  const pending = await readPendingState();
  (await cookies()).delete(UAE_PASS_STATE_COOKIE);
  redirect(pending?.returnTo ?? "/");
}

/** Disconnect UAE PASS. Stamps the row rather than deleting it, so the history of having been verified survives. */
export async function revokeUaePassVerification(): Promise<void> {
  const user = await getCurrentUser();
  if (!user) return;

  await db
    .update(identityVerification)
    .set({ revokedAt: new Date() })
    .where(and(eq(identityVerification.userId, user.id), isNull(identityVerification.revokedAt)));

  revalidatePath("/", "layout");
}
