"use client";

import { CheckIcon, ChevronsUpDownIcon, ShieldCheckIcon } from "lucide-react";
import { useTransition } from "react";
import { switchUser } from "@/app/actions";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { SessionUser } from "@/lib/session";

type SwitcherUser = Pick<SessionUser, "id" | "fullName" | "role">;

const initials = (name: string) =>
  name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

/**
 * Stands in for signing in. The brief asks for a view toggle rather than real
 * accounts, so this writes an app_user id to a cookie and re-renders.
 */
export function UserSwitcher({
  users,
  currentUserId,
  verified = false,
}: {
  users: SwitcherUser[];
  currentUserId: string;
  verified?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const current = users.find((u) => u.id === currentUserId);

  const groups = [
    { label: "Applicants", items: users.filter((u) => u.role === "applicant") },
    { label: "Advisors", items: users.filter((u) => u.role === "advisor") },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            disabled={pending}
            aria-label={current ? `Signed in as ${current.fullName}` : "Select user"}
            /* min-w-0 on the trigger and the label column is what stops the
               name running under the avatar while the sidebar animates between
               its two widths; in icon mode only the avatar remains. */
            className="h-auto w-full min-w-0 justify-start gap-2 px-2 py-1.5 text-left group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
          >
            <Avatar className="size-7 shrink-0 rounded-lg">
              <AvatarFallback className="rounded-lg text-xs">
                {current ? initials(current.fullName) : "?"}
              </AvatarFallback>
            </Avatar>
            <span className="grid min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
              <span className="truncate text-sm font-medium">{current?.fullName ?? "Select user"}</span>
              <span className="flex min-w-0 items-center gap-1 text-xs font-normal text-muted-foreground">
                <span className="truncate capitalize">{current?.role}</span>
                {verified ? (
                  <>
                    <span aria-hidden>·</span>
                    <ShieldCheckIcon className="size-3 shrink-0 text-success" aria-hidden />
                    <span className="truncate">UAE PASS</span>
                  </>
                ) : null}
              </span>
            </span>
            <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground group-data-[collapsible=icon]:hidden" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" side="top" className="w-(--anchor-width) min-w-56">
        {groups.map((group, index) => (
          <DropdownMenuGroup key={group.label}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
            {group.items.map((user) => (
              <DropdownMenuItem
                key={user.id}
                onClick={() => startTransition(() => switchUser(user.id))}
              >
                <Avatar className="size-6 rounded-md">
                  <AvatarFallback className="rounded-md text-[0.6rem]">
                    {initials(user.fullName)}
                  </AvatarFallback>
                </Avatar>
                <span className="flex-1 truncate">{user.fullName}</span>
                {user.id === currentUserId ? <CheckIcon className="size-4" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
