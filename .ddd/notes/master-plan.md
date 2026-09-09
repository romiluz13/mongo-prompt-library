# mongo-prompt-library — master plan (DDD note)

**Requested outcome**: a clean, plug-and-copy template repo showing how to build
agents with MongoDB as the prompt library — showcasing ALL capabilities:
versioning, A/B stats, tenant overlays, macros, Atlas Vector Search (semantic),
Atlas Search (full-text), aggregation analytics, change streams, and a chat-edit
agent. Four example agents (support triage, code review, research assistant,
marketing copy). Deployed live. The backline-demo repo stays as-is.

**Infrastructure (done)**:
- Atlas project `mongo-prompt-library` (id `6aa11409a3fe8439f7736590`), org Rom's Atlas.
- M0 cluster `promptlib` — `mongodb+srv://promptlib.cjedu6t.mongodb.net`, IDLE.
- DB user `promptlib-app` (pw in /tmp/promptlib-db-pw.txt), ACL 0.0.0.0/0 (Railway egress).
- Probe database `probe` w/ 4 docs + `probe_autoembed` index (throwaway; drop when template seeds).

## Documentation basis

| Question | Source and applicable version/section | Rule and implementation decision | Check/result or open question |
|---|---|---|---|
| Does autoEmbed Vector Search work on free M0? | Empirical probe on promptlib M0 (2026-09-09): created index `probe_autoembed` type `vectorSearch`, fields `[{type:"autoEmbed",modality:"text",path:"text",model:"voyage-4-lite"}]` via mongosh; status READY | Use autoEmbed as the primary semantic capability — zero embedding code in the app | VERIFIED: index READY; query `{$vectorSearch:{index,path,query:{text:"..."},numCandidates,model,limit}}` returned marketing-copy 0.71 top hit for a landing-page-tone query |
| autoEmbed syntax (index + query) | https://www.mongodb.com/docs/vector-search/tutorials/quick-start/ (mongosh + autoEmbed interface, read 2026-09-09) + automated-embedding overview | Index via `createSearchIndex(name,"vectorSearch",{fields:[{type:"autoEmbed",...}]})`; query via `$vectorSearch` with `query:{text}` object form; embeddings billed per token (has free token allowance, shown in Atlas UI) | Overview page shows `query:"<text>"` string form; quick start uses `query:{text}` — use `{text}` form (matches verified probe) |
| Driver support for search index creation | VERIFIED EMPIRICALLY (2026-09-09, mongodb 6.21.0 + Bun): `coll.createSearchIndex({name, type, definition})` object form works on M0; `coll.listSearchIndexes(name)` returns status. | App self-provisions its search indexes on boot | VERIFIED: both autoEmbed indexes created from driver and reached READY |
| $vectorSearch pre-filter | LEARNED EMPIRICALLY (2026-09-09): `filter: {agent}` in $vectorSearch fails with "Path 'agent' needs to be indexed as filter" unless the index definition declares `{type:"filter", path:"agent"}` fields | Every $vectorSearch filter path must be a `filter` field in the index definition | FIXED: both indexes declare filter fields (few_shots: agent; prompts: status, field) |
| Atlas Search full-text ($search) | VERIFIED EMPIRICALLY (2026-09-09): M0 free tier supports $search but has an FTS index quota — "The maximum number of FTS indexes has been reached for this instance size" at 3 indexes (probe + 2 vector); dropping the throwaway probe freed a slot | `atlas_prompts` index (type "search", dynamic mappings) + /api/search across all versions; keep total search indexes ≤ 3 on M0 | VERIFIED: q=churn ranks archived v2 (introduced there, 1.305) above active v3; agent filter works |
| Automated Embedding maturity | automated-embedding overview (read 2026-09-09) | Preview feature; models voyage-4-lite ($0.02/1M, probe-verified), voyage-4 (recommended), voyage-code-4. Embeddings persist in `__mdb_internal_search` internal db | Use voyage-4-lite for template (cheapest, works) |
| Change streams | backline-demo/.ddd/notes/slice3-change-streams.md (proven, Bun 1.3.13 + mongodb 6.21.0, local RS + Atlas) — refresh sources when implementing slice 5 | db.watch pipeline $match on ns.coll; pull-mode only; AbortSignal on disconnect; add SSE heartbeat (proxy idle-kill ~100s) | Reuse backline-demo watch.ts pattern (heartbeat addition verified deployed) |
| Run executor + LLM gateway | backline-demo/.ddd/notes/slice2-run-executor.md + slice6-chat-edit.md (proven) | Port streamRunEvents + Grove adapter (api-key header, stream:true, deepseek-v4-flash-0731) generalizing agent names | Refresh llm.ts when porting |
| A/B + overlays + macros + aggregation analytics | backline-demo/.ddd/notes/slice4-overlay-management.md + slice5-ab-autopilot.md (proven) | Port store design (versions, status active, tenant overlay patch docs, variant weights, verdicts) | Refresh when porting |

