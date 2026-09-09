import type { Collection, Document, WithId } from "mongodb";
import { fewShots, prompts } from "./db";
import type { FewShot } from "./types";

/**
 * Semantic layer — Atlas Vector Search with Automated Embedding.
 *
 * The app never computes embeddings: indexes are declared `autoEmbed`, Atlas
 * embeds the documents (and the query text) server-side using the configured
 * model. Zero embedding code, zero embedding API keys.
 */

const MODEL = "voyage-4-lite"; // cheapest autoEmbed model; swap for voyage-4 / voyage-code-4
export const FEWSHOTS_INDEX = "autoembed_few_shots";
export const PROMPTS_INDEX = "autoembed_prompts";

/** autoEmbed field definition plus the fields we pre-filter on.
 *  $vectorSearch `filter` requires those paths declared as `filter` fields. */
const autoEmbed = (path: string, filterPaths: string[] = []) => [
  { type: "autoEmbed", modality: "text", path, model: MODEL },
  ...filterPaths.map(p => ({ type: "filter", path: p })),
];

export interface Scored<T> {
  doc: WithId<T>;
  score: number;
}

// ---- index self-provisioning -------------------------------------------------

/**
 * Create the vector indexes if missing and wait until they are READY.
 * Called on boot — this is what makes the template plug-and-copy: point it
 * at an Atlas cluster and it provisions its own search infrastructure.
 */
export async function ensureSemanticIndexes(waitMs = 180_000): Promise<void> {
  await Promise.all([
    ensureIndex(fewShots, FEWSHOTS_INDEX, "text", ["agent"], waitMs),
    ensureIndex(prompts, PROMPTS_INDEX, "body", ["status", "field"], waitMs),
  ]);
}

async function ensureIndex<T extends Document>(
  coll: Collection<T>,
  name: string,
  path: string,
  filterPaths: string[],
  waitMs: number,
): Promise<void> {
  const existing = await coll.listSearchIndexes(name).toArray();
  if (existing.length === 0) {
    await coll.createSearchIndex({
      name,
      type: "vectorSearch",
      definition: { fields: autoEmbed(path, filterPaths) },
    });
    console.log(`[semantic] creating vector index ${name} on ${coll.collectionName}.${path}`);
  }

  const deadline = Date.now() + waitMs;
  for (;;) {
    const idx = (await coll.listSearchIndexes(name).next()) as
      | { status?: string }
      | null;
    if (idx?.status === "READY") {
      console.log(`[semantic] index ${name} READY`);
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`vector index ${name} not READY after ${waitMs}ms (status: ${idx?.status ?? "unknown"})`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

/** Wait until a search index is READY (shared with the full-text search module). */
export async function waitIndexReady<T extends Document>(
  coll: Collection<T>,
  name: string,
  waitMs: number,
): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const idx = (await coll.listSearchIndexes(name).next()) as
      | { status?: string }
      | null;
    if (idx?.status === "READY") {
      console.log(`[search] index ${name} READY`);
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`search index ${name} not READY after ${waitMs}ms (status: ${idx?.status ?? "unknown"})`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

// ---- queries -------------------------------------------------------------------

/** Retrieve the few-shots most relevant to this user input, for this agent. */
export async function semanticFewShots(
  agent: string,
  text: string,
  k = 3,
): Promise<Scored<FewShot>[]> {
  const hits = await fewShots
    .aggregate<WithId<FewShot> & { score: number }>([
      {
        $vectorSearch: {
          index: FEWSHOTS_INDEX,
          path: "text",
          query: { text },
          numCandidates: 50,
          limit: k,
          filter: { agent },
        },
      },
      { $set: { score: { $meta: "vectorSearchScore" } } },
    ])
    .toArray();
  return hits.map(doc => ({ doc, score: doc.score }));
}

export interface RoutedAgent {
  agent: string;
  score: number;
  version: number;
}

/**
 * The routing endpoint's engine: describe what you need in plain language,
 * get the agents whose active prompts best match, ranked by cosine score.
 */
export async function routeAgent(text: string, k = 3): Promise<RoutedAgent[]> {
  return prompts
    .aggregate<RoutedAgent & { _id?: string }>([
      {
        $vectorSearch: {
          index: PROMPTS_INDEX,
          path: "body",
          query: { text },
          numCandidates: 100,
          limit: 20,
          filter: { status: "active", field: "system_prompt" },
        },
      },
      { $set: { score: { $meta: "vectorSearchScore" } } },
      { $sort: { score: -1 } },
      {
        $group: {
          _id: "$agent",
          score: { $max: "$score" },
          version: { $first: "$version" },
        },
      },
      { $sort: { score: -1 } },
      { $limit: k },
      { $project: { _id: 0, agent: "$_id", score: 1, version: 1 } },
    ])
    .toArray();
}
