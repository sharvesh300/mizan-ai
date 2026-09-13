import { ArrowRightIcon, FileTextIcon, MessageSquareIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Progress, ProgressIndicator, ProgressTrack } from "@/components/ui/progress";
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

export default async function ApplicationsPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  if (user.role === "advisor") {
    const rows = await listAllApplications();
    return (
      <>
        <PageHeader
          title="Applications"
          description="Every application in the pipeline and where it has got to. Ordered by most recent movement."
        />
        <PageBody>
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Applicant</TableHead>
                  <TableHead>Cohort</TableHead>
                  <TableHead className="w-48">Progress</TableHead>
                  <TableHead>Last moved</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((app) => (
                  <TableRow key={app.id}>
                    <TableCell className="font-medium">{app.reference}</TableCell>
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
                        <Progress value={journeyProgress(app.status)} className="h-1">
                          <ProgressTrack className="h-1">
                            <ProgressIndicator />
                          </ProgressTrack>
                        </Progress>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{dateLabel(app.statusChangedAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button
            nativeButton={false}
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Open ${app.reference}`}
                        render={
                          <Link href={`/applications/${app.id}`}>
                            <ArrowRightIcon />
                          </Link>
                        }
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
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
                      <Progress value={journeyProgress(app.status)} className="h-1 max-w-xs">
                        <ProgressTrack className="h-1">
                          <ProgressIndicator />
                        </ProgressTrack>
                      </Progress>
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
