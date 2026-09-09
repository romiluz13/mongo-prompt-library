/** Domain types for the prompt library. */

export type PromptStatus = "active" | "draft" | "archived";

export interface Variant {
  id: string; // "A" | "B" | ...
  label: string;
  weight: number; // percent of traffic, 0-100
  body?: string | null; // variant bodies are opt-in overrides of the document body
}

export interface AgentPrompt {
  agent: string;
  field: string; // "system_prompt"
  version: number;
  status: PromptStatus;
  body: string;
  /** {{token}} placeholders substituted at resolve() time */
  macros: Record<string, string>;
  variants: Variant[];
  changelog: string;
  updated_by: string;
  updated_at: Date;
}

export interface OverlayPatch {
  /** appended to the resolved body (tenant voice, extra rules) */
  body_append?: string;
  /** override/extend macros for this tenant */
  macros?: Record<string, string>;
}

export interface PromptOverlay {
  agent: string;
  tenant: string;
  patch: OverlayPatch;
  updated_at: Date;
}

/**
 * Few-shot examples, retrieved semantically (Atlas Vector Search autoEmbed)
 * at run time — the library assembles the prompt: base + overlay + macros +
 * the few-shots most relevant to the user's input.
 */
export interface FewShot {
  agent: string;
  text: string;
  note?: string;
  updated_at: Date;
}

export interface ResolvedPrompt {
  agent: string;
  version: number;
  body: string; // base body + overlay append + macro substitution
  macros: Record<string, string>;
  overlay: { tenant: string; patch: OverlayPatch } | null;
  resolved_at: string;
}

export interface Run {
  ts: Date;
  agent: string;
  prompt_version: number;
  variant: string | null;
  tenant: string | null;
  input: string;
  output: string;
  model: string;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  verdict?: "up" | "down";
  tools?: { name: string; ok: boolean; version?: number }[];
}
