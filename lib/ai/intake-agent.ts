// The intake agent.
//
//   converse ──> gaps ──┬──> ask     (interrupt: hand control back to the human)
//                       └──> confirm (nothing missing — recap and submit)
//
// The applicant talks first and keeps talking. The agent's job is to hear what
// they said, reply like a person, work out what an application still needs,
// and ask only for that.
//
// ONE CALL PER TURN. Reading the message, replying to it and choosing what to
// ask next are the same act of understanding; splitting them made the reply
// ignorant of the questions printed underneath it, and doubled the latency on
// free models that are slow already.
//
// WHAT THE MODEL DOES NOT DECIDE: whether a required field can be skipped
// (`missingFields` is deterministic), what a value means (the same `apply`
// the web form uses re-parses everything), and which control a known field
// uses (`controlFor`). It decides understanding and wording — the parts a
// person is actually better at.
//
// HUMAN IN THE LOOP: `ask` ends the turn with LangGraph's `interrupt()`. The
// graph pauses, the questionnaire becomes `conversation_question` rows plus a
// message payload, and the applicant's submission resumes it. Durable resume
// is the database, not a checkpointer: state is replayed from the conversation
// log every turn, so a refresh, a second tab, or coming back tomorrow all land
// in the same place.

import "server-only";
import { Annotation, END, interrupt, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import {
  controlFor,
  fieldByKey,
  fieldCatalogue,
  GATED_FIELD_KEYS,
  labelForField,
  missingFields,
  questionCatalogue,
  turnSchema,
  type ControlKind,
  type ExtractedValue,
  type FieldSpec,
  type ProposedQuestion,
} from "@/lib/ai/fields";
import { structuredCall } from "@/lib/ai/openrouter";
import { emptyDraft, type IntakeDraft } from "@/lib/intake";
import { summarise } from "@/lib/intake-chat";

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

/**
 * The question the applicant actually sees for a field.
 *
 * The model's wording is used where it is usable; the control, the option set
 * for parser-sensitive fields, the bounds and whether the field is required
 * are decided here, because those are what make the answer readable again.
 * Exported so the caller can re-ask a field WITHOUT a model call — a rejected
 * answer needs the parser's own words back, not a fresh cheerful turn.
 */
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

export type Turn = {
  /** What the assistant says back, in its own words. */
  reply: string;
  /** Values that survived validation and are safe to persist. */
  accepted: (ExtractedValue & { method: "stated" | "normalised"; valueText: string })[];
  /** Values the model proposed but we refused (inference on a gated field). */
  rejected: ExtractedValue[];
  questions: PendingQuestion[];
  draft: IntakeDraft;
  /** True when nothing is missing — the recap is on screen awaiting a yes. */
  readyToSubmit: boolean;
  recap: string | null;
  servedBy: string | null;
  latencyMs: number;
};

const State = Annotation.Root({
  transcript: Annotation<{ role: "applicant" | "assistant"; text: string }[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),
  draft: Annotation<IntakeDraft>({ reducer: (_, next) => next, default: emptyDraft }),
  settled: Annotation<string[]>({ reducer: (_, next) => next, default: () => [] }),
  reply: Annotation<string>({ reducer: (_, next) => next, default: () => "" }),
  accepted: Annotation<Turn["accepted"]>({ reducer: (_, next) => next, default: () => [] }),
  rejected: Annotation<ExtractedValue[]>({ reducer: (_, next) => next, default: () => [] }),
  proposed: Annotation<ProposedQuestion[]>({ reducer: (_, next) => next, default: () => [] }),
  questions: Annotation<PendingQuestion[]>({ reducer: (_, next) => next, default: () => [] }),
  recap: Annotation<string | null>({ reducer: (_, next) => next, default: () => null }),
  servedBy: Annotation<string | null>({ reducer: (_, next) => next, default: () => null }),
  latencyMs: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  /** Set when the applicant answered a questionnaire — there is nothing to extract. */
  skipExtraction: Annotation<boolean>({ reducer: (_, next) => next, default: () => false }),
});

type StateType = typeof State.State;

const renderTranscript = (transcript: StateType["transcript"]) =>
  transcript.map((m) => `${m.role === "applicant" ? "Applicant" : "You"}: ${m.text}`).join("\n");

/** What we already hold, in the model's own vocabulary. */
function renderKnown(draft: IntakeDraft): string {
  const lines = [
    draft.subjectRelationship
      ? `${labelForField("person.relationship")}: ${draft.subjectRelationship}`
      : null,
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
async function converse(state: StateType): Promise<Partial<StateType>> {
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
    console.log("[intake-agent] RAW MODEL OUTPUT", result.raw);
    console.log(
      "[intake-agent] MODEL VALUES",
      JSON.stringify(result.value.values, null, 2)
    );
  } catch (error) {
    console.error("[intake-agent] turn failed", error);
    return { reply: "", accepted: [], rejected: [], proposed: [] };
  }

  const accepted: Turn["accepted"] = [];
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
    console.log("[intake-agent] APPLYING", {
      fieldKey: value.fieldKey,
      value: value.value,
      rawSpan: value.rawSpan,
      inferred: value.inferred,
    });
    const applied = field.validate(draft, value.value, value.rawSpan);
    console.log("[intake-agent] APPLY RESULT", {
      fieldKey: value.fieldKey,
      value: value.value,
      ok: applied.ok,
      valueText: applied.ok ? applied.valueText : undefined,
      retry: applied.ok ? undefined : applied.retry,
      draft: applied.ok ? applied.draft : draft,
    });
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
function gaps(state: StateType): "ask" | "confirm" {
  return missingFields(state.draft, new Set(state.settled)).length > 0 ? "ask" : "confirm";
}

/**
 * Turn the model's proposals into the questionnaire the applicant sees, then
 * hand control to the human.
 *
 * Wording comes from the model where it is usable. The control, the option set
 * for parser-sensitive fields, and whether a field is required do not — those
 * decide whether the answer can be read back at all.
 */
function ask(state: StateType): Partial<StateType> {
  const missing = missingFields(state.draft, new Set(state.settled)).slice(0, 5);

  // Driven by what is missing, not by what the model chose to return: a
  // forgotten blocking field would stall the application indefinitely.
  const questions = missing.map((field) =>
    buildQuestion(
      field.key,
      state.draft,
      state.proposed.find((p) => p.fieldKey === field.key),
    ),
  );

  // The human-in-the-loop boundary. Execution stops here; the caller persists
  // the questionnaire and the applicant's submission resumes it next turn.
  interrupt({ questions });

  return { questions };
}

/** Nothing outstanding — say what we have and ask for a yes. */
function confirm(state: StateType): Partial<StateType> {
  const lead = state.reply ? `${state.reply}\n\n` : "";
  return { recap: `${lead}${summarise(state.draft)}\n\nShall I send this over to an advisor?` };
}

const graph = new StateGraph(State)
  .addNode("converse", converse)
  .addNode("ask", ask)
  .addNode("confirm", confirm)
  .addEdge(START, "converse")
  .addConditionalEdges("converse", gaps, ["ask", "confirm"])
  .addEdge("ask", END)
  .addEdge("confirm", END);

/**
 * Run one turn. A fresh checkpointer per turn is deliberate: durable state is
 * the conversation log in SQLite, replayed by the caller, so there is no second
 * copy of the truth to drift.
 */
export async function runIntakeTurn(input: {
  transcript: { role: "applicant" | "assistant"; text: string }[];
  draft: IntakeDraft;
  settled: string[];
  /** True when this turn follows a questionnaire submission. */
  skipExtraction?: boolean;
}): Promise<Turn> {
  const compiled = graph.compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: crypto.randomUUID() } };

  const result = await compiled.invoke(input, config);

  // `ask` interrupted, so its questions are on the paused task rather than in
  // the returned state. Read them off the snapshot.
  const snapshot = await compiled.getState(config);
  const paused = snapshot.tasks
    .flatMap((task) => task.interrupts ?? [])
    .flatMap((i) => (i.value as { questions?: PendingQuestion[] } | undefined)?.questions ?? []);

  const questions = paused.length > 0 ? paused : result.questions;

  return {
    reply: result.reply ?? "",
    accepted: result.accepted ?? [],
    rejected: result.rejected ?? [],
    questions,
    draft: result.draft,
    readyToSubmit: questions.length === 0,
    recap: result.recap ?? null,
    servedBy: result.servedBy ?? null,
    latencyMs: result.latencyMs ?? 0,
  };
}
