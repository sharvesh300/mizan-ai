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
import { Progress, ProgressIndicator, ProgressTrack } from "@/components/ui/progress";

/**
 * Where an application has got to. Shown to both audiences — an applicant needs
 * to know what is happening to their application, and it is the first thing an
 * advisor reads off the pipeline.
 */
export function ApplicationJourney({
  status,
  audience = "customer",
}: {
  status: ApplicationStatus;
  audience?: "customer" | "broker";
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

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-medium">{applicationStatusLabel[status]}</p>
          <p className="text-xs text-muted-foreground tabular-nums">
            Step {current + 1} of {APPLICATION_JOURNEY.length}
          </p>
        </div>
        <Progress value={journeyProgress(status)}>
          <ProgressTrack>
            <ProgressIndicator />
          </ProgressTrack>
        </Progress>
      </div>

      {audience === "customer" ? (
        <p className="text-sm text-muted-foreground text-pretty">{applicationStatusHint[status]}</p>
      ) : null}

      <ol className="grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        {APPLICATION_JOURNEY.map((step, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li key={step} className="flex items-center gap-2">
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
