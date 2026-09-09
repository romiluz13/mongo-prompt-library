import type { Document, WithId } from "mongodb";
import { prompts } from "./db";
import { SEARCH_INDEX } from "./search";
import { PROMPTS_INDEX } from "./semantic";
import type { AgentPrompt } from "./types";

/**
 * Hybrid retrieval — $rankFusion fuses two ranked pipelines over the same
 * collection in a single server-side stage:
 *
 *   vec — $vectorSearch with Automated Embedding (meaning: "angry customer")
 *   fts — $search full-text (words: "refund", "SLA", exact tokens)
 *
 * Reciprocal Rank Fusion merges both rankings (weight-aware); scoreDetails
 * exposes per-pipeline rank and raw score so every hit can show exactly how
 * each retriever contributed. One round trip, two retrievers, zero client
 * embedding code.
 */

export interface HybridOptions {
  agent?: string;
  status?: string;
  k?: number;
  vecWeight?: number;
  ftsWeight?: number;
}

export interface PipelineAttribution {
  rank: number;
  value: number;
}

export interface HybridHit {
  doc: WithId<AgentPrompt>;
  /** fused RRF score */
  score: number;
  /** semantic pipeline contribution, null if the doc only matched lexically */
  vec: PipelineAttribution | null;
  /** lexical pipeline contribution, null if the doc only matched semantically */
  fts: PipelineAttribution | null;
}

interface ScoreDetails {
  value: number;
  details: { inputPipelineName: string; rank: number; value: number }[];
}

export async function hybridSearch(q: string, opts: HybridOptions = {}): Promise<HybridHit[]> {
  const k = opts.k ?? 10;
  const vecWeight = opts.vecWeight ?? 0.6;
  const ftsWeight = opts.ftsWeight ?? 0.4;

  const matches: Record<string, string>[] = [];
  if (opts.agent) matches.push({ agent: opts.agent });
  if (opts.status) matches.push({ status: opts.status });

  const rows = await prompts
    .aggregate<WithId<AgentPrompt> & { score: number; scoreDetails: ScoreDetails }>([
      {
        $rankFusion: {
          input: {
            pipelines: {
              vec: [
                {
                  $vectorSearch: {
                    index: PROMPTS_INDEX,
                    path: "body",
                    query: { text: q }, // auto-embedded server-side
                    limit: k,
                    numCandidates: Math.max(100, k * 10),
                  },
                },
              ],
              fts: [
                { $search: { index: SEARCH_INDEX, text: { query: q, path: ["body", "changelog"] } } },
                { $limit: k },
              ],
            },
          },
          combination: { weights: { vec: vecWeight, fts: ftsWeight } },
          scoreDetails: true,
        },
      },
      { $addFields: { score: { $meta: "score" }, scoreDetails: { $meta: "scoreDetails" } } },
      ...(matches.length > 0 ? [{ $match: { $and: matches } }] : []),
      { $sort: { score: -1 } },
      { $limit: k },
    ] as Document[])
    .toArray();

  return rows.map(row => {
    const byName = new Map(row.scoreDetails.details.map(d => [d.inputPipelineName, d]));
    return {
      doc: row,
      score: row.score,
      vec: byName.has("vec")
        ? { rank: byName.get("vec")!.rank, value: byName.get("vec")!.value }
        : null,
      fts: byName.has("fts")
        ? { rank: byName.get("fts")!.rank, value: byName.get("fts")!.value }
        : null,
    };
  });
}
