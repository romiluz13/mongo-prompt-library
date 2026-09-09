import { prompts } from "./db";
import { waitIndexReady } from "./semantic";
import type { WithId } from "mongodb";
import type { AgentPrompt } from "./types";

/**
 * Full-text layer — Atlas Search ($search) across every prompt version.
 * Answers "which version said X?" and "where did we mention churn risk?"
 * Vector search finds meaning; this finds words.
 */

export const SEARCH_INDEX = "atlas_prompts";

export async function ensureSearchIndex(waitMs = 180_000): Promise<void> {
  const existing = await prompts.listSearchIndexes(SEARCH_INDEX).toArray();
  if (existing.length === 0) {
    await prompts.createSearchIndex({
      name: SEARCH_INDEX,
      type: "search",
      // dynamic mappings index every string field; refine to explicit
      // field mappings + analyzers as the library grows
      definition: { mappings: { dynamic: true } },
    });
    console.log(`[search] creating Atlas Search index ${SEARCH_INDEX} on prompts (dynamic)`);
  }
  await waitIndexReady(prompts, SEARCH_INDEX, waitMs);
}

export interface SearchOptions {
  agent?: string;
  status?: string;
  k?: number;
}

export async function searchPrompts(
  q: string,
  opts: SearchOptions = {},
): Promise<(WithId<AgentPrompt> & { score: number })[]> {
  const k = opts.k ?? 10;
  const matches: Record<string, string>[] = [];
  if (opts.agent) matches.push({ agent: opts.agent });
  if (opts.status) matches.push({ status: opts.status });

  return prompts
    .aggregate<WithId<AgentPrompt> & { score: number }>([
      {
        $search: {
          index: SEARCH_INDEX,
          text: { query: q, path: ["body", "changelog"] },
        },
      },
      ...(matches.length > 0 ? [{ $match: { $and: matches } }] : []),
      { $set: { score: { $meta: "searchScore" } } },
      { $sort: { score: -1 } },
      { $limit: k },
    ])
    .toArray();
}
