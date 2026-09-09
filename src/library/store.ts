import type { WithId } from "mongodb";
import { fewShots, guardrails, overlays, prompts, runs, tools, withTx } from "./db";
import type {
  AgentPrompt,
  FewShot,
  Guardrail,
  OverlayPatch,
  PromptOverlay,
  ResolvedBundle,
  ResolvedPrompt,
  Run,
  ToolDef,
} from "./types";

const FIELD = "system_prompt";

export class StoreError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** All agents that have at least one prompt version (aggregation). */
export async function listAgents(): Promise<
  { agent: string; active_version: number | null; versions: number }[]
> {
  const agg = await prompts
    .aggregate<{
      _id: string;
      versions: number;
      active_version: number | null;
    }>([
      { $group: { _id: "$agent", versions: { $sum: 1 } } },
      {
        $lookup: {
          from: "prompts",
          let: { a: "$_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$agent", "$$a"] }, field: FIELD, status: "active" } },
            { $project: { version: 1, _id: 0 } },
          ],
          as: "active",
        },
      },
      { $set: { active_version: { $first: "$active.version" } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  return agg.map(r => ({ agent: r._id, versions: r.versions, active_version: r.active_version }));
}

export async function getActive(agent: string): Promise<WithId<AgentPrompt> | null> {
  return prompts.findOne(
    { agent, field: FIELD, status: "active" },
    { sort: { version: -1 } },
  );
}

export async function listVersions(agent: string): Promise<WithId<AgentPrompt>[]> {
  return prompts.find({ agent, field: FIELD }).sort({ version: -1 }).toArray();
}

export async function countPrompts(agent?: string): Promise<number> {
  return prompts.countDocuments(agent ? { agent } : {});
}

async function nextVersion(agent: string): Promise<number> {
  const last = await prompts.findOne(
    { agent, field: FIELD },
    { sort: { version: -1 }, projection: { version: 1 } },
  );
  return (last?.version ?? 0) + 1;
}

export interface NewVersionInput {
  body: string;
  macros?: Record<string, string>;
  variants?: AgentPrompt["variants"];
  changelog: string;
  updated_by?: string;
}

/**
 * Every save is a new immutable version, born as a draft. The active prompt
 * keeps serving until this draft is submitted, approved, and published —
 * editors can iterate without touching production. Git-like history for
 * prompts, without deploys.
 */
export async function createVersion(
  agent: string,
  input: NewVersionInput,
): Promise<WithId<AgentPrompt>> {
  if (!input.body?.trim()) throw new StoreError("body is required");
  if (!input.changelog?.trim()) throw new StoreError("changelog is required");

  const version = await nextVersion(agent);
  const prev = await getActive(agent);

  const doc: AgentPrompt = {
    agent,
    field: FIELD,
    version,
    status: "draft",
    body: input.body,
    macros: input.macros ?? prev?.macros ?? {},
    variants: input.variants ?? prev?.variants ?? [],
    changelog: input.changelog,
    updated_by: input.updated_by ?? "console@promptlib",
    updated_at: new Date(),
  };
  const res = await prompts.insertOne(doc);
  return { ...doc, _id: res.insertedId };
}

/** Draft → in_review: an editor asks a reviewer to look at this version. */
export async function submitForReview(
  agent: string,
  version: number,
  by = "editor@promptlib",
): Promise<WithId<AgentPrompt>> {
  const target = await mustFind(agent, version);
  if (target.status !== "draft") {
    throw new StoreError(
      `v${version} is ${target.status}; only drafts can be submitted for review`,
      409,
    );
  }
  const now = new Date();
  await prompts.updateOne(
    { _id: target._id },
    { $set: { status: "in_review", submitted_by: by, submitted_at: now } },
  );
  return { ...target, status: "in_review", submitted_by: by, submitted_at: now };
}

/**
 * In_review → approved (or back to draft on rejection). Approving records
 * who signed off; rejecting clears the review state so the editor can
 * iterate and resubmit.
 */
export async function reviewVersion(
  agent: string,
  version: number,
  decision: "approve" | "reject",
  by = "reviewer@promptlib",
): Promise<WithId<AgentPrompt>> {
  const target = await mustFind(agent, version);
  if (target.status !== "in_review") {
    throw new StoreError(
      `v${version} is ${target.status}; only versions in review can be ${decision}d`,
      409,
    );
  }
  const now = new Date();
  if (decision === "approve") {
    await prompts.updateOne(
      { _id: target._id },
      { $set: { status: "approved", approved_by: by, approved_at: now } },
    );
    return { ...target, status: "approved", approved_by: by, approved_at: now };
  }
  await prompts.updateOne(
    { _id: target._id },
    { $set: { status: "draft" }, $unset: { approved_by: "", approved_at: "" } },
  );
  return { ...target, status: "draft" };
}

/**
 * Approved → active, atomically: the previous active version archives and
 * the new version activates inside ONE transaction — a crash can never
 * leave two actives or zero actives. This is the release moment.
 */
export async function publish(
  agent: string,
  version: number,
  by = "admin@promptlib",
  opts: { force?: boolean } = {},
): Promise<WithId<AgentPrompt>> {
  const target = await mustFind(agent, version);
  if (target.status !== "approved") {
    throw new StoreError(
      `v${version} is ${target.status}; only approved versions can be published`,
      409,
    );
  }
  // eval gate: a scored regression on this version blocks the release
  // (force publishes anyway — the human decided, and it's on the record)
  const { latestEvalRun } = await import("./eval");
  const latest = await latestEvalRun(agent, version);
  if (latest?.regression && !opts.force) {
    throw new StoreError(
      `eval regression: v${version} scored ${latest.mean_score.toFixed(1)} vs ` +
        `baseline v${latest.baseline_version} at ${latest.baseline_mean?.toFixed(1)} — ` +
        `publish with force: true to override`,
      409,
    );
  }
  return withTx(async session => {
    const prev = await prompts.findOne(
      { agent, field: FIELD, status: "active" },
      { session, sort: { version: -1 } },
    );
    if (prev && prev.version !== version) {
      await prompts.updateOne(
        { _id: prev._id },
        { $set: { status: "archived" } },
        { session },
      );
    }
    const now = new Date();
    await prompts.updateOne(
      { _id: target._id },
      { $set: { status: "active", published_by: by, published_at: now } },
      { session },
    );
    return { ...target, status: "active", published_by: by, published_at: now };
  });
}

/** Re-activate an archived version — transactional, like publish. */
export async function rollback(
  agent: string,
  version: number,
): Promise<WithId<AgentPrompt>> {
  const target = await mustFind(agent, version);
  if (target.status === "active") return target;
  if (target.status !== "archived" && target.status !== "approved") {
    throw new StoreError(
      `v${version} is ${target.status}; only archived (previously live) or approved versions can be activated`,
      409,
    );
  }
  return withTx(async session => {
    const prev = await prompts.findOne(
      { agent, field: FIELD, status: "active" },
      { session, sort: { version: -1 } },
    );
    if (prev && prev.version !== version) {
      await prompts.updateOne(
        { _id: prev._id },
        { $set: { status: "archived" } },
        { session },
      );
    }
    await prompts.updateOne(
      { _id: target._id },
      { $set: { status: "active" } },
      { session },
    );
    return { ...target, status: "active" };
  });
}

async function mustFind(agent: string, version: number): Promise<WithId<AgentPrompt>> {
  const target = await prompts.findOne({ agent, field: FIELD, version });
  if (!target) throw new StoreError(`version ${version} not found`, 404);
  return target;
}

/** Public read accessor for a single version (used by the eval runner). */
export async function getVersion(
  agent: string,
  version: number,
): Promise<WithId<AgentPrompt> | null> {
  return prompts.findOne({ agent, field: FIELD, version });
}

export async function upsertOverlay(
  agent: string,
  tenant: string,
  patch: OverlayPatch,
): Promise<void> {
  if (!tenant || tenant === "*") throw new StoreError("tenant is required");
  await overlays.updateOne(
    { agent, tenant },
    { $set: { patch, updated_at: new Date() } },
    { upsert: true },
  );
}

export async function listOverlays(agent: string): Promise<WithId<PromptOverlay>[]> {
  return overlays.find({ agent }).sort({ tenant: 1 }).toArray();
}

/** Remove a tenant overlay; the tenant falls back to the base prompt. */
export async function deleteOverlay(agent: string, tenant: string): Promise<void> {
  if (!tenant || tenant === "*") throw new StoreError("tenant is required");
  const res = await overlays.deleteOne({ agent, tenant });
  if (res.deletedCount === 0) {
    throw new StoreError(`no overlay for tenant ${tenant}`, 404);
  }
}

// ---- few-shots -------------------------------------------------------------

export async function listFewShots(agent: string): Promise<WithId<FewShot>[]> {
  return fewShots.find({ agent }).sort({ updated_at: -1 }).toArray();
}

export async function addFewShot(
  agent: string,
  text: string,
  note?: string,
): Promise<WithId<FewShot>> {
  if (!text?.trim()) throw new StoreError("few-shot text is required");
  const doc: FewShot = { agent, text, note, updated_at: new Date() };
  const res = await fewShots.insertOne(doc);
  return { ...doc, _id: res.insertedId };
}

export async function deleteFewShot(id: string): Promise<void> {
  const { ObjectId } = await import("mongodb");
  let oid;
  try {
    oid = new ObjectId(id);
  } catch {
    throw new StoreError("invalid few-shot id", 400);
  }
  const res = await fewShots.deleteOne({ _id: oid });
  if (res.deletedCount === 0) throw new StoreError("few-shot not found", 404);
}

// ---- resolution ------------------------------------------------------------

/**
 * The heart of the library: base body + tenant overlay + macro substitution,
 * all resolved from MongoDB in two reads. Semantic few-shot injection is
 * layered on top at run time (see library/semantic.ts).
 */
export async function resolvePrompt(
  agent: string,
  tenant?: string | null,
): Promise<ResolvedPrompt | null> {
  const active = await getActive(agent);
  if (!active) return null;

  let body = active.body;
  let macros = { ...active.macros };
  let overlay: ResolvedPrompt["overlay"] = null;

  if (tenant && tenant !== "*") {
    const ov = await overlays.findOne({ agent, tenant });
    if (ov) {
      overlay = { tenant, patch: ov.patch };
      if (ov.patch.body_append) body += "\n\n" + ov.patch.body_append;
      if (ov.patch.macros) macros = { ...macros, ...ov.patch.macros };
    }
  }

  body = subMacros(body, macros);

  return {
    agent,
    version: active.version,
    body,
    macros,
    overlay,
    resolved_at: new Date().toISOString(),
  };
}

/** Substitute {{token}} macros; exported so variant bodies can reuse it. */
export function subMacros(body: string, macros: Record<string, string>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key: string) =>
    key in macros ? macros[key] : m,
  );
}

