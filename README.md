# mongo-prompt-library

**MongoDB as the platform store for your agents.** Versioned prompts with an
enforced review lifecycle, an LLM-judged eval gate on publish, hybrid
retrieval, tools, guardrails, and alerting — every piece a document, every
change streamed to a live console. One database, the whole agent config layer.

Live demo: **https://promptlib-production.up.railway.app/** — landing page,
console at `/console.html`, everything backed by the real API.

## The tour

Open the console and everything is live over a change stream — no refresh
button anywhere:

| tab | what you see |
|---|---|
| **Playground** | describe what you need in plain language → Vector Search routes you to the right agent → run it, streaming, with tools firing and guardrails enforcing; 👍/👎 verdicts roll into A/B stats |
| **Library** | every agent as versioned documents — draft → review → approved → publish lifecycle, immutable version history, A/B splits, tenant overlays, few-shots, tools, guardrails |
| **Evals** | golden cases per agent, LLM-judged 0-10; a regression against baseline blocks publish — run the suite on any agent's active version |
| **Search** | one `$rankFusion` stage fusing Vector Search (meaning) with Atlas Search (words), with per-retriever attribution on every hit |
| **Ops** | `$facet` analytics (runs, win rate, p95 latency, tokens, eval means, guardrail activity) and the alerting feed — rules evaluate on the write, alerts stream in |

## The capability map

Every capability is one MongoDB feature doing real work, not a checkbox:

| capability | MongoDB machinery |
|---|---|
| Prompt lifecycle: draft → review → approved → active, immutable history, one-write rollback | `$jsonSchema` validators reject illegal states; publish archives the old version and activates the new one **in a transaction** |
| The eval gate: LLM-as-judge scores golden cases, regression blocks publish | eval cases, runs, and judged scores are documents; the publish endpoint consults the latest suite run |
| Hybrid retrieval: plain-language routing + search over every version | **Atlas Vector Search** via `autoEmbed` (zero embedding code) + **Atlas Search** full-text, fused server-side with **`$rankFusion`** |
| Tools + guardrails served as config | one `resolveBundle` call returns prompt + tools (JSON-Schema-checked args) + guardrails (injection refusal pre-LLM, banned-phrase cut mid-stream, token caps) |
| Alerting with zero polling | rules evaluate **on the write** (run/eval insert hooks); fired alerts ride the **change stream** to every open tab |
| Analytics | one `$facet`/`$percentile` pass; eval means via `$last`, guardrail counts via `$size` |
| Git mirror for PR people | `bun run export` flattens the library into frontmatter'd Markdown — diffable, blameable, reviewable |

## Quick start

Works on a free-tier Atlas M0 cluster. The server self-provisions all three
search indexes and the seed data on boot.

```bash
bun install
cp .env.example .env          # fill in MONGODB_URI + an OpenAI-compatible LLM
bun start                     # or: bun run src/server.ts
open http://localhost:3000/   # landing · /console.html for the console
```

`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` point at any OpenAI-compatible
endpoint. Optional RBAC keys (`PROMPTLIB_ADMIN_KEY` etc.) gate write endpoints
if set; unset means open.

Export the git mirror:

```bash
bun run export   # → ./export — one .md per version, evals.md, ops.md, index
```

## REST API

