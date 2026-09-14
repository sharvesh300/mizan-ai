// `confirm` — nothing outstanding. Say what we have and ask for a yes.
//
// The recap is deterministic: it is `summarise(draft)`, the same words the
// scripted flow uses, so what the applicant confirms is exactly what will be
// written to the application row. The model's reply rides above it as a lead-in
// and nothing more.

import "server-only";
import { summarise } from "@/lib/intake-chat";
import type { IntakeStateType } from "@/lib/ai/graph/state";

export function confirm(state: IntakeStateType): Partial<IntakeStateType> {
  const lead = state.reply ? `${state.reply}\n\n` : "";
  return { recap: `${lead}${summarise(state.draft)}\n\nShall I send this over to an advisor?` };
}
