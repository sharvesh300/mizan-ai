import { CardSkeleton, HeaderSkeleton } from "@/components/crm/skeletons";
import { PageBody } from "@/components/page-header";

export default function Loading() {
  return (
    <>
      <HeaderSkeleton />
      <PageBody className="space-y-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <CardSkeleton lines={4} />
          <CardSkeleton lines={4} />
        </div>
        <CardSkeleton lines={8} />
      </PageBody>
    </>
  );
}