| endpoint | what it does |
|---|---|
| `GET /api/agents` | gallery: versions, overlays, few-shot counts, active version |
| `GET /api/resolve/:agent?tenant=&variant=` | the full runner bundle: prompt (overlay + macros applied), tools, guardrails |
| `POST /api/prompts/:agent` | new draft version |
| `POST /api/prompts/:agent/:version/submit` · `/review` · `/publish` | lifecycle transitions (publish: transactional swap, eval-gated) |
| `POST /api/prompts/:agent/rollback` | one write, no deploy |
| `GET /api/overlays/:agent` · `POST/DELETE /api/overlays/:agent/:tenant` | tenant overlay CRUD |
| `GET/POST /api/fewshots/:agent` · `DELETE /api/fewshots/:id` | few-shot CRUD |
| `GET /api/ab/:agent` · `POST /api/ab/:agent/split` | A/B stats · set weights |
| `GET/POST /api/tools` · `DELETE /api/tools/:name` · `GET /api/tools/:agent` | tool CRUD (JSON-Schema params) |
| `GET/POST /api/guardrails` · `DELETE /api/guardrails/:name` · `GET /api/guardrails/:agent` | guardrail CRUD |
| `GET/POST /api/eval/cases/:agent` · `DELETE /api/eval/cases/:id` | golden case CRUD |
| `POST /api/eval/:agent/:version` · `GET /api/eval/:agent` | run the judged suite · history |
| `POST /api/runs/:agent` | run (SSE: start → guardrails → tool calls → deltas → done) |
| `GET /api/runs?agent=&k=` · `POST /api/verdict` | recent runs · human verdict |
| `GET /api/route?q=` | semantic routing across agents |
| `GET /api/search?q=` · `GET /api/search/hybrid?q=&wvec=` | full-text · fused vector+lexical with attribution |
| `GET/POST /api/alert-rules` · `DELETE /api/alert-rules/:name` | alert rule CRUD |
| `GET /api/alerts?k=` · `DELETE /api/alerts` | fired alert feed · clear |
| `GET /api/analytics` · `GET /api/stats` | the $facet dashboard · collection counts |
| `GET /api/stream` | change-stream SSE (9 collections) |
| `POST /api/seed` · `GET /healthz` | seed if empty · health |

## Copy these pieces into your app

Everything is plain documents in ten collections — copy the `src/library/`
files you need, or hit the REST API.

```ts
import { resolveBundle } from "./library/store";

// one call: base prompt + tenant overlay + macros + tools + guardrails
const bundle = await resolveBundle("support-triage", { tenant: "acme" });

import { streamRunEvents } from "./library/run";
for await (const ev of streamRunEvents("support-triage", {
  input: "customer's API is down, they're losing orders",
  tenant: "acme",
})) {
  if (ev.type === "delta") process.stdout.write(ev.text);
  if (ev.type === "guardrail_block") console.error("refused:", ev.guardrails);
  if (ev.type === "done") console.log("\nrecorded:", ev.run._id, ev.ab);
}
```

## Layout

```
src/library/
  types.ts       # the whole schema: prompts, overlays, few-shots, runs, evals, tools, guardrails, alerts
  db.ts          # client, collections, $jsonSchema validators, transactions
  store.ts       # lifecycle, resolve, runs, verdicts, A/B, analytics
  semantic.ts    # autoEmbed index self-provisioning, routing, few-shot retrieval
  search.ts      # Atlas Search index + query
  hybrid.ts      # $rankFusion hybrid retrieval
  eval.ts        # golden cases, LLM-judge suite, regression gate
  alerts.ts      # rule evaluation on write + rule CRUD
  run.ts         # streaming executor: guardrails, tools, variants, chat-edit
  watch.ts       # change-stream feed (9 collections)
  export.ts      # the git mirror
  seed.ts        # four agents, tools, guardrails, rules, golden cases
src/server.ts    # Bun.serve + regex router + SSE
index.html       # landing page (live stats, capability map, try-it)
console.html     # the tabbed live console (no build step, vanilla JS)
```

Design notes and verification logs live in
[`.ddd/notes/v2-next-level.md`](.ddd/notes/v2-next-level.md).

## Notes learned the hard way (M0 free tier)

- `$vectorSearch` pre-filters (`filter: {agent}`) require the path declared as
  a `filter` field in the index definition — both vector indexes declare theirs.
- M0 allows at most **3 search indexes** total (vector + FTS combined); this
  app uses exactly 3.
- autoEmbed is the easiest path: no embedding code, no embedding storage —
  Atlas manages the embeddings (`voyage-4-lite`).

## Deploy

Docker (Bun runtime) — the repo includes a `Dockerfile`:

```bash
docker build -t promptlib .
docker run -p 3000:3000 -e MONGODB_URI=... -e LLM_API_KEY=... -e LLM_BASE_URL=... promptlib
```

The live demo runs on Railway from this exact Dockerfile with three env vars.
