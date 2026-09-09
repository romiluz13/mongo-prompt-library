/**
 * OpenAI-compatible chat-completions adapter (streaming only).
 *
 * Works with any OpenAI-compatible gateway. Config precedence per key:
 *   LLM_BASE_URL  > GROVE_BASE_URL > https://api.openai.com/v1
 *   LLM_API_KEY   > GROVE_API_KEY  > OPENAI_API_KEY
 *   LLM_MODEL     > deepseek-v4-flash-0731 (the demo gateway's model)
 *
 * The Grove gateway (Azure APIM) authenticates with an `api-key` header
 * (probed: `authorization` is rejected, `api-key` is accepted); vanilla OpenAI
 * uses `Authorization: Bearer`. Both shapes are supported.
 *
 * Streaming only: the gateway's non-stream responses were unreliable (empty
 * body in probing), so we always set stream:true and accumulate.
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** header name carrying the credential ("api-key" | "authorization") */
  authHeader: string;
  /** header value for the credential (raw key or "Bearer <key>") */
  authValue: string;
}

export function llmConfig(): LlmConfig {
  const baseUrl = (process.env.LLM_BASE_URL ?? process.env.GROVE_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const apiKey = process.env.LLM_API_KEY ?? process.env.GROVE_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  const isGrove = Boolean(process.env.GROVE_API_KEY && !process.env.LLM_API_KEY);
  const authHeader = process.env.LLM_API_HEADER ?? (isGrove ? "api-key" : "authorization");
  const authValue = authHeader.toLowerCase() === "authorization" ? `Bearer ${apiKey}` : apiKey;
  const model = process.env.LLM_MODEL ?? "deepseek-v4-flash-0731";
  return { baseUrl, apiKey, model, authHeader, authValue };
}

export interface ToolCall {
  id: string;
  name: string;
  /** raw JSON string, concatenated from streamed argument fragments */
  arguments: string;
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export type ToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export interface LlmEvent {
  /** incremental completion text (empty string events are skipped) */
  text?: string;
  /** complete tool calls, emitted once when the stream finishes for tools */
  toolCalls?: ToolCall[];
  finishReason?: string;
  /** usage from the final chunk, when the gateway sends one */
  tokensIn?: number;
  tokensOut?: number;
}

export interface StreamChatOptions {
  messages: ChatMessage[];
  tools?: ChatTool[];
  toolChoice?: ToolChoice;
  maxTokens?: number;
}

/** One streamed chat completion as async events; text deltas then usage. */
export async function* streamChat(
  opts: StreamChatOptions,
): AsyncGenerator<LlmEvent> {
  const cfg = llmConfig();
  if (!cfg.apiKey) throw new Error("no LLM API key configured (LLM_API_KEY / GROVE_API_KEY / OPENAI_API_KEY)");

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [cfg.authHeader]: cfg.authValue,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: opts.messages,
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.toolChoice ? { tool_choice: opts.toolChoice } : {}),
      stream: true,
      max_tokens: opts.maxTokens ?? 400,
    }),
    // a stalled gateway stream would hang the SSE run forever — the client
    // shows "running…" and blocks all later runs (observed e2e, 2026-09-08).
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LLM gateway ${res.status}: ${detail.slice(0, 200)}`);
  }

  // Parse the SSE body per MDN event-stream format: `data: <json>` lines,
  // `data: [DONE]` terminator. Tolerate nonstandard fields and a trailing
  // usage chunk with empty choices (deepseek-style).
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pendingToolCalls = new Map<
    number,
    { id?: string; name?: string; arguments: string }
  >();
  let emittedToolCalls = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trimEnd();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue; // comments/keep-alives/blank lines
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;

      let chunk: {
        choices?: {
          delta?: {
            content?: string | null;
            tool_calls?: {
              index: number;
              id?: string | null;
              function?: {
                name?: string | null;
                arguments?: string | null;
              } | null;
            }[] | null;
          };
          finish_reason?: string | null;
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue; // partial/foreign line — skip rather than kill the stream
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      const text = delta?.content;
      if (typeof text === "string" && text.length > 0) yield { text };

      for (const fragment of delta?.tool_calls ?? []) {
        const pending = pendingToolCalls.get(fragment.index) ?? { arguments: "" };
        if (fragment.id) pending.id = fragment.id;
        if (fragment.function?.name) pending.name = fragment.function.name;
        if (fragment.function?.arguments) {
          pending.arguments += fragment.function.arguments;
        }
        pendingToolCalls.set(fragment.index, pending);
      }

      if (
        choice?.finish_reason === "tool_calls" &&
        !emittedToolCalls
      ) {
        emittedToolCalls = true;
        yield {
          finishReason: choice.finish_reason,
          toolCalls: [...pendingToolCalls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, pending]) => ({
              id: pending.id ?? "",
              name: pending.name ?? "",
              arguments: pending.arguments,
            })),
        };
        pendingToolCalls.clear();
      }

      if (chunk.usage) {
        yield {
          tokensIn: chunk.usage.prompt_tokens,
          tokensOut: chunk.usage.completion_tokens,
        };
      }
    }
  }
}

/** Accumulate a full completion (convenience for non-streaming callers). */
export async function completeChat(
  opts: StreamChatOptions,
): Promise<{ text: string; tokensIn?: number; tokensOut?: number }> {
  let text = "";
  let tokensIn: number | undefined;
  let tokensOut: number | undefined;
  for await (const ev of streamChat(opts)) {
    if (ev.text) text += ev.text;
    if (ev.tokensIn !== undefined) tokensIn = ev.tokensIn;
    if (ev.tokensOut !== undefined) tokensOut = ev.tokensOut;
  }
  return { text, tokensIn, tokensOut };
}
