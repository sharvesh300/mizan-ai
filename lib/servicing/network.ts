// Network tier admission — servicing_spec.md §6, machine-readable.
//
// A network is a GATE, not a discount: a provider outside it is denied, never
// paid at a worse rate. `unknown_foreign` is deliberately admitted by nothing;
// the engine never asks (an unrecognised provider is `insufficient_data`
// before the gate is reached), but if it ever did, the answer must be no.
//
// This mirrors the `network_admits` table. db/seed/check-servicing.ts asserts
// the two agree, so a change to one without the other fails loudly.

import type { ClaimProviderTier, NetworkTier, ProviderTier } from "@/db/schema/enums";

const RESTRICTED: readonly ProviderTier[] = ["in_network_clinic", "general_hospital"];
const STANDARD: readonly ProviderTier[] = [...RESTRICTED, "private_hospital"];
const WIDE: readonly ProviderTier[] = [...STANDARD, "top_tier_private_hospital", "premium_private_hospital"];

export const NETWORK_ADMITS: Readonly<Record<NetworkTier, readonly ProviderTier[]>> = {
  restricted: RESTRICTED,
  standard: STANDARD,
  wide: WIDE,
};

export const admitsTier = (network: NetworkTier, tier: ClaimProviderTier): boolean =>
  (NETWORK_ADMITS[network] as readonly string[]).includes(tier);
