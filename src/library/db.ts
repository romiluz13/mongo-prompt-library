import { MongoClient, type ClientSession } from "mongodb";
import type { AgentPrompt, FewShot, PromptOverlay, Run } from "./types";

// Any MongoDB works: Atlas (SRV URI), local replica set (needed for change
// streams), or atlas-local. Set MONGODB_URI; the library does the rest.
export const MONGO_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
export const DB_NAME = process.env.PROMPTLIB_DB ?? "promptlib";

// A single-host URI (local dev: mongod as a single-node replica set that
// advertises its container hostname) must skip topology discovery or the
// driver chases the unresolvable advertised host. directConnection forces
// Single topology (driver 6.x). Multi-host, +srv, or explicit replicaSet
// URIs keep normal discovery.
const singleHost =
  !MONGO_URI.startsWith("mongodb+srv") &&
  !/[?&]replicaSet=/.test(MONGO_URI) &&
  !MONGO_URI.replace(/^[^:]*:\/\//, "").split(/[/?]/)[0]!.includes(",");

const client = new MongoClient(MONGO_URI, singleHost ? { directConnection: true } : {});
export const db = client.db(DB_NAME);

export const prompts = db.collection<AgentPrompt>("prompts");
export const overlays = db.collection<PromptOverlay>("overlays");
export const fewShots = db.collection<FewShot>("few_shots");
export const runs = db.collection<Run>("runs");

export async function connect(): Promise<void> {
  await client.connect();
  await db.command({ ping: 1 });
  await ensureIndexes();
}

async function ensureIndexes(): Promise<void> {
  // one version history per agent+field; the active doc is found via status
  await prompts.createIndex({ agent: 1, field: 1, version: -1 }, { unique: true });
  await prompts.createIndex({ agent: 1, field: 1, status: 1 });
  await overlays.createIndex({ agent: 1, tenant: 1 }, { unique: true });
  await fewShots.createIndex({ agent: 1 });
  await runs.createIndex({ agent: 1, ts: -1 });
  await runs.createIndex({ agent: 1, variant: 1, verdict: 1 });
}

export async function close(): Promise<void> {
  await client.close();
}

/**
 * Run a unit of work inside a MongoDB transaction with automatic retry on
 * transient commit errors. Used for lifecycle transitions that must flip
 * two documents atomically (publish, rollback) — no version can ever be
 * stranded between statuses.
 */
export async function withTx<T>(
  fn: (session: ClientSession) => Promise<T>,
): Promise<T> {
  return client.withSession(async session => {
    return session.withTransaction(async () => fn(session));
  });
}
