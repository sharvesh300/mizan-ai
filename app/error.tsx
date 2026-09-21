"use client";

import { RotateCcwIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

/**
 * The fallback when a page throws.
 *
 * It renders inside the app shell, so the sidebar and the user switcher stay
 * usable — whatever broke, the rest of the console did not, and dropping
 * someone onto a bare error page makes a single failed query look like the
 * whole product falling over.
 *
 * `digest` is shown because these are server errors: the message itself is
 * redacted in production, and the digest is the only thing that ties what the
 * person saw to what the server logged.
 */
export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="px-4 py-16 sm:px-6">
      <Empty className="mx-auto max-w-lg rounded-xl border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TriangleAlertIcon className="text-warning" />
          </EmptyMedia>
          <EmptyTitle>This page didn&apos;t load</EmptyTitle>
          <EmptyDescription className="text-pretty">
            Something went wrong reading this record. Nothing has been changed — trying again is safe.
            {error.digest ? (
              <>
                {" "}
                Reference <code className="font-mono text-xs">{error.digest}</code>.
              </>
            ) : null}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={() => retry()}>
            <RotateCcwIcon />
            Try again
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}
