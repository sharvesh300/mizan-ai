import { CheckIcon } from "lucide-react";
import { cn } from "cn";
import type { ApplicationStatus } from "@/db/schema";
import {
  APPLICATION_JOURNEY,
  applicationStatusHint,
  applicationStatusLabel,
  journeyProgress,
  journeyStep,
} from "@/lib/domain";
import { StatusBadge } from "@/components/status-badge";
import { Progress, ProgressIndicator, ProgressTrack } from "@/components/ui/progress";

/**
 * Where an application has got to. Shown to both audiences — an applicant needs
 * to know what is happening to their application, and it is the first thing an
 * advisor reads off the pipeline.
 *
 * `withAdvisor` is an overlay, not a step: Review 1 (`in_review`) interrupts
 * whichever milestone is current rather than being one itself — the record
 * hasn't advanced, it's paused. Passing it separately keeps every tick in
 * `APPLICATION_JOURNEY` honest ("done" = a row was actually written).
 *
 * `orientation` only changes how the step list itself lays out — everywhere
 * this already renders (the advisor's Progress card, the dashboard cards in
 * app/page.tsx) keeps the horizontal strip by leaving it at the default.
 * `vertical` is for a narrow sidebar column, where four-across steps would
 * either wrap awkwardly or force the column too wide to sit next to content.
 */
export function ApplicationJourney({
  status,
  audience = "customer",
  withAdvisor = false,
  orientation = "horizontal",
}: {
  status: ApplicationStatus;
  audience?: "customer" | "broker";
  withAdvisor?: boolean;
  orientation?: "horizontal" | "vertical";
}) {
  const current = journeyStep(status);

  if (current === null) {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium">{applicationStatusLabel[status]}</p>
        <p className="text-sm text-muted-foreground">{applicationStatusHint[status]}</p>
      </div>
    );
  }

  const header = (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-medium">
          {applicationStatusLabel[status]}
          {withAdvisor ? <StatusBadge tone="warning">With an advisor</StatusBadge> : null}
        </p>
        <p className="text-xs text-muted-foreground tabular-nums">
          Step {current + 1} of {APPLICATION_JOURNEY.length}
        </p>
      </div>
      <Progress value={journeyProgress(status)} aria-label={`Application progress: ${applicationStatusLabel[status]}, step ${current + 1} of ${APPLICATION_JOURNEY.length}`}>
        <ProgressTrack>
          <ProgressIndicator />
        </ProgressTrack>
      </Progress>
    </div>
  );

  const hint =
    audience === "customer" ? <p className="text-sm text-muted-foreground text-pretty">{applicationStatusHint[status]}</p> : null;

  if (orientation === "vertical") {
    return (
      <div className="space-y-4">
        {header}
        {hint}
        <ol>
          {APPLICATION_JOURNEY.map((step, index) => {
            const done = index < current;
            const active = index === current;
            const last = index === APPLICATION_JOURNEY.length - 1;
            return (
              <li key={step} aria-current={active ? "step" : undefined} className="relative flex gap-3 pb-6 last:pb-0">
                {!last ? (
                  <span
                    aria-hidden
                    className={cn("absolute top-5 left-[0.5625rem] h-[calc(100%-1rem)] w-px", done ? "bg-success" : "bg-border")}
                  />
                ) : null}
                <span
                  className={cn(
                    "z-10 flex size-4.5 shrink-0 items-center justify-center rounded-full text-[0.6rem] font-semibold",
                    done && "bg-success text-success-foreground",
                    active && "bg-brand text-brand-foreground ring-3 ring-brand/25",
                    !done && !active && "bg-muted text-muted-foreground",
                  )}
                >
                  {done ? <CheckIcon className="size-2.5" strokeWidth={3} /> : index + 1}
                </span>
                <span className={cn("pt-0.5 text-sm", active ? "font-medium text-foreground" : "text-muted-foreground")}>
                  {applicationStatusLabel[step]}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {header}
      {hint}
      <ol className="grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        {APPLICATION_JOURNEY.map((step, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li key={step} aria-current={active ? "step" : undefined} className="flex items-center gap-2">
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-full text-[0.6rem] font-semibold",
                  done && "bg-success text-success-foreground",
                  active && "bg-brand text-brand-foreground ring-3 ring-brand/25",
                  !done && !active && "bg-muted text-muted-foreground",
                )}
              >
                {done ? <CheckIcon className="size-2.5" strokeWidth={3} /> : index + 1}
              </span>
              <span
                className={cn(
                  "truncate text-xs",
                  active ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {applicationStatusLabel[step]}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
