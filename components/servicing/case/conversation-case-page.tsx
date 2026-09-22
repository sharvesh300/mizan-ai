// A hand-off with no claim of its own: the member asked for a person, or the agent stopped. The packet is the case.

import { TriangleAlertIcon } from "lucide-react";
import { PageBody, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ConversationCase } from "@/lib/servicing/case";
import type { Packet } from "@/lib/servicing/packet";
import { CaseDecision } from "./case-decision";
import { PacketTab } from "./packet-tab";

export function ConversationCasePage({ c, packet, colleagues }: { c: ConversationCase; packet: Packet; colleagues: { id: string; name: string }[] }) {
  return (
    <>
      <PageHeader
        backHref={`/policies/${c.policy.id}`}
        backLabel={c.policy.ref}
        title={<span className="flex flex-wrap items-center gap-2">Hand-off · {c.subject.fullName}</span>}
        description={`${c.subject.fullName} · ${c.policy.ref} · ${c.policy.planName}`}
      >
        <StatusBadge tone={c.conversation.status === "escalated" ? "warning" : "neutral"}>{c.conversation.status.replace(/_/g, " ")}</StatusBadge>
      </PageHeader>
      <PageBody className="space-y-5">
        {c.task ? (
          <Alert className="border-warning/40">
            <TriangleAlertIcon className="text-warning" />
            <AlertTitle>Why this needs you</AlertTitle>
            <AlertDescription className="text-pretty">{packet.why.meaning ? `${packet.why.meaning[0].toUpperCase()}${packet.why.meaning.slice(1)}. ` : ""}{c.task.reason}</AlertDescription>
          </Alert>
        ) : null}
        <Tabs defaultValue="decision">
          <TabsList className="max-w-full overflow-x-auto">
            <TabsTrigger value="decision">Decision</TabsTrigger>
            <TabsTrigger value="packet">Packet</TabsTrigger>
          </TabsList>
          <TabsContent value="decision" className="pt-4">
            {c.task ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Your decision</CardTitle>
                  <CardDescription className="text-pretty">The member has been told this is with you and that they won&apos;t need to repeat anything. Reply in their thread, close it with the last word, or pass it on.</CardDescription>
                </CardHeader>
                <CardContent>
                  <CaseDecision policyId={c.policy.id} subjectId={c.conversation.id} taskId={c.task.id} kind="escalation" preview={null} colleagues={colleagues} hasConversation={c.conversation.status === "escalated"} callbackRequested={packet.callback !== null} defaultDenyMessage={null} />
                </CardContent>
              </Card>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing is waiting on this. See the packet for what happened.</p>
            )}
          </TabsContent>
          <TabsContent value="packet" className="pt-4">
            <PacketTab p={packet} />
          </TabsContent>
        </Tabs>
      </PageBody>
    </>
  );
}
