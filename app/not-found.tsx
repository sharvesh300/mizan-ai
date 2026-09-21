import { CompassIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { getCurrentUser } from "@/lib/session";

/**
 * Not found, inside the shell.
 *
 * This fires more often for a reason than for a typo: every broker-only route
 * calls `notFound()` when an applicant reaches it, which is how the two
 * audiences are kept apart. So the copy has to work for someone who followed a
 * legitimate link into a page that is not theirs, without naming the pages
 * they cannot see — and the way back is their own home, not a 404 dead end.
 */
export default async function NotFound() {
  const user = await getCurrentUser();

  return (
    <div className="px-4 py-16 sm:px-6">
      <Empty className="mx-auto max-w-lg rounded-xl border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CompassIcon />
          </EmptyMedia>
          <EmptyTitle>There&apos;s nothing here</EmptyTitle>
          <EmptyDescription className="text-pretty">
            {user?.role === "advisor"
              ? "This page doesn't exist, or the record it pointed at has been removed."
              : "This page doesn't exist, or it isn't part of your account."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button nativeButton={false} render={<Link href="/">Back to your overview</Link>} />
        </EmptyContent>
      </Empty>
    </div>
  );
}
