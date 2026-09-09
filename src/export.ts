/**
 * `bun run export` — materialize the git mirror (see library/export.ts).
 * Wipes and rebuilds ./export from the live store.
 */

import { connect, close } from "./library/db";
import { exportAll } from "./library/export";

await connect();
try {
  const { agents, files } = await exportAll("export");
  console.log(`[export] ${files} files for ${agents} agents → ./export (git mirror rebuilt)`);
} finally {
  await close();
}
