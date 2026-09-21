import { FilterBarSkeleton, HeaderSkeleton } from "@/components/crm/skeletons";
import { PageBody } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";

/** The board: six columns of cards, scrolled horizontally. */
export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      <PageBody className="space-y-5">
        <FilterBarSkeleton />
        <div className="-mx-4 overflow-hidden px-4 sm:-mx-6 sm:px-6">
          <div className="flex min-w-max gap-4">
            {Array.from({ length: 6 }, (_, column) => (
              <div key={column} className="w-72 shrink-0 space-y-3">
                <div className="flex items-center justify-between border-b pb-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3 w-8" />
                </div>
                {Array.from({ length: 3 }, (_, card) => (
                  <div key={card} className="space-y-2 rounded-lg bg-card p-3 ring-1 ring-foreground/10">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </PageBody>
    </>
  );
}
