// Astro emits a doctype for page files. Turn the authored JSON fragments into JSON assets after compilation.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DocumentationSchema } from "../src/core/contract.ts";
import { DOCUMENTS } from "../src/core/resources.ts";
import { ROOT } from "./lib/files.ts";

for (const name of DOCUMENTS) {
  const directory = join(ROOT, "dist", "reference-content", "docs", name);
  const text = readFileSync(join(directory, "index.html"), "utf8").replace(/^<!doctype html>/i, "");
  const document = DocumentationSchema.parse(JSON.parse(text));
  writeFileSync(`${directory}.json`, JSON.stringify(document));
  rmSync(directory, { recursive: true });
}
