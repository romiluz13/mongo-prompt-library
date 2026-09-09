// Change-stream feed → SSE frames: one watch per connected console tab.
// Documentation basis (proven on Bun 1.3.13 + mongodb 6.21.0, Atlas M0):
// - MongoDB manual: db-level watch covers all non-system collections; the
//   pipeline may $match on operationType / ns.coll but must never modify the
//   event _id (resume token); fullDocument:"updateLookup" returns the current
//   doc on update events.
// - Node driver docs: ChangeStream is async-iterable; EventEmitter + Iterator
//   concurrently is unsupported — pull mode only here.
// - Empirical: req.signal aborts with "The connection was closed" when the
//   client drops; `finally` frees the pooled watch connection.
import type { Document } from "mongodb";
import { db } from "./db";

export const WATCHED = [
  "prompts",
  "overlays",
  "few_shots",
  "runs",
  "eval_runs",
  "tools",
  "guardrails",
  "alert_rules",
  "alerts",
] as const;
const OPS = ["insert", "update", "replace", "delete"] as const;

const PIPELINE = [
  {
    $match: {
      operationType: { $in: [...OPS] },
      "ns.coll": { $in: [...WATCHED] },
    },
  },
];

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

// SSE comment frame. EventSource clients ignore comment lines, so this keeps
// bytes flowing on an otherwise quiet stream (proxies kill idle connections —
// Railway/Cloudflare around ~100s). 30s is comfortably under that window.
const HEARTBEAT_MS = 30_000;
const heartbeat = () => `: keepalive ${Date.now()}\n\n`;

type Ev = Document & {
  operationType?: string;
  ns?: { db?: string; coll?: string };
  fullDocument?: Document | null;
  documentKey?: Document;
};

/** Slim change event for the wire. Run docs drop input/output (bulk; the
 *  owning tab already streamed the text live). Delete events have no
 *  fullDocument by definition — the client refetches lists instead. */
function slim(ev: Ev): Document {
  const frame: Record<string, unknown> = {
    type: "change",
    coll: ev.ns && ev.ns.coll,
    op: ev.operationType,
  };
  if (ev.documentKey) frame.key = ev.documentKey._id;
  if (ev.fullDocument) {
    const doc = { ...ev.fullDocument } as Record<string, unknown>;
    if (frame.coll === "runs") {
      delete doc.input;
      delete doc.output;
    }
    if (frame.coll === "eval_runs") {
      delete doc.results; // per-case judging detail; the table reads it lazily
    }
    frame.doc = doc;
  }
  return frame as Document;
}

/** Pull the change stream until the client disconnects (signal aborts) or the
 *  stream ends. */
export async function* openChangeFeed(
  signal: AbortSignal,
): AsyncGenerator<string> {
  const cs = db.watch(PIPELINE, { fullDocument: "updateLookup" });
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new Error("client disconnected")),
      { once: true },
    );
  });
  try {
    yield sse({ type: "ready", colls: [...WATCHED] });
    while (!cs.closed) {
      // Race the next change event against a heartbeat so quiet periods
      // still emit bytes. The timer is cleared every loop so at most one
      // pending timer exists per stream.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const beat = new Promise<"beat">((resolve) => {
        timer = setTimeout(() => resolve("beat"), HEARTBEAT_MS);
      });
      let ev: Ev | "beat";
      try {
        ev = (await Promise.race([cs.next(), beat, aborted])) as Ev | "beat";
      } finally {
        clearTimeout(timer);
      }
      if (ev === "beat") {
        yield heartbeat();
        continue;
      }
      yield sse(slim(ev));
    }
  } catch (e) {
    if (!signal.aborted) yield sse({ type: "error", error: String(e) });
  } finally {
    await cs.close().catch(() => {});
  }
}
