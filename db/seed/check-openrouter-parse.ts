// `extractJson`, attacked — pure, no DB, no model call.
//
//   bun --conditions=react-server run db/seed/check-openrouter-parse.ts
//
// (needs `--conditions=react-server`: `lib/ai/openrouter.ts` imports a `server-only` module — see the note in
// db/seed/check-reassess.ts's own header.)
//
// A model is asked for ONE JSON object and nothing else, but not every model honours that: seen live
// (model_run.error_text, 2026-09-22), a free OpenRouter model wrapped its tool call in ITS OWN vendor's
// `<tool_call>...</tool_call>` function-calling syntax instead — `<tool_call>read_policy\n\n</tool_call>`, a
// tool this system never exposed, and no arguments to recover. The graph's own fallback (a deterministic form)
// already covers a failure like this; what's under test here is that the failure is DIAGNOSABLE from
// `model_run.error_text` alone, without re-running the turn — a `<tool_call>` wrapper gets its own named error,
// not the generic "no JSON object in model output".
/* eslint-disable @typescript-eslint/no-explicit-any */
import { extractJson } from "@/lib/ai/openrouter";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${!ok && detail ? `\n         ${detail}` : ""}`);
};

console.log("\nClean and near-clean JSON");
check("plain JSON parses", (extractJson('{"thought":"x","tool":"y","args":{}}') as any).tool === "y");
check("JSON inside a fenced code block parses", (extractJson('```json\n{"thought":"x","tool":"y","args":{}}\n```') as any).tool === "y");
check("a preamble sentence before the object is skipped", (extractJson('Sure, here it is:\n{"thought":"x","tool":"y","args":{}}') as any).tool === "y");
check("a brace inside a quoted string does not end the object early", (extractJson('{"thought":"she said \\"hi }\\"","tool":"y","args":{}}') as any).tool === "y");

console.log("\nWhat this project has actually seen fail, from model_run's own log");
check(
  "a <tool_call> wrapper with no JSON object at all is named for what it is, not the generic message",
  (() => {
    try {
      extractJson("<tool_call>read_policy\n\n</tool_call>");
      return false;
    } catch (e) {
      return e instanceof Error && /<tool_call> wrapper/.test(e.message) && /read_policy/.test(e.message);
    }
  })(),
);
// `extractJson`'s only job is finding A json object — enforcing that it has the RIGHT shape
// (`{thought, tool, args}`, not a vendor's own `{name, arguments}`) is `structuredCall`'s schema layer, one
// step up, not this function's concern. A `<tool_call>` wrapper AROUND a real object still extracts the
// object inside it; the named `<tool_call>` error above only fires when there is no object to find at all.
check(
  "a JSON object embedded inside a <tool_call> wrapper is still extracted — shape-checking it is the schema's job, not this function's",
  (extractJson('<tool_call>{"name":"ask_member","arguments":{"fieldKey":"amount"}}</tool_call>') as any).name === "ask_member",
);
check(
  "genuinely empty or non-JSON prose still throws the plain, generic message — the <tool_call> case is a NAMED addition, not a replacement",
  (() => {
    try {
      extractJson("Sorry, I don't have enough information to proceed.");
      return false;
    } catch (e) {
      return e instanceof Error && e.message === "no JSON object in model output";
    }
  })(),
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
