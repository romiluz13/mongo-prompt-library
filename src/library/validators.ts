import { db } from "./db";

/**
 * Database-enforced contracts for every collection: $jsonSchema validators
 * applied at boot (idempotent collMod). The database itself rejects malformed
 * writes — code 121 — which the API surfaces as a clean 400.
 *
 * validationLevel "moderate": inserts and updates of conforming documents are
 * validated; any legacy document that predates a validator can still be
 * updated (no lockout), and gets convered on its next full rewrite.
 */

const PROMPTS_VALIDATOR = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "agent",
      "field",
      "version",
      "status",
      "body",
      "changelog",
      "updated_by",
      "updated_at",
    ],
    properties: {
      agent: { bsonType: "string", minLength: 1 },
      field: { bsonType: "string" },
      version: { bsonType: "int", minimum: 1 },
      status: { enum: ["draft", "in_review", "approved", "active", "archived"] },
      body: { bsonType: "string", minLength: 1 },
      macros: { bsonType: "object" },
      variants: { bsonType: "array" },
      changelog: { bsonType: "string", minLength: 1 },
      updated_by: { bsonType: "string" },
      updated_at: { bsonType: "date" },
      submitted_by: { bsonType: "string" },
      submitted_at: { bsonType: "date" },
      approved_by: { bsonType: "string" },
      approved_at: { bsonType: "date" },
      published_by: { bsonType: "string" },
      published_at: { bsonType: "date" },
    },
  },
};

const OVERLAYS_VALIDATOR = {
  $jsonSchema: {
    bsonType: "object",
    required: ["agent", "tenant", "patch", "updated_at"],
    properties: {
      agent: { bsonType: "string", minLength: 1 },
      tenant: { bsonType: "string", minLength: 1 },
      patch: {
        bsonType: "object",
        properties: {
          body_append: { bsonType: "string" },
          macros: { bsonType: "object" },
        },
        additionalProperties: false,
      },
      updated_at: { bsonType: "date" },
    },
  },
};

const FEW_SHOTS_VALIDATOR = {
  $jsonSchema: {
    bsonType: "object",
    required: ["agent", "text", "updated_at"],
    properties: {
      agent: { bsonType: "string", minLength: 1 },
      text: { bsonType: "string", minLength: 1 },
      note: { bsonType: "string" },
      updated_at: { bsonType: "date" },
    },
  },
};

const RUNS_VALIDATOR = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "ts",
      "agent",
      "prompt_version",
      "input",
      "output",
      "model",
      "latency_ms",
      "tokens_in",
      "tokens_out",
    ],
    properties: {
      ts: { bsonType: "date" },
      agent: { bsonType: "string", minLength: 1 },
      prompt_version: { bsonType: "int", minimum: 1 },
      variant: { bsonType: ["string", "null"] },
      tenant: { bsonType: ["string", "null"] },
      input: { bsonType: "string" },
      output: { bsonType: "string" },
      model: { bsonType: "string" },
      latency_ms: { bsonType: "int", minimum: 0 },
      tokens_in: { bsonType: "int", minimum: 0 },
      tokens_out: { bsonType: "int", minimum: 0 },
      verdict: { enum: ["up", "down"] },
      tools: {
        bsonType: "array",
        items: { bsonType: "object" },
      },
      guardrail_blocks: {
        bsonType: "array",
        items: { bsonType: "string" },
      },
    },
  },
};

const EVAL_CASES_VALIDATOR = {
  $jsonSchema: {
    bsonType: "object",
    required: ["agent", "input", "rubric", "updated_at"],
    properties: {
      agent: { bsonType: "string", minLength: 1 },
      input: { bsonType: "string", minLength: 1 },
      rubric: { bsonType: "string", minLength: 1 },
      updated_at: { bsonType: "date" },
    },
  },
};

const EVAL_RUNS_VALIDATOR = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "ts",
      "agent",
      "version",
      "model",
      "judge_model",
      "results",
      "mean_score",
      "regression",
    ],
    properties: {
      ts: { bsonType: "date" },
      agent: { bsonType: "string", minLength: 1 },
      version: { bsonType: "int", minimum: 1 },
      model: { bsonType: "string", minLength: 1 },
      judge_model: { bsonType: "string", minLength: 1 },
      results: {
        bsonType: "array",
        items: {
          bsonType: "object",
          required: ["case_id", "input", "rubric", "score", "rationale"],
          properties: {
            case_id: { bsonType: "string" },
            input: { bsonType: "string" },
            rubric: { bsonType: "string" },
            score: { bsonType: "number", minimum: 0, maximum: 10 },
            rationale: { bsonType: "string" },
          },
        },
      },
      mean_score: { bsonType: "number", minimum: 0, maximum: 10 },
      baseline_version: { bsonType: ["int", "null"] },
      baseline_mean: { bsonType: ["number", "null"] },
      regression: { bsonType: "bool" },
    },
  },
};

