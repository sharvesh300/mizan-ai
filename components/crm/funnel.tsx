import Link from "next/link";

/**
 * Applications per stage, as bars against the busiest stage.
 *
 * Bars are scaled to the LARGEST stage, not to the total: the question a
 * broker asks of a funnel is "where is everything piling up", and a
 * percentage-of-total scale flattens exactly that — with six stages, a real
 * bottleneck holding a third of the book renders as a third of the width and
 * reads as unremarkable.
 *
 * Every stage links to the applications list filtered to it, so a pile-up is
 * one click from the records causing it.
 */
export function Funnel({
  stages,
  hrefFor,
}: {
  stages: { key: string; label: string; count: number }[];
  hrefFor: (key: string) => string;
}) {
  const peak = Math.max(1, ...stages.map((stage) => stage.count));

  return (
    <ol className="space-y-2.5">
      {stages.map((stage) => (
        <li key={stage.key}>
          <Link
            href={hrefFor(stage.key)}
            className="group block rounded-md focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate text-muted-foreground group-hover:text-foreground">{stage.label}</span>
              <span className="shrink-0 font-medium tabular-nums">{stage.count}</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-brand transition-[width]"
                style={{ width: `${Math.round((stage.count / peak) * 100)}%` }}
              />
            </div>
          </Link>
        </li>
      ))}
    </ol>
  );
}
