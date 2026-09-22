// Loop limits for the servicing agent (docs/servicing_agent_plan.md §7).
//
// They come from configuration, not from a constant at a call site. The
// defaults below are defaults, not rules — an environment that sets a value
// gets that value. A value that is set but not a positive integer throws:
// a limit that silently falls back to a default is a limit nobody knows the
// real value of, and these are the numbers that decide when a member is
// handed to a human.

export type Limits = {
  /** Questions the agent may ask the member for one event before escalating. */
  clarificationRounds: number;
  /** Times the agent may ask for a document for one event before escalating. */
  evidenceRequestRounds: number;
  /** Times a plan-fit reassessment may be re-run for one policy before escalating. */
  reassessmentRounds: number;
  /** Tool calls in one agent turn. */
  toolCallsPerTurn: number;
};

const DEFAULTS: Limits = {
  clarificationRounds: 5,
  evidenceRequestRounds: 3,
  reassessmentRounds: 2,
  toolCallsPerTurn: 10,
};

const ENV_NAMES: Record<keyof Limits, string> = {
  clarificationRounds: "SERVICING_MAX_CLARIFICATION_ROUNDS",
  evidenceRequestRounds: "SERVICING_MAX_EVIDENCE_REQUEST_ROUNDS",
  reassessmentRounds: "SERVICING_MAX_REASSESSMENT_ROUNDS",
  toolCallsPerTurn: "SERVICING_MAX_TOOL_CALLS",
};

export function readLimits(env: Record<string, string | undefined> = process.env): Limits {
  const out = { ...DEFAULTS };
  for (const key of Object.keys(ENV_NAMES) as (keyof Limits)[]) {
    const name = ENV_NAMES[key];
    const raw = env[name]?.trim();
    if (raw === undefined || raw === "") continue;
    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
      throw new Error(`${name} must be a positive integer, got "${raw}"`);
    }
    out[key] = Number(raw);
  }
  return out;
}

let cached: Limits | null = null;

/** The limits for this process. Read once; call `readLimits(env)` directly to test with another environment. */
export const limits = (): Limits => (cached ??= readLimits());
