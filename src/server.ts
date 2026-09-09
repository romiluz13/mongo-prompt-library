import { connect, close, DB_NAME } from "./library/db";
import {
  abStats,
  addFewShot,
  createVersion,
  deleteFewShot,
  deleteOverlay,
  getActive,
  listAgents,
  listFewShots,
  listOverlays,
  listVersions,
  resolvePrompt,
  rollback,
  setSplit,
  stats,
  StoreError,
  upsertOverlay,
} from "./library/store";
import { seedIfEmpty } from "./library/seed";
import { ensureSemanticIndexes, routeAgent, semanticFewShots } from "./library/semantic";
import { ensureSearchIndex, searchPrompts } from "./library/search";
import { streamRunEvents } from "./library/run";
import { openChangeFeed } from "./library/watch";
import { listRuns, setVerdict, analytics } from "./library/store";

const PORT = Number(process.env.PORT ?? 3000);

type Ctx = Request & { params: Record<string, string> };
type Handler = (ctx: Ctx) => Promise<Response> | Response;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function notFound(msg = "not found"): Response {
  return json({ error: msg }, 404);
}

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new StoreError("request body must be JSON", 400);
  }
}

// ---- routes ------------------------------------------------------------------

const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];

function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:([A-Za-z_]+)/g, (_m, key) => {
        keys.push(key);
        return "([^/]+)";
      }) +
      "$",
  );
  routes.push({ method, pattern, keys, handler });
}

// agents
route("GET", "/api/agents", async () => json(await listAgents()));

// prompts
route("GET", "/api/prompts/:agent/active", async ctx => {
  const active = await getActive(ctx.params.agent);
  return active ? json(active) : notFound(`agent '${ctx.params.agent}' not found`);
});

route("GET", "/api/prompts/:agent/versions", async ctx =>
  json(await listVersions(ctx.params.agent)),
);

route("POST", "/api/prompts/:agent", async ctx => {
  const input = await body<{ body: string; macros?: Record<string, string>; changelog: string; updated_by?: string }>(ctx);
  return json(await createVersion(ctx.params.agent, input), 201);
});

route("POST", "/api/prompts/:agent/rollback", async ctx => {
  const { version } = await body<{ version: number }>(ctx);
  return json(await rollback(ctx.params.agent, version));
});

// resolve — what an agent runner actually calls
route("GET", "/api/resolve/:agent", async ctx => {
  const url = new URL(ctx.url);
  const tenant = url.searchParams.get("tenant");
  const resolved = await resolvePrompt(ctx.params.agent, tenant);
  return resolved ? json(resolved) : notFound(`agent '${ctx.params.agent}' not found`);
});

// overlays
route("GET", "/api/overlays/:agent", async ctx => json(await listOverlays(ctx.params.agent)));

route("POST", "/api/overlays/:agent/:tenant", async ctx => {
  const patch = await body<{ body_append?: string; macros?: Record<string, string> }>(ctx);
  await upsertOverlay(ctx.params.agent, ctx.params.tenant, patch);
  return json({ ok: true, agent: ctx.params.agent, tenant: ctx.params.tenant });
});

route("DELETE", "/api/overlays/:agent/:tenant", async ctx => {
  await deleteOverlay(ctx.params.agent, ctx.params.tenant);
  return json({ ok: true });
});

// few-shots
route("GET", "/api/fewshots/:agent", async ctx => json(await listFewShots(ctx.params.agent)));

route("POST", "/api/fewshots/:agent", async ctx => {
  const { text, note } = await body<{ text: string; note?: string }>(ctx);
  return json(await addFewShot(ctx.params.agent, text, note), 201);
});

route("DELETE", "/api/fewshots/:id", async ctx => {
  await deleteFewShot(ctx.params.id);
  return json({ ok: true });
});

// runs + A/B
route("GET", "/api/ab/:agent", async ctx => json(await abStats(ctx.params.agent)));

route("POST", "/api/ab/:agent/split", async ctx => {
  const w = await body<{ a: number; b: number }>(ctx);
  return json(await setSplit(ctx.params.agent, w));
});

// runs (executor) — SSE stream of a real LLM completion
route("POST", "/api/runs/:agent", async ctx => {
  server.timeout(ctx, 0); // disable the 10s idle timeout for SSE
  const input = await body<{ input?: string; tenant?: string; variant?: string; chat?: boolean }>(ctx);
  if (!String(input.input ?? "").trim()) return json({ error: "input is required" }, 400);

  const events = streamRunEvents(ctx.params.agent, {
    input: String(input.input),
    tenant: input.tenant ?? null,
    variant: input.variant ?? null,
    chat: input.chat === true,
  });
  return sseResponse(events);
});

