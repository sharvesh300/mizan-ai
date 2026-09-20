// =====================================================================
// PREFERENCE SIGNALS — what the applicant told us mattered, kept over time
//
// Append-only. A signal is never UPDATEd: a later round that reads the same
// dimension differently writes a new row and stamps `superseded_at` on the
// old one, so the history IS the learning record — an advisor can see an
// applicant move from "comprehensive cover, whatever it costs" in round 1 to
// "this is more than I want to spend" in round 3, which is precisely the
// argument the negotiation loop is having.
//
// `dimension` is a `CriterionId` (lib/recommendation/types.ts), not a free
// word: a signal that cannot be pointed at a scoring criterion cannot move a
// weight. It is stored as text rather than a CHECK'd enum because the
// criterion vocabulary lives in TypeScript next to the arithmetic that reads
// it; `validateSignals` (lib/recommendation/preference.ts) is the gate, and it
// runs before anything reaches here.
// =====================================================================

import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { col, createdAt, uuidPk } from "./columns";
import { application } from "./application";

export const preferenceDirectionEnum = ["increase", "decrease"] as const;
export type PreferenceDirectionValue = (typeof preferenceDirectionEnum)[number];

export const preferenceSourceEnum = ["explicit", "clarification", "rejection", "inferred"] as const;
export type PreferenceSourceValue = (typeof preferenceSourceEnum)[number];

export const applicationPreferenceSignal = sqliteTable(
  "application_preference_signal",
  {
    id: uuidPk(),
    applicationId: text("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "cascade" }),

    /** A `CriterionId` — one of the 8 the scoring engine knows how to act on. */
    dimension: text("dimension").notNull(),
    /** How much this criterion should MATTER. Never which way its value should go — that is declared once, on the criterion itself. */
    direction: text("direction", { enum: preferenceDirectionEnum }).notNull(),
    strength: real("strength").notNull(),
    confidence: real("confidence").notNull(),
    source: text("source", { enum: preferenceSourceEnum }).notNull(),
    reason: text("reason").notNull(),

    // Provenance, same discipline as `ScenarioProvenance` in the cost engine:
    // the row this was read out of, when there was one. Null for a signal the
    // model inferred from free text nobody tagged.
    evidenceTable: text("evidence_table"),
    evidenceId: text("evidence_id"),

    /** Which recommendation round produced it — 1-based, matching `recommendation.version`. */
    round: integer("round").notNull().default(1),
    /** Set when a later round replaced this reading of the same dimension. Never deleted. */
    supersededAt: integer("superseded_at", { mode: "timestamp" }),
    createdAt: createdAt(),
  },
  (table) => [
    // The load path is always "every live signal for this application".
    index("preference_signal_application_live_idx").on(table.applicationId, table.supersededAt),
    check("preference_signal_strength_range", sql`${col("strength")} between 0 and 1`),
    check("preference_signal_confidence_range", sql`${col("confidence")} between 0 and 1`),
  ],
);
