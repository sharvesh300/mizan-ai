// =====================================================================
// v2 · 1 · CHANNELS — one person, many addresses
// =====================================================================

import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { createdAt, uuidPk } from "./columns";
import { channelEnum } from "./enums";
import { appUser, person } from "./identity";

export const channelIdentity = sqliteTable(
  "channel_identity",
  {
    id: uuidPk(),
    userId: text("user_id").references(() => appUser.id), // null until the address is matched to a user
    personId: text("person_id").references(() => person.id), // optional: a dependant reachable on their own number
    channel: text("channel", { enum: channelEnum }).notNull(),
    address: text("address").notNull(), // E.164 for whatsapp/sms, session id for web_chat, email
    displayName: text("display_name"), // WhatsApp profile name, as reported by the provider
    verifiedAt: integer("verified_at", { mode: "timestamp" }),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    unique("channel_identity_channel_address_key").on(table.channel, table.address),
    index("channel_identity_user_id_idx").on(table.userId),
  ],
);

// Approved templates. Outside WhatsApp's 24h service window only these may be sent.
export const messageTemplate = sqliteTable(
  "message_template",
  {
    id: uuidPk(),
    name: text("name").notNull(),
    channel: text("channel", { enum: channelEnum }).notNull(),
    locale: text("locale").notNull().default("en"),
    category: text("category"), // utility / authentication / marketing
    body: text("body").notNull(),
    variables: text("variables", { mode: "json" }).$type<string[]>().notNull().default([]),
    externalId: text("external_id"), // provider-side template id
    approvedAt: integer("approved_at", { mode: "timestamp" }),
  },
  (table) => [unique("message_template_name_channel_locale_key").on(table.name, table.channel, table.locale)],
);
