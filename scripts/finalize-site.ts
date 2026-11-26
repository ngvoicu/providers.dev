// Astro emits a doctype for page files. Turn the authored JSON fragments into JSON assets after compilation.
// Then the products' sites: each page's markdown version (`index.html.md` beside its `index.html`), written from the
// page as built, and the site's llms.txt, written from its pages' titles and descriptions. They are made on every build
// from the HTML of that build, so they cannot fall out of step with the pages. Written into dist/ (Astro has already
// copied public/ there).
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DocumentationSchema } from "../src/core/contract.ts";
import { productMarkdown, productLlmsTxt } from "../src/core/product-agents.ts";
import { PI_CACHE_KEEPER } from "../src/core/pi-cache-keeper-site.ts";
import { PROVIMUX } from "../src/core/provimux-site.ts";
import { DOCUMENTS } from "../src/core/resources.ts";
import { ROOT } from "./lib/files.ts";

for (const name of DOCUMENTS) {
  const directory = join(ROOT, "dist", "reference-content", "docs", name);
  const text = readFileSync(join(directory, "index.html"), "utf8").replace(/^<!doctype html>/i, "");
  const document = DocumentationSchema.parse(JSON.parse(text));
  writeFileSync(`${directory}.json`, JSON.stringify(document));
  rmSync(directory, { recursive: true });
}

for (const site of [PROVIMUX, PI_CACHE_KEEPER]) {
  const pages = site.pages.map((path) => {
    const folder = join(ROOT, "dist", site.assets, path);
    const html = readFileSync(join(folder, "index.html"), "utf8");
    writeFileSync(join(folder, "index.html.md"), productMarkdown(site, path, html));
    return { path, html };
  });
  writeFileSync(join(ROOT, "dist", site.assets, "llms.txt"), productLlmsTxt(site, pages));
}
