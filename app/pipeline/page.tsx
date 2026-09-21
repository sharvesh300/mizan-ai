import type { Metadata } from "next";
import { ClockIcon, LayersIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FilterBar } from "@/components/crm/filter-bar";
import { PageBody, PageHeader } from "@/components/page-header";
import { StatusBadge, StatusDot } from "@/components/status-badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { cohortLabel, type Tone } from "@/lib/domain";
import { getPipeline, type PipelineStage } from "@/lib/queries";
import { getCurrentUser } from "@/lib/session";

const CONFIDENCE_TONE: Record<string, Tone> = { low: "warning", medium: "info", high: "success" };

const SEGMENTS = [
  { value: "all", label: "Everything" },
  { value: "review", label: "With an advisor" },
  { value: "low", label: "Low confidence" },
  { value: "unassessed", label: "Not assessed" },
] as const;

type Card = PipelineStage["cards"][number];

const MATCH: Record<string, (row: Card) => boolean> = {
  all: () => true,
  review: (row) => row.status === "in_review",
  low: (row) => row.confidence === "low",
  unassessed: (row) => row.cohort == null,
};

export const metadata: Metadata = {
  title: "Pipeline · Mizan AI",
  description: "Every application still in play, by stage.",
};

export default async function PipelinePage(props: PageProps<"/pipeline">) {
  const user = await getCurrentUser();
  if (!user) return null;
  if (user.role !== "advisor") notFound();

  const search = await props.searchParams;
  const filter = typeof search.filter === "string" ? search.filter : "all";
  const query = typeof search.q === "string" ? search.q : "";
  const match = MATCH[filter] ?? MATCH.all;

  const stages = await getPipeline();
  const filtered = stages.map((stage) => ({
    ...stage,
    cards: stage.cards
      .filter(match)
      .filter((row) =>
        query
          ? [row.reference, row.personName, row.cohort ?? ""].some((field) =>
              field.toLowerCase().includes(query.toLowerCase()),
            )
          : true,
      ),
  }));

  const total = filtered.reduce((sum, stage) => sum + stage.cards.length, 0);
  const counts = Object.fromEntries(
    SEGMENTS.map((segment) => [
      segment.value,
      stages.reduce((sum, stage) => sum + stage.cards.filter(MATCH[segment.value]).length, 0),
    ]),
  );

  return (
    <>
      <PageHeader
        title="Pipeline"
        description="Every application still in play, by stage, oldest first inside each column — a column is a queue, and what has waited longest belongs at the top of it."
      />
      <PageBody className="space-y-5">
        <FilterBar
          segments={SEGMENTS.map((segment) => ({ ...segment, count: counts[segment.value] }))}
          active={filter}
          query={query}
          placeholder="Search by reference, applicant or cohort"
        />

        {total === 0 ? (
          <Empty className="rounded-xl border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LayersIcon />
              </EmptyMedia>
              <EmptyTitle>Nothing matches</EmptyTitle>
              <EmptyDescription>
                {query ? `No application matches "${query}".` : "No application is in this state right now."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          /* Horizontal scroll rather than wrapping: six columns that reflow
             into two rows stop being a pipeline and become a list of lists. */
          <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6">
            <ol className="flex min-w-max gap-4">
              {filtered.map((stage) => (
                <StageColumn key={stage.key} stage={stage} />
              ))}
            </ol>
          </div>
        )}

        {/* A board that looks draggable and is not would be a lie: these
            stages move when the work moves, and issuing a policy has rather
            more to it than a card landing in a column. */}
        <p className="text-xs text-muted-foreground text-pretty">
          Cards are not dragged between columns. A record moves stage when the work does — an assessment completes, an
          applicant picks a plan, an advisor signs off — so every move here has a decision behind it, recorded against
          whoever made it.
        </p>
      </PageBody>
    </>
  );
}

function StageColumn({ stage }: { stage: PipelineStage }) {
  // Derived from the cards actually on screen — the query deliberately does
  // not precompute it, because the filter runs between the two.
  const oldestDays = stage.cards[0]?.daysInStage ?? 0;

  return (
    <li className="flex w-72 shrink-0 flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2 border-b pb-2">
        <h2 className="text-sm font-medium">
          {stage.label}
          <span className="ml-1.5 text-muted-foreground tabular-nums">{stage.cards.length}</span>
        </h2>
        {oldestDays > 0 ? (
          <span
            className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums"
            title={`Longest anything has sat in ${stage.label.toLowerCase()}`}
          >
            <ClockIcon className="size-3" />
            {oldestDays}d
          </span>
        ) : null}
      </div>

      {stage.cards.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
          Nothing here
        </p>
      ) : (
        <ol className="space-y-2">
          {stage.cards.map((card) => (
            <li key={card.id}>
              <Link
                href={`/applications/${card.id}`}
                className="block rounded-lg bg-card p-3 ring-1 ring-foreground/10 transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium">{card.personName}</span>
                  <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">{card.reference}</span>
                </div>

                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  age {card.age} · {card.budget.replace(/_/g, " ")} budget
                  {card.cohort ? ` · ${cohortLabel(card.cohort)}` : ""}
                </p>

                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {card.status === "in_review" ? (
                    <StatusBadge tone="warning">With an advisor</StatusBadge>
                  ) : null}
                  {card.confidence ? (
                    <span className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
                      <StatusDot tone={CONFIDENCE_TONE[card.confidence]} />
                      {card.confidence}
                    </span>
                  ) : (
                    <span className="text-[0.6875rem] text-muted-foreground">not assessed</span>
                  )}
                  <span className="ml-auto text-[0.6875rem] text-muted-foreground tabular-nums">
                    {card.daysInStage}d here
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}
