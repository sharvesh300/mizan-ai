// Mirrors the Postgres `create type ... as enum (...)` declarations in the
// fwdhelm baseline schema. SQLite has no native enum type, so each tuple is
// consumed by `text(column, { enum: [...] })`, which gives the same
// compile-time union type. It is TS-only — unlike Postgres, SQLite/drizzle
// does not enforce membership at the database level, so invalid values
// written outside the TS layer (raw SQL, another client) are not rejected.

export const userRoleEnum = ["applicant", "advisor"] as const;
export type UserRole = (typeof userRoleEnum)[number];

export const relationshipTypeEnum = ["self", "spouse", "parent", "child", "other"] as const;
export type RelationshipType = (typeof relationshipTypeEnum)[number];

export const maritalStatusEnum = ["single", "married", "divorced", "widowed"] as const;
export type MaritalStatus = (typeof maritalStatusEnum)[number];

export const budgetBandEnum = ["low", "moderate", "comfortable", "not_a_concern"] as const;
export type BudgetBand = (typeof budgetBandEnum)[number];

export const intakeSourceEnum = ["web_form", "chat", "voice", "advisor_manual", "imported_fixture"] as const;
export type IntakeSource = (typeof intakeSourceEnum)[number];

// full pipeline lifecycle; transitions are enumerated in SCHEMA.md §2.3
export const applicationStatusEnum = [
  "draft",
  "in_intake",
  "submitted",
  "confirmed",
  "assessed",
  "quoted",
  "recommended",
  "in_review",
  "approved",
  "plan_selected",
  "policy_issued",
  "withdrawn",
  "declined",
  "expired",
] as const;
export type ApplicationStatus = (typeof applicationStatusEnum)[number];

export const conditionStabilityEnum = ["managed", "unstable", "unknown"] as const;
export type ConditionStability = (typeof conditionStabilityEnum)[number];

export const benefitClassEnum = ["general", "maternity", "chronic_preexisting", "dental_optical"] as const;
export type BenefitClass = (typeof benefitClassEnum)[number];

export const priorityTagEnum = [
  "premium",
  "network_access",
  "chronic_depth",
  "maternity",
  "outpatient_terms",
  "other",
] as const;
export type PriorityTag = (typeof priorityTagEnum)[number];

export const networkTierEnum = ["restricted", "standard", "wide"] as const;
export type NetworkTier = (typeof networkTierEnum)[number];

export const providerTierEnum = [
  "in_network_clinic",
  "general_hospital",
  "private_hospital",
  "top_tier_private_hospital",
  "premium_private_hospital",
] as const;
export type ProviderTier = (typeof providerTierEnum)[number];

// What a CLAIM may carry, which is not the same set. `provider_tier` above is
// the network-admission vocabulary — the five tiers `network_admits` maps and
// a plan's network gate is evaluated against. A submitted claim can name a
// provider that sits outside that vocabulary entirely (CLM-9: a foreign
// provider, tier unknown), and that is not a sixth tier the gate can admit or
// refuse — it is the absence of a tier. Kept as a separate enum so
// `network_admits` and the gate stay closed over the five real tiers.
export const claimProviderTierEnum = [...providerTierEnum, "unknown_foreign"] as const;
export type ClaimProviderTier = (typeof claimProviderTierEnum)[number];

// Geographic scope is THE undefined case in the supplied data (servicing_spec
// §4). The column exists so the adjudicator can SEE 'abroad' and return
// `insufficient_data` off it, rather than inventing a rule or silently
// treating a foreign claim as domestic.
export const geographyEnum = ["uae", "abroad", "unknown"] as const;
export type Geography = (typeof geographyEnum)[number];

export const dentalOpticalTierEnum = ["none", "basic", "full"] as const;
export type DentalOpticalTier = (typeof dentalOpticalTierEnum)[number];

export const flagSeverityEnum = ["block", "review", "warn"] as const;
export type FlagSeverity = (typeof flagSeverityEnum)[number];

export const confidenceLevelEnum = ["high", "medium", "low"] as const;
export type ConfidenceLevel = (typeof confidenceLevelEnum)[number];

export const actorKindEnum = ["system", "advisor", "applicant"] as const;
export type ActorKind = (typeof actorKindEnum)[number];

export const recoStatusEnum = ["pending_review", "approved", "edited", "overridden", "superseded"] as const;
export type RecoStatus = (typeof recoStatusEnum)[number];

export const reviewSubjectEnum = ["application", "recommendation", "servicing_event", "reassessment"] as const;
export type ReviewSubject = (typeof reviewSubjectEnum)[number];

