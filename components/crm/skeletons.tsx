import { PageBody } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The shapes each page settles into, for its `loading.tsx`.
 *
 * Deliberately matched to the real layout rather than being generic grey
 * boxes: a skeleton whose proportions differ from what arrives makes the page
 * jump when it lands, which reads worse than a plain spinner. Each of these
 * mirrors the tile row, table or board it stands in for.
 */

function HeaderSkeleton() {
  return (
    <div className="flex flex-col gap-3 border-b px-4 py-5 sm:px-6">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-4 w-full max-w-lg" />
    </div>
  );
}

export function StatRowSkeleton({ tiles = 5 }: { tiles?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      {Array.from({ length: tiles }, (_, index) => (
        <div key={index} className="space-y-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-12" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="divide-y rounded-xl border">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-4 px-4 py-4">
          <Skeleton className="h-4 w-24" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-5 w-24 rounded-full" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  );
}

export function FilterBarSkeleton() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Skeleton className="h-9 w-full max-w-xs" />
      {[16, 20, 24, 18].map((width, index) => (
        <Skeleton key={index} className="h-7 rounded-full" style={{ width: `${width * 4}px` }} />
      ))}
    </div>
  );
}

export function CardSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={`space-y-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10 ${className ?? ""}`}>
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-3 w-full max-w-sm" />
      <div className="space-y-2 pt-1">
        {Array.from({ length: lines }, (_, index) => (
          <Skeleton key={index} className="h-3 w-full" />
        ))}
      </div>
    </div>
  );
}

/** A list page: header, tiles, filters, table. */
export function ListPageSkeleton({ tiles = 5 }: { tiles?: number }) {
  return (
    <>
      <HeaderSkeleton />
      <PageBody className="space-y-5">
        <StatRowSkeleton tiles={tiles} />
        <FilterBarSkeleton />
        <TableSkeleton />
      </PageBody>
    </>
  );
}

export { HeaderSkeleton };
