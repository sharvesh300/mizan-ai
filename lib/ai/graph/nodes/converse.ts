// `converse` — hear what they said, reply like a person, work out what the
// application still needs, and ask only for that.
//
// ONE CALL PER TURN. Reading the message, replying to it and choosing what to
// ask next are the same act of understanding; splitting them made the reply
// ignorant of the questions printed underneath it, and doubled the latency on
// free models that are slow already.
//
// WHAT THE MODEL DOES NOT DECIDE: whether a required field can be skipped
// (`missingFields` is deterministic), what a value means (the same `validate`
// the web form uses re-parses everything), and which control a known field
// uses (`controlFor`). It decides understanding and wording — the parts a
// person is actually better at.

import "server-only";
import {
  fieldByKey,
  fieldCatalogue,
  GATED_FIELD_KEYS,
  labelForField,
  missingFields,
  questionCatalogue,
  turnSchema,
  type ExtractedValue,
} from "@/lib/ai/fields";
import { structuredCall } from "@/lib/ai/openrouter";
import type { AcceptedValue, IntakeStateType } from "@/lib/ai/graph/state";
import type { IntakeDraft } from "@/lib/intake";

const renderTranscript = (transcript: IntakeStateType["transcript"]) =>
  transcript.map((m) => `${m.role === "applicant" ? "Applicant" : "You"}: ${m.text}`).join("\n");

/** What we already hold, in the model's own vocabulary. */
function renderKnown(draft: IntakeDraft): string {
  const lines = [
    draft.subjectRelationship ? `${labelForField("person.relationship")}: ${draft.subjectRelationship}` : null,
    draft.subjectFullName ? `${labelForField("person.full_name")}: ${draft.subjectFullName}` : null,
    draft.age != null ? `${labelForField("application.age")}: ${draft.age}` : null,
    draft.maritalStatus ? `${labelForField("application.marital_status")}: ${draft.maritalStatus}` : null,
    draft.smoker != null ? `${labelForField("application.smoker")}: ${draft.smoker ? "yes" : "no"}` : null,
    draft.emirate ? `${labelForField("application.emirate")}: ${draft.emirate}` : null,
    draft.budget ? `${labelForField("application.budget")}: ${draft.budget}` : null,
    draft.policyInception ? `${labelForField("application.policy_inception")}: ${draft.policyInception}` : null,
    draft.conditions.length
      ? `${labelForField("condition.raw_text")}: ${draft.conditions.map((c) => `${c.rawText} (${c.stability})`).join(", ")}`
      : null,
    draft.needs.length
      ? `${labelForField("need.benefit_class")}: ${draft.needs
          .map((n) => `${n.rawText}${n.horizonMonths != null ? ` in ~${n.horizonMonths} months` : ""}`)
          .join(", ")}`
      : null,
    draft.priorities.length
      ? `${labelForField("priority.raw_text")}: ${draft.priorities.map((p) => p.rawText).join(", ")}`
      : null,
  ].filter(Boolean);
  return lines.length ? lines.join("\n") : "nothing yet";
}

const SYSTEM = `You are the intake assistant for Mizan, a UAE health insurance broker. You are talking to someone who wants cover, in a chat window.

HOW YOU TALK
- Like a warm, competent human being. Short sentences. No corporate filler, no "I appreciate you sharing that".
- Reply to what they actually said. If they mention a baby on the way or a condition they live with, respond to THAT before anything else.
- Never re-ask something they already told you. Reading it twice is the fastest way to lose someone's trust.
- Never promise cover, prices or acceptance. An advisor decides those, always.
- 1-2 sentences. You are not writing a letter.
- Your reply must NOT contain a question. The questionnaire underneath it does the asking; a question in both places reads as if you were not listening.

WHAT YOU ARE DOING
Quietly filling in an application while you talk. Two jobs each turn:

1. "values" — pull out ONLY what they actually said.
   - "rawSpan" must be their exact words, copied from their message.
   - "inferred": true if you are guessing rather than reporting. Be honest; guessed answers to the important fields are thrown away, and a wrong guess about someone's health is worse than an extra question.
   - One entry per field. For several conditions or needs, put them in one entry separated by commas.
   - They said nothing extractable? Send an empty list. That is a correct answer.

2. "questions" — a short questionnaire for what is still missing.
   - ONLY the field keys listed as missing. Never invent one.
   - Ask for everything outstanding in one go — they fill it in as a small form, so this is not an interrogation, it is one page of questions.
   - Where options are marked "use these exactly", use them exactly. Where they are marked "you may tailor these", make them specific to this person — "Cover for my diabetes" beats "Cover for an existing condition".
   - Fields marked "wording fixed" already have a settled question the app will show verbatim (age, marital status, who the cover is for, and the other profile fields) — set their "questionText" to "" rather than composing one. Whether the field is asked at all is not yours to decide; it is included whenever it is missing regardless of what you send.
   - "helpText" is one short line, or empty. Most questions do not need it.
   - Nothing missing? Send an empty list and say so warmly in your reply.

ANSWER FORMAT
Return ONE JSON object, nothing else. No code fences, no commentary.
{"reply": "...", "values": [{"fieldKey": "...", "value": "...", "rawSpan": "...", "confidence": 0.9, "inferred": false}], "questions": [{"fieldKey": "...", "questionText": "...", "helpText": "", "control": "radio", "options": ["..."]}]}

Every field key you may ever use:
${fieldCatalogue()}`;

