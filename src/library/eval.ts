/**
 * The eval gate: golden cases (input + rubric) are run through a candidate
 * prompt version, and an LLM judge scores each output 0-10 against the
 * rubric. Scores land in `eval_runs` per version; publish refuses versions
 * whose latest run regressed against the active baseline.
 *
 * Both the candidate run and the judge go through the same OpenAI-compatible
 * gateway as production traffic — the eval measures the real thing.
 */

import type { WithId } from "mongodb";
import { evalCases, evalRuns } from "./db";
import { evaluate } from "./alerts";
import { completeChat, llmConfig } from "./llm";
import { getActive, getVersion, StoreError, subMacros } from "./store";
import type { EvalCase, EvalResult, EvalRun } from "./types";

export async function listEvalCases(agent: string): Promise<WithId<EvalCase>[]> {
  return evalCases.find({ agent }).sort({ updated_at: 1 }).toArray();
}

export async function addEvalCase(
  agent: string,
  input: string,
  rubric: string,
): Promise<WithId<EvalCase>> {
  if (!input?.trim()) throw new StoreError("eval case input is required");
  if (!rubric?.trim()) throw new StoreError("eval case rubric is required");
  const doc: EvalCase = { agent, input, rubric, updated_at: new Date() };
  const res = await evalCases.insertOne(doc);
  return { ...doc, _id: res.insertedId };
}

export async function deleteEvalCase(id: string): Promise<void> {
  const { ObjectId } = await import("mongodb");
  let oid;
  try {
    oid = new ObjectId(id);
  } catch {
    throw new StoreError("invalid eval case id", 400);
  }
  const res = await evalCases.deleteOne({ _id: oid });
  if (res.deletedCount === 0) throw new StoreError("eval case not found", 404);
}

/** Most recent suite result for a version — the number publish gates on. */
export async function latestEvalRun(
  agent: string,
  version: number,
): Promise<WithId<EvalRun> | null> {
  return evalRuns.findOne({ agent, version }, { sort: { ts: -1 } });
}

/** Score history for an agent, newest first. */
export async function listEvalRuns(agent: string): Promise<WithId<EvalRun>[]> {
  return evalRuns.find({ agent }).sort({ ts: -1 }).limit(20).toArray();
}

const JUDGE_SYSTEM = `You are an impartial QA judge for AI agent outputs.
Score the OUTPUT against the RUBRIC on a 0-10 integer scale:
  9-10 fully satisfies every rubric point; 7-8 satisfies most with minor gaps;
  4-6 partially satisfies; 0-3 fails or contradicts the rubric.
Judge only what the rubric asks — ignore style unless the rubric says so.
Respond with ONLY a JSON object, no prose:
{"score": <integer 0-10>, "rationale": "<one sentence>"}`;

/** Tolerant JSON extraction: judges sometimes wrap or prefix their JSON. */
function parseJudgeReply(text: string): { score: number; rationale: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as { score?: unknown; rationale?: unknown };
    const score = Number(parsed.score);
    if (!Number.isFinite(score) || score < 0 || score > 10) return null;
    return {
      score: Math.round(score),
      rationale:
        typeof parsed.rationale === "string" && parsed.rationale.trim()
          ? parsed.rationale.trim()
          : "(no rationale given)",
    };
  } catch {
    return null;
  }
}

/**
 * Run the golden suite against one prompt version (its base body with its
 * own macros substituted — the canonical prompt, no tenant overlay, control
 * variant). Each case: candidate completion, then judged against the rubric.
 * The run is compared to the current active version's latest score and
 * stored; a regression flags (and later blocks) the publish.
 */
export async function runEvalSuite(
  agent: string,
  version: number,
): Promise<WithId<EvalRun>> {
  const doc = await getVersion(agent, version);
  if (!doc) throw new StoreError(`version ${version} not found`, 404);

  const cases = await listEvalCases(agent);
  if (cases.length === 0) {
    throw new StoreError(
      `no eval cases for ${agent} — add golden cases before running the suite`,
      409,
    );
  }

  const body = subMacros(doc.body, doc.macros);
  const cfg = llmConfig();
  const results: EvalResult[] = [];

  for (const c of cases) {
    // 1. the candidate: the version under test answers the golden input
    const candidate = await completeChat({
      messages: [
        { role: "system", content: body },
        { role: "user", content: c.input },
      ],
      maxTokens: 800,
    });

    // 2. the judge: scores that answer against the case's rubric
    const judged = await completeChat({
      messages: [
        { role: "system", content: JUDGE_SYSTEM },
        {
          role: "user",
          content: `RUBRIC:\n${c.rubric}\n\nINPUT:\n${c.input}\n\nOUTPUT TO JUDGE:\n${candidate.text}`,
        },
      ],
      maxTokens: 200,
    });
    const verdict = parseJudgeReply(judged.text) ?? {
      score: 0,
      rationale: "judge reply unparseable — scored 0, rerun the suite",
    };
    results.push({
      case_id: String(c._id),
      input: c.input,
      rubric: c.rubric,
      score: verdict.score,
      rationale: verdict.rationale,
    });
  }

  const mean =
    Math.round((results.reduce((s, r) => s + r.score, 0) / results.length) * 100) / 100;

  // baseline: the live version's most recent suite at eval time
  const active = await getActive(agent);
  let baseline_version: number | null = null;
  let baseline_mean: number | null = null;
  if (active && active.version !== version) {
    const baseline = await latestEvalRun(agent, active.version);
    if (baseline) {
      baseline_version = baseline.version;
      baseline_mean = baseline.mean_score;
    }
  }

  const run: EvalRun = {
    ts: new Date(),
    agent,
    version,
    model: cfg.model,
    judge_model: cfg.model,
    results,
    mean_score: mean,
    baseline_version,
    baseline_mean,
    regression: baseline_mean != null && mean < baseline_mean,
  };
  const res = await evalRuns.insertOne(run);
  // observability: alert rules (score drops, regressions) fire on the write
  await evaluate("eval_runs", { ...run, _id: res.insertedId });
  return { ...run, _id: res.insertedId };
}
