# mongo-prompt-library v2 — next level (DDD note)

**Requested outcome**: fix every gap the landscape research surfaced, with a
MongoDB capability as the hero of each fix, and turn the repo into a
showcase-grade, interactive demo — "MongoDB as the agent platform store".
Eval gates kill silent regressions (pain #1), approvals fix collaboration
(pain #4), `$rankFusion` hybrid search is the retrieval showpiece, tools +
guardrails make it a full agent-config store (what-else #1/#3), observability
closes the version-to-outcome gap (pain #3), and a cinematic landing page +
redesigned console sell it. Deploy-coupling pain #2 is already solved by the
live deployment; git mirror export gives the git-native crowd their PR
ergonomics. No preview/GA caveats anywhere in the repo.

**Decisions (user, 2026-09-09)**:
- Stay on free Atlas M0 (8.0.32) — skip `$rerank` (needs 8.3+); `$rankFusion`
  hybrid search is verified working on 8.0 and is the showpiece.
- UI: cinematic `index.html` landing hero (live stats, try-it CTA) + fully
  redesigned `console.html` with tabs: Library, Playground, Evals, Search, Ops.

## Documentation basis

| Question | Source and applicable version/section | Rule and implementation decision | Check/result or open question |
|---|---|---|---|
| $rankFusion on M0 8.0? | Empirical probe on promptlib M0 (2026-09-09): correct syntax discovered over 5 iterations | Sub-pipelines live under `input.pipelines.<name>` as stage arrays | VERIFIED: hybrid query returned support-triage v2/v3/v1 |
| $vectorSearch inside $rankFusion | Same probe | Uses `query` (auto-embedded string, NOT `queryText`), `limit` (NOT `k`), and `numCandidates` is required | VERIFIED — autoEmbed applies inside fusion (no client embedding code) |
| $search inside $rankFusion | Same probe | Operator goes directly on the $search stage: `{index, text: {query, path}}`, followed by a `$limit` stage | VERIFIED |
| Weights + score attribution | Atlas hybrid search tutorial + probe with `scoreDetails: true` | `combination: {weights: {vec: w1, fts: w2}}`; `scoreDetails` exposes per-pipeline contribution per doc | VERIFIED in probe |
| $rerank | Vector Search docs ($rerank stage page, read 2026-09-09) | Requires MongoDB 8.3+ and Native Reranking in Project Settings; cannot appear inside $rankFusion input pipelines | SKIPPED by user decision (free tier, stay on 8.0.32) |
| $scoreFusion | Same docs | Requires 8.3+ | SKIPPED (8.0 cluster) |
| $jsonSchema validators | Manual: core/schema-validation/specify-json-schema (read 2026-09-09); core server feature | Validators via `createCollection` (new) or `collMod` (existing); enforce required fields, types, enums (status lifecycle), ranges | To verify empirically in slice 1 |
| Transactions on M0 | Empirical probe (2026-09-09): session/transaction round-trip succeeded on shared tier | Transactional publish: flip old active → archived + new version → active atomically | VERIFIED |
| Change streams as alert bus | Existing watch.ts (in production since v1) + landscape research | Extend the change feed: alert rules evaluated on run/prompt events → live alert feed in console | Pattern proven; rules logic new in slice 6 |
| LLM-as-judge | Existing llm.ts gateway adapter (Grove, OpenAI-compatible, streaming) | Judge = same gateway, structured scoring prompt against rubric; scores stored per version in `eval_runs` | To verify in slice 3 |
| $percentile/$facet analytics | Existing analytics() (in production) | Extend for eval scores + alert thresholds | Pattern proven |
| $last in $group | Manual: reference/operator/aggregation/last (read 2026-09-10, 8.3 docs / cluster 8.0.32 core accumulator) | Order comes from a preceding `$sort` stage; missing field → `null` | Code: `$sort: {ts:1}` → `$group` `eval_mean: {$last:"$mean_score"}` matches the documented example. VERIFIED live: after re-running the v4 eval (mean 2), analytics served eval_mean 2/10 with eval_runs 4 (3 old + 1 new) — $last picked the newest by ts |
| $size on possibly-missing array | Manual: reference/operator/aggregation/size (read 2026-09-10) | `$size` ERRORS if the argument is missing or not an array — must guard | Code: `$size: {$ifNull:["$guardrail_blocks", []]}`; VERIFIED live: analytics ran clean over runs that predate the guardrail_blocks field (guardrail_blocks 4 / blocked_runs 4 for support-triage) |
| Alert rule evaluation point | Existing watch.ts pattern (in production) + design reasoning | DEVIATION from original plan: rules evaluate synchronously at write time (run.ts/eval.ts hooks after insert), not over the change stream — the writer already has the doc in memory, no second process, no double-evaluation on resume tokens. Change stream's job stays delivery: `alerts` is a watched collection so fired alerts stream to consoles with zero polling | VERIFIED live: alert row count went 4→5 in an open browser tab with no reload when a run crossed a latency threshold |
| Alert contracts (DB-level rejection) | Same ensureValidators boot path proven in slices 1/3/5 (code 121 rejections) | Happy-path inserts (seed rules, evaluate() alerts, UI-created rules) all passed the contracts; direct bad-write probe into `alerts` skipped — the MCP insert tool rejected the array parameter (tooling gap, not a product gap) | OPEN: no negative DB probe for alert_rules/alerts; contracts are structurally identical to the probe-verified ones |

## Plan (slices, each: implement → verify → commit)

1. **Schema governance** — `$jsonSchema` validators on `prompts`, `overlays`,
   `few_shots`, `runs` (+ new collections as they appear). Idempotent
   `ensureValidators()` in the boot path (collMod with `validationLevel:
   "moderate"` so legacy docs don't break). Invalid writes rejected by the
   database itself, surfaced as clean 400s.
2. **Approval workflow + RBAC** — version lifecycle
   `draft → in_review → approved → active` (+ archived/retired), role API keys
   (ADMIN/EDITOR/REVIEWER via env), publish gate (only approved versions can
   activate), transactional publish + rollback. Routes:
   submit/approve/reject/publish.
3. **Eval gate** — `eval_cases` (golden inputs + rubric per agent),
   LLM-as-judge via the existing gateway, `eval_runs` store scores per
   version. Publish runs the suite; regression vs. previous active version
   flags/blocks. Console shows score history per agent.
4. **Hybrid search showpiece** — `/api/search/hybrid` with `$rankFusion`
   (verified syntax), `scoreDetails` exposing vector vs. lexical contribution
   per hit. UI: per-result score-attribution bars.
5. **Agent config bundle: tools + guardrails** — versioned `tools` collection
   (function defs w/ JSON-Schema params) + `guardrails` collection (policies).
   `/api/resolve` returns the full bundle. Playground enforces guardrails and
   exposes tools via function calling.
6. **Observability + alerting** — run metric aggregations extended with eval
   scores; `alert_rules` collection; rules evaluated over the change stream →
   live alert feed in the console.
7. **Showcase surface** — `bun run export` git-mirror (agent/version trees as
   frontmatter'd .md for PR review), cinematic `index.html` landing,
   redesigned `console.html` (Library / Playground / Evals / Search / Ops
   tabs), README rewrite, push to GitHub.

## Verification plan

Per slice: live-cluster probe of the new MongoDB feature (validator
rejection, transaction behavior, fusion output, judge run), `bunx tsc
--noEmit` clean, end-to-end route check, conventional-commits commit pushed
to `romiluz13/mongo-prompt-library`. Slices 3/5 verified with real LLM runs
through the configured gateway. Slice 7 verified in the browser.

## Status

- [x] Research: $rankFusion syntax verified on M0 (5 probe iterations);
      $rerank/$scoreFusion skipped (8.3+, user decision); transactions
      verified on M0
- [x] Slice 1 — schema governance VERIFIED live: collMod on M0 needs a custom
      role (readWrite lacks the collMod action) → Atlas custom role
      `schemaManager` (collMod@promptlib) granted to promptlib-app via UI;
      validators applied to all 4 collections (moderate/error); probe rejected
      4 bad writes with code 121 (bad status enum, missing changelog,
      additionalProperties patch key, negative latency); API surfaces 400 with
      full schemaRulesNotSatisfied details (verified over HTTP)
- [x] Slice 2 — approval workflow + RBAC VERIFIED live on Atlas: full
      lifecycle walked over HTTP (create → draft, publish-draft 409, submit →
      in_review w/ submitted_by, double-submit 409, approve → approved w/
      approved_by, publish → transactional flip [v1 archived + v2 active],
      resolve serves v2, reject returns draft, rollback transactional back to
      v1); the in_review/submitted_by update passing also proves the updated
      $jsonSchema enum is live (old enum would 121); RBAC verified with
      keys on a second server: no/wrong key 401, editor create 201 +
      review/publish 403, reviewer author 403 + review allowed, admin-only
      seed/split/publish; console renders DRAFT/IN REVIEW/APPROVED/ACTIVE/
      ARCHIVED badges, per-status action buttons, review trail, and a
      new-version draft composer (browser-verified)
- [x] Slice 3 — eval gate VERIFIED live on Atlas with real LLM runs:
      `eval_cases` (6 golden cases seeded, backfills into existing libraries)
      + `eval_runs` collections with $jsonSchema contracts (probe: code 121
      rejects mean_score=99, missing judge_model, empty rubric); suite runs
      the candidate version through the real gateway then LLM-judges each
      output 0-10 against the case rubric; support-triage v3 (active)
      scored 7.5 baseline, weak archived v1 scored 6.5 → regression flagged,
      deliberately bad v4 scored 4.0 → publish blocked 409 naming both
      scores, force:true override publishes (on the record), rollback
      restored v3; console renders score history (mean/baseline/gate
      columns, regression flags) + case management (browser-verified);
      eval route needed `server.timeout(ctx, 0)` (Bun's 10s idle timeout
      killed long LLM suites)
- [x] Slice 4 — hybrid search VERIFIED live on Atlas: new
      `src/library/hybrid.ts` fuses an autoEmbed `$vectorSearch` pipeline
      (meaning) with a `$search` full-text pipeline (words) in one
      server-side `$rankFusion` stage — `combination.weights` is a SIBLING
      of `input` (nesting it inside `input` is an unknown-field error),
      the fused RRF score surfaces via `$meta: "score"`, per-pipeline
      attribution via `$meta: "scoreDetails"` (probed live:
      `details[].{inputPipelineName, rank, value}` with raw cosine ~0.6
      and searchScore ~2.2); `GET /api/search/hybrid` with
      `q/k/agent/status/wvec` params (wvec=0 pure lexical, wvec=1 pure
      semantic, post-fusion `$match` filters apply cleanly); console has a
      hybrid search panel with a semantic↔lexical weight slider and
      per-hit attribution bars (browser-verified: slider at 54% re-weighted
      bars to 54/46; API extremes verified at 0 and 1)
- [x] Slice 5 — tools + guardrails bundle VERIFIED live on Atlas with real
      LLM runs: `tools` (JSON-Schema function defs, versioned on upsert,
      agent-scoped with "*" wildcard) + `guardrails` (3 kinds:
      input_block / banned_phrase / max_tokens) collections with
      $jsonSchema contracts (probe: code 121 rejects bad tool name pattern,
      non-object parameters, bad guardrail kind); `resolveBundle` extends
      resolvePrompt — `GET /api/resolve/:agent?bundle=1` returns prompt +
      tools + active guardrails in one read; runner exposes agent tools via
      function calling in every run (meta tool stays chat-only), validates
      args against the stored JSON Schema before executing demo executors
      (lookup_order, search_knowledge, escalate_to_human, search_codebase);
      guardrails enforced server-side: injection input ("ignore your
      previous instructions…") refused pre-LLM with 0 tokens spent and a
      recorded blocked run, banned phrase ("guaranteed refund") cut the
      stream mid-generation with guardrail_blocks recorded on the Run doc,
      max_tokens capped marketing-copy at token_cap 400 (start event);
      `guardrail_blocks` added to Run contract + listRuns projection;
      seeded 4 tools + 4 guardrails (backfill like eval cases); console
      renders Tools/Guardrails sections per agent, generalized tool_call /
      tool_result events (name + args + result preview), guardrail block
      banners, and tools/guardrails counts in the run meta line
      (browser-verified with a live double-tool-call run)
- [x] Slice 6 — observability + alerting VERIFIED live on Atlas with real
      LLM runs: `alert_rules` + `alerts` collections with $jsonSchema
      contracts (metrics latency_ms/tokens_out/guardrail_blocks on runs,
      mean_score/regression on eval_runs; ops gt/lt/eq; source-metric
      mismatch rejected 400 by upsertRule — probed over HTTP);
      `src/library/alerts.ts` evaluate() loads active rules matching source
      + agent (with "*" wildcard), extracts the metric, tests the op,
      inserts Alert docs — hooked after every insertRun (blocked runs
      included) and every eval_runs insert; VERIFIED: injection-blocked run
      fired guardrail-spike (value 1, 0 tokens), a normal 20.4s run fired a
      latency rule, and re-running the weak-v4 eval suite (mean 2 vs
      baseline 7.5) fired BOTH eval-regression and score-drop from the
      eval write; WATCHED extended to 9 collections (slim() drops
      eval_runs.results) so fired alerts stream to consoles — VERIFIED in
      the browser: alert rows went 4→5 live with no reload when a new run
      crossed a threshold; analytics extended per agent with eval_runs/
      eval_mean ($last after $sort — empirically picked the newest eval,
      2/10)/eval_regressions and guardrail_blocks ($size+$ifNull — clean
      over pre-guardrail runs)/blocked_runs; routes GET/POST/DELETE
      /api/alert-rules + GET/DELETE /api/alerts (?agent&k); 4 seed rules
      backfilled; console has a rules table + add-rule form (source-metric
      select filtered per source) and a live alert feed — add and delete
      of a probe rule both verified through the UI, rules table refreshes
      itself via the alert_rules change event; `bunx tsc --noEmit` clean.
      Gotcha recorded: restarting the server without MONGODB_URI silently
      falls back to localhost:27017 and creates an empty promptlib db —
      that stray local db was dropped; server now started with the Atlas
      URI explicitly. OPEN: no direct negative DB probe for the two alert
      collections (MCP insert tool rejected the array param); contracts
      structurally identical to probe-verified ones from slices 1/3/5
- [ ] Slice 7 — showcase surface + deploy + README
