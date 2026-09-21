import { cn } from "cn";
import { money } from "@/lib/domain";
import { Progress, ProgressIndicator, ProgressTrack } from "@/components/ui/progress";

/**
 * One consumed-against-a-cap bar. Utilization is meaningless without the term
 * it is measured against, so the cap is always shown next to the amount.
 */
export function UtilizationBar({
  label,
  used,
  cap,
  hint,
  tone = "brand",
}: {
  label: string;
  used: number;
  cap: number | null;
  hint?: string;
  tone?: "brand" | "warning";
}) {
  const pct = cap && cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  const exhausted = cap != null && cap > 0 && used >= cap;

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {money(used)}
          {cap != null ? <span className="text-muted-foreground/70"> of {money(cap)}</span> : null}
        </span>
      </div>
      <Progress value={pct} aria-label={cap != null ? `${label}: ${money(used)} of ${money(cap)} used` : `${label}: ${money(used)} used`}>
        <ProgressTrack>
          <ProgressIndicator
            className={cn(
              exhausted ? "bg-destructive" : tone === "warning" ? "bg-warning" : "bg-brand",
            )}
          />
        </ProgressTrack>
      </Progress>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
