// MVP "who am I" layer. No authentication yet — the active user is just an
// app_user id stored in a cookie, swappable from the header UserSwitcher.
// Every server component / server action reads the current actor from here,
// so the whole app is already role-aware and will keep working once a real
// auth provider replaces getCurrentUser().

import { asc } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "@/db/client";
import { appUser } from "@/db/schema";

export const USER_COOKIE = "mizan_user_id";

export type SessionUser = typeof appUser.$inferSelect;

/** All seeded users, name-sorted. The UserSwitcher groups them by role. */
export async function listUsers(): Promise<SessionUser[]> {
  return db.select().from(appUser).orderBy(asc(appUser.fullName));
}

/**
 * The active user for this request. Falls back to the first seeded user when
 * the cookie is missing or points at an unknown id, so the app is never in a
 * "logged out" state during the MVP.
 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const users = await listUsers();
  if (users.length === 0) return null;

  const id = (await cookies()).get(USER_COOKIE)?.value;
  return users.find((user) => user.id === id) ?? users[0];
}
