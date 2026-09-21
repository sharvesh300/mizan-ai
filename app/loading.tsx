import { CardSkeleton, HeaderSkeleton, StatRowSkeleton } from "@/components/crm/skeletons";
import { PageBody } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";

/** The dashboard: tiles, the top of the queue, then two rows of panels. */
export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      <PageBody className="space-y-6">
        <StatRowSkeleton />
        <div className="space-y-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-48" />
          <div className="space-y-4 border-t pt-4">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="space-y-2">
                <Skeleton className="h-5 w-56 rounded-full" />
                <Skeleton className="h-4 w-full max-w-xl" />
                <Skeleton className="h-3 w-64" />
              </div>
            ))}
          </div>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <CardSkeleton lines={6} />
          <CardSkeleton lines={4} />
        </div>
      </PageBody>
    </>
  );
}
