import {
  ClipboardCheckIcon,
  FileTextIcon,
  GavelIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  StethoscopeIcon,
  TriangleAlertIcon,
  UserCheckIcon,
} from "lucide-react";
import Link from "next/link";
import { cn } from "cn";
import type { TimelineEntry } from "@/lib/queries";
import type { Tone } from "@/lib/domain";

/**
 * How each kind of event reads: an icon and a tone.
 *
 * A timeline where every entry looks the same is a log. The point of this one
 * is that a broker scanning it before a call can tell a flag from a decision
 * from a claim without reading a word of it — so the two entries that carry
 * human judgement (a decision) or a problem (a flag) are the two that are
 * coloured, and the routine machinery is grey.
 */
const KIND: Record<TimelineEntry["kind"], { icon: typeof FileTextIcon; tone: Tone; label: string }> = {
  application: { icon: FileTextIcon, tone: "neutral", label: "Application" },
  assessment: { icon: ClipboardCheckIcon, tone: "neutral", label: "Classification" },
  flag: { icon: TriangleAlertIcon, tone: "warning", label: "Flag" },
  recommendation: { icon: UserCheckIcon, tone: "info", label: "Recommendation" },
  decision: { icon: GavelIcon, tone: "brand", label: "Decision" },
  policy: { icon: ShieldCheckIcon, tone: "success", label: "Policy" },
  servicing: { icon: StethoscopeIcon, tone: "info", label: "Servicing" },
  reassessment: { icon: RefreshCwIcon, tone: "info", label: "Reassessment" },
};

const TONE_RING: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  brand: "bg-brand-subtle text-brand",
  success: "bg-success-subtle text-success",
  warning: "bg-warning-subtle text-warning",
  info: "bg-info-subtle text-info",
  danger: "bg-destructive-subtle text-destructive",
};

const dayLabel = (date: Date) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(date);
const timeLabel = (date: Date) =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(date);

/**
 * Everything that has happened to one client, grouped by day.
 *
 * Grouping matters more than it looks: intake, classification, flags and a
 * recommendation are usually written within the same second by the same pass,
 * and a flat list renders that burst as eight entries with eight timestamps.
 * Under one date heading it reads as what it is — one day's work.
 */
export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing has happened on this record yet.</p>;
  }

  const days = new Map<string, TimelineEntry[]>();
  for (const entry of entries) {
    const key = dayLabel(entry.at);
    const bucket = days.get(key);
    if (bucket) bucket.push(entry);
    else days.set(key, [entry]);
  }

  return (
    <div className="space-y-6">
      {[...days].map(([day, rows]) => (
        <section key={day}>
          <h3 className="mb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">{day}</h3>
          <ol className="space-y-0">
            {rows.map((entry, index) => (
              <TimelineRow key={`${day}-${index}`} entry={entry} last={index === rows.length - 1} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function TimelineRow({ entry, last }: { entry: TimelineEntry; last: boolean }) {
  const kind = KIND[entry.kind];
  const Icon = kind.icon;

  const body = (
    <>
      <p className="text-sm font-medium first-letter:uppercase">{entry.title}</p>
      {entry.detail ? (
        <p className="mt-0.5 text-sm text-muted-foreground text-pretty">{entry.detail}</p>
      ) : null}
      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span>{kind.label}</span>
        <span aria-hidden>·</span>
        <span>{timeLabel(entry.at)}</span>
        <span aria-hidden>·</span>
        {/* The brief asks that every action record who took it; "the system"
            is an answer, not a blank. */}
        <span>{entry.actor ?? "system"}</span>
        {entry.code ? (
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem]">{entry.code}</code>
        ) : null}
      </p>
    </>
  );

  return (
    <li className="relative flex gap-3 pb-5 last:pb-0">
      {!last ? (
        <span aria-hidden className="absolute top-8 left-[0.9375rem] h-[calc(100%-2rem)] w-px bg-border" />
      ) : null}
      <span className={cn("z-10 flex size-8 shrink-0 items-center justify-center rounded-full", TONE_RING[kind.tone])}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 pt-1">
        {entry.href ? (
          <Link href={entry.href} className="block rounded-md hover:underline focus-visible:outline-none">
            {body}
          </Link>
        ) : (
          body
        )}
      </div>
    </li>
  );
}