// ---- tools + guardrails ----------------------------------------------------

/** Tools available to an agent (or all agents via the "*" wildcard). */
export async function toolsForAgent(agent: string): Promise<WithId<ToolDef>[]> {
  return tools.find({ agents: { $in: [agent, "*"] } }).sort({ name: 1 }).toArray();
}

export async function listTools(): Promise<WithId<ToolDef>[]> {
  return tools.find().sort({ name: 1 }).toArray();
}

/** Create or evolve a tool definition; bumping the version keeps intent. */
export async function upsertTool(
  def: Omit<ToolDef, "version" | "updated_at" | "updated_by">,
  updatedBy: string,
): Promise<WithId<ToolDef>> {
  const existing = await tools.findOne({ name: def.name });
  const version = (existing?.version ?? 0) + 1;
  const now = new Date();
  const doc = { ...def, version, updated_by: updatedBy, updated_at: now };
  await tools.updateOne(
    { name: def.name },
    { $set: doc },
    { upsert: true },
  );
  return (await tools.findOne({ name: def.name }))!;
}

export async function deleteTool(name: string): Promise<void> {
  const res = await tools.deleteOne({ name });
  if (res.deletedCount === 0) throw new StoreError(`tool ${name} not found`, 404);
}

/** Active guardrails that apply to an agent (wildcard "*" included). */
export async function guardrailsForAgent(agent: string): Promise<WithId<Guardrail>[]> {
  return guardrails
    .find({ active: true, agents: { $in: [agent, "*"] } })
    .sort({ name: 1 })
    .toArray();
}

