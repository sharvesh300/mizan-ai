// =====================================================================
// v2 · 2 · CONVERSATION & MESSAGES — channel-agnostic
//
// `message` is append-only against deletion only (not update — `redacted`
// is a legitimate in-place flag). See db/triggers.sql `message_no_delete`.
// =====================================================================

import { desc, sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { application } from "./application";
import { channelIdentity, messageTemplate } from "./channels";
import { col, createdAt, uuidPk } from "./columns";
import {
  channelEnum,
  conversationPurposeEnum,
  conversationStatusEnum,
  deliveryStatusEnum,
  messageDirectionEnum,
  messageRoleEnum,
  messageTypeEnum,
} from "./enums";
import { appUser, person } from "./identity";
import { policy } from "./policy-ledger";

export const conversation = sqliteTable(
  "conversation",
  {
    id: uuidPk(),
    channel: text("channel", { enum: channelEnum }).notNull(),
    purpose: text("purpose", { enum: conversationPurposeEnum }).notNull(),
    status: text("status", { enum: conversationStatusEnum }).notNull().default("active"),
    locale: text("locale").notNull().default("en"),

    channelIdentityId: text("channel_identity_id").references(() => channelIdentity.id),
    userId: text("user_id").references(() => appUser.id),
    personId: text("person_id").references(() => person.id),
    applicationId: text("application_id").references(() => application.id),
    policyId: text("policy_id").references(() => policy.id),

    assignedAdvisorId: text("assigned_advisor_id").references(() => appUser.id), // set on escalation / takeover
    externalThreadId: text("external_thread_id"), // provider thread/room id
    startedAt: createdAt("started_at"),
    lastInboundAt: integer("last_inbound_at", { mode: "timestamp" }),
    lastOutboundAt: integer("last_outbound_at", { mode: "timestamp" }),
    windowExpiresAt: integer("window_expires_at", { mode: "timestamp" }), // WhatsApp 24h service window; null elsewhere
    closedAt: integer("closed_at", { mode: "timestamp" }),
  },
  (table) => [
    unique("conversation_channel_external_thread_id_key").on(table.channel, table.externalThreadId),
    index("conversation_application_id_idx").on(table.applicationId),
    index("conversation_policy_id_idx").on(table.policyId),
    index("conversation_status_last_inbound_idx").on(table.status, desc(table.lastInboundAt)),
  ],
);

export const message = sqliteTable(
  "message",
  {
    id: uuidPk(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(), // monotonic within the conversation
    direction: text("direction", { enum: messageDirectionEnum }).notNull(),
    role: text("role", { enum: messageRoleEnum }).notNull(),
    type: text("type", { enum: messageTypeEnum }).notNull().default("text"),

    bodyText: text("body_text"),
    payload: text("payload", { mode: "json" }).$type<unknown>(), // buttons / list replies / structured provider body
    templateId: text("template_id").references(() => messageTemplate.id),
    templateVariables: text("template_variables", { mode: "json" }).$type<Record<string, unknown>>(),

    provider: text("provider"), // 'meta_cloud_api', 'internal', ...
    externalMessageId: text("external_message_id"), // provider id — webhook idempotency key
    deliveryStatus: text("delivery_status", { enum: deliveryStatusEnum }).notNull().default("pending"),
    providerTimestamp: integer("provider_timestamp", { mode: "timestamp" }), // provider clock: order by this, not arrival
    receivedAt: integer("received_at", { mode: "timestamp" }),
    failedReason: text("failed_reason"),
    inReplyToMessageId: text("in_reply_to_message_id").references((): AnySQLiteColumn => message.id),
    redacted: integer("redacted", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    unique("message_conversation_id_seq_key").on(table.conversationId, table.seq),
    unique("message_provider_external_message_id_key").on(table.provider, table.externalMessageId),
    check("template_only_outbound", sql`${col("type")} <> 'template' or ${col("direction")} = 'outbound'`),
    check(
      "has_content",
      sql`${col("body_text")} is not null or ${col("payload")} is not null or ${col("template_id")} is not null or ${col("type")} = 'media'`,
    ),
    index("message_conversation_provider_ts_idx").on(table.conversationId, table.providerTimestamp),
  ],
);

export const messageMedia = sqliteTable("message_media", {
  id: uuidPk(),
  messageId: text("message_id")
    .notNull()
    .references(() => message.id, { onDelete: "cascade" }),
  mediaType: text("media_type").notNull(), // image / document / audio / video
  mimeType: text("mime_type"),
  storageUri: text("storage_uri").notNull(),
  bytes: integer("bytes"),
  sha256: text("sha256"),
  caption: text("caption"),
});
