"use client";

import { SearchIcon, XIcon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { cn } from "cn";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

export type Segment = { value: string; label: string; count?: number };

/**
 * Search and segmented filters, held in the URL.
 *
 * State lives in the query string rather than in this component so the server
 * page stays the single reader of it: the list is filtered where the data is,
 * a filtered view can be linked to or reloaded, and the back button does what
 * it should. This component only ever writes — it is handed the current values
 * as props instead of reading them back with `useSearchParams`, which keeps it
 * out of the page's suspense boundary.
 */
export function FilterBar({
  segments,
  active,
  paramKey = "filter",
  query = "",
  queryKey = "q",
  placeholder = "Search",
}: {
  segments: Segment[];
  active: string;
  paramKey?: string;
  query?: string;
  queryKey?: string;
  placeholder?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState(query);

  // Keep the box in step when the URL changes from somewhere else — a cleared
  // filter, a back button — without fighting the person while they type. This
  // is the adjust-state-during-render pattern rather than an effect: React
  // restarts the render before committing, so no cascading pass is scheduled.
  const [lastQuery, setLastQuery] = useState(query);
  if (query !== lastQuery) {
    setLastQuery(query);
    setDraft(query);
  }

  const push = (nextSegment: string, nextQuery: string) => {
    const params = new URLSearchParams();
    if (nextSegment && nextSegment !== "all") params.set(paramKey, nextSegment);
    if (nextQuery.trim()) params.set(queryKey, nextQuery.trim());
    const search = params.toString();
    startTransition(() => router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false }));
  };

  // Debounced: a keystroke per round trip makes the list flicker and the
  // server work for input nobody has finished typing.
  useEffect(() => {
    if (draft === query) return;
    const timer = setTimeout(() => push(active, draft), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative min-w-0 flex-1 sm:max-w-xs">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="pl-8"
        />
        {draft ? (
          <button
            type="button"
            onClick={() => setDraft("")}
            aria-label="Clear search"
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {segments.map((segment) => {
          const selected = segment.value === active;
          return (
            <button
              key={segment.value}
              type="button"
              onClick={() => push(segment.value, draft)}
              aria-pressed={selected}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                selected
                  ? "bg-brand text-brand-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground",
              )}
            >
              {segment.label}
              {segment.count != null ? (
                <span className={cn("tabular-nums", selected ? "opacity-80" : "opacity-60")}>{segment.count}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {pending ? <Spinner className="size-4 text-muted-foreground" /> : null}
    </div>
  );
}
