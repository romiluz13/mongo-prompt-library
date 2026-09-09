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
 *   {"type":"guardrail_block","phase":"input"|"output",...}  (run refused or cut)
 *   {"type":"done","run":{...},"ab":[...],"tools":[...]} or {"type":"error","error":"..."}
 */

import * as store from "./store";
import { evaluate } from "./alerts";
import { semanticFewShots } from "./semantic";
import { llmConfig, streamChat } from "./llm";
import type { ChatMessage, ChatTool, ToolCall } from "./llm";
import type { Run, ToolDef, Variant } from "./types";

const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

const WRITE_PROMPT_VERSION_TOOL: ChatTool = {
  type: "function",
  function: {
    name: "write_prompt_version",
    description:
      "Create a new draft system-prompt version for this agent. It does NOT go live " +
      "immediately — it lands in review, and a human must approve and publish it. " +
      "Use ONLY when the user explicitly asks to change this agent's instructions, " +
      'tone, rules, or behavior (e.g. "make the tone friendlier", "always mention ' +
      'the SLA"). Do NOT use this tool for answering questions, drafting content, or ' +
      "logging — those are normal replies, not instruction changes. If no instruction " +
      "change was requested, reply in text only.",
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

/**
 * Demo tool executors: each seeded tool gets a deterministic fake backend so
 * function calling is fully demonstrable without real integrations. Unknown
 * tools still "execute" and echo their arguments — the plumbing is real,
 * only the side effects are simulated.
 */
const DEMO_EXECUTORS: Record<string, (args: Record<string, unknown>) => unknown> = {
  lookup_order: args => ({
    order_id: String(args.order_id ?? "ORD-1042"),
    status: "shipped",
    charges: [
      { amount: 49.0, at: "2025-06-01T09:12:00Z" },
      { amount: 49.0, at: "2025-06-01T09:12:04Z" },
    ],
    duplicate_charge: true,
    refund_policy:
      "duplicate charges are refunded to the original payment method within 5 business days",
  }),
  search_knowledge: args => ({
    query: args.query ?? "",
    hits: [
      {
        title: "Refund policy",
        snippet:
          "Refunds for duplicate charges are issued within 5 business days to the original payment method.",
      },
      {
        title: "Escalation SLA",
        snippet: "P1 tickets must receive a human response within 15 minutes.",
      },
    ],
  }),
  escalate_to_human: args => ({
    ticket_id: "TCK-" + (1000 + Math.floor(Math.random() * 9000)),
    queue: String(args.queue ?? "platform-oncall"),
    eta_minutes: 15,
    acknowledged: true,
  }),
  search_codebase: args => ({
    query: args.query ?? "",
    files: [
      { path: "src/library/run.ts", reason: "run executor: where tools are dispatched" },
      { path: "src/library/store.ts", reason: "persistence and resolution" },
    ],
  }),
};

function executeDemoTool(name: string, args: Record<string, unknown>): unknown {
  const exec = DEMO_EXECUTORS[name];
  return exec
    ? exec(args)
    : { demo: true, note: "executed in demo mode", arguments: args };
}

/**
 * Check arguments against the tool's JSON Schema: required fields present,
 * and declared primitive types (string/number/boolean) honored. The schema
 * is the contract; the runner refuses to execute against it.
 */
export function validateToolArgs(
  parameters: Record<string, unknown>,
  raw: string,
): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const args = value as Record<string, unknown>;

  const required = Array.isArray(parameters.required)
    ? (parameters.required as unknown[]).filter(
        (k): k is string => typeof k === "string",
      )
    : [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) return null;
  }

  const props =
    parameters.properties && typeof parameters.properties === "object"
      ? (parameters.properties as Record<string, unknown>)
      : {};
  for (const [key, val] of Object.entries(args)) {
    const p = props[key];
    if (!p || typeof p !== "object") continue;
    const t = (p as { type?: unknown }).type;
    if (t === "string" && typeof val !== "string") return null;
    if ((t === "number" || t === "integer") && typeof val !== "number") return null;
    if (t === "boolean" && typeof val !== "boolean") return null;
  }
  return args;
}

/**
 * Guardrail checks: input_block phrases refuse the run before any LLM call;
 * banned_phrase cuts the stream the moment one appears in the output;
 * max_tokens caps the completion budget. All server-authoritative.
 */
