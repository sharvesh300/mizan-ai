"use server";

// The member's side of a servicing conversation. Every export authorises the caller as the owner of the
// conversation (the session layer checks it against the row — a forged id is "not found"), and every input is
// validated here first: what a card reports back is a claim about which button was pressed, never data the
// server trusts. The session re-derives its meaning from its own state.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { FIELD_KEYS } from "@/lib/servicing/facts";
import { longDate } from "@/lib/servicing";
import { servicingDecider, servicingProvider } from "@/lib/ai/servicing-model";
import { handleServicingInput, openAppeal, openServicing, requestCallback } from "@/lib/ai/servicing-session";
import { getCurrentUser } from "@/lib/session";

const fieldKey = z.enum(FIELD_KEYS as unknown as [string, ...string[]]);
const short = z.string().trim().min(1).max(200);

const inputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().trim().min(1).max(2000) }),
  z.object({ kind: z.literal("chip"), fieldKey, value: short, label: short }),
  z.object({ kind: z.literal("conflict"), fieldKey, value: short, label: short }),
  z.object({ kind: z.literal("confirm") }),
  z.object({ kind: z.literal("change") }),
  // An appeal: "I don't have this" is a real answer, not silence.
  z.object({ kind: z.literal("decline_evidence") }),
  z.object({ kind: z.literal("form"), values: z.record(z.string().max(60), z.string().max(400)) }),
  z.object({ kind: z.literal("advisor") }),
]);

export type ServicingActionResult = { ok: true; href?: string } | { ok: false; message: string };

const deps = () => ({ decide: servicingDecider(), provider: servicingProvider.provider });

/**
 * Begin a conversation. Returns where it lives rather than redirecting: a server action's `redirect` is applied
 * as a fresh render of the target, which the intercepting drawer route never sees — the client `router.push`
 * is a soft navigation, so the conversation opens in the drawer like every other link to it.
 */
export async function startServicing(policyId: string, intent: "claim" | "preauth"): Promise<ServicingActionResult> {
  if (intent !== "claim" && intent !== "preauth") return { ok: false, message: "Choose whether you are claiming or checking cover." };
  const user = await getCurrentUser();
  if (!user || user.role !== "applicant") return { ok: false, message: "Only the policy holder can do this." };

  const opened = await openServicing({ userId: user.id, policyId, intent }, deps());
  if (!opened.ok) return { ok: false, message: opened.reason === "not_yet_active" ? `Your cover starts on ${longDate(opened.inceptionDate)} — come back once it has started.` : "We couldn't find that policy." };
  revalidatePath(`/policies/${policyId}`);
  return { ok: true, href: `/policies/${policyId}/service/${opened.conversationId}` };
}

/**
 * Begin an appeal of one decision. Whether it CAN be appealed is read from the log by the session — never from what this
 * call says about it — and a decision that cannot be comes back with words a member can read, not an error. Like
 * `startServicing` it returns where the conversation lives, and the client pushes to it, so it opens in the drawer.
 */
export async function startAppeal(policyId: string, eventId: string): Promise<ServicingActionResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== "applicant") return { ok: false, message: "Only the policy holder can do this." };
  if (typeof eventId !== "string" || eventId.length < 8 || eventId.length > 64) return { ok: false, message: "We couldn't find that decision." };
  const opened = await openAppeal({ userId: user.id, policyId, eventId }, deps());
  if (!opened.ok) return { ok: false, message: opened.message };
  revalidatePath(`/policies/${policyId}`);
  return { ok: true, href: `/policies/${policyId}/service/${opened.conversationId}` };
}

export async function sendServicingInput(policyId: string, conversationId: string, raw: unknown): Promise<ServicingActionResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== "applicant") return { ok: false, message: "Only the policy holder can do this." };
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "That didn't come through — please try again." };

  const outcome = await handleServicingInput(conversationId, user.id, parsed.data as Parameters<typeof handleServicingInput>[2], deps());
  revalidatePath(`/policies/${policyId}/service/${conversationId}`);
  revalidatePath(`/policies/${policyId}`);
  revalidatePath("/", "layout");
  if (!outcome.ok) return { ok: false, message: outcome.reason === "closed" ? "This conversation is finished." : "We couldn't find that conversation." };
  return { ok: true };
}

const callbackSchema = z.object({ window: z.enum(["morning", "afternoon", "evening"]), phone: z.string().trim().min(5).max(30) });

export async function requestServicingCallback(policyId: string, conversationId: string, raw: unknown): Promise<ServicingActionResult> {
  const user = await getCurrentUser();
  if (!user || user.role !== "applicant") return { ok: false, message: "Only the policy holder can do this." };
  const parsed = callbackSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: "Please enter a phone number the advisor can reach." };
  const r = await requestCallback(conversationId, user.id, parsed.data);
  revalidatePath(`/policies/${policyId}/service/${conversationId}`);
  return r.ok ? { ok: true } : { ok: false, message: "We couldn't record that request." };
}