export async function listGuardrails(): Promise<WithId<Guardrail>[]> {
  return guardrails.find().sort({ name: 1 }).toArray();
}

export async function upsertGuardrail(
  def: Omit<Guardrail, "updated_at">,
): Promise<void> {
  await guardrails.updateOne(
    { name: def.name },
    { $set: { ...def, updated_at: new Date() } },
    { upsert: true },
  );
}

export async function deleteGuardrail(name: string): Promise<void> {
  const res = await guardrails.deleteOne({ name });
  if (res.deletedCount === 0) throw new StoreError(`guardrail ${name} not found`, 404);
}

/**
 * The full bundle an agent runs with: resolved prompt + callable tools +
 * active guardrails. One call gives the runner everything it needs — the
 * same view the console and the API expose, so what you see is what runs.
 */
export async function resolveBundle(
  agent: string,
  tenant?: string | null,
): Promise<ResolvedBundle | null> {
  const prompt = await resolvePrompt(agent, tenant);
  if (!prompt) return null;
  const [ts, gs] = await Promise.all([toolsForAgent(agent), guardrailsForAgent(agent)]);
  const strip = <T extends { _id: unknown }>({ _id, ...rest }: T) => rest as Omit<T, "_id">;
  return {
    prompt,
    tools: ts.map(strip),
    guardrails: gs.map(strip),
    resolved_at: new Date().toISOString(),
  };
}

