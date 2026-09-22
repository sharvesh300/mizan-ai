"use server";

// The broker's answer to a plan-fit recommendation — BROKER ONLY.
//
// Three verbs (plan §13.3.3): approve as written, edit the reasoning, dismiss. Every one checks the caller is an
// advisor HERE as well as in `lib/ai/servicing-reassess.ts`, which re-checks against the row — a server action is
// a public endpoint, "the button was hidden from members" is not an authorisation.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { approveReassessment, dismissReassessment, editReassessmentReasoning } from "@/lib/ai/servicing-reassess";
import { getCurrentUser } from "@/lib/session";

export type DecisionResult = { ok: true; message: string } | { ok: false; message: string };

const input = z.discriminatedUnion("verb", [
  z.object({ verb: z.literal("approve"), taskId: z.string().min(8).max(64), note: z.string().trim().max(600) }),
  z.object({ verb: z.literal("edit"), taskId: z.string().min(8).max(64), note: z.string().trim().max(600), brokerReasoning: z.string().trim().max(2000) }),
  z.object({ verb: z.literal("dismiss"), taskId: z.string().min(8).max(64), note: z.string().trim().max(600) }),
]);

function refresh(policyId: string, reassessmentId: string) {
  revalidatePath("/queue");
  revalidatePath("/");
  revalidatePath(`/policies/${policyId}`);
  revalidatePath(`/policies/${policyId}/reassess/${reassessmentId}`);
  // The member's own policy screen changes too, once approved or edited.
  revalidatePath("/", "layout");
}

export async function decideReassessment(policyId: string, reassessmentId: string, raw: unknown): Promise<DecisionResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== "advisor") return { ok: false, message: "Only an advisor can decide this." };
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "That didn't come through — please try again." };

  const result =
    parsed.data.verb === "approve"
      ? await approveReassessment({ taskId: parsed.data.taskId, advisorUserId: user.id, note: parsed.data.note })
      : parsed.data.verb === "edit"
        ? await editReassessmentReasoning({ taskId: parsed.data.taskId, advisorUserId: user.id, note: parsed.data.note, brokerReasoning: parsed.data.brokerReasoning })
        : await dismissReassessment({ taskId: parsed.data.taskId, advisorUserId: user.id, note: parsed.data.note });
  if (!result.ok) return { ok: false, message: result.reason };
  refresh(policyId, reassessmentId);
  return { ok: true, message: result.message };
}
