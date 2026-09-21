import { HeaderSkeleton } from "@/components/crm/skeletons";
import { PageBody } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      <PageBody className="space-y-6">
        {Array.from({ length: 2 }, (_, group) => (
          <div key={group} className="space-y-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-full max-w-lg" />
            <div className="space-y-5 border-t pt-4">
              {Array.from({ length: 3 }, (_, row) => (
                <div key={row} className="space-y-2">
                  <Skeleton className="h-5 w-64 rounded-full" />
                  <Skeleton className="h-4 w-full max-w-2xl" />
                  <Skeleton className="h-3 w-72" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </PageBody>
    </>
  );
}
