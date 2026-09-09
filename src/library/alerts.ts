/**
 * Alerting: rules are documents, evaluated the moment a run or eval-run is
 * written. Fired rules insert Alert docs — and because `alerts` is a watched
 * collection, the change stream pushes every alert to every open console
 * tab in real time. No polling anywhere: writes trigger rules, rules write
 * alerts, alerts stream to humans.
 */

import type { WithId } from "mongodb";
import { alertRules, alerts } from "./db";
import { StoreError } from "./store";
import type { Alert, AlertRule } from "./types";

type RunLike = {
  agent: string;
  latency_ms?: number;
  tokens_out?: number;
  guardrail_blocks?: string[];
  version?: number;
};

type EvalLike = {
  agent: string;
  version: number;
  mean_score: number;
  regression: boolean;
  baseline_mean?: number | null;
};

/** Extract the numeric value a rule's metric reads off a written doc. */
function metricValue(
  metric: AlertRule["metric"],
  doc: RunLike & Partial<EvalLike>,
): number | undefined {
  switch (metric) {
    case "latency_ms":
      return doc.latency_ms;
    case "tokens_out":
      return doc.tokens_out;
    case "guardrail_blocks":
      return Array.isArray(doc.guardrail_blocks) ? doc.guardrail_blocks.length : 0;
    case "mean_score":
      return doc.mean_score;
    case "regression":
      return doc.regression === true ? 1 : doc.regression === false ? 0 : undefined;
  }
}

function testOp(op: AlertRule["op"], value: number, threshold: number): boolean {
  if (op === "gt") return value > threshold;
  if (op === "lt") return value < threshold;
  return value === threshold;
}

function message(
  rule: WithId<AlertRule>,
  value: number,
  doc: RunLike & Partial<EvalLike>,
): string {
  switch (rule.metric) {
    case "latency_ms":
      return `${doc.agent} run took ${(value / 1000).toFixed(1)}s (threshold ${rule.threshold / 1000}s)`;
    case "tokens_out":
      return `${doc.agent} run spent ${value} output tokens (threshold ${rule.threshold})`;
    case "guardrail_blocks": {
      const names = (doc.guardrail_blocks ?? []).join(", ");
      return `${doc.agent} run hit ${value} guardrail${value === 1 ? "" : "s"}${names ? `: ${names}` : ""}`;
    }
    case "mean_score":
      return `${doc.agent} v${doc.version} scored ${value}/10 (threshold ${rule.threshold})`;
    case "regression":
      return `${doc.agent} v${doc.version} regressed: mean ${doc.mean_score} vs baseline ${doc.baseline_mean ?? "—"}`;
  }
}

/**
 * Evaluate all active rules for one freshly written run / eval-run doc.
 * Returns the alerts that fired (already inserted — the change stream
 * delivers them; callers don't need to).
 */
export async function evaluate(
  source: AlertRule["source"],
  doc: RunLike & Partial<EvalLike> & { _id?: unknown },
): Promise<Alert[]> {
  const rules = await alertRules
    .find({ active: true, source, agents: { $in: [doc.agent, "*"] } })
    .toArray();

  const fired: Alert[] = [];
  for (const rule of rules) {
    const value = metricValue(rule.metric, doc);
    if (value === undefined) continue;
    if (!testOp(rule.op, value, rule.threshold)) continue;
    fired.push({
      ts: new Date(),
      rule: rule.name,
      agent: doc.agent,
      source,
      metric: rule.metric,
      op: rule.op,
      threshold: rule.threshold,
      value,
      message: message(rule, value, doc),
      ...(doc.version !== undefined ? { version: doc.version } : {}),
    });
  }
  if (fired.length > 0) await alerts.insertMany(fired);
  return fired;
}

// ---- alert history feed ------------------------------------------------------

export async function listAlerts(
  agent?: string,
  limit = 20,
): Promise<WithId<Alert>[]> {
  return alerts
    .find(agent ? { agent } : {})
    .sort({ ts: -1 })
    .limit(limit)
    .toArray();
}

export async function clearAlerts(agent?: string): Promise<number> {
  const res = await alerts.deleteMany(agent ? { agent } : {});
  return res.deletedCount;
}

// ---- rules CRUD ---------------------------------------------------------------

export async function listRules(): Promise<WithId<AlertRule>[]> {
  return alertRules.find().sort({ source: 1, name: 1 }).toArray();
}

export async function upsertRule(
  def: Omit<AlertRule, "updated_at">,
): Promise<void> {
  const metrics: Record<AlertRule["source"], AlertRule["metric"][]> = {
    runs: ["latency_ms", "tokens_out", "guardrail_blocks"],
    eval_runs: ["mean_score", "regression"],
  };
  if (!metrics[def.source].includes(def.metric)) {
    throw new StoreError(
      `metric ${def.metric} does not apply to ${def.source} (use ${metrics[def.source].join(", ")})`,
      400,
    );
  }
  await alertRules.updateOne(
    { name: def.name },
    { $set: { ...def, updated_at: new Date() } },
    { upsert: true },
  );
}

export async function deleteRule(name: string): Promise<void> {
  const res = await alertRules.deleteOne({ name });
  if (res.deletedCount === 0) throw new StoreError(`rule ${name} not found`, 404);
}
