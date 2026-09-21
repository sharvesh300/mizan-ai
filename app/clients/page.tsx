import { UsersIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FilterBar } from "@/components/crm/filter-bar";
import { StatRow, StatTile } from "@/components/crm/stat-tile";
import { PageBody, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dateLabel, money, type Tone } from "@/lib/domain";
import { listClients, type ClientRow } from "@/lib/queries";
import { getCurrentUser } from "@/lib/session";

/** What the relationship is worth saying in one word, and how it should read. */
const STATE: Record<ClientRow["state"], { label: string; tone: Tone }> = {
  covered: { label: "Covered", tone: "success" },
  in_progress: { label: "In progress", tone: "info" },
  closed: { label: "No open work", tone: "neutral" },
  no_activity: { label: "No applications", tone: "neutral" },
};

const SEGMENTS = [
  { value: "all", label: "Everyone" },
  { value: "in_progress", label: "In progress" },
  { value: "covered", label: "Covered" },
  { value: "duplicates", label: "Duplicate risk" },
] as const;

export default async function ClientsPage(props: PageProps<"/clients">) {
  const user = await getCurrentUser();
  if (!user) return null;
  // Broker-only by construction: this page shows cohort-adjacent aggregates
  // and every person in the book, neither of which belongs to an applicant.
  if (user.role !== "advisor") notFound();

  const search = await props.searchParams;
  const filter = typeof search.filter === "string" ? search.filter : "all";
  const query = typeof search.q === "string" ? search.q : "";

  const all = await listClients();

  const counts = {
    all: all.length,
    in_progress: all.filter((row) => row.state === "in_progress").length,
    covered: all.filter((row) => row.state === "covered").length,
    /**
     * More than one application open on the same person. This is the number
     * the product could not show before: it existed only as a flag fired
     * inside one of the applications involved.
     */
    duplicates: all.filter((row) => row.openApplications > 1).length,
  };

  const rows = all
    .filter((row) => {
      if (filter === "duplicates") return row.openApplications > 1;
      if (filter === "in_progress" || filter === "covered") return row.state === filter;
      return true;
    })
    .filter((row) =>
      query
        ? [row.fullName, row.ownerName, row.emirate ?? ""].some((field) =>
            field.toLowerCase().includes(query.toLowerCase()),
          )
        : true,
    );

  return (
    <>
      <PageHeader
        title="Clients"
        description="Everyone this brokerage covers or is working on, one row per person. Ordered by most recent movement."
      />
      <PageBody className="space-y-5">
        <StatRow>
          <StatTile label="People on file" value={counts.all} hint="subjects of cover" href="/clients" />
          <StatTile
            label="In progress"
            value={counts.in_progress}
            hint="at least one open application"
            tone="info"
            href="/clients?filter=in_progress"
          />
          <StatTile
            label="Covered"
            value={counts.covered}
            hint="cover in force"
            tone="success"
            href="/clients?filter=covered"
          />
          <StatTile
            label="Duplicate risk"
            value={counts.duplicates}
            hint="more than one open application"
            tone={counts.duplicates > 0 ? "warning" : "neutral"}
            href="/clients?filter=duplicates"
          />
          <StatTile
            label="Premium live"
            value={money(all.reduce((sum, row) => sum + row.liveAnnual, 0))}
            hint="across all active cover"
            href="/policies"
          />
        </StatRow>

        <FilterBar
          segments={SEGMENTS.map((segment) => ({ ...segment, count: counts[segment.value as keyof typeof counts] }))}
          active={filter}
          query={query}
          placeholder="Search by name, account holder or emirate"
        />

        {rows.length === 0 ? (
          <Empty className="rounded-xl border border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UsersIcon />
              </EmptyMedia>
              <EmptyTitle>No one matches</EmptyTitle>
              <EmptyDescription>
                {query ? `Nothing found for "${query}".` : "No client is in this state right now."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Applications</TableHead>
                  <TableHead className="text-right">Cover</TableHead>
                  <TableHead>Last movement</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <Link href={`/clients/${row.id}`} className="block min-w-0 hover:underline">
                        <p className="truncate font-medium">{row.fullName}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {row.relationshipToOwner === "self"
                            ? "account holder"
                            : `${row.relationshipToOwner} of ${row.ownerName}`}
                          {row.emirate ? ` · ${row.emirate}` : ""}
                        </p>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={STATE[row.state].tone}>{STATE[row.state].label}</StatusBadge>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="tabular-nums">
                        <span className="font-medium">{row.openApplications}</span>
                        <span className="text-muted-foreground"> open of {row.applications}</span>
                      </span>
                      {row.openApplications > 1 ? (
                        <StatusBadge tone="warning" className="mt-1 block w-fit ml-auto">
                          duplicate risk
                        </StatusBadge>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.policies > 0 ? money(row.liveAnnual) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{dateLabel(row.lastMoved)}</TableCell>
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