/**
 * One model call: understand, reply, propose questions. Then validate
 * everything it claimed against the deterministic parsers.
 *
 * On any failure this returns empty-handed rather than throwing — `ask` still
 * has the scripted wording to fall back on, so a bad model turn costs the
 * applicant a less chatty question, never their place in the conversation.
 */
export async function converse(state: IntakeStateType): Promise<Partial<IntakeStateType>> {
  // A questionnaire submission is already structured — its answers were mapped
  // to fields by the caller, and re-reading the transcript would only re-derive
  // what is already recorded.
  const missing = missingFields(state.draft, new Set(state.settled)).slice(0, 6);

  if (state.skipExtraction && missing.length === 0) return { reply: "", accepted: [], rejected: [] };

  const user = [
    `Conversation so far:\n${renderTranscript(state.transcript)}`,
    `\nAlready recorded (do NOT ask about these again):\n${renderKnown(state.draft)}`,
    missing.length
      ? `\nStill missing — ask for these:\n${questionCatalogue(missing.map((f) => f.key))}`
      : `\nNothing is missing. Send an empty "questions" list and tell them you have everything.`,
  ].join("\n");

  let result;
  try {
    result = await structuredCall({ system: SYSTEM, user, schema: turnSchema });
  } catch (error) {
    console.error("[intake-agent] turn failed", error);
    return { reply: "", accepted: [], rejected: [], proposed: [] };
  }

  const accepted: AcceptedValue[] = [];
  const rejected: ExtractedValue[] = [];
  // What the parser refused, in its words — the applicant is told, rather than
  // being re-asked the same question with no hint that their answer bounced.
  const retries: string[] = [];
  let draft = state.draft;

  for (const value of state.skipExtraction ? [] : result.value.values) {
    const field = fieldByKey(value.fieldKey);
    if (!field) continue;

    // A gating field with no textual basis at all (empty rawSpan, inferred)
    // is genuinely fabricated — reject it without giving it to the validator.
    const rawSpanPresent = value.rawSpan.trim().length > 0;
    if (value.inferred && !rawSpanPresent && GATED_FIELD_KEYS.has(value.fieldKey)) {
      rejected.push(value);
      continue;
    }
    if (!rawSpanPresent) {
      rejected.push(value);
      continue;
    }

    // The LLM already did the semantic work ("my daughter" → "child",
    // "I don't want anything expensive" → "low"). The validator checks the
    // pre-normalised value is in-enum / in-range and writes it to the draft.
    // It does NOT parse English — that is the LLM's job.
    const applied = field.validate(draft, value.value, value.rawSpan);
    if (!applied.ok) {
      rejected.push(value);
      if (!retries.includes(applied.retry)) retries.push(applied.retry);
      continue;
    }

    // Re-emitting a value already on the draft would write a second extraction
    // row saying the same thing. The transcript only grows, so without this the
    // audit trail fills with duplicates of the applicant's first answer.
    if (JSON.stringify(applied.draft) === JSON.stringify(draft)) continue;

    draft = applied.draft;
    accepted.push({
      ...value,
      valueText: applied.valueText,
      // rawSpan === valueText only when the applicant stated the normalised
      // form verbatim (e.g. typed "child" exactly). For everything else the
      // LLM did the normalisation — mark it as such for the replay path.
      method: value.rawSpan.trim() === applied.valueText ? "stated" : "normalised",
    });
  }

  return {
    draft,
    accepted,
    rejected,
    proposed: result.value.questions,
    reply: [result.value.reply?.trim() ?? "", ...retries].filter(Boolean).join("\n\n"),
    servedBy: result.servedBy,
    latencyMs: result.latencyMs,
  };
}

/** Deterministic: does this draft still need anything? */
export function gaps(state: IntakeStateType): "ask" | "confirm" {
  return missingFields(state.draft, new Set(state.settled)).length > 0 ? "ask" : "confirm";
}
