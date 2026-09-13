import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Consistent page chrome: optional back link, title, description, actions. */
export function PageHeader({
  title,
  description,
  backHref,
  backLabel = "Back",
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  backHref?: string;
  backLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b px-4 py-5 sm:px-6 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0 space-y-1">
        {backHref ? (
          <Button
            nativeButton={false}
            variant="ghost"
            size="xs"
            className="-ml-1.5 mb-1 text-muted-foreground"
            render={
              <Link href={backHref}>
                <ChevronLeftIcon />
                {backLabel}
              </Link>
            }
          />
        ) : null}
        <h1 className="text-xl font-semibold tracking-tight text-balance">{title}</h1>
        {description ? (
          <p className="max-w-2xl text-sm text-muted-foreground text-pretty">{description}</p>
        ) : null}
      </div>
      {children ? <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

/** Standard body padding for a page under a PageHeader. */
export function PageBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={`px-4 py-6 sm:px-6 ${className ?? ""}`}>{children}</div>;
}