## Plan (slices, each gets its own note section here or a slice note)

1. **Library core** — `src/library/` (db, store: versions/activate/rollback/overlays/macros/resolve, types), seed: 4 agents × multi-version prompts + per-agent few_shots + 2 tenant overlays, Bun server + REST API, bun tests.
2. **Semantic** — driver-verified index self-provisioning (autoEmbed on few_shots.text + prompts.body), `semanticSearch()` + agent routing endpoint, resolve pipeline picks few-shots via $vectorSearch.
3. **Full-text** — Atlas Search index on prompt bodies, `/api/search` across versions.
4. **Runs + streaming** — run executor (variant selection, SSE, Grove), runs collection + verdicts.
5. **Live console** — change streams + console.html: agent gallery, semantic "describe your need" box, version timeline, A/B dashboard, overlay editor, analytics via $facet aggregations.
6. **Chat-edit agent** — tool-gated prompt editing (write_prompt_version) on any agent.
7. **Deploy + README** — Dockerfile, Railway service, live smoke test, README with plug-and-copy snippets.

## Status

- [x] Research batch 1 (autoEmbed M0 verified empirically; quick-start syntax; driver type shape)
- [x] Atlas project/cluster/user/ACL provisioned
- [x] Slice 1 — library core (types/db/store/seed/server) VERIFIED end-to-end vs Atlas: seed 8 prompts/3 overlays/8 few-shots, agents aggregation, resolve base+overlay+macros, version create/rollback, split 80/20 + validation, overlay + few-shot CRUD, stats
- [x] Slice 2 — semantic VERIFIED: driver object-form createSearchIndex works on M0; autoEmbed filter-field requirement learned+fixed; /api/route ranks correctly (landing-tone→marketing-copy 0.688, PR-security→code-reviewer 0.743, outage→support-triage 0.662); tenant overlay flows through routing; few-shot retrieval works (how-to 0.814, churn 0.678)
- [x] Slice 3 — full-text VERIFIED: atlas_prompts index (search/dynamic) self-provisions via driver; M0 FTS quota learned (≤3 search indexes — dropped throwaway probe index); /api/search?q=churn surfaces archived v2 (1.305) above active v3; agent filter works
- [x] Slice 4 — runs + streaming VERIFIED: SSE run vs Atlas (support-triage, acme overlay: #acme-escalations, TAM, 4h SLA, churn risk, doc-gap flag), verdict UP recorded, A/B stats updated, change stream verified (live insert event)
- [x] Slice 5 — live console VERIFIED via agent-browser: routing hero ranks correctly, run composer prefilled from routing, SSE completion renders with latency/tokens, verdict row, analytics table, live dot. Bug found+fixed: change-stream re-render wiped composer/verdict row → renderDetail now preserves composer state (input, output, verdict, running) across live re-renders + suppression window during stream
- [x] Slice 6 — chat-edit VERIFIED via console: agent called write_prompt_version → v3 live ("end with a question"), agent's own output followed its new rule; version timeline updated live; full verdict loop (👍 up → A/B runs:1 wins:1 → analytics)
- [x] Slice 7 — deploy VERIFIED: Dockerfile (bun), Railway project `mongo-prompt-library`, service `promptlib`, live at https://promptlib-production.up.railway.app — smoke: /api/stats 200 (9 prompts, 5 runs), routing (SQL-injection→code-reviewer 0.719), search, analytics, resolve(acme), console.html 200, full SSE run from Railway (acme overlay applied, variant B, A/B updated). README with plug-and-copy snippets written. Probe database dropped.
