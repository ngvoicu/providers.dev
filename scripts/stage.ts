// npm run stage
// Copy the published snapshot to where the site build and the Worker read it.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA, ROOT } from "./lib/files.ts";

const published = join(DATA, "published");
if (!existsSync(join(published, "site", "api.json"))) {
  console.error("No published snapshot. Run `npm run sync` and `npm run data` first.");
  process.exit(1);
}
for (const name of ["data", "api.json", "_headers"]) rmSync(join(ROOT, "public", name), { recursive: true, force: true });
cpSync(join(published, "site"), join(ROOT, "public"), { recursive: true });
rmSync(join(ROOT, "worker", "generated"), { recursive: true, force: true });
mkdirSync(join(ROOT, "worker", "generated"), { recursive: true });
cpSync(join(published, "worker"), join(ROOT, "worker", "generated"), { recursive: true });
console.log("staged the snapshot into public/ and worker/generated/");
