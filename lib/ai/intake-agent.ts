// The intake agent, as the rest of the app still knows it.
//
// The graph moved to lib/ai/graph.ts and its nodes to lib/ai/graph/nodes/ —
// one file per node, one file for the topology — so that the classification,
// quoting and recommendation nodes can be added without this module growing a
// second and third graph inside it. This file stays as the import surface the
// server actions and the session layer already use.

import "server-only";

export { runIntakeTurn } from "@/lib/ai/graph";
export { buildQuestion, type PendingQuestion } from "@/lib/ai/questions";
export type { AcceptedValue, Turn } from "@/lib/ai/graph/state";
