/**
 * Git mirror export: the whole library, flattened into a tree of
 * frontmatter'd Markdown files — one file per prompt version, overlay,
 * few-shot, tool, and guardrail. Git-native teams get diffs, blame, and PR
 * review over the same documents the live store serves; the export is
 * read-only (the database stays the source of truth, the tree is the
 * reviewable projection of it).
 *
 * Frontmatter values are JSON scalars — YAML 1.2 is a superset of JSON, so
 * `key: "json"` lines parse in any standard YAML frontmatter reader without
 * a bespoke escaping scheme.
 */

import { rm, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  alertRules,
  alerts,
  evalCases,
  evalRuns,
  fewShots,
  guardrails,
  overlays,
  prompts,
  tools,
} from "./db";
import type {
  AgentPrompt,
  Alert,
  AlertRule,
  EvalCase,
  EvalRun,
  FewShot,
  Guardrail,
  PromptOverlay,
  ToolDef,
} from "./types";

const iso = (d: Date | undefined | null) => (d ? d.toISOString() : "—");

/** One frontmatter block: `---` fence, JSON-valued YAML lines, `---`. */
function fm(fields: [string, unknown][]): string {
  const lines = fields
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

async function write(path: string, content: string): Promise<number> {
  await writeFile(path, content, "utf8");
  return 1;
}

const fileSafe = (s: string) => s.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "untitled";

function promptDoc(p: AgentPrompt): string {
  const trail: string[] = [];
  if (p.submitted_by) trail.push(`submitted by ${p.submitted_by} ${iso(p.submitted_at)}`);
  if (p.approved_by) trail.push(`approved by ${p.approved_by} ${iso(p.approved_at)}`);
  if (p.published_by) trail.push(`published by ${p.published_by} ${iso(p.published_at)}`);
  return (
    fm([
      ["agent", p.agent],
      ["version", p.version],
      ["status", p.status],
      ["changelog", p.changelog],
      ["updated_by", p.updated_by],
      ["updated_at", iso(p.updated_at)],
      ["macros", p.macros],
      ["variants", p.variants.map(v => ({ id: v.id, label: v.label, weight: v.weight }))],
      ["review_trail", trail],
    ]) +
    `# ${p.agent} — v${p.version} (${p.status})\n\n` +
    (p.variants.some(v => v.body) ? `> Note: A/B variant bodies live in the database; this file is the base body.\n\n` : "") +
    "## System prompt\n\n```\n" + p.body + "\n```\n"
  );
}

function overlayDoc(o: PromptOverlay): string {
  return (
    fm([
      ["agent", o.agent],
      ["tenant", o.tenant],
      ["updated_at", iso(o.updated_at)],
    ]) +
    `# Overlay — ${o.agent} @ ${o.tenant}\n\n` +
    "```json\n" + JSON.stringify(o.patch, null, 2) + "\n```\n"
  );
}

function fewShotDoc(f: FewShot): string {
  return (
    fm([
      ["agent", f.agent],
      ["note", f.note],
      ["updated_at", iso(f.updated_at)],
    ]) +
    `# Few-shot${f.note ? ` — ${f.note}` : ""}\n\n` +
    "```\n" + f.text + "\n```\n"
  );
}

function toolDoc(t: ToolDef): string {
  return (
    fm([
      ["tool", t.name],
      ["description", t.description],
      ["agents", t.agents],
      ["version", t.version],
      ["updated_by", t.updated_by],
      ["updated_at", iso(t.updated_at)],
    ]) +
    `# Tool — ${t.name}\n\n${t.description}\n\n` +
    "## Parameters (JSON Schema)\n\n```json\n" +
    JSON.stringify(t.parameters, null, 2) + "\n```\n"
  );
}

function guardrailDoc(g: Guardrail): string {
  return (
    fm([
      ["guardrail", g.name],
      ["kind", g.kind],
      ["value", g.value],
      ["agents", g.agents],
      ["active", g.active],
      ["description", g.description],
      ["updated_at", iso(g.updated_at)],
    ]) +
    `# Guardrail — ${g.name} (${g.kind}${g.active ? "" : ", inactive"})\n\n${g.description}\n\n` +
    "```json\n" + JSON.stringify(g.value, null, 2) + "\n```\n"
  );
}

function evalsDoc(cases: WithIdCase[], runs: EvalRun[]): string {
  const caseMd = cases.length
    ? "## Golden cases\n\n" +
      cases
        .map((c, i) => `### Case ${i + 1}\n\n**Input**\n\n\`\`\`\n${c.input}\n\`\`\`\n\n**Rubric**\n\n${c.rubric}\n`)
        .join("\n")
    : "";
  const runRows = runs
    .map(
      r =>
        `| ${iso(r.ts)} | v${r.version} | ${r.mean_score} | ` +
        `${r.baseline_version != null ? `v${r.baseline_version} @ ${r.baseline_mean}` : "—"} | ` +
        `${r.regression ? "🚨 regression" : "ok"} | ${r.judge_model} |`,
    )
    .join("\n");
  const runMd = runs.length
    ? "## Score history (newest first)\n\n| when | version | mean | baseline | gate | judge |\n|---|---|---|---|---|---|\n" + runRows + "\n"
    : "";
  return `# Evals\n\n${caseMd}${runMd}`;
}
type WithIdCase = EvalCase & { _id?: unknown };

function alertsDoc(rules: AlertRule[], alerts: Alert[]): string {
  const ruleRows = rules.map(r => `| ${r.name} | ${r.source} | ${r.metric} ${r.op} ${r.threshold} | ${r.agents.join(", ")} | ${r.active ? "on" : "off"} |`).join("\n");
  const alertRows = alerts.slice(0, 50).map(a => `| ${iso(a.ts)} | ${a.rule} | ${a.agent} | ${a.message} |`).join("\n");
  return (
    `# Ops — rules + alert history\n\n## Rules\n\n| rule | source | condition | agents | state |\n|---|---|---|---|---|\n${ruleRows || "| — | — | — | — | — |"}\n\n` +
    `## Recent alerts (latest 50)\n\n| when | rule | agent | message |\n|---|---|---|---|\n${alertRows || "| — | — | — | — |"}\n`
  );
}

/**
 * Materialize the git mirror. Wipes and rebuilds `outDir` — it is a
 * generated artifact; the database remains the source of truth.
 */
export async function exportAll(outDir = "export"): Promise<{ agents: number; files: number }> {
  const root = resolve(outDir);
  if (root === resolve(".") || root === resolve("/")) {
    throw new Error("refusing to export into the repo root");
  }
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  const [allPrompts, allOverlays, allFewShots, allTools, allGuardrails, allCases, allEvalRuns] =
    await Promise.all([
      prompts.find().sort({ agent: 1, version: 1 }).toArray(),
      overlays.find().sort({ agent: 1, tenant: 1 }).toArray(),
      fewShots.find().sort({ agent: 1, updated_at: 1 }).toArray(),
      tools.find().sort({ name: 1 }).toArray(),
      guardrails.find().sort({ name: 1 }).toArray(),
      evalCases.find().sort({ agent: 1, updated_at: 1 }).toArray(),
      evalRuns.find().sort({ ts: -1 }).limit(200).toArray(),
    ]);

  const agents = [...new Set(allPrompts.map(p => p.agent))].sort();
  let files = 0;

  for (const agent of agents) {
    const dir = `${root}/${fileSafe(agent)}`;
    await mkdir(dir, { recursive: true });

    // one .md per prompt version — diffs and review happen per version
    for (const p of allPrompts.filter(p => p.agent === agent)) {
      files += await write(`${dir}/prompt-v${p.version}.md`, promptDoc(p));
    }
    const agentOverlays = allOverlays.filter(o => o.agent === agent);
    if (agentOverlays.length) {
      await mkdir(`${dir}/overlays`, { recursive: true });
      for (const o of agentOverlays) {
        files += await write(`${dir}/overlays/${fileSafe(o.tenant)}.md`, overlayDoc(o));
      }
    }
    const agentFewShots = allFewShots.filter(f => f.agent === agent);
    if (agentFewShots.length) {
      await mkdir(`${dir}/few-shots`, { recursive: true });
      for (let i = 0; i < agentFewShots.length; i++) {
        const f = agentFewShots[i];
        files += await write(`${dir}/few-shots/${String(i + 1).padStart(2, "0")}-${fileSafe(f.note ?? "example")}.md`, fewShotDoc(f));
      }
    }
    files += await write(
      `${dir}/evals.md`,
      evalsDoc(allCases.filter(c => c.agent === agent), allEvalRuns.filter(r => r.agent === agent)),
    );
  }

  // tools + guardrails are library-global (agents: ["*"] wildcards) — top level
  if (allTools.length) {
    await mkdir(`${root}/tools`, { recursive: true });
    for (const t of allTools) files += await write(`${root}/tools/${fileSafe(t.name)}.md`, toolDoc(t));
  }
  if (allGuardrails.length) {
    await mkdir(`${root}/guardrails`, { recursive: true });
    for (const g of allGuardrails) files += await write(`${root}/guardrails/${fileSafe(g.name)}.md`, guardrailDoc(g));
  }

  // ops mirror: rules + recent alerts (the alert history is point-in-time)
  const [rules, fired] = await Promise.all([alertRules.find().sort({ name: 1 }).toArray(), alerts.find().sort({ ts: -1 }).limit(50).toArray()]);
  files += await write(`${root}/ops.md`, alertsDoc(rules, fired));

  // index
  const activeBy = new Map(allPrompts.filter(p => p.status === "active").map(p => [p.agent, p.version]));
  const index =
    fm([
      ["generated_at", iso(new Date())],
      ["agents", agents.map(a => ({ agent: a, active_version: activeBy.get(a) ?? null }))],
    ]) +
    `# Prompt library — git mirror\n\n` +
    `Generated from the live MongoDB store by \`bun run export\`. Read-only projection: the database is the source of truth; commit this tree (or a branch of it) when you want PR review over prompt changes.\n\n` +
    agents
      .map(a => `- **${a}** — active v${activeBy.get(a) ?? "—"}, [evals](./${fileSafe(a)}/evals.md)`)
      .join("\n") +
    `\n\n- [tools](./tools/) · [guardrails](./guardrails/) · [ops rules + alerts](./ops.md)\n`;
  files += await write(`${root}/README.md`, index);

  return { agents: agents.length, files };
}