route("GET", "/api/runs", async ctx => {
  const url = new URL(ctx.url);
  const agent = url.searchParams.get("agent") ?? undefined;
  return json(await listRuns(agent, Number(url.searchParams.get("k") ?? 20)));
});

route("POST", "/api/verdict", async ctx => {
  const v = await body<{ run_id: string; verdict: "up" | "down" }>(ctx);
  if (v.verdict !== "up" && v.verdict !== "down") {
    return json({ error: "verdict must be 'up' or 'down'" }, 400);
  }
  return json(await setVerdict(v.run_id, v.verdict));
});

// change stream — one MongoDB watch per connected console tab (SSE)
route("GET", "/api/stream", ctx => {
  server.timeout(ctx, 0);
  console.log("[stream] console tab subscribed (change stream open)");
  return sseResponse(openChangeFeed(ctx.signal));
});

/** Wrap an async generator of SSE frames in a Response (DOM-typed BodyInit
 *  has no async-iterable overload). The cancel hook runs the generator's
 *  finally → change-stream close. */
function sseResponse(gen: AsyncGenerator<string>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of gen) {
          controller.enqueue(encoder.encode(frame));
        }
      } catch (e) {
        controller.error(e);
        return;
      }
      controller.close();
    },
    cancel() {
      void gen.return(undefined);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

// ops
route("POST", "/api/seed", async () => json(await seedIfEmpty()));
route("GET", "/api/stats", async () => json({ db: DB_NAME, ...(await stats()) }));
route("GET", "/api/analytics", async () => json(await analytics()));

// semantic — Vector Search with automated embedding (zero embedding code)
route("GET", "/api/semantic/fewshots/:agent", async ctx => {
  const url = new URL(ctx.url);
  const q = url.searchParams.get("q") ?? "";
  const k = Number(url.searchParams.get("k") ?? 3);
  if (!q.trim()) return json({ error: "query param q is required" }, 400);
  const hits = await semanticFewShots(ctx.params.agent, q, k);
  return json({
    agent: ctx.params.agent,
    query: q,
    hits: hits.map(h => ({ score: round(h.score), text: h.doc.text, note: h.doc.note ?? null })),
  });
});

/** Describe what you need in plain language — get the right agent + its resolved prompt. */
route("GET", "/api/route", async ctx => {
  const url = new URL(ctx.url);
  const q = url.searchParams.get("q") ?? "";
  const tenant = url.searchParams.get("tenant");
  if (!q.trim()) return json({ error: "query param q is required" }, 400);
  const matches = await routeAgent(q);
  if (matches.length === 0) return json({ query: q, matches: [] });
  const resolved = await resolvePrompt(matches[0]!.agent, tenant);
  return json({
    query: q,
    matches: matches.map(m => ({ ...m, score: round(m.score) })),
    resolved,
  });
});

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// full-text — Atlas Search across every version
route("GET", "/api/search", async ctx => {
  const url = new URL(ctx.url);
  const q = url.searchParams.get("q") ?? "";
  if (!q.trim()) return json({ error: "query param q is required" }, 400);
  const hits = await searchPrompts(q, {
    agent: url.searchParams.get("agent") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    k: Number(url.searchParams.get("k") ?? 10),
  });
  return json({
    query: q,
    hits: hits.map(h => ({
      agent: h.agent,
      version: h.version,
      status: h.status,
      changelog: h.changelog,
      score: round(h.score),
      snippet: h.body.slice(0, 160),
    })),
  });
});

// ---- server ------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  async fetch(req, server): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return json({ ok: true, db: DB_NAME });
    if (url.pathname === "/" || url.pathname === "/console.html") {
      return new Response(Bun.file("./console.html"));
    }

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      const ctx = req as Ctx;
      ctx.params = params;
      try {
        return await r.handler(ctx);
      } catch (err) {
        if (err instanceof StoreError) return json({ error: err.message }, err.status);
        console.error("unhandled route error:", err);
        return json({ error: "internal error" }, 500);
      }
    }
    return notFound("no such route");
  },
});

await connect();
await ensureSemanticIndexes(); // self-provisions autoEmbed vector indexes, waits for READY
await ensureSearchIndex(); // self-provisions the full-text Atlas Search index
console.log(`prompt-library API on http://localhost:${server.port} (db: ${DB_NAME})`);

process.on("SIGTERM", async () => {
  await close();
  server.stop();
  process.exit(0);
});
