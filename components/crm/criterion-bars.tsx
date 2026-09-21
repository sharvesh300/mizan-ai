import { ArrowDownIcon, ArrowUpIcon, QuoteIcon } from "lucide-react";
import { cn } from "cn";
import type { RecommendationWeights } from "@/lib/queries";

/** The eight criteria, in the register a broker would use out loud. */
const CRITERION_LABEL: Record<string, string> = {
  premium_cost: "Premium",
  out_of_pocket_exposure: "Out-of-pocket exposure",
  need_coverage: "Covering the stated needs",
  waiting_period_fit: "Waiting periods that clear in time",
  network_access: "Network access",
  chronic_depth: "Depth of chronic cover",
  annual_limit: "Annual limit",
  dental_optical: "Dental and optical",
};

const label = (id: string) => CRITERION_LABEL[id] ?? id.replace(/_/g, " ");
const pct = (weight: number) => `${Math.round(weight * 100)}%`;

/**
 * What the recommendation was scored on, and what moved it.
 *
 * Two things are deliberately kept apart here. The bar is the weight that
 * actually scored the plans; the delta beside it is how far the applicant's
 * own stated preferences moved that weight off the cohort baseline. A reader
 * can therefore see both what mattered and whether it mattered because of
 * anything this applicant said.
 *
 * The quoted preferences underneath are the applicant's words, tagged by
 * whether the system was told them outright or inferred them. That tag is the
 * honest part: an inference the applicant never made is exactly the kind of
 * thing a broker should be able to disagree with.
 */
export function CriterionBars({ weights }: { weights: RecommendationWeights }) {
  const peak = Math.max(...weights.criteria.map((row) => row.applied), 0.01);

  return (
    <div className="space-y-4">
      <ol className="space-y-3.5">
        {weights.criteria.map((row) => (
          <li key={row.criterionId}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{label(row.criterionId)}</span>
              <span className="flex shrink-0 items-center gap-2">
                {row.delta != null && row.delta !== 0 ? (
                  <span
                    className={cn(
                      "flex items-center gap-0.5 text-xs tabular-nums",
                      row.delta > 0 ? "text-success" : "text-muted-foreground",
                    )}
                    title={`Cohort baseline was ${pct(row.base ?? 0)}`}
                  >
                    {row.delta > 0 ? <ArrowUpIcon className="size-3" /> : <ArrowDownIcon className="size-3" />}
                    {pct(Math.abs(row.delta))}
                  </span>
                ) : null}
                <span className="font-medium tabular-nums">{pct(row.applied)}</span>
              </span>
            </div>

            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-brand"
                style={{ width: `${Math.round((row.applied / peak) * 100)}%` }}
              />
            </div>

            {row.preferences.length > 0 ? (
              <ul className="mt-2 space-y-1">
                {row.preferences.map((preference, index) => (
                  <li key={index} className="flex gap-1.5 text-xs text-muted-foreground text-pretty">
                    <QuoteIcon className="mt-0.5 size-3 shrink-0" />
                    <span>
                      {preference.reason}
                      <span
                        className={cn(
                          "ml-1.5 rounded px-1 py-0.5 text-[0.625rem] font-medium",
                          preference.source === "explicit"
                            ? "bg-success-subtle text-success"
                            : "bg-warning-subtle text-warning",
                        )}
                      >
                        {preference.source === "explicit" ? "they said this" : "inferred"}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>

      <p className="text-xs text-muted-foreground text-pretty">
        Weights are what the comparison was scored on, after being settled back to a total of 100%. A delta is movement
        off the cohort baseline caused by what this applicant said.
        {weights.confidence != null
          ? ` The system rated its own reading of those preferences at ${Math.round(weights.confidence * 100)}%.`
          : ""}
        {weights.round > 1 ? ` This is round ${weights.round} — an earlier shortlist was rejected.` : ""}
        {weights.fellBackTo ? ` Scoring fell back to ${weights.fellBackTo.replace(/_/g, " ")}.` : ""}
      </p>
    </div>
  );
}
