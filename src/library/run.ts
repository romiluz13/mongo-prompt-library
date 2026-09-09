/**
 * The run executor: resolve the active prompt (variant + tenant overlay),
 * retrieve matching few-shots semantically, stream a real LLM completion to
 * the client as SSE, and record the run.
 *
 * This is where the whole library comes together at run time:
 *   system = base body (or variant body) + tenant overlay + macros + few-shots
 *
 * SSE event shapes (one JSON object per `data:` line):
 *   {"type":"start","variant":"B","version":3,"model":"...","tenant":"acme","few_shots":2}
 *   {"type":"delta","text":"..."}        (many)
 *   {"type":"tool_call",...} → {"type":"tool_result",...}  (at most one round)
 *   {"type":"done","run":{...},"ab":[...],"tools":[...]} or {"type":"error","error":"..."}
 */

import * as store from "./store";
import { semanticFewShots } from "./semantic";
import { llmConfig, streamChat } from "./llm";
import type { ChatMessage, ChatTool, ToolCall } from "./llm";
import type { Run, Variant } from "./types";

const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

const WRITE_PROMPT_VERSION_TOOL: ChatTool = {
  type: "function",
  function: {
    name: "write_prompt_version",
    description:
      "Create a new active system-prompt version for this agent. Use ONLY when the user " +
      "explicitly asks to change this agent's instructions, tone, rules, or behavior " +
      '(e.g. "make the tone friendlier", "always mention the SLA"). ' +
      "Do NOT use this tool for answering questions, drafting content, or logging — " +
      "those are normal replies, not instruction changes. If no instruction change " +
      "was requested, reply in text only.",
    parameters: {
      type: "object",
      properties: {
        body: {
          type: "string",
          minLength: 200,
          maxLength: 20_000,
          description: "The complete canonical base system prompt.",
        },
        changelog: {
          type: "string",
          minLength: 1,
          description: "A concise description of the requested instruction change.",
        },
      },
      required: ["body", "changelog"],
      additionalProperties: false,
    },
  },
};

interface PromptVersionArgs {
  body: string;
  changelog: string;
}

interface ToolOutcome {
  call_id: string;
  name: string;
  ok: boolean;
  version?: number;
}

interface ToolFailure {
  ok: false;
  error: {
    code: "invalid_arguments" | "unknown_tool" | "store_error";
    message: string;
  };
}

function parsePromptVersionArgs(raw: string): PromptVersionArgs | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== "body" && key !== "changelog")) {
    return null;
  }
  if (typeof record.body !== "string" || typeof record.changelog !== "string") {
    return null;
  }

  const body = record.body.trim();
  const changelog = record.changelog.trim();
  if (body.length < 200 || body.length > 20_000 || !changelog) return null;
  return { body, changelog };
}

const toolFailure = (
  code: ToolFailure["error"]["code"],
  message: string,
): ToolFailure => ({ ok: false, error: { code, message } });

export interface RunRequest {
  input: string;
  tenant?: string | null;
  /** pin a variant ("A"|"B") for demos; otherwise routed by doc weights */
  variant?: string | null;
  /** conversational (composer-initiated) run: offer the prompt-edit tool */
  chat?: boolean;
}

/** Weighted, server-authoritative variant routing (falls back to unpinned). */
export function pickVariant(
  variants: Variant[],
  pin?: string | null,
): Variant | null {
  if (pin) {
    const pinned = variants.find(v => v.id === pin);
    if (pinned) return pinned;
  }
  const pool = variants.filter(v => v.weight > 0);
  if (pool.length === 0) return null;
  const total = pool.reduce((sum, v) => sum + v.weight, 0);
  let roll = Math.random() * total;
  for (const v of pool) {
    roll -= v.weight;
    if (roll < 0) return v;
  }
  return pool[pool.length - 1]!;
}

/**
 * Retrieve the few-shots most relevant to this input and format them as an
 * examples block. The library stores examples; Vector Search picks which
 * ones teach this particular run.
 */
async function fewShotBlock(agent: string, input: string, k = 3): Promise<string> {
  const hits = await semanticFewShots(agent, input, k);
  if (hits.length === 0) return "";
  const examples = hits
    .map(h => `<example>\n${h.doc.text}\n</example>`)
    .join("\n");
  return `\n\nLearn from these examples of the task done well:\n${examples}`;
}

