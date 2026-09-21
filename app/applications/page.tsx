import { ArrowRightIcon, FileTextIcon, MessageSquareIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { FilterBar } from "@/components/crm/filter-bar";
import { StatRow, StatTile } from "@/components/crm/stat-tile";
import { PageBody, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  applicationStatusLabel,
  applicationStatusTone,
  cohortLabel,
  dateLabel,
  journeyProgress,
} from "@/lib/domain";
import { listAllApplications, listApplicationsForUser } from "@/lib/queries";
import { getCurrentUser } from "@/lib/session";

const SOURCE_ICON = { chat: MessageSquareIcon, voice: MessageSquareIcon } as const;

/**
 * The stages an advisor actually filters by.
 *
 * Deliberately coarser than `application_status`: fourteen statuses is the
 * schema's vocabulary, not a person's. "With an advisor" is the one that
 * matters most and is not a stage at all — it is a record paused for review,
 * which is why the queue exists — so it gets its own segment.
 */
const SEGMENTS: { value: string; label: string; match: (status: string) => boolean }[] = [
  { value: "all", label: "All", match: () => true },
  { value: "open", label: "Open", match: (s) => !["policy_issued", "declined", "withdrawn", "expired"].includes(s) },
  { value: "review", label: "With an advisor", match: (s) => s === "in_review" },
  { value: "recommended", label: "Plans ready", match: (s) => s === "recommended" || s === "plan_selected" },
  { value: "issued", label: "Policy live", match: (s) => s === "policy_issued" },
];

export default async function ApplicationsPage(props: PageProps<"/applications">) {
  const user = await getCurrentUser();
  if (!user) return null;

  if (user.role === "advisor") {
    const search = await props.searchParams;
    const filter = typeof search.filter === "string" ? search.filter : "all";
    const query = typeof search.q === "string" ? search.q : "";

    const all = await listAllApplications();
    const segment = SEGMENTS.find((row) => row.value === filter) ?? SEGMENTS[0];

    const rows = all
      .filter((row) => segment.match(row.status))
      .filter((row) =>
        query
          ? [row.reference, row.personName, row.ownerName, row.cohort ?? ""].some((field) =>
              field.toLowerCase().includes(query.toLowerCase()),
            )
          : true,
      );

    const open = all.filter((row) => SEGMENTS[1].match(row.status));
    const withAdvisor = all.filter((row) => row.status === "in_review");
    const unassessed = open.filter((row) => row.cohort == null);
    const lowConfidence = all.filter((row) => row.confidence === "low");

    return (
      <>
        <PageHeader
          title="Applications"
          description="Every application in the pipeline and where it has got to. Ordered by most recent movement."
        />
        <PageBody className="space-y-5">
          <StatRow>
            <StatTile label="Total" value={all.length} hint="every application on file" href="/applications" />
            <StatTile label="Open" value={open.length} hint="not yet closed" tone="info" href="/applications?filter=open" />
            <StatTile
              label="With an advisor"
              value={withAdvisor.length}
              hint="paused for review"
              tone={withAdvisor.length > 0 ? "warning" : "neutral"}
              href="/applications?filter=review"
            />
            <StatTile
              label="Not yet assessed"
              value={unassessed.length}
              hint="no cohort assigned"
              tone={unassessed.length > 0 ? "warning" : "success"}
              href="/applications?filter=open"
            />
            <StatTile
              label="Low confidence"
              value={lowConfidence.length}
              hint="genuine judgement calls"
              tone={lowConfidence.length > 0 ? "warning" : "neutral"}
              href="/queue"
            />
          </StatRow>

          <FilterBar
            segments={SEGMENTS.map((row) => ({
              value: row.value,
              label: row.label,
              count: all.filter((app) => row.match(app.status)).length,
            }))}
            active={filter}
            query={query}
            placeholder="Search by reference, applicant, account holder or cohort"
          />

          {rows.length === 0 ? (
            <Empty className="rounded-xl border border-dashed">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileTextIcon />
                </EmptyMedia>
                <EmptyTitle>Nothing matches</EmptyTitle>
                <EmptyDescription>
                  {query ? `No application matches "${query}".` : "No application is at this stage right now."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-x-auto rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reference</TableHead>
                    <TableHead>Applicant</TableHead>
                    <TableHead>Cohort</TableHead>
                    <TableHead className="w-48">Progress</TableHead>
                    <TableHead>Last moved</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((app) => (
                    <TableRow key={app.id}>
                      <TableCell className="font-medium">
                        <Link href={`/applications/${app.id}`} className="hover:underline">
                          {app.reference}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <div className="min-w-0">
                          <p className="truncate">{app.personName}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            age {app.age} · {app.budget.replace(/_/g, " ")} budget · via{" "}
                            {app.intakeSource.replace(/_/g, " ")}
                          </p>
                        </div>
                      </TableCell>
                      {/* Cohort is broker-only vocabulary — this table is never
                          rendered for an applicant. */}
                      <TableCell className="text-muted-foreground">
                        {app.cohort ? cohortLabel(app.cohort) : "Not assessed"}
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1.5">
                          <StatusBadge tone={applicationStatusTone[app.status]}>
                            {applicationStatusLabel[app.status]}
                          </StatusBadge>
                          <Progress value={journeyProgress(app.status)} className="h-1" />
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{dateLabel(app.statusChangedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </PageBody>
      </>
    );
  }

  const rows = await listApplicationsForUser(user.id);
  return (
    <>
      <PageHeader title="My applications" description="Everything you've started, and where each one has got to.">
        <Button
            nativeButton={false} render={<Link href="/applications/new"><PlusIcon />New application</Link>} />
      </PageHeader>
      <PageBody>
        {rows.length === 0 ? (
          <Empty className="rounded-xl border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileTextIcon />
              </EmptyMedia>
              <EmptyTitle>No applications yet</EmptyTitle>
              <EmptyDescription>
                Start one with a form or talk it through — either way it takes about a minute.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
            nativeButton={false} render={<Link href="/applications/new">Start an application</Link>} />
            </EmptyContent>
          </Empty>
        ) : (
          <ul className="divide-y rounded-xl border">
            {rows.map((app) => {
              const Icon = SOURCE_ICON[app.intakeSource as keyof typeof SOURCE_ICON] ?? FileTextIcon;
              return (
                <li key={app.id}>
                  <Link
                    href={`/applications/${app.id}`}
                    className="flex items-center gap-4 px-4 py-4 transition-colors hover:bg-muted/50"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <Icon className="size-4 text-muted-foreground" />
                    </span>
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{app.reference}</span>
                        <StatusBadge tone={applicationStatusTone[app.status]}>
                          {applicationStatusLabel[app.status]}
                        </StatusBadge>
                      </div>
                      <p className="truncate text-sm text-muted-foreground">
                        {app.personName}
                        {app.planName ? ` · ${app.planName}` : ""} · started {dateLabel(app.createdAt)}
                      </p>
                      <Progress value={journeyProgress(app.status)} className="h-1 max-w-xs" />
                    </div>
                    <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </PageBody>
    </>
  );
}