export const reviewStatusEnum = ["open", "in_progress", "resolved"] as const;
export type ReviewStatus = (typeof reviewStatusEnum)[number];

// `reject` is additive to the baseline: an advisor closing an application
// down is a real decision and needs its own verb, distinct from `override`
// (which replaces the system's answer with a different one). SQLite stores
// these as text, so widening the tuple is a TS-only change — no migration.
export const reviewActionEnum = [
  "approve",
  "edit",
  "override",
  "reject",
  "uphold",
  "overturn",
  "request_info",
] as const;
export type ReviewAction = (typeof reviewActionEnum)[number];

export const policyStatusEnum = ["active", "lapsed", "cancelled"] as const;
export type PolicyStatus = (typeof policyStatusEnum)[number];

export const eventKindEnum = ["claim", "preauth", "reimbursement", "appeal"] as const;
export type EventKind = (typeof eventKindEnum)[number];

export const careSettingEnum = ["inpatient", "outpatient"] as const;
export type CareSetting = (typeof careSettingEnum)[number];

export const eventOutcomeEnum = [
  "covered",
  "denied",
  "approved_with_limit",
  "insufficient_data",
  "upheld",
  "overturned",
] as const;
export type EventOutcome = (typeof eventOutcomeEnum)[number];

export const reasonCodeEnum = [
  "covered",
  "policy_not_active",
  "benefit_excluded",
  "waiting_period_not_elapsed",
  "provider_out_of_network",
  "sublimit_exhausted",
  "annual_limit_reached",
  "insufficient_data",
] as const;
export type ReasonCode = (typeof reasonCodeEnum)[number];

export const fitVerdictEnum = ["confirm", "recommend_change"] as const;
export type FitVerdict = (typeof fitVerdictEnum)[number];

// =====================================================================
// v2 · AI & CONVERSATION LAYER — additive, see db/schema/{channels,
// conversation,questions,actions,ai-decision,extraction,ai-views}.ts
// =====================================================================

export const channelEnum = ["web_chat", "whatsapp", "voice", "sms", "email", "advisor_console"] as const;
export type Channel = (typeof channelEnum)[number];

export const conversationPurposeEnum = ["intake", "servicing", "support", "notification"] as const;
export type ConversationPurpose = (typeof conversationPurposeEnum)[number];

export const conversationStatusEnum = [
  "active",
  "awaiting_user",
  "awaiting_review",
  "escalated",
  "completed",
  "abandoned",
  "expired",
] as const;
export type ConversationStatus = (typeof conversationStatusEnum)[number];

export const messageDirectionEnum = ["inbound", "outbound"] as const;
export type MessageDirection = (typeof messageDirectionEnum)[number];

export const messageRoleEnum = ["applicant", "assistant", "advisor", "system"] as const;
export type MessageRole = (typeof messageRoleEnum)[number];

export const messageTypeEnum = ["text", "template", "interactive", "media", "location", "system_event"] as const;
export type MessageType = (typeof messageTypeEnum)[number];

export const deliveryStatusEnum = ["pending", "sent", "delivered", "read", "failed", "received"] as const;
export type DeliveryStatus = (typeof deliveryStatusEnum)[number];

export const questionStatusEnum = ["asked", "answered", "declined", "skipped", "superseded", "expired"] as const;
export type QuestionStatus = (typeof questionStatusEnum)[number];

export const actionStatusEnum = ["pending", "succeeded", "failed", "rejected"] as const;
export type ActionStatus = (typeof actionStatusEnum)[number];

export const extractionMethodEnum = ["stated", "normalised", "inferred"] as const;
export type ExtractionMethod = (typeof extractionMethodEnum)[number];

export const modelRunStatusEnum = ["ok", "error", "timeout", "filtered"] as const;
export type ModelRunStatus = (typeof modelRunStatusEnum)[number];

export const aiDecisionTypeEnum = [
  "intake_extraction",
  "field_normalisation",
  "question_selection",
  "cohort_classification",
  "flag_evaluation",
  "plan_recommendation",
  "benefit_classification",
  "evidence_classification",
  "appeal_assessment",
  "fit_reassessment",
  "explanation_generation",
  "routing",
] as const;
export type AiDecisionType = (typeof aiDecisionTypeEnum)[number];

export const aiDecisionStatusEnum = [
  "proposed",
  "auto_accepted",
  "accepted",
  "edited",
  "rejected",
  "superseded",
] as const;
export type AiDecisionStatus = (typeof aiDecisionStatusEnum)[number];
