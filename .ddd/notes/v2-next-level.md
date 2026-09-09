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
- [ ] Slice 2 — approval workflow + RBAC
- [ ] Slice 3 — eval gate
- [ ] Slice 4 — hybrid search
- [ ] Slice 5 — tools + guardrails bundle
- [ ] Slice 6 — observability + alerting
- [ ] Slice 7 — showcase surface + deploy + README
