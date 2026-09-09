# mongo-prompt-library

**MongoDB as the prompt layer for your agents.** Versioned, A/B-testable,
tenant-overridable, semantically retrievable prompts — with a live console,
streaming runs, and an agent that can edit its own prompt through a tool call.

Live demo: **https://promptlib-production.up.railway.app/console.html**

Four example agents ship in the seed:

| agent | what it shows |
|---|---|
| `support-triage` | macros, tenant overlays (acme/globex/itech), severity rubric across 3 versions |
| `code-reviewer` | A/B variants (control vs candidate), few-shot retrieval |
| `research-assistant` | claim-evidence-confidence structure, single version |
| `marketing-copy` | chat-edit: the agent writes its own next prompt version |

## What's in the box

- **Immutable versioning** — every prompt change is a new document; rollback is one write, no deploy.
- **A/B testing** — weighted variants per agent, human verdicts (`up`/`down`) roll into per-variant win stats.
- **Tenant overlays** — per-tenant `body_append` + macro patches layered over the base prompt at resolve time.
- **Macros** — `{{placeholders}}` substituted from the active version's macro map.
- **Atlas Vector Search (autoEmbed)** — zero embedding code; Atlas embeds `few_shots.text` and `prompts.body` with `voyage-4-lite`. Powers semantic routing (`/api/route`) and per-run few-shot retrieval.
- **Atlas Search (full-text)** — `$search` over every version of every prompt, archived included.
- **Aggregation analytics** — one `$facet` pass: runs, wins, win-rate, avg/p95 latency ($percentile), tokens — per agent.
- **Change streams** — every prompt/overlay/few-shot/run write pushes to the console live (SSE).
- **Streaming runs** — SSE from resolve (base + overlay + macros + few-shots) through the LLM stream to the recorded run.
- **Chat-edit agent** — an agent with a `write_prompt_version` tool can revise its own prompt; the new version is live on the next run.

## Quick start

```bash
bun install

export MONGODB_URI="mongodb+srv://<user>:<pw>@<cluster>/?retryWrites=true&w=majority"
export LLM_API_KEY="..."          # any OpenAI-compatible gateway
export LLM_BASE_URL="https://..." # defaults to GROVE_BASE_URL / openai

bun run src/server.ts             # seeds if empty, self-provisions all search indexes
open http://localhost:3000/console.html
```

The server self-provisions everything it needs on boot: the two autoEmbed
vector indexes (with filter fields), the Atlas Search index, and the seed data.
Works on a free-tier M0 cluster.

Any OpenAI-compatible endpoint works via `LLM_BASE_URL` / `LLM_API_KEY` /
`LLM_MODEL` (or `GROVE_*`).

## Copy these pieces into your app

Everything is plain documents in four collections — copy the `src/library/`
files you need, or hit the REST API.

**1. Resolve the prompt for a run (base + overlay + macros):**

```ts
import { resolvePrompt } from "./library/store";

const resolved = await resolvePrompt("support-triage", { tenant: "acme" });
// → { agent, version, body }  — acme's overlay appended, {{macros}} substituted
```

**2. Run an agent with streaming (SSE):**

```ts
import { streamRunEvents } from "./library/run";

for await (const ev of streamRunEvents("support-triage", {
  input: "customer's API is down, they're losing orders",
  tenant: "acme",
})) {
  if (ev.type === "delta") process.stdout.write(ev.text);
  if (ev.type === "done") console.log("\nrun recorded:", ev.run._id, ev.ab);
}
```

**3. Route a free-text request to the right agent (vector search):**

```ts
import { routeAgent } from "./library/semantic";

const matches = await routeAgent("someone left a SQL injection in a PR");
// → [{ agent: "code-reviewer", score: 0.72, version: 2 }, …]
```

**4. Ship a new prompt version + rollback:**

```ts
import { createVersion, rollback } from "./library/store";

await createVersion("support-triage", "v4: tighter severity rubric", body, { updated_by: "rom" });
await rollback("support-triage", 3); // one write, no deploy
```

**5. Record a human verdict (feeds A/B stats):**

```ts
import { setVerdict } from "./library/store";
await setVerdict(runId, "up");
```

## REST API

| endpoint | what it does |
|---|---|
| `GET /api/agents` | gallery: per-agent versions, overlays, few-shot counts, active changelog |
| `GET /api/resolve/:agent?tenant=&variant=` | resolved prompt body |
| `POST /api/prompts/:agent` · `POST /api/prompts/:agent/rollback` | new version · rollback |
| `GET/POST/DELETE /api/overlays/:agent[/:tenant]` | tenant overlay CRUD |
| `GET/POST /api/fewshots/:agent` · `DELETE /api/fewshots/:id` | few-shot CRUD |
| `GET /api/ab/:agent` · `POST /api/ab/:agent/split` | A/B stats · set weights |
| `POST /api/runs/:agent` | run (SSE stream: start → delta… → done) |
| `GET /api/runs?agent=&k=` · `POST /api/verdict` | recent runs · human verdict |
| `GET /api/route?q=` | semantic routing across agents |
| `GET /api/search?q=&agent=&k=` | full-text search across all versions |
| `GET /api/analytics` | $facet analytics: runs, wins, p95 latency, tokens |
| `GET /api/stream` | change-stream SSE feed (live console) |
| `GET /api/stats` · `POST /api/seed` | collection counts · seed if empty |

## Deploy

Docker (Bun runtime) — the repo includes a `Dockerfile`:

```bash
docker build -t promptlib .
docker run -p 3000:3000 -e MONGODB_URI=... -e LLM_API_KEY=... promptlib
```

The live demo runs on Railway from this exact Dockerfile with three env vars:
`MONGODB_URI`, `LLM_API_KEY`, `LLM_BASE_URL`.

## Layout

```
src/library/
  types.ts     # AgentPrompt, PromptOverlay, FewShot, Run — the whole schema
  db.ts        # client + collections (prompts, overlays, few_shots, runs)
  store.ts     # versions, overlays, few-shots, resolve, runs, verdicts, A/B, analytics
  semantic.ts  # autoEmbed index self-provisioning, routing, few-shot retrieval
  search.ts    # Atlas Search full-text index + query
  run.ts       # streaming run executor (variant pick, few-shot injection, chat-edit tool)
  llm.ts       # OpenAI-compatible streaming adapter
  watch.ts     # change-stream feed
src/server.ts  # Bun.serve + regex router, all endpoints, SSE
console.html   # the live console (no build step, vanilla JS)
```

## Notes learned the hard way (M0 free tier)

- `$vectorSearch` pre-filters (`filter: {agent}`) require the path declared as a `filter` field in the index definition — both indexes here declare theirs.
- M0 allows at most **3 search indexes** total (vector + FTS combined); this app uses exactly 3.
- autoEmbed is the easiest path: no embedding code, no embedding storage, embeddings managed inside Atlas (`voyage-4-lite`).