const TOOLS_VALIDATOR = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "name",
      "description",
      "parameters",
      "agents",
      "version",
      "updated_by",
      "updated_at",
    ],
    properties: {
      name: { bsonType: "string", minLength: 1, pattern: "^[a-z][a-z0-9_]*$" },
      description: { bsonType: "string", minLength: 1 },
      parameters: {
        bsonType: "object",
        required: ["type"],
        properties: {
          type: { enum: ["object"] },
        },
      },
      agents: {
        bsonType: "array",
        items: { bsonType: "string", minLength: 1 },
        minItems: 1,
      },
      version: { bsonType: "int", minimum: 1 },
      updated_by: { bsonType: "string" },
      updated_at: { bsonType: "date" },
    },
  },
};

const GUARDRAILS_VALIDATOR = {
  $jsonSchema: {
    bsonType: "object",
    required: ["name", "description", "kind", "value", "agents", "active", "updated_at"],
    properties: {
      name: { bsonType: "string", minLength: 1 },
      description: { bsonType: "string", minLength: 1 },
      kind: { enum: ["input_block", "banned_phrase", "max_tokens"] },
      value: {
        bsonType: ["array", "int"],
        properties: {
          items: { bsonType: "string", minLength: 1 },
        },
      },
      agents: {
        bsonType: "array",
        items: { bsonType: "string", minLength: 1 },
        minItems: 1,
      },
      active: { bsonType: "bool" },
      updated_at: { bsonType: "date" },
    },
  },
};

const ALERT_RULES_VALIDATOR = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "name",
      "description",
      "source",
      "metric",
      "op",
      "threshold",
      "agents",
      "active",
      "updated_at",
    ],
    properties: {
      name: { bsonType: "string", minLength: 1 },
      description: { bsonType: "string", minLength: 1 },
      source: { enum: ["runs", "eval_runs"] },
      metric: {
        enum: ["latency_ms", "tokens_out", "guardrail_blocks", "mean_score", "regression"],
      },
      op: { enum: ["gt", "lt", "eq"] },
      threshold: { bsonType: "number", minimum: 0 },
      agents: {
        bsonType: "array",
        items: { bsonType: "string", minLength: 1 },
        minItems: 1,
      },
      active: { bsonType: "bool" },
      updated_at: { bsonType: "date" },
    },
  },
};

const ALERTS_VALIDATOR = {
  $jsonSchema: {
    bsonType: "object",
    required: [
      "ts",
      "rule",
      "agent",
      "source",
      "metric",
      "op",
      "threshold",
      "value",
      "message",
    ],
    properties: {
      ts: { bsonType: "date" },
      rule: { bsonType: "string", minLength: 1 },
      agent: { bsonType: "string", minLength: 1 },
      source: { enum: ["runs", "eval_runs"] },
      metric: {
        enum: ["latency_ms", "tokens_out", "guardrail_blocks", "mean_score", "regression"],
      },
      op: { enum: ["gt", "lt", "eq"] },
      threshold: { bsonType: "number" },
      value: { bsonType: "number" },
      message: { bsonType: "string", minLength: 1 },
      version: { bsonType: "int", minimum: 1 },
    },
  },
};

/** All collection contracts in one place; new collections join here. */
const CONTRACTS: Record<string, object> = {
  prompts: PROMPTS_VALIDATOR,
  overlays: OVERLAYS_VALIDATOR,
  few_shots: FEW_SHOTS_VALIDATOR,
  runs: RUNS_VALIDATOR,
  eval_cases: EVAL_CASES_VALIDATOR,
  eval_runs: EVAL_RUNS_VALIDATOR,
  tools: TOOLS_VALIDATOR,
  guardrails: GUARDRAILS_VALIDATOR,
  alert_rules: ALERT_RULES_VALIDATOR,
  alerts: ALERTS_VALIDATOR,
};

/**
 * Apply (or update) every collection contract. Existing collections get an
 * atomically swapped validator via collMod; missing ones (fresh environment)
 * are created with the validator up front. Safe on every boot — validators
 * evolve with the domain.
 */
export async function ensureValidators(): Promise<void> {
  for (const [name, validator] of Object.entries(CONTRACTS)) {
    const options = { validator, validationLevel: "moderate", validationAction: "error" } as const;
    const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
    if (exists) {
      await db.command({ collMod: name, ...options });
    } else {
      await db.createCollection(name, options);
    }
  }
}
