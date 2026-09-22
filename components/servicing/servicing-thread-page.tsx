// The server half of the servicing conversation: authorise, load, and hand a serialisable transcript to the
// client thread. Rendered by BOTH routes — the full page and the intercepted drawer — so what is open, what is
// answered and whether a composer exists are derived once.

import { notFound } from "next/navigation";
import { ServicingThreadView } from "@/components/servicing/servicing-thread";
import { PageHeader } from "@/components/page-header";
import { readServicingThread } from "@/lib/ai/servicing-session";
import { listAppealableEventIds } from "@/lib/servicing/appeal-store";
import { servicingDecider } from "@/lib/ai/servicing-model";
import type { SessionUser } from "@/lib/session";

export const TITLE: Record<"claim" | "preauth" | "appeal", string> = { claim: "Your claim", preauth: "Is this covered?", appeal: "Your appeal" };

/** One sentence for where the conversation stands. */
export function statusLine(status: string, hasModel: boolean, intent: "claim" | "preauth" | "appeal" = "claim"): string {
  if (status === "completed") return intent === "appeal" ? "Done — we've looked at this again." : "Done — this is on your policy.";
  // A reversal computed and waiting on a signature: a real interim state, with no workflow words in it.
  if (status === "awaiting_review" && intent === "appeal") return "Your evidence changes the decision. We're finalising the numbers — you'll see them here.";
  if (status === "escalated" || status === "awaiting_review") return "An advisor has this now. Everything you told us is with them.";
  if (intent === "appeal") return hasModel ? "Paste or describe what your document says, or tell us you don't have it. Everything is saved as you go." : "Send what your document says, or tell us you don't have it. Everything is saved as you go.";
  return hasModel ? "Tell me in your own words, or use the buttons. Everything is saved as you go." : "Fill in the details below. Everything is saved as you go.";
}

export async function ServicingThread({ policyId, conversationId, user, variant = "page" }: { policyId: string; conversationId: string; user: SessionUser; variant?: "page" | "drawer" }) {
  const thread = await readServicingThread(conversationId, user.id);
  // Someone else's conversation, or a URL whose policy is not the conversation's: simply not found.
  if (!thread || thread.policyId !== policyId) notFound();

  const hasModel = servicingDecider() !== undefined;
  // "Appeal this decision" is offered only when the LOG says this decision can be appealed right now — not from a flag on the
  // card, which was true when it was written and is not necessarily true today.
  const appealable = thread.committedEventId && thread.intent !== "appeal" ? await listAppealableEventIds(policyId) : new Set<string>();
  const appealEventId = thread.committedEventId && appealable.has(thread.committedEventId) ? thread.committedEventId : null;
  const initials = user.fullName.split(" ").slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  const line = statusLine(thread.status, hasModel, thread.intent);

  return (
    <div className={variant === "page" ? "flex h-[calc(100dvh-3.5rem)] flex-col" : "flex min-h-0 flex-1 flex-col"}>
      {variant === "page" ? (
        <div className="shrink-0">
          <PageHeader backHref={`/policies/${policyId}`} backLabel="Your cover" title={TITLE[thread.intent]} description={line} />
        </div>
      ) : (
        <p className="shrink-0 px-4 pb-3 text-sm text-pretty text-muted-foreground">{line}</p>
      )}
      <ServicingThreadView
        policyId={policyId}
        conversationId={conversationId}
        status={thread.status}
        messages={thread.messages}
        hasModel={hasModel}
        callbackRequested={thread.callbackRequested}
        appealEventId={appealEventId}
        intent={thread.intent}
        advisorPhone={process.env.ADVISOR_PHONE?.trim() || null}
        defaultPhone={user.phone ?? ""}
        initials={initials}
        variant={variant}
      />
    </div>
  );
}
