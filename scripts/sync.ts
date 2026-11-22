// npm run sync [-- --force] [-- --only=pi]
// Fetch models.dev, the measurements file, groundtruth's discovery file and pi's model catalog once each, check them, and replace the snapshots in
// data/. `--only=pi` runs the pi part alone. A failed pi import alone does not fail the run.
import { DATA } from "./lib/files.ts";
import { sync, SyncBusyError, writeStepOutputs, type PartReport } from "./lib/sync.ts";

const onlyArgument = process.argv.find((argument) => argument.startsWith("--only="));
const only = onlyArgument?.slice("--only=".length);
if (only !== undefined && only !== "pi") {
  console.error(`Unknown part "${only}". The one part that can run alone is pi: --only=pi`);
  process.exit(1);
}

try {
  const report = await sync({ dataDir: DATA, fetch, force: process.argv.includes("--force"), only, log: console.log });
  const parts: [string, PartReport][] = [["models.dev", report.upstream], ["measurements", report.measurements], ["discovery (listed.json)", report.listed], ["pi", report.pi]];
  for (const [name, part] of parts) {
    if (part.status === "skipped") continue;
    console.log(`${name}: ${part.status}${part.error ? ` - ${part.error}` : ""}`);
    for (const line of part.summary ?? []) console.log(`  ${line}`);
  }
  if (process.env.GITHUB_OUTPUT) writeStepOutputs(report, process.env.GITHUB_OUTPUT);
  if (report.listed.status === "failed") {
    console.error("The discovery file could not be read. The last good copy is unchanged and is still what gets published.");
  }
  if (report.pi.status === "failed") {
    console.error("The pi import failed. The last good pi snapshot is unchanged and is still what gets published.");
  }
  if (!report.ok) {
    console.error("The sync failed. The previous snapshot is unchanged and is still what gets published.");
    process.exit(1);
  }
  if (only === "pi" && report.pi.status === "failed") process.exit(1);
} catch (error) {
  console.error(error instanceof SyncBusyError ? error.message : error);
  process.exit(error instanceof SyncBusyError ? 2 : 1);
}
