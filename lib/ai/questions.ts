// The question the applicant actually sees, for one field.
//
// Lifted out of the intake agent so both the graph's `ask` node and the
// callers that re-ask WITHOUT a model call (a rejected questionnaire answer
// needs the parser's own words back, not a fresh cheerful turn) read the same
// definition.
//
// The model's wording is used where it is usable; the control, the option set
// for parser-sensitive fields, the bounds and whether the field is required
// are decided here, because those are what make the answer readable again.

import { controlFor, fieldByKey, type ControlKind, type FieldSpec, type ProposedQuestion } from "@/lib/ai/fields";
import type { IntakeDraft } from "@/lib/intake";

export type PendingQuestion = {
  fieldKey: string;
  questionText: string;
  /** One-line clarification under the question. */
  helpText: string;
  control: ControlKind;
  /** Choices for radio/multi; empty for the typed controls. */
  options: string[];
  /** `block` fields cannot be skipped in the form. */
  required: boolean;
  severity: FieldSpec["severity"];
  /** Bounds for a `number` control, so the box states the range up front. */
  min?: number;
  max?: number;
};

export function buildQuestion(fieldKey: string, draft: IntakeDraft, proposal?: ProposedQuestion): PendingQuestion {
  const field = fieldByKey(fieldKey);
  const spec = controlFor(fieldKey);
  const control = spec.control;
  const tailored = !spec.fixed && proposal?.options?.length ? proposal.options : null;
  // Profile fields (age, marital status, who the cover is for, ...) keep the
  // app's own wording regardless of what the model proposed — see
  // `FieldSpec.scriptedWording`. Everything else uses the model's words when
  // it offered any, because a tailored "Cover for my diabetes" beats the
  // generic scripted prompt.
  const modelWording = !field?.scriptedWording ? proposal?.questionText?.trim() : "";

  return {
    fieldKey,
    questionText: modelWording || field?.fallbackPrompt(draft) || fieldKey,
    helpText: proposal?.helpText?.trim() ?? "",
    control,
    options: control === "radio" || control === "multi" ? (tailored ?? spec.choices ?? []) : [],
    required: field?.severity === "block",
    severity: field?.severity ?? "warn",
    min: spec.min,
    max: spec.max,
  };
}
