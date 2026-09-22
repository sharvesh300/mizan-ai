// The production model for a servicing turn.
//
// The graph and the session take the model as a function (`ServicingDecider`) rather than importing one, for
// two reasons: `server-only` throws under Bun, where the check suites run the whole lifecycle, and nothing
// about a model call should ever be serialised into a checkpoint. This file is the only place the two meet:
// it wraps `structuredCall` — the same parse-validate-repair-once path intake uses — into the shape the loop
// expects. One call = one step: `{ thought, tool, args }`. The tool layer validates everything after that.
//
// No key → `servicingDecider()` returns undefined and the conversation runs on forms. A call that fails
// throws, and the loop turns that into a fallback with the reason audited; it never becomes an error page.

import "server-only";
import { z } from "zod";
import type { ServicingDecider } from "@/lib/ai/graph/nodes/servicing";
import { isAgentEnabled, MODEL_ID, PROVIDER, structuredCall } from "@/lib/ai/openrouter";

const stepSchema = z.object({
  thought: z.string().min(1).max(600),
  tool: z.string().min(1).max(60),
  args: z.unknown().optional(),
});

/** Low: this is choosing among a closed set of tools, not writing. The prose the member reads is fixed or templated. */
const TEMPERATURE = 0.2;

export const servicingProvider = { provider: PROVIDER, model: MODEL_ID };

export function servicingDecider(): ServicingDecider | undefined {
  if (!isAgentEnabled()) return undefined;
  return async ({ system, user }) => {
    const r = await structuredCall({
      system,
      user,
      schema: stepSchema,
      temperature: TEMPERATURE,
    });
    return { decision: r.value, servedBy: r.servedBy, latencyMs: r.latencyMs };
  };
}