// ---- runs + A/B ------------------------------------------------------------

/** Record one executed run (written by the run executor after a completion). */
export async function insertRun(run: Run): Promise<Run> {
  await runs.insertOne({ ...run });
  return run;
}

/** Recent runs for an agent, newest first (A/B dashboard feed). */
export async function listRuns(agent?: string, limit = 20) {
  return runs
    .find(agent ? { agent } : {})
    .sort({ ts: -1 })
    .limit(limit)
    .project({ input: 1, output: 1, agent: 1, variant: 1, tenant: 1, prompt_version: 1, model: 1, latency_ms: 1, tokens_in: 1, tokens_out: 1, verdict: 1, guardrail_blocks: 1, ts: 1 })
    .toArray();
}

/** A/B verdicts are human: mark a run up/down after reading the reply. */
export async function setVerdict(runId: string, verdict: "up" | "down") {
  const { ObjectId } = await import("mongodb");
  let oid;
  try {
    oid = new ObjectId(runId);
  } catch {
    throw new StoreError("invalid run id", 400);
  }
  const res = await runs.updateOne({ _id: oid }, { $set: { verdict } });
  if (res.matchedCount === 0) throw new StoreError("run not found", 404);
  return { ok: true, run_id: runId, verdict };
}

export interface AbVariantStats {
  variant: string;
  runs: number;
  wins: number;
}

