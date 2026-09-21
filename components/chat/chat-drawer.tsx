"use client";

import { ArrowUpRightIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

/**
 * The shell the intercepted chat routes render into.
 *
 * Closing goes back rather than setting state: the drawer's existence IS a
 * history entry (it is an intercepted route), so `router.back()` is what
 * actually dismisses it, and the browser's own back gesture then does the
 * same thing. A local `open` flag would leave the URL pointing at a drawer
 * nobody can see.
 */
export function ChatDrawer({
  title,
  description,
  fullHref,
  children,
}: {
  title: string;
  description?: string;
  /** The same content as its own page — a drawer should never be a dead end. */
  fullHref?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();

  return (
    <Sheet open onOpenChange={(open) => { if (!open) router.back(); }}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
        aria-describedby={description ? undefined : ""}
      >
        {/* pe-12 keeps the header clear of the sheet's own close button,
            which is absolutely positioned at top-right. */}
        <SheetHeader className="shrink-0 gap-1 border-b px-4 pt-4 pb-3 pe-12">
          <div className="flex items-start justify-between gap-3">
            <SheetTitle>{title}</SheetTitle>
            {fullHref ? (
              <Link
                href={fullHref}
                className="flex shrink-0 items-center gap-1 rounded-md text-xs text-muted-foreground hover:text-foreground"
              >
                Full view
                <ArrowUpRightIcon className="size-3.5" />
              </Link>
            ) : null}
          </div>
          {description ? <SheetDescription className="text-pretty">{description}</SheetDescription> : null}
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col pt-3">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
