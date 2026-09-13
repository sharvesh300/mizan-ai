// Mirrors the Postgres `create type ... as enum (...)` declarations in the
// fwdhelm baseline schema. SQLite has no native enum type, so each tuple is
// consumed by `text(column, { enum: [...] })`, which gives the same
// compile-time union type and generates a `CHECK (col IN (...))` constraint.

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

export const reviewActionEnum = ["approve", "edit", "override", "uphold", "overturn", "request_info"] as const;
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