/** Real A/B numbers: aggregate the runs collection by variant. */
export async function abStats(agent: string): Promise<AbVariantStats[]> {
  const agg = await runs
    .aggregate<{ _id: string; runs: number; wins: number }>([
      { $match: { agent, variant: { $ne: null } } },
      {
        $group: {
          _id: "$variant",
          runs: { $sum: 1 },
          wins: { $sum: { $cond: [{ $eq: ["$verdict", "up"] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  return agg.map(r => ({ variant: r._id, runs: r.runs, wins: r.wins }));
}

/**
 * Traffic split lives on the active document's variant weights — it is
 * operational routing config, not prompt content, so it updates in place
 * (version/body history stays immutable; createVersion still owns content).
 */
export async function setSplit(
  agent: string,
  weights: { a: number; b: number },
): Promise<WithId<AgentPrompt>> {
  const active = await getActive(agent);
  if (!active) throw new StoreError(`agent ${agent} has no active version`, 404);

  const clean = (n: number) =>
    Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : NaN;
  const a = clean(weights.a);
  const b = clean(weights.b);
  if (Number.isNaN(a) || Number.isNaN(b) || a + b !== 100) {
    throw new StoreError("weights a and b must be integers 0-100 summing to 100");
  }

  await prompts.updateOne(
    { _id: active._id },
    { $set: { "variants.$[va].weight": a, "variants.$[vb].weight": b } },
    { arrayFilters: [{ "va.id": "A" }, { "vb.id": "B" }] },
  );

  const updated = await getActive(agent);
  if (!updated) throw new StoreError("setSplit failed: active version vanished", 500);
  return updated;
}

export async function stats(agent?: string) {
  const [promptCount, overlayCount, fewShotCount, runCount] = await Promise.all([
    countPrompts(agent),
    overlays.countDocuments(agent ? { agent } : {}),
    fewShots.countDocuments(agent ? { agent } : {}),
    runs.countDocuments(agent ? { agent } : {}),
  ]);
  return { prompts: promptCount, overlays: overlayCount, few_shots: fewShotCount, runs: runCount };
}

// ---- analytics (aggregation showcase) ---------------------------------------

export interface Analytics {
  agents: {
    agent: string;
    versions: number;
    overlays: number;
    few_shots: number;
    runs: number;
    wins: number;
    win_rate: number | null;
    avg_latency_ms: number | null;
    p95_latency_ms: number | null;
    tokens_in: number;
    tokens_out: number;
  }[];
}

/**
 * One $facet pass over runs joined to library counts per agent: win rates,
 * latency percentiles ($percentile, MongoDB 7+), token totals. This is the
 * "prompt ops" view — the aggregation framework doing the analytics the
 * console renders.
 */
export async function analytics(): Promise<Analytics> {
  const [libAgg, runAgg] = await Promise.all([
    prompts.aggregate<{ _id: string; versions: number }>([
      { $group: { _id: "$agent", versions: { $sum: 1 } } },
    ]).toArray(),
    runs
      .aggregate<{
        _id: string;
        runs: number;
        wins: number;
        avg_latency_ms: number | null;
        p95_latency_ms: number | null;
        tokens_in: number;
        tokens_out: number;
      }>([
        {
          $group: {
            _id: "$agent",
            runs: { $sum: 1 },
            wins: { $sum: { $cond: [{ $eq: ["$verdict", "up"] }, 1, 0] } },
            avg_latency_ms: { $avg: "$latency_ms" },
            p95_latency_ms: {
              $percentile: { input: "$latency_ms", p: [0.95], method: "approximate" },
            },
            tokens_in: { $sum: "$tokens_in" },
            tokens_out: { $sum: "$tokens_out" },
          },
        },
      ])
      .toArray(),
  ]);

  const overlayCounts = new Map(
    (await overlays.aggregate<{ _id: string; n: number }>([
      { $group: { _id: "$agent", n: { $sum: 1 } } },
    ]).toArray()).map(o => [o._id, o.n]),
  );
  const fewShotCounts = new Map(
    (await fewShots.aggregate<{ _id: string; n: number }>([
      { $group: { _id: "$agent", n: { $sum: 1 } } },
    ]).toArray()).map(f => [f._id, f.n]),
  );
  const runBy = new Map(runAgg.map(r => [r._id, r]));

  const agents = libAgg.map(l => {
    const r = runBy.get(l._id);
    return {
      agent: l._id,
      versions: l.versions,
      overlays: overlayCounts.get(l._id) ?? 0,
      few_shots: fewShotCounts.get(l._id) ?? 0,
      runs: r?.runs ?? 0,
      wins: r?.wins ?? 0,
      win_rate: r && r.runs > 0 ? Math.round((r.wins / r.runs) * 100) / 100 : null,
      avg_latency_ms: r?.avg_latency_ms != null ? Math.round(r.avg_latency_ms) : null,
      p95_latency_ms: r?.p95_latency_ms != null ? Math.round(r.p95_latency_ms) : null,
      tokens_in: r?.tokens_in ?? 0,
      tokens_out: r?.tokens_out ?? 0,
    };
  });
  agents.sort((a, b) => a.agent.localeCompare(b.agent));
  return { agents };
}
