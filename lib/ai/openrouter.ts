// The one place a model is constructed and called.
//
// OpenRouter speaks the OpenAI wire format, so `ChatOpenAI` pointed at their
// base URL is the whole integration — swapping models is an env var.
//
// WHY NOT `withStructuredOutput`: it leans on strict JSON-schema or tool
// calling, and the free models this runs on mostly advertise neither (the
// catalogue lists `tools` but not `structured_outputs`). Small models also
// produce noticeably better prose when they are writing JSON in plain
// completion rather than filling a tool call. So structure is asked for in the
// prompt, parsed defensively, validated with zod, and repaired once. That works
// on every model in the catalogue, free or paid.
//
// `isAgentEnabled()` is load-bearing: without a key the app must still run the
// deterministic scripted intake end to end (see the note at the top of
// lib/intake.ts). Nothing here is imported by a client component.

import "server-only";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { z } from "zod";

export const MODEL_ID = process.env.OPENROUTER_MODEL ?? "inclusionai/ling-3.0-flash-fin:free";
export const PROVIDER = "openrouter";

/**
 * Free models share an upstream pool and are rate-limited without warning —
 * `:free` routinely answers 429 mid-conversation. OpenRouter's `models`
 * parameter takes a preference order and serves the first one with capacity,
 * so a throttled primary becomes a slower answer instead of a failed turn.
 *
 * Measured on the real intake prompt (2026-09-13): ling-3.0-flash-fin answered
 * in ~3-4s with clean, parseable JSON on every attempt. gemma-4-26b:free was
 * rate-limited on 5 of 5 attempts at this prompt size, and on the one occasion
 * it did serve it returned prose with no JSON in it at all — it is kept in the
 * chain so it can carry load when its pool frees up, but it cannot be the
 * model the conversation depends on.
 *
 * Models excluded deliberately: nemotron-3-super / nemotron-3.5-lightning /
 * nex-n2.5 / ling-flash-sante are reasoning models that spend the whole token
 * budget thinking (30-100s, truncated JSON), and inkling is harness-gated.
 */
export const FALLBACK_MODELS = (
  process.env.OPENROUTER_FALLBACK_MODELS ??
  "inclusionai/ling-3.0-flash-fin:free,google/gemma-4-31b-it:free,inclusionai/ling-3.0-flash-vl:free"
)
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

/**
 * Preference order sent to OpenRouter: the chosen model, then the safety net.
 * Capped at three — the API rejects a longer `models` array outright.
 */
const MAX_CHAIN = 3;

export const modelChain = () =>
  [MODEL_ID, ...FALLBACK_MODELS.filter((id) => id !== MODEL_ID)].slice(0, MAX_CHAIN);

/** Bumped whenever a prompt in lib/ai/ changes, so `model_run` rows stay comparable. */
export const PROMPT_VERSION = "intake-v2";

/**
 * Output budget per call. It has to be set explicitly: left unset the client
 * asks for the model's full context window, which OpenRouter rejects outright
 * (402) when the account's credit cannot cover the reservation.
 */
const MAX_OUTPUT_TOKENS = 2048;

export const isAgentEnabled = () => Boolean(process.env.OPENROUTER_API_KEY);

export function chatModel({ temperature = 0.4 }: { temperature?: number } = {}): ChatOpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set — check isAgentEnabled() before calling chatModel().");

  return new ChatOpenAI({
    apiKey,
    model: MODEL_ID,
    temperature,
    maxTokens: MAX_OUTPUT_TOKENS,
    // `models` is OpenRouter's fallback list. No `response_format` here: the
    // catalogue shows none of these free models supports strict
    // `structured_outputs`, and the two that accept `json_object` reject it
    // often enough that asking for it costs more turns than it saves.
    // `extractJson` does the work instead.
    modelKwargs: { models: modelChain() },
    configuration: {
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        // OpenRouter attributes usage with these; both are optional.
        "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
        "X-Title": process.env.OPENROUTER_APP_NAME ?? "Mizan AI",
      },
    },
  });
}

/**
 * Pull a JSON object out of whatever the model actually returned — a fenced
 * block, a preamble sentence, or clean JSON. Brace-matching rather than a
 * regex, because the payload contains prose with braces in it often enough.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();

  const start = body.indexOf("{");
  if (start === -1) throw new Error("no JSON object in model output");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const char = body[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === "{") depth++;
    if (char === "}" && --depth === 0) return JSON.parse(body.slice(start, i + 1));
  }
  throw new Error("unterminated JSON object in model output");
}

export type StructuredResult<T> = {
  value: T;
  raw: string;
  latencyMs: number;
  attempts: number;
  /** Which model OpenRouter actually served — not always the one asked for. */
  servedBy: string;
};

/**
 * One structured call: ask, parse, validate, and on failure show the model its
 * own output plus the error and let it fix it. Two attempts, then give up —
 * every caller has a deterministic fallback, and a third round-trip costs the
 * applicant more waiting than it is worth.
 */
export async function structuredCall<T>(input: {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  temperature?: number;
}): Promise<StructuredResult<T>> {
  const model = chatModel({ temperature: input.temperature });
  const startedAt = Date.now();

  const messages = [new SystemMessage(input.system), new HumanMessage(input.user)];
  let raw = "";
  let lastError = "";
  let servedBy = MODEL_ID;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await model.invoke(
      attempt === 1
        ? messages
        : [
            ...messages,
            new HumanMessage(
              `Your previous reply could not be used: ${lastError}\n\n` +
                `It was:\n${raw.slice(0, 1500)}\n\n` +
                `Reply again with ONLY the JSON object, matching the shape exactly. No prose, no code fences.`,
            ),
          ],
    );

    raw = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
    const metadata = response.response_metadata as { model_name?: string; model?: string } | undefined;
    servedBy = metadata?.model_name ?? metadata?.model ?? MODEL_ID;

    try {
      const parsed = input.schema.parse(extractJson(raw));
      return { value: parsed, raw, latencyMs: Date.now() - startedAt, attempts: attempt, servedBy };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(`model did not return usable JSON after 2 attempts: ${lastError}`);
}
