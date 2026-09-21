import { CardSkeleton, HeaderSkeleton, StatRowSkeleton } from "@/components/crm/skeletons";
import { PageBody } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      <PageBody className="space-y-5">
        <StatRowSkeleton />
        <div className="flex gap-2">
          {[24, 20, 28, 30].map((width, index) => (
            <Skeleton key={index} className="h-9 rounded-md" style={{ width: `${width * 4}px` }} />
          ))}
        </div>
        <CardSkeleton lines={10} />
      </PageBody>
    </>
  );
}
