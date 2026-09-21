import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { cn } from "cn";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * The one card wrapper every panel in the console uses.
 *
 * Before this existed, each page assembled Card/CardHeader/CardTitle by hand
 * and the spacing drifted page to page — a `px-0` content here, a `space-y-4`
 * there. Everything a panel varies (title, sub-line, an action in the corner,
 * whether its content is padded or bleeds to the card edge for a list) is a
 * prop, so the rest cannot drift.
 */
export function SectionCard({
  title,
  description,
  action,
  /** A list that should sit flush against the card's edges, not inset. */
  flush = false,
  className,
  contentClassName,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  flush?: boolean;
  className?: string;
  contentClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={className}>
      <CardHeader className={action ? "grid-cols-[1fr_auto] items-start gap-3" : undefined}>
        <div className="min-w-0 space-y-1">
          {/* A real heading, not a styled div: a page of panels whose titles
              are `generic` gives a screen-reader user no way to move between
              them. CardTitle keeps the typography; the h2 carries the
              semantics. */}
          <CardTitle as="h2">{title}</CardTitle>
          {description ? <CardDescription className="text-pretty">{description}</CardDescription> : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </CardHeader>
      <CardContent className={cn(flush && "px-0", contentClassName)}>{children}</CardContent>
    </Card>
  );
}

/** The "see all of them" link a panel showing a top-N slice needs. */
export function SectionLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Button
      nativeButton={false}
      size="xs"
      variant="ghost"
      className="text-muted-foreground"
      render={
        <Link href={href}>
          {children}
          <ArrowRightIcon />
        </Link>
      }
    />
  );
}
