"use client";

import {
  FileTextIcon,
  InboxIcon,
  LayersIcon,
  LayoutDashboardIcon,
  PlusIcon,
  ScaleIcon,
  ShieldCheckIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import type { UserRole } from "@/db/schema";
import type { SessionUser } from "@/lib/session";
import { UserSwitcher } from "@/components/user-switcher";

/**
 * The console's navigation, grouped by when an advisor uses it rather than by
 * what kind of object each page holds. "Today" is the two pages they open at
 * the start of a shift; "Records" is everything they go looking for.
 *
 * Groups exist because a flat four-item list stops reading as a structure the
 * moment a fifth and sixth item arrive (Clients and Pipeline, next phases).
 */
type NavGroup = { label: string; items: { href: string; label: string; icon: typeof FileTextIcon }[] };

const NAV: Record<UserRole, NavGroup[]> = {
  applicant: [
    {
      label: "Menu",
      items: [
        { href: "/", label: "Overview", icon: LayoutDashboardIcon },
        { href: "/applications", label: "My applications", icon: FileTextIcon },
        { href: "/policies", label: "My cover", icon: ShieldCheckIcon },
      ],
    },
  ],
  advisor: [
    {
      label: "Today",
      items: [
        { href: "/", label: "Dashboard", icon: LayoutDashboardIcon },
        { href: "/queue", label: "Review queue", icon: InboxIcon },
        { href: "/pipeline", label: "Pipeline", icon: LayersIcon },
      ],
    },
    {
      label: "Records",
      items: [
        { href: "/clients", label: "Clients", icon: UsersIcon },
        { href: "/applications", label: "Applications", icon: FileTextIcon },
        { href: "/policies", label: "Policies", icon: ShieldCheckIcon },
      ],
    },
  ],
};

export function AppSidebar({
  user,
  users,
}: {
  user: SessionUser;
  users: Pick<SessionUser, "id" | "fullName" | "role">[];
}) {
  const pathname = usePathname();
  const groups = NAV[user.role];

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-1 py-1.5">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand text-brand-foreground">
            <ScaleIcon className="size-4" />
          </div>
          <div className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
            <span className="truncate text-sm font-semibold">Mizan AI</span>
            <span className="truncate text-xs text-muted-foreground">
              {user.role === "advisor" ? "Advisor console" : "Health cover"}
            </span>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {user.role === "applicant" ? (
          <SidebarGroup>
            <SidebarGroupContent>
              <Button
                nativeButton={false}
                size="sm"
                className="w-full justify-start group-data-[collapsible=icon]:justify-center"
                render={
                  <Link href="/applications/new">
                    <PlusIcon />
                    <span className="group-data-[collapsible=icon]:hidden">New application</span>
                  </Link>
                }
              />
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}

        {groups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      isActive={isActive(item.href)}
                      tooltip={item.label}
                      render={
                        <Link href={item.href}>
                          <item.icon />
                          <span>{item.label}</span>
                        </Link>
                      }
                    />
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <UserSwitcher users={users} currentUserId={user.id} />
      </SidebarFooter>
    </Sidebar>
  );
}
