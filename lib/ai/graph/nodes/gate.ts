// `gate` — hand the application to a human and stop.
//
// The second human-in-the-loop boundary in the system, and the same shape as
// `ask` in intake: the graph interrupts, the caller persists a `review_task`,
// and an advisor's decision is what resumes the pipeline. Nothing downstream —
// quoting, recommendation — runs on an application sitting behind this node.
//
// As with intake, LangGraph's interrupt marks the boundary but is not what
// makes it durable. The review task in SQLite is: close the browser, come back
// tomorrow, the application is still gated and still in the queue at the same
// priority. A checkpointer would be a second copy of that truth, free to drift
// from it.

import "server-only";
import { interrupt } from "@langchain/langgraph";
import type { AssessmentStateType } from "@/lib/ai/graph/state";

export function gate(state: AssessmentStateType): Partial<AssessmentStateType> {
  interrupt({
    applicationId: state.record.applicationId,
    reason: state.verdict?.queueReason,
    priorityScore: state.verdict?.priorityScore,
    gate: state.verdict?.gate,
  });

  return {};
}
