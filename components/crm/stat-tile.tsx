import Link from "next/link";
import { cn } from "cn";
import { StatusDot } from "@/components/status-badge";
import type { Tone } from "@/lib/domain";

/**
 * One number, on the dashboard.
 *
 * Every tile is a link. A number an advisor cannot click is a number they have
 * to go and look up somewhere else, which is how a dashboard becomes a poster
 * rather than a place to start work from. `href` is required for that reason —
 * if a figure has nowhere to go, it does not belong in this row.
 */
export function StatTile({
  label,
  value,
  hint,
  tone,
  href,
  className,
}: {
  label: string;
  value: React.ReactNode;
  /** The sub-line: what the number is of, or what it means. */
  hint?: React.ReactNode;
  /** Colours the dot only — the number itself stays foreground-coloured so a row of tiles is readable. */
  tone?: Tone;
  href: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group flex flex-col justify-between gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10 transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        className,
      )}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {tone ? <StatusDot tone={tone} /> : null}
        {label}
      </span>
      <span className="space-y-0.5">
        <span className="block text-2xl leading-none font-semibold tabular-nums">{value}</span>
        {hint ? <span className="block text-xs text-muted-foreground text-pretty">{hint}</span> : null}
      </span>
    </Link>
  );
}

/** The dashboard's top row. Wraps to two columns on a phone, five on a desktop. */
export function StatRow({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{children}</div>;
}
