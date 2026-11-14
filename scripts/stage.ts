// Stage data independently of templates. --dist refreshes an already-built site.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA, ROOT } from "./lib/files.ts";
import { stageSnapshot } from "./lib/stage.ts";

const destination = join(ROOT, process.argv.includes("--dist") ? "dist" : "public");
if (process.argv.includes("--dist") && !existsSync(join(destination, "site-shell", "index.html"))) {
  throw new Error("Build the site templates once with `npm run build` before refreshing data.");
}
const id = stageSnapshot(join(DATA, "published"), destination);
rmSync(join(ROOT, "worker", "generated"), { recursive: true, force: true });
console.log(`staged publication ${id} into ${destination}`);
