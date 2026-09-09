/** Domain types for the prompt library. */

/** Version lifecycle: draft → in_review → approved → active → archived. */
export type PromptStatus = "draft" | "in_review" | "approved" | "active" | "archived";

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
  /** review trail — who moved this version through the lifecycle, and when */
  submitted_by?: string;
  submitted_at?: Date;
  approved_by?: string;
  approved_at?: Date;
  published_by?: string;
  published_at?: Date;
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

// ---- evals -------------------------------------------------------------------

/** A golden case: input fed to the candidate prompt + the judge's rubric. */
export interface EvalCase {
  agent: string;
  input: string;
  rubric: string;
  updated_at: Date;
}

/** One judged case inside an eval run. */
export interface EvalResult {
  case_id: string;
  input: string;
  rubric: string;
  /** 0-10, judged by the LLM against the rubric */
  score: number;
  rationale: string;
}

/** One suite execution against a specific prompt version. */
export interface EvalRun {
  ts: Date;
  agent: string;
  version: number;
  /** model that produced the candidate outputs */
  model: string;
  /** model that judged them */
  judge_model: string;
  results: EvalResult[];
  mean_score: number;
  /** the active version this run was compared against, if any */
  baseline_version: number | null;
  baseline_mean: number | null;
  /** true when mean_score dropped below the baseline — blocks publish */
  regression: boolean;
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
