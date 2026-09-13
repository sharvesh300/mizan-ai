import { and, desc, eq, inArray } from "drizzle-orm";
import { MessageSquareIcon } from "lucide-react";
import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { conversation } from "@/db/schema";
import { PageBody, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUser } from "@/lib/session";
import { startChatIntake } from "../actions";

export default async function ChatIntakeEntryPage() {
  const user = await getCurrentUser();
  if (!user) return null;

  // Resume rather than restart. An unfinished intake is the applicant's work,
  // and re-asking everything is the exact failure the brief calls out.
  const [inProgress] = await db
    .select({ id: conversation.id })
    .from(conversation)
    .where(
      and(
        eq(conversation.userId, user.id),
        eq(conversation.purpose, "intake"),
        inArray(conversation.status, ["active", "awaiting_user"]),
      ),
    )
    .orderBy(desc(conversation.startedAt))
    .limit(1);

  if (inProgress) redirect(`/applications/new/chat/${inProgress.id}`);

  return (
    <>
      <PageHeader backHref="/applications/new" title="Talk it through" />
      <PageBody>
        <Card className="mx-auto max-w-lg">
          <CardHeader>
            <span className="flex size-10 items-center justify-center rounded-xl bg-brand-subtle text-brand">
              <MessageSquareIcon className="size-5" />
            </span>
            <CardTitle className="mt-3">A few questions, one at a time</CardTitle>
            <CardDescription className="text-pretty">
              Answer in your own words — everything is saved as you go, so you can close this and come back to the
              same place. Nothing is sent to an advisor until you say so.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={startChatIntake}>
              <Button type="submit" size="lg" className="w-full">
                Start
              </Button>
            </form>
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
