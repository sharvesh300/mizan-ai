"use server";

// The broker's answer to a reversal waiting on a signature — BROKER ONLY.
//
// Three verbs (plan §13.3.2): confirm the reversal, uphold instead, ask the member for more. Every one checks the caller
// is an advisor HERE as well as in `lib/ai/servicing-signoff.ts`, which re-checks against the row: a server action is a
// public endpoint, and "the button was hidden from members" is not an authorisation.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { closeQualityCheck, coverIt, denyIt, handOff, markCalled, replyInThread, resolveCase } from "@/lib/ai/servicing-handoff";
import { confirmReversal, requestMoreEvidence, upholdInstead } from "@/lib/ai/servicing-signoff";
import { getCurrentUser } from "@/lib/session";

export type DecisionResult = { ok: true; message: string } | { ok: false; message: string };

const input = z.object({
  taskId: z.string().min(8).max(64),
  verb: z.enum(["confirm", "uphold", "more_evidence"]),
  /** For the file. Confirming from the queue supplies its own, saying what was on screen when it was signed. */
  note: z.string().trim().max(600),
  /** What the member is told — pre-drafted by the agent and editable. Confirm and ask-for-more only. */
  memberMessage: z.string().trim().max(1200).optional(),
});

function refresh(policyId: string, eventId: string) {
  revalidatePath("/queue");
  revalidatePath("/");
  revalidatePath(`/policies/${policyId}`);
  revalidatePath(`/policies/${policyId}/events/${eventId}`);
  // The member's thread and their policy screen change too.
  revalidatePath("/", "layout");
}

export async function decideOverturn(policyId: string, eventId: string, raw: unknown): Promise<DecisionResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== "advisor") return { ok: false, message: "Only an advisor can decide this." };
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "That didn't come through — please try again." };
  const { taskId, verb, note, memberMessage } = parsed.data;

  const result =
    verb === "confirm"
      ? await confirmReversal({ taskId, advisorUserId: user.id, note, memberMessage })
      : verb === "uphold"
        ? await upholdInstead({ taskId, advisorUserId: user.id, note })
        : await requestMoreEvidence({ taskId, advisorUserId: user.id, note, memberMessage });
  if (!result.ok) return { ok: false, message: result.reason };
  refresh(policyId, eventId);
  return { ok: true, message: verb === "confirm" ? "Reversal confirmed. The member has been told." : verb === "uphold" ? "The decision stands. The member has been told." : "Sent back to the member for more." };
}

// ---------------------------------------------------------------------------
// Everything else a person does with a case that was handed over (plan §13.3.2)
// ---------------------------------------------------------------------------

const caseInput = z.discriminatedUnion("verb", [
  z.object({ verb: z.literal("cover"), taskId: z.string().min(8).max(64), providerTier: z.string().max(40), note: z.string().trim().max(600), memberMessage: z.string().trim().max(1200).optional() }),
  z.object({ verb: z.literal("deny"), taskId: z.string().min(8).max(64), note: z.string().trim().max(600), memberMessage: z.string().trim().max(1200).optional() }),
  z.object({ verb: z.literal("reply"), taskId: z.string().min(8).max(64), message: z.string().trim().max(1200) }),
  z.object({ verb: z.literal("resolve"), taskId: z.string().min(8).max(64), note: z.string().trim().max(600), memberMessage: z.string().trim().max(1200) }),
  z.object({ verb: z.literal("hand_off"), taskId: z.string().min(8).max(64), toUserId: z.string().max(64), note: z.string().trim().max(600) }),
  z.object({ verb: z.literal("called"), taskId: z.string().min(8).max(64), note: z.string().trim().max(600) }),
  z.object({ verb: z.literal("close_quality"), taskId: z.string().min(8).max(64), note: z.string().trim().max(600) }),
]);

export async function decideCase(policyId: string, subjectId: string, raw: unknown): Promise<DecisionResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== "advisor") return { ok: false, message: "Only an advisor can decide this." };
  const parsed = caseInput.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "That didn't come through — please try again." };
  const i = parsed.data;
  const by = user.id;
  const r =
    i.verb === "cover"
      ? await coverIt({ taskId: i.taskId, advisorUserId: by, providerTier: i.providerTier, note: i.note, memberMessage: i.memberMessage })
      : i.verb === "deny"
        ? await denyIt({ taskId: i.taskId, advisorUserId: by, note: i.note, memberMessage: i.memberMessage })
        : i.verb === "reply"
          ? await replyInThread({ taskId: i.taskId, advisorUserId: by, message: i.message })
          : i.verb === "resolve"
            ? await resolveCase({ taskId: i.taskId, advisorUserId: by, note: i.note, memberMessage: i.memberMessage })
            : i.verb === "hand_off"
              ? await handOff({ taskId: i.taskId, advisorUserId: by, toUserId: i.toUserId, note: i.note })
              : i.verb === "called"
                ? await markCalled({ taskId: i.taskId, advisorUserId: by, note: i.note })
                : await closeQualityCheck({ taskId: i.taskId, advisorUserId: by, note: i.note });
  if (!r.ok) return { ok: false, message: r.reason };
  refresh(policyId, subjectId);
  revalidatePath(`/policies/${policyId}/conversations/${subjectId}`);
  return { ok: true, message: r.message };
}
