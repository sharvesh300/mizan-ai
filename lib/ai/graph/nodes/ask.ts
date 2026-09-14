// `ask` — turn the model's proposals into the questionnaire the applicant
// sees, then hand control to the human.
//
// HUMAN IN THE LOOP: this node ends the turn with LangGraph's `interrupt()`.
// The graph pauses, the questionnaire becomes `conversation_question` rows plus
// a message payload, and the applicant's submission resumes it. Durable resume
// is the database, not a checkpointer: state is replayed from the conversation
// log every turn, so a refresh, a second tab, or coming back tomorrow all land
// in the same place.

import "server-only";
import { interrupt } from "@langchain/langgraph";
import { missingFields } from "@/lib/ai/fields";
import { buildQuestion } from "@/lib/ai/questions";
import type { IntakeStateType } from "@/lib/ai/graph/state";

export function ask(state: IntakeStateType): Partial<IntakeStateType> {
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
