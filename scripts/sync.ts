// npm run sync [-- --force]
// Fetch models.dev and the measurements file once, check them, and replace the snapshots in data/.
import { DATA } from "./lib/files.ts";
import { sync, SyncBusyError } from "./lib/sync.ts";

try {
  const report = await sync({ dataDir: DATA, fetch, force: process.argv.includes("--force"), log: console.log });
  for (const [name, part] of [["models.dev", report.upstream], ["measurements", report.measurements]] as const) {
    console.log(`${name}: ${part.status}${part.error ? ` - ${part.error}` : ""}`);
    for (const line of part.summary ?? []) console.log(`  ${line}`);
  }
  if (!report.ok) {
    console.error("The sync failed. The previous snapshot is unchanged and is still what gets published.");
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof SyncBusyError ? error.message : error);
  process.exit(error instanceof SyncBusyError ? 2 : 1);
}
