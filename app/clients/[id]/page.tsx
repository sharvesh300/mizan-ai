import { FileTextIcon, MessageSquareIcon, ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SectionCard } from "@/components/crm/section-card";
import { StatRow, StatTile } from "@/components/crm/stat-tile";
import { Timeline } from "@/components/crm/timeline";
import { PageBody, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UtilizationBar } from "@/components/utilization";
import {
  applicationStatusLabel,
  applicationStatusTone,
  cohortLabel,
  conversationStatusLabel,
  conversationStatusTone,
  dateLabel,
  journeyProgress,
  money,
} from "@/lib/domain";
import { getClient, getClientTimeline } from "@/lib/queries";
import { getCurrentUser } from "@/lib/session";

const OPEN_STATUSES = ["policy_issued", "declined", "withdrawn", "expired"];

export default async function ClientPage(props: PageProps<"/clients/[id]">) {
  const { id } = await props.params;
  const user = await getCurrentUser();
  if (!user) return null;
  if (user.role !== "advisor") notFound();

  const [client, timeline] = await Promise.all([getClient(id), getClientTimeline(id)]);
  if (!client) notFound();

  const open = client.applications.filter((row) => !OPEN_STATUSES.includes(row.status));
  const active = client.policies.filter(({ policy }) => policy.status === "active");
  const liveAnnual = active.reduce((sum, { policy }) => sum + policy.annualPremium, 0);

  return (
    <>
      <PageHeader
        backHref="/clients"
        backLabel="Clients"
        title={client.person.fullName}
        description={
          <>
            {client.person.relationshipToOwner === "self"
              ? "Account holder"
              : `${client.person.relationshipToOwner} of ${client.ownerName}`}
            {client.person.emirate ? ` · ${client.person.emirate}` : ""}
            {client.person.dateOfBirth ? ` · born ${dateLabel(client.person.dateOfBirth)}` : ""}
            {" · "}
            {client.ownerEmail}
            {client.ownerPhone ? ` · ${client.ownerPhone}` : ""}
          </>
        }
      >
        {active.length > 0 ? (
          <StatusBadge tone="success">Covered</StatusBadge>
        ) : open.length > 0 ? (
          <StatusBadge tone="info">In progress</StatusBadge>
        ) : (
          <StatusBadge>No open work</StatusBadge>
        )}
      </PageHeader>

      <PageBody className="space-y-5">
        {/* The fact the product could not surface before: one person, several
            live applications, each of which could become its own policy. */}
        {open.length > 1 ? (
          <Alert>
            <FileTextIcon className="text-warning" />
            <AlertTitle>{open.length} applications are open for this person</AlertTitle>
            <AlertDescription>
              Approving more than one produces duplicate recommendations, and two policies if both are issued. Worth
              settling which of these is the real one before any of them moves.
            </AlertDescription>
          </Alert>
        ) : null}

        <StatRow>
          <StatTile label="Applications" value={client.applications.length} hint={`${open.length} still open`} href="/applications" />
          <StatTile label="Policies" value={client.policies.length} hint={`${active.length} active`} tone={active.length > 0 ? "success" : "neutral"} href="/policies" />
          <StatTile label="Premium live" value={money(liveAnnual)} hint="annualised" href="/policies" />
          <StatTile label="Conversations" value={client.conversations.length} hint="intake and plan chats" href={`/clients/${id}`} />
          <StatTile label="Events on file" value={timeline.length} hint="everything recorded" href={`/clients/${id}`} />
        </StatRow>

        <Tabs defaultValue="timeline">
          <TabsList>
            <TabsTrigger value="timeline">Timeline ({timeline.length})</TabsTrigger>
            <TabsTrigger value="cover">Cover ({client.policies.length})</TabsTrigger>
            <TabsTrigger value="applications">Applications ({client.applications.length})</TabsTrigger>
            <TabsTrigger value="conversations">Conversations ({client.conversations.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="timeline" className="pt-4">
            <SectionCard
              title="Everything that has happened"
              description="Intake, classification, flags, recommendations, decisions, policies and servicing — merged and newest first. Every entry says who did it."
            >
              <Timeline entries={timeline} />
            </SectionCard>
          </TabsContent>

          <TabsContent value="cover" className="space-y-4 pt-4">
            {client.policies.length === 0 ? (
              <SectionCard title="No cover yet" description="Nothing has been issued for this person.">
                <p className="text-sm text-muted-foreground">
                  A policy appears here once a recommendation is approved and the applicant has chosen a plan.
                </p>
              </SectionCard>
            ) : (
              client.policies.map(({ policy, plan, ledger }) => (
                <SectionCard
                  key={policy.id}
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      <ShieldCheckIcon className="size-4 text-success" />
                      {plan.name}
                      <StatusBadge tone={policy.status === "active" ? "success" : "neutral"}>
                        {policy.status}
                      </StatusBadge>
                    </span>
                  }
                  description={`${policy.policyNumber} · ${money(policy.annualPremium)} a year · cover from ${dateLabel(policy.inceptionDate)}`}
                  action={
                    <Link href={`/policies/${policy.id}`} className="text-xs text-muted-foreground hover:underline">
                      Open policy
                    </Link>
                  }
                >
                  <div className="space-y-4">
                    <UtilizationBar
                      label="Annual limit"
                      used={ledger?.annualPaid ?? 0}
                      cap={plan.annualLimit}
                    />
                    <UtilizationBar
                      label="Deductible"
                      used={ledger?.deductibleMet ?? 0}
                      cap={plan.deductible}
                    />
                  </div>
                </SectionCard>
              ))
            )}
          </TabsContent>

          <TabsContent value="applications" className="pt-4">
            <SectionCard
              flush
              title="Every application on this person"
              description="Including closed ones — the history is the point of a client record."
            >
              <ul className="divide-y border-t">
                {client.applications.map((row) => (
                  <li key={row.id}>
                    <Link href={`/applications/${row.id}`} className="flex items-center gap-4 px-4 py-3.5 hover:bg-muted/50">
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{row.reference}</span>
                          <StatusBadge tone={applicationStatusTone[row.status]}>
                            {applicationStatusLabel[row.status]}
                          </StatusBadge>
                          {row.cohort ? (
                            <span className="text-xs text-muted-foreground">{cohortLabel(row.cohort)}</span>
                          ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          age {row.age} · {row.budget.replace(/_/g, " ")} budget · via{" "}
                          {row.intakeSource.replace(/_/g, " ")} · last moved {dateLabel(row.statusChangedAt)}
                        </p>
                        <Progress value={journeyProgress(row.status)} className="h-1 max-w-xs" />
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </SectionCard>
          </TabsContent>

          <TabsContent value="conversations" className="pt-4">
            <SectionCard
              flush
              title="Conversations"
              description="Intake chats and plan discussions, newest first."
            >
              {client.conversations.length === 0 ? (
                <p className="px-4 pt-4 text-sm text-muted-foreground">No conversations on file.</p>
              ) : (
                <ul className="divide-y border-t">
                  {client.conversations.map((row) => (
                    <li key={row.id} className="flex items-center gap-3 px-4 py-3.5">
                      <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium capitalize">{row.channel}</span>
                          <StatusBadge tone={conversationStatusTone[row.status]}>
                            {conversationStatusLabel[row.status]}
                          </StatusBadge>
                        </div>
                        <p className="text-xs text-muted-foreground">Started {dateLabel(row.startedAt)}</p>
                      </div>
                      {row.applicationId ? (
                        <Link
                          href={`/applications/${row.applicationId}`}
                          className="shrink-0 text-xs text-muted-foreground hover:underline"
                        >
                          Open application
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </TabsContent>
        </Tabs>
      </PageBody>
    </>
  );
}
