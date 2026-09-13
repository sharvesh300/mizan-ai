// =====================================================================
// 3 · CATALOGUE — supplied plan schema kept field-for-field
// =====================================================================

import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { amount, col } from "./columns";
import { dentalOpticalTierEnum, networkTierEnum, providerTierEnum } from "./enums";

export const carrier = sqliteTable("carrier", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

export const plan = sqliteTable(
  "plan",
  {
    id: text("id").primaryKey(), // 'plan_a' — supplied ids kept verbatim
    carrierId: text("carrier_id").references(() => carrier.id),
    name: text("name").notNull(),
    annualPremium: amount("annual_premium").notNull(),
    deductible: amount("deductible").notNull(),
    network: text("network", { enum: networkTierEnum }).notNull(),
    networkNote: text("network_note"),
    outpatientCopayPct: amount("outpatient_copay_pct").notNull(),
    annualLimit: amount("annual_limit").notNull(),
    dentalOptical: text("dental_optical", { enum: dentalOpticalTierEnum }).notNull(),

    maternityCovered: integer("maternity_covered", { mode: "boolean" }).notNull(),
    maternityWaitingPeriodMonths: integer("maternity_waiting_period_months"),
    maternityLimit: amount("maternity_limit"),

    chronicCovered: integer("chronic_covered", { mode: "boolean" }).notNull(),
    chronicWaitingPeriodMonths: integer("chronic_waiting_period_months"),

    effectiveFrom: text("effective_from"),
    effectiveTo: text("effective_to"),
  },
  // No `table` param: every reference inside a CHECK is unqualified by design.
  () => [
    check(
      "maternity_terms_present",
      sql`not ${col("maternity_covered")} or (${col("maternity_waiting_period_months")} is not null and ${col("maternity_limit")} is not null)`,
    ),
    check(
      "chronic_terms_present",
      sql`not ${col("chronic_covered")} or ${col("chronic_waiting_period_months")} is not null`,
    ),
  ],
);

// provider_tiers from the fixture, as a joinable table (§4 step 4)
export const networkAdmits = sqliteTable(
  "network_admits",
  {
    network: text("network", { enum: networkTierEnum }).notNull(),
    providerTier: text("provider_tier", { enum: providerTierEnum }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.network, table.providerTier] })],
);
