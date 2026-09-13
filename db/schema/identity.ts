// =====================================================================
// 1 · IDENTITY — who acts, and who is insured (two different things)
// =====================================================================

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, uuidPk } from "./columns";
import { maritalStatusEnum, relationshipTypeEnum, userRoleEnum } from "./enums";

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
