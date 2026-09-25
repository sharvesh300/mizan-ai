// Mirrors the Postgres `create type ... as enum (...)` declarations in the
// fwdhelm baseline schema. SQLite has no native enum type, so each tuple is
// consumed by `text(column, { enum: [...] })`, which gives the same
// compile-time union type. It is TS-only — unlike Postgres, SQLite/drizzle
// does not enforce membership at the database level, so invalid values
// written outside the TS layer (raw SQL, another client) are not rejected.

export const userRoleEnum = ["applicant", "advisor"] as const;
export type UserRole = (typeof userRoleEnum)[number];

export const identityProviderEnum = ["uae_pass"] as const;
export type IdentityProvider = (typeof identityProviderEnum)[number];

// UAE PASS account tiers: SOP1 basic, SOP2 verified, SOP3 verified in person.
export const uaePassAssuranceEnum = ["SOP1", "SOP2", "SOP3"] as const;
export type UaePassAssurance = (typeof uaePassAssuranceEnum)[number];

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

// `conversation` is additive: a member who asks for a person BEFORE anything is adjudicated (or whose case
// stalls on a question) has no servicing event to hang a task on, and a hand-off with no task is a promise
// nobody will keep. SQLite stores these as text, so widening the tuple is a TS-only change — no migration.
// `settlement` is additive for the same reason: a payout waiting on a person is not a question about the
// adjudication (that is settled), so it cannot hang off `servicing_event` without the queue reading it as a
// dispute about the decision. It is a task about MONEY LEAVING, which is a different kind of attention.
export const reviewSubjectEnum = ["application", "recommendation", "servicing_event", "reassessment", "conversation", "settlement"] as const;
export type ReviewSubject = (typeof reviewSubjectEnum)[number];

/**
 * A payout's life, which is NOT an adjudication (plan §5: the ledger is a projection of what the plan OWES;
 * this records what it actually PAID). Adjudication decides the amount; these three states are about the money
 * leaving, and none of them may ever move a ledger or change a replay.
 */
export const settlementStatusEnum = ["awaiting_approval", "approved", "paid"] as const;
export type SettlementStatus = (typeof settlementStatusEnum)[number];

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
  // Servicing hand-offs (plan §13.3.2): a person answering a case the agent could not settle. Additive, TS-only.
  "reply",
  "resolve",
  "hand_off",
  "called",
  // Settlement (§payouts): approving what the plan owes, and recording that it actually left. Two verbs, not
  // one — authorising a payment and making it are different acts, on different days, by possibly different
  // people, and a record that cannot tell them apart cannot answer "was this paid?". Additive, TS-only.
  "approve_payment",
  "mark_paid",
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

// `clarification_required` is additive to the baseline: a recommendation round
// that asked the applicant one clarifying question instead of proposing a
// shortlist (lib/ai/graph/nodes/clarify.ts) needs its own resting state distinct
// from `proposed` — it is not awaiting an advisor's approve/edit/reject, it is
// awaiting the applicant's answer, and it must supersede cleanly once round 2
// writes a real decision. SQLite stores these as text, so widening the tuple is
// a TS-only change — no migration (same discipline reviewActionEnum documents).
export const aiDecisionStatusEnum = [
  "proposed",
  "auto_accepted",
  "accepted",
  "edited",
  "rejected",
  "superseded",
  "clarification_required",
] as const;
export type AiDecisionStatus = (typeof aiDecisionStatusEnum)[number];
