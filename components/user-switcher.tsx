"use client";

import { useTransition } from "react";
import { switchUser } from "@/app/actions";
import type { SessionUser } from "@/lib/session";

type SwitcherUser = Pick<SessionUser, "id" | "fullName" | "role">;

export function UserSwitcher({
  users,
  currentUserId,
}: {
  users: SwitcherUser[];
  currentUserId: string;
}) {
  const [pending, startTransition] = useTransition();

  const applicants = users.filter((user) => user.role === "applicant");
  const advisors = users.filter((user) => user.role === "advisor");

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-zinc-500 dark:text-zinc-400">Acting as</span>
      <select
        aria-label="Active user"
        value={currentUserId}
        disabled={pending}
        onChange={(event) => {
          const userId = event.target.value;
          startTransition(() => switchUser(userId));
        }}
        className="rounded-md border border-black/10 bg-white px-2 py-1 font-medium text-zinc-900 disabled:opacity-50 dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-50"
      >
        <optgroup label="Applicants">
          {applicants.map((user) => (
            <option key={user.id} value={user.id}>
              {user.fullName}
            </option>
          ))}
        </optgroup>
        <optgroup label="Advisors">
          {advisors.map((user) => (
            <option key={user.id} value={user.id}>
              {user.fullName}
            </option>
          ))}
        </optgroup>
      </select>
    </label>
  );
}
