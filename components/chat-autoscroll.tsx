"use client";

import { useEffect, useRef } from "react";

/** Keeps the newest message in view after every server render of the thread. */
export function ChatAutoscroll({ dep }: { dep: string | number }) {
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    anchor.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [dep]);
  return <div ref={anchor} aria-hidden className="h-px" />;
}