export function checkInputGuardrails(
  guardrails: { name: string; kind: string; value: string[] | number }[],
  input: string,
): string[] {
  const lower = input.toLowerCase();
  return guardrails
    .filter(
      g =>
        g.kind === "input_block" &&
        Array.isArray(g.value) &&
        g.value.some(p => lower.includes(p.toLowerCase())),
    )
    .map(g => g.name);
}

export function scanBannedPhrases(
  guardrails: { name: string; kind: string; value: string[] | number }[],
  output: string,
): string[] {
  const lower = output.toLowerCase();
  return guardrails
    .filter(
      g =>
        g.kind === "banned_phrase" &&
        Array.isArray(g.value) &&
        g.value.some(p => lower.includes(p.toLowerCase())),
    )
    .map(g => g.name);
}

export function tokenCap(
  guardrails: { kind: string; value: string[] | number }[],
  fallback = 2000,
): number {
  let cap = fallback;
  for (const g of guardrails) {
    if (g.kind === "max_tokens" && typeof g.value === "number") {
      cap = Math.min(cap, g.value);
    }
  }
  return cap;
}

/** Weighted, server-authoritative variant routing (falls back to unpinned). */
export function pickVariant(  variants: Variant[],
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

  const t0 = Date.now();

  // the agent's config bundle: callable tools + active guardrails
  const bundleTools = await store.toolsForAgent(agent);
  const bundleGuardrails = await store.guardrailsForAgent(agent);
  let outputBlocks: string[] = [];

  // input guardrails: the run is refused before any LLM call is spent
  const inputBlocks = checkInputGuardrails(bundleGuardrails, req.input);
  if (inputBlocks.length > 0) {
    yield sse({
      type: "guardrail_block",
      phase: "input",
      guardrails: inputBlocks,
      message:
        "input refused by guardrail — the run never reached the model; " +
        "no tokens spent, nothing to moderate after the fact",
    });
    const blockedRun: Run = {
      ts: new Date(),
      agent,
      prompt_version: resolved.version,
      variant: variant?.id ?? null,
      tenant: req.tenant ?? null,
      input: req.input,
      output: "",
      model: llmConfig().model,
      latency_ms: Date.now() - t0,
      tokens_in: 0,
      tokens_out: 0,
      guardrail_blocks: inputBlocks,
    };
    await store.insertRun(blockedRun);
    // alert rules see blocked runs too — a spike in refusals is a signal
    await evaluate("runs", blockedRun);
    return;
  }

  const banned = bundleGuardrails.filter(g => g.kind === "banned_phrase");
  const scanOutput = (text: string): string[] =>
    scanBannedPhrases(banned, text).filter(n => !outputBlocks.includes(n));

  const model = llmConfig().model;

  // the agent's own tools are always offered — they're capabilities of the
  // agent, not conveniences of the chat UI. The prompt-edit meta-tool stays
  // chat-only: ambient task runs proved the model calls it spuriously.
  const agentTools: ChatTool[] = bundleTools.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const offeredTools =
    req.chat && agentTools.length === 0
      ? [WRITE_PROMPT_VERSION_TOOL]
      : req.chat
        ? [WRITE_PROMPT_VERSION_TOOL, ...agentTools]
        : agentTools;
  const maxTokens = tokenCap(bundleGuardrails);

  yield sse({
    type: "start",
    variant: variant?.id ?? null,
    version: resolved.version,
    model,
    tenant: req.tenant ?? null,
    few_shots: fewShotCount,
    tools: offeredTools.map(t => t.function.name),
    guardrails: bundleGuardrails.map(g => g.name),
    token_cap: maxTokens,
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
    for await (const ev of streamChat({
      messages,
      ...(offeredTools.length > 0
        ? { tools: offeredTools, toolChoice: "auto" as const }
        : {}),
      maxTokens,
    })) {
      if (ev.text) {
        output += ev.text;
        yield sse({ type: "delta", text: ev.text });
        // output guardrails: cut the stream the moment a banned phrase lands
        const hits = scanOutput(output);
        if (hits.length > 0) {
          outputBlocks = [...outputBlocks, ...hits];
          yield sse({
            type: "guardrail_block",
            phase: "output",
            guardrails: hits,
            message: "stream cut by guardrail — the phrase never completes",
          });
          break;
        }
      }
      if (ev.toolCalls) toolCalls = ev.toolCalls;
      if (ev.tokensIn !== undefined) tokensIn += ev.tokensIn;
      if (ev.tokensOut !== undefined) tokensOut += ev.tokensOut;
    }

    if (!outputBlocks.length && toolCalls && toolCalls.length > 0) {
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
        // The tool contract: meta-tool handled in-store, agent tools
        // validated against their JSON Schema then executed.
        const def = bundleTools.find(t => t.name === call.name);

        if (
          call.name === WRITE_PROMPT_VERSION_TOOL.function.name &&
          req.chat
        ) {
          // ---- the prompt-edit meta-tool (unchanged behavior) ----------
          const args = parsePromptVersionArgs(call.arguments);
          let toolResult: ToolFailure | { ok: true; result: Record<string, unknown> };
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
            try {
              const doc = await store.createVersion(agent, {
                body: args.body,
                changelog: args.changelog,
                updated_by: `agent:${agent}`,
                variants: active.variants.map(v => ({ ...v, body: null })),
              });
              toolResult = {
                ok: true,
                result: {
                  agent,
                  version: doc.version,
                  status: "draft",
                  changelog: doc.changelog,
                  updated_by: doc.updated_by,
                  variants_cleared: active.variants.map(v => v.id),
                  next:
                    "draft created — submit it for review, then approve and publish " +
                    "from the console to go live",
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
          yield sse({ type: "tool_result", call_id: callId, name: call.name, ...toolResult });
          toolOutcomes.push({
            call_id: callId,
            name: call.name,
            ok: toolResult.ok,
            ...(toolResult.ok && typeof toolResult.result.version === "number"
              ? { version: toolResult.result.version }
              : {}),
          });
          messages.push({
            role: "tool",
            tool_call_id: callId,
            content: JSON.stringify(toolResult),
          });
        } else if (def) {
          // ---- an agent tool from the store -----------------------------
          const args = validateToolArgs(def.parameters, call.arguments);
          let toolResult: ToolFailure | { ok: true; result: unknown };
          if (!args) {
            toolResult = toolFailure(
              "invalid_arguments",
              `arguments for ${def.name} do not match its JSON Schema (required: ` +
                `${(def.parameters.required as string[] | undefined)?.join(", ") ?? "—"})`,
            );
          } else {
            yield sse({ type: "tool_call", call_id: callId, name: call.name, arguments: args });
            const result = executeDemoTool(def.name, args);
            toolResult = { ok: true, result };
          }
          yield sse({ type: "tool_result", call_id: callId, name: call.name, ...toolResult });
          toolOutcomes.push({ call_id: callId, name: call.name, ok: toolResult.ok });
          messages.push({
            role: "tool",
            tool_call_id: callId,
            content: JSON.stringify(toolResult),
          });
        } else {
          // ---- no such tool in the bundle: refused, recorded -------------
          const toolResult = toolFailure(
            "unknown_tool",
            `Tool ${call.name || "(unnamed)"} is not available to agent ${agent}.`,
          );
          yield sse({ type: "tool_result", call_id: callId, name: call.name, ...toolResult });
          toolOutcomes.push({ call_id: callId, name: call.name, ok: false });
          messages.push({
            role: "tool",
            tool_call_id: callId,
            content: JSON.stringify(toolResult),
          });
        }
      }

      // final round: the model weaves the tool results into its reply
      for await (const ev of streamChat({ messages, maxTokens: Math.min(600, maxTokens) })) {
        if (ev.text) {
          output += ev.text;
          yield sse({ type: "delta", text: ev.text });
          const hits = scanOutput(output);
          if (hits.length > 0) {
            outputBlocks = [...outputBlocks, ...hits];
            yield sse({
              type: "guardrail_block",
              phase: "output",
              guardrails: hits,
              message: "stream cut by guardrail — the phrase never completes",
            });
            break;
          }
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
    ...(outputBlocks.length > 0 ? { guardrail_blocks: outputBlocks } : {}),
  };
  await store.insertRun(run);
  // observability: alert rules evaluate this run the moment it is written
  await evaluate("runs", run);
  const ab = await store.abStats(agent);

  yield sse({
    type: "done",
    run: { ...run, ts: run.ts.toISOString() },
    ab,
    tools: toolOutcomes,
  });
}
