// =====================================================================
// 1 · IDENTITY — who acts, and who is insured (two different things)
// =====================================================================

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, uuidPk } from "./columns";
import {
  identityProviderEnum,
  maritalStatusEnum,
  relationshipTypeEnum,
  uaePassAssuranceEnum,
  userRoleEnum,
} from "./enums";

export const appUser = sqliteTable("app_user", {
  id: uuidPk(),
  role: text("role", { enum: userRoleEnum }).notNull(),
  fullName: text("full_name").notNull(),
  email: text("email").notNull().unique(),
  phone: text("phone"),
  createdAt: createdAt(),
});

// A person is the SUBJECT of cover. Never a login.
export const person = sqliteTable(
  "person",
  {
    id: uuidPk(),
    externalRef: text("external_ref").unique(), // 'P1'..'P5' for the supplied fixtures
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => appUser.id),
    relationshipToOwner: text("relationship_to_owner", { enum: relationshipTypeEnum }).notNull().default("self"),
    fullName: text("full_name").notNull(),
    dateOfBirth: text("date_of_birth"),
    maritalStatus: text("marital_status", { enum: maritalStatusEnum }),
    smoker: integer("smoker", { mode: "boolean" }),
    emirate: text("emirate"),
    createdAt: createdAt(),
    updatedAt: createdAt("updated_at"),
  },
  (table) => [index("person_owner_user_id_idx").on(table.ownerUserId)],
);

// A UAE PASS verification of an account holder. One row per time they
// verified; disconnecting stamps `revoked_at` rather than deleting, so the
// record of "this person was verified on this date" survives. The current
// verification is the newest un-revoked row (rowid breaks a same-second tie).
//
// MVP: the provider is mocked (lib/uae-pass.ts). The columns are the claims a
// real UAE PASS userinfo response carries, so swapping in the real OAuth
// exchange changes where the values come from, not where they land.
export const identityVerification = sqliteTable(
  "identity_verification",
  {
    id: uuidPk(),
    userId: text("user_id")
      .notNull()
      .references(() => appUser.id),
    provider: text("provider", { enum: identityProviderEnum }).notNull().default("uae_pass"),
    subject: text("subject").notNull(), // UAE PASS `uuid` — stable per citizen/resident
    /** SOP1 basic · SOP2 verified · SOP3 verified in person / biometric. */
    assuranceLevel: text("assurance_level", { enum: uaePassAssuranceEnum }).notNull(),
    /** Emirates ID, masked at rest — only the last five digits are kept. */
    emiratesIdMasked: text("emirates_id_masked").notNull(),
    fullNameEn: text("full_name_en").notNull(),
    dateOfBirth: text("date_of_birth"),
    mobile: text("mobile"),
    email: text("email"),
    verifiedAt: createdAt("verified_at"),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
  },
  (table) => [index("identity_verification_user_id_idx").on(table.userId)],
);
