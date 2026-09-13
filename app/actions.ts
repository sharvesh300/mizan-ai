"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { db } from "@/db/client";
import { appUser } from "@/db/schema";
import { USER_COOKIE } from "@/lib/session";

const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * Switch the active user (MVP stand-in for signing in). Validates the id
 * against app_user, writes the cookie, and re-renders every route so server
 * components pick up the new actor.
 */
export async function switchUser(userId: string): Promise<void> {
  const [user] = await db
    .select({ id: appUser.id })
    .from(appUser)
    .where(eq(appUser.id, userId))
    .limit(1);

  if (!user) return;

  (await cookies()).set(USER_COOKIE, user.id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: ONE_YEAR,
  });

  revalidatePath("/", "layout");
}
