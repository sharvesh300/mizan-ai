"use server";

// Ledger maintenance — BROKER ONLY.

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/session";
import { rebuildLedger } from "@/lib/servicing/store";

/**
 * Rebuild a policy's ledger from its event log. Replays the history and writes the
 * result through the store, the only writer of `benefit_ledger`. It never edits the
 * log, so it cannot change what happened — only repair a projection that drifted.
 */
export async function rebuildLedgerAction(policyId: string): Promise<void> {
  const user = await getCurrentUser();
  if (!user || user.role !== "advisor") throw new Error("Only an advisor can rebuild a ledger.");
  await rebuildLedger(policyId);
  revalidatePath(`/policies/${policyId}`);
}
