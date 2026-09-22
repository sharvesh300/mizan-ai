// The servicing graph — a claim, a pre-authorization or a reimbursement, one turn at a time.
//
//   SERVICING (a policy is live and the member just did something)
//     processResponse ──> agent ──┬──> wait      (interrupt: the member owns the next move)
//                                 ├──> gate ──> commit ──> END   (an outcome: the session writes the event)
//                                 └──> escalate ──> END          (a hand-off)
//
// It lives beside graph.ts rather than in it because graph.ts is `server-only`, and this graph has to be
// runnable from a script with a scripted model — that is how the tool loop, its cutoffs and its fallback
// are tested at all. The topology is documented in graph.ts's header with the others.
//
// Compiled PER CALL with the model captured in a closure, and a fresh checkpointer: durable state is the
// conversation's rows, so there is no second copy to drift, and LangGraph is never asked to serialise a
// function into a checkpoint.

import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { ServicingState, type ServicingStateType } from "@/lib/ai/graph/state";
import { makeAppealAgent, processAppealResponse } from "@/lib/ai/graph/nodes/appeal";
import { commit, escalation, gate, makeAgent, processResponse, routeAfterAgent, wait, type ServicingDecider, type ServicingInput } from "@/lib/ai/graph/nodes/servicing";
import type { ServicingToolContext } from "@/lib/ai/tools/servicing";

export function buildServicingGraph(decide?: ServicingDecider) {
  const claimAgent = makeAgent(decide);
  const appealAgent = makeAppealAgent(decide);
  return new StateGraph(ServicingState)
    // A conversation is EITHER a claim or an appeal (plan §5.4); the tool context says which, and each has its own
    // registry. Same topology, same wait/gate/commit/escalate, two brains.
    .addNode("processResponse", (s: ServicingStateType) => (s.ctx?.appeal ? processAppealResponse(s) : processResponse(s)))
    .addNode("agent", (s: ServicingStateType) => (s.ctx?.appeal ? appealAgent(s) : claimAgent(s)))
    .addNode("wait", wait)
    .addNode("gate", gate)
    .addNode("commit", commit)
    .addNode("escalate", escalation)
    .addEdge(START, "processResponse")
    .addEdge("processResponse", "agent")
    .addConditionalEdges("agent", (s: ServicingStateType) => (routeAfterAgent(s) === "commit" ? "gate" : routeAfterAgent(s)), ["wait", "gate", "escalate"])
    .addEdge("gate", "commit")
    .addEdge("wait", END)
    .addEdge("commit", END)
    .addEdge("escalate", END);
}

export type ServicingTurnResult = Pick<ServicingStateType, "ctx" | "turn" | "plan" | "formErrors" | "notes" | "changing">;

/** Run one turn. */
export async function runServicingTurn(input: {
  ctx: ServicingToolContext;
  input: ServicingInput;
  transcript: { role: "member" | "assistant"; text: string }[];
  decide?: ServicingDecider;
  /** Carried from the last turn: the member asked to change something and has not been re-confirmed. */
  changing?: boolean;
}): Promise<ServicingTurnResult> {
  const compiled = buildServicingGraph(input.decide).compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: crypto.randomUUID() } };
  const result = await compiled.invoke({ ctx: input.ctx, input: input.input, transcript: input.transcript, changing: input.changing ?? false }, config);
  return { ctx: result.ctx, turn: result.turn, plan: result.plan, formErrors: result.formErrors, notes: result.notes, changing: result.changing };
}
