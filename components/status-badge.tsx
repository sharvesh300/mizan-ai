import { Badge } from "@/components/ui/badge";
import { cn } from "cn";
import { type Tone, toneBadge, toneDot } from "@/lib/domain";

/**
 * One badge for every status in the product. Tone comes from lib/domain.ts,
 * colour from the semantic tokens — no component picks its own colour.
 */
export function StatusBadge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Badge variant="ghost" className={cn(toneBadge[tone], "font-medium", className)}>
      {children}
    </Badge>
  );
}

export function StatusDot({ tone = "neutral", className }: { tone?: Tone; className?: string }) {
  return <span className={cn("size-2 shrink-0 rounded-full", toneDot[tone], className)} aria-hidden />;
}
