"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const OPTIONS = [
  { value: "light", label: "Light", Icon: SunIcon },
  { value: "dark", label: "Dark", Icon: MoonIcon },
  { value: "system", label: "System", Icon: MonitorIcon },
] as const;

// Hoisted: stable identities, and not re-created on every render.
const subscribeNever = () => () => {};
const onClient = () => true;
const onServer = () => false;

/** Declared at module scope so it keeps its identity across renders. */
function ThemeIcon({ theme }: { theme: string | undefined }) {
  switch (theme) {
    case "light":
      return <SunIcon />;
    case "dark":
      return <MoonIcon />;
    default:
      return <MonitorIcon />;
  }
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  // The stored theme is unknowable during SSR, so the server and the first
  // client render must agree on the neutral icon. useSyncExternalStore answers
  // "are we past hydration yet" without mirroring it into state from an effect.
  const mounted = React.useSyncExternalStore(subscribeNever, onClient, onServer);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label="Change theme">
            <ThemeIcon theme={mounted ? theme : undefined} />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-36">
        {OPTIONS.map(({ value, label, Icon }) => (
          <DropdownMenuItem key={value} onClick={() => setTheme(value)}>
            <Icon className="size-4" />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
