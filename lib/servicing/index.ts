// The servicing engine — pure, no I/O. See docs/servicing_agent_plan.md §3.

export { adjudicate } from "./adjudicate";
export { addMonths, isRealDate, longDate, monthOfDate, monthYear, policyMonthStart, policyYearEndsOn, waitClearsOn } from "./dates";
export { explain, type ExplainInput, type Explanation } from "./explain-template";
export { benefitClassLabel, benefitClassPhrase, eventKindWord, providerTypeLabel, providerTypePlural } from "./labels";
export { cloneLedger, compareLedgers, emptyLedger, ledgerToJson } from "./ledger";
export { EVIDENCE_THAT_COULD_CHANGE, nextStepFacts, type NextStepFacts } from "./next-steps";
export { limits, readLimits, type Limits } from "./limits";
export { NETWORK_ADMITS, admitsTier } from "./network";
export { effectOrder, effectPositions, project, replay } from "./replay";
export type {
  AdjudicationInput,
  AdjudicationResult,
  ClippedBy,
  LedgerState,
  Replay,
  ReplayEvent,
  ReplayStep,
} from "./types";
export * from "./cards";
export { ESCALATION_CAUSES, ESCALATION_MEANING, type EscalationCause } from "./escalation";
export {
  FIELD_KEYS,
  FIELD_LABEL,
  REQUIRED_FIELDS,
  OPTIONAL_FIELDS,
  FACT_VALUE,
  completeness,
  emptyDraft,
  fieldsFor,
  kindOf,
  numbersIn,
  observedNumbers,
  toAdjudicationInput,
  type Conflict,
  type Draft,
  type Fact,
  type FactSource,
  type FieldKey,
  type Intent,
} from "./facts";
export { INTERNAL_REF, MEMBER_BANNED, TIME_PROMISES, memberCopyViolations } from "./copy-rules";
export { interpretForm, type FormEntry, type FormKey, type FormReading } from "./form";
export { CONFIDENCE_VALUE, buildEventDraft, type Confidence, type EventDraft } from "./commit";
export { appealStateSchema, changedFacts, initialSessionState, parseSessionState, sessionStateSchema, type AppealState, type ServicingSessionState } from "./session-state";
export {
  ADMISSIBILITY,
  APPEAL_EXIT_TEXT,
  CORRECTABLE_FIELDS,
  EVIDENCE_KINDS,
  MAX_REQUESTS_PER_KIND,
  adjudicateAt,
  admissibilityFor,
  admissibleKinds,
  compareOutcome,
  currentValue,
  evidenceClause,
  evidenceClauseBroker,
  identifyContested,
  kindInfo,
  kindMarkerProblem,
  reAdjudicate,
  remainingKinds,
  validateCorrection,
  type AdmissibleKind,
  type Admissibility,
  type AppealExit,
  type Contested,
  type ContestedRow,
  type Correction,
  type CorrectableField,
  type EvidenceKind,
  type EvidenceLedger,
  type ReAdjudication,
} from "./appeal";
export { buildOverturnDraft, buildUpheldDraft, parseOverturnProposal, overturnProposalSchema, type AppealEventDraft, type OverturnProposal } from "./appeal-commit";
export { buildCoverDraft, buildDenyDraft, checkMemberMessage, defaultDenyMessage, type HandDraft, type HandSource } from "./handoff";
export {
  computeVerdict,
  extractFitFeatures,
  type AppealAttempt,
  type Citable,
  type FitFeatures,
  type ReassessEvent,
  type Verdict,
} from "./reassess";
export { buildHindsightTable, type HindsightRow } from "./reassess";
export { buildReassessmentProse, hindsightCaption, type Citation, type ReassessmentProse } from "./reassess-template";
export { canApprove, canMarkPaid, memberSettlementLine, owesPayment, payeeOf, refusalFor, type DecidedEvent, type Payee } from "./settlement";
