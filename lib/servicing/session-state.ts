// What a servicing conversation remembers between turns.
//
// Durable state is ROWS, not graph memory (plan §6): every turn loads this from the latest
// `servicing_state` action row, rebuilds a tool context, runs one pass, and writes the result back. So a
// reload, a second device, or a server restart three days later all resume in the same place — and the
// graph itself holds nothing across turns.
//
// It comes out of a JSON column, so it is PARSED, never cast: a corrupted or hand-edited row must fail
// closed into "start again", not into an adjudication against a draft nobody validated.

import { z } from "zod";
import { benefitClassEnum, reasonCodeEnum } from "@/db/schema/enums";
import { EVIDENCE_KINDS } from "./appeal";
import { FIELD_KEYS, type Draft, type Fact, type FieldKey, type Intent } from "./facts";

const fact = z.strictObject({
  value: z.union([z.string(), z.number(), z.boolean()]),
  source: z.enum(["stated", "inferred", "record", "document"]),
  quote: z.string(),
});
const fieldKey = z.enum(FIELD_KEYS);

const draftSchema = z.strictObject({
  intent: z.enum(["preauth", "claim"]),
  facts: z.partialRecord(fieldKey, fact),
  benefitClass: z
    .strictObject({ value: z.enum(benefitClassEnum), declaredCondition: z.string().nullable(), by: z.enum(["agent", "member"]) })
    .nullable(),
  conflicts: z.array(z.strictObject({ fieldKey, a: fact, b: fact, resolved: z.boolean() })),
  confirmed: z.boolean(),
});

const evidenceKind = z.enum(EVIDENCE_KINDS);

/**
 * An appeal's memory between turns (plan §5.4). Everything is rows, so a reload three days later resumes at the same
 * evidence request. What is NOT here is the verdict: `remainingKinds`, the admissibility and the re-adjudication are all
 * recomputed from this and the log, so nothing derived can go stale.
 */
export const appealStateSchema = z.strictObject({
  contestedEventId: z.string(),
  contestedRef: z.string(),
  contestedReason: z.enum(reasonCodeEnum),
  /** What the member sent, verbatim, in order. `assess_evidence` refers to these by index. */
  evidence: z.array(z.string()),
  assessments: z.array(
    z.strictObject({
      evidenceIndex: z.number().int().min(0),
      verdict: z.enum(["bears_on", "does_not_bear_on"]),
      kind: z.union([evidenceKind, z.literal("none")]),
      quote: z.string().nullable(),
      why: z.string(),
    }),
  ),
  /** Kinds a piece of evidence showed. */
  supplied: z.array(evidenceKind),
  /** Kinds the member said they do not have. */
  declined: z.array(evidenceKind),
  /** Kinds asked for, one entry per request — a kind asked twice is not asked again. */
  requested: z.array(evidenceKind),
  /** The evidence request on screen right now, waiting on the member. */
  openRequest: evidenceKind.nullable(),
  /** Evidence bore on the finding and a correction is what comes next. */
  pendingCorrection: evidenceKind.nullable(),
  /** The finding was explained and the member's first request made — the conversation has begun. */
  begun: z.boolean(),
});
export type AppealState = z.infer<typeof appealStateSchema>;

export const sessionStateSchema = z.strictObject({
  version: z.literal(1),
  intent: z.enum(["preauth", "claim", "appeal"]),
  /** The reference this event will carry (CLM-… / PRE-…), reserved when the conversation opens. */
  eventRef: z.string().min(3),
  draft: draftSchema,
  /** The field a question is waiting on. */
  openQuestion: fieldKey.nullable(),
  awaitingConfirmation: z.boolean(),
  providerUnsure: z.boolean(),
  clarificationCount: z.number().int().min(0),
  phase: z.enum(["collecting", "done", "escalated", "awaiting_signoff"]),
  committedEventId: z.string().nullable(),
  /**
   * The member asked to change something and has not been shown a fresh confirmation since. While it is set, a
   * fallback opens the PREFILLED form rather than the confirm card: otherwise a change they typed to a model that
   * then failed would be silently dropped, and the old details put in front of them again.
   */
  changing: z.boolean().default(false),
  /** Set only for an appeal; the claim draft above is then unused. */
  appeal: appealStateSchema.nullable().default(null),
});

export type ServicingSessionState = z.infer<typeof sessionStateSchema>;

export const initialSessionState = (intent: Intent, eventRef: string, appeal: AppealState | null = null): ServicingSessionState => ({
  version: 1,
  intent,
  eventRef,
  draft: { intent, facts: {}, benefitClass: null, conflicts: [], confirmed: false },
  openQuestion: null,
  awaitingConfirmation: false,
  providerUnsure: false,
  clarificationCount: 0,
  phase: "collecting",
  committedEventId: null,
  changing: false,
  appeal,
});

/** Null when the row is not a valid state: the caller treats that as "cannot resume", never as "empty". */
export function parseSessionState(raw: unknown): ServicingSessionState | null {
  const parsed = sessionStateSchema.safeParse(raw);
  return parsed.success ? (parsed.data as ServicingSessionState) : null;
}

/** Facts that are new or different since `before` — the ones that need a provenance row. */
export function changedFacts(before: Draft, after: Draft): { key: FieldKey; fact: Fact }[] {
  const out: { key: FieldKey; fact: Fact }[] = [];
  for (const key of FIELD_KEYS) {
    const b = before.facts[key];
    const a = after.facts[key];
    if (a && (!b || b.value !== a.value || b.source !== a.source || b.quote !== a.quote)) out.push({ key, fact: a });
  }
  return out;
}