/** Yield SSE frames for one run: start → deltas → done (Run doc written). */
export async function* streamRunEvents(
  agent: string,
  req: RunRequest,
): AsyncGenerator<string> {
  const active = await store.getActive(agent);
  if (!active) {
    yield sse({ type: "error", error: `agent ${agent} has no active version` });
    return;
  }

  const resolved = await store.resolvePrompt(agent, req.tenant);
  if (!resolved) {
    yield sse({ type: "error", error: `could not resolve ${agent}` });
    return;
  }

  const variant = pickVariant(active.variants, req.variant);
  let system = resolved.body;
  if (variant?.body) {
    // variant bodies are opt-in overrides: variant body + tenant overlay + macros
    const append = resolved.overlay?.patch.body_append;
    system = store.subMacros(
      variant.body + (append ? `\n\n${append}` : ""),
      resolved.macros,
    );
  }

  // semantic few-shot injection — the library assembles the final prompt
  let fewShotCount = 0;
  try {
    const block = await fewShotBlock(agent, req.input);
    if (block) {
      system += block;
      fewShotCount = 1;
    }
  } catch (e) {
    // few-shot retrieval is an enhancement, not a hard dependency
    console.warn("[run] few-shot retrieval failed (continuing without):", e);
  }

  const model = llmConfig().model;
  const t0 = Date.now();

  yield sse({
    type: "start",
    variant: variant?.id ?? null,
    version: resolved.version,
    model,
    tenant: req.tenant ?? null,
    few_shots: fewShotCount,
  });

  let output = "";
  let tokensIn = 0;
  let tokensOut = 0;
  const toolOutcomes: ToolOutcome[] = [];
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: req.input },
  ];
  let toolCalls: ToolCall[] | null = null;
  try {
    // the edit tool is offered only in conversational runs: ambient task
    // runs proved the model calls it spuriously, creating junk versions
    for await (const ev of streamChat({
      messages,
      ...(req.chat ? { tools: [WRITE_PROMPT_VERSION_TOOL], toolChoice: "auto" as const } : {}),
      maxTokens: 2000,
    })) {
      if (ev.text) {
        output += ev.text;
        yield sse({ type: "delta", text: ev.text });
      }
      if (ev.toolCalls) toolCalls = ev.toolCalls;
      if (ev.tokensIn !== undefined) tokensIn += ev.tokensIn;
      if (ev.tokensOut !== undefined) tokensOut += ev.tokensOut;
    }

    if (toolCalls && toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: toolCalls.map((call, index) => ({
          id: call.id || `call_${index + 1}`,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });

      for (const [index, call] of toolCalls.entries()) {
        const callId = call.id || `call_${index + 1}`;
        let toolResult:
          | ToolFailure
          | {
              ok: true;
              result: {
                agent: string;
                version: number;
                status: "active";
                changelog: string;
                updated_by: string;
                variants_cleared: string[];
              };
            };

        if (call.name !== WRITE_PROMPT_VERSION_TOOL.function.name) {
          toolResult = toolFailure(
            "unknown_tool",
            `Tool ${call.name || "(unnamed)"} is not available.`,
          );
        } else {
          const args = parsePromptVersionArgs(call.arguments);
          if (!args) {
            toolResult = toolFailure(
              "invalid_arguments",
              "body must be a 200-20000 character string and changelog must be a non-empty string.",
            );
          } else {
            yield sse({
              type: "tool_call",
              call_id: callId,
              name: call.name,
              arguments: args,
            });

            const variantsCleared = active.variants.map(v => v.id);
            try {
              const updatedBy = `agent:${agent}`;
              const doc = await store.createVersion(agent, {
                body: args.body,
                changelog: args.changelog,
                updated_by: updatedBy,
                variants: active.variants.map(v => ({ ...v, body: null })),
              });
              toolResult = {
                ok: true,
                result: {
                  agent,
                  version: doc.version,
                  status: "active",
                  changelog: doc.changelog,
                  updated_by: doc.updated_by,
                  variants_cleared: variantsCleared,
                },
              };
            } catch (e) {
              console.error("write_prompt_version store failure:", e);
              toolResult = toolFailure(
                "store_error",
                "The prompt version could not be created.",
              );
            }
          }
        }

        yield sse({
          type: "tool_result",
          call_id: callId,
          name: call.name,
          ...toolResult,
        });

        toolOutcomes.push({
          call_id: callId,
          name: call.name,
          ok: toolResult.ok,
          ...(toolResult.ok ? { version: toolResult.result.version } : {}),
        });
        messages.push({
          role: "tool",
          tool_call_id: callId,
          content: JSON.stringify(toolResult),
        });
      }

      for await (const ev of streamChat({ messages, maxTokens: 600 })) {
        if (ev.text) {
          output += ev.text;
          yield sse({ type: "delta", text: ev.text });
        }
        if (ev.tokensIn !== undefined) tokensIn += ev.tokensIn;
        if (ev.tokensOut !== undefined) tokensOut += ev.tokensOut;
      }
    }
  } catch (e) {
    yield sse({
      type: "error",
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }

  // no auto-verdict in the general template: A/B wins are human verdicts,
  // recorded from the console via POST /api/verdict after reading the reply
  const run: Run = {
    ts: new Date(),
    agent,
    prompt_version: resolved.version,
    variant: variant?.id ?? null,
    tenant: req.tenant ?? null,
    input: req.input,
    output,
    model,
    latency_ms: Date.now() - t0,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    tools: toolOutcomes.map(({ name, ok, version }) => ({
      name,
      ok,
      ...(version !== undefined ? { version } : {}),
    })),
  };
  await store.insertRun(run);
  const ab = await store.abStats(agent);

  yield sse({
    type: "done",
    run: { ...run, ts: run.ts.toISOString() },
    ab,
    tools: toolOutcomes,
  });
}
