"use server";

// The broker's two verbs on a payout — BROKER ONLY.
//
// Approve the payment, then mark it paid once the money has actually gone (§payouts). Both check the caller is
// an advisor HERE as well as in `lib/ai/servicing-settlement.ts`, which re-checks against the row: a server
// action is a public endpoint, and "the button was hidden from members" is not an authorisation.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { approvePayment, markPaid } from "@/lib/ai/servicing-settlement";
import { getCurrentUser } from "@/lib/session";

export type SettlementActionResult = { ok: true; message: string } | { ok: false; message: string };

const input = z.discriminatedUnion("verb", [
  z.object({ verb: z.literal("approve"), taskId: z.string().min(8).max(64), note: z.string().trim().max(600) }),
  z.object({ verb: z.literal("mark_paid"), taskId: z.string().min(8).max(64), paymentReference: z.string().trim().max(80) }),
]);

export async function decideSettlement(policyId: string, raw: unknown): Promise<SettlementActionResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== "advisor") return { ok: false, message: "Only an advisor can decide this." };
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "That didn't come through — please try again." };

  const result =
    parsed.data.verb === "approve"
      ? await approvePayment({ taskId: parsed.data.taskId, advisorUserId: user.id, note: parsed.data.note })
      : await markPaid({ taskId: parsed.data.taskId, advisorUserId: user.id, paymentReference: parsed.data.paymentReference });
  if (!result.ok) return { ok: false, message: result.reason };

  revalidatePath("/queue");
  revalidatePath("/");
  revalidatePath(`/policies/${policyId}`);
  // The member's own policy screen changes the moment it is paid.
  revalidatePath("/", "layout");
  return { ok: true, message: result.message };
}
