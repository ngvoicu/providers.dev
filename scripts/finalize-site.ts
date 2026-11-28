// Astro emits a doctype for page files. Turn the authored JSON fragments into JSON assets after compilation.
// Then the products' sites: each page's markdown version (`index.html.md` beside its `index.html`), written from the
// page as built, and the site's llms.txt, written from its pages' titles and descriptions. They are made on every build
// from the HTML of that build, so they cannot fall out of step with the pages. Written into dist/ (Astro has already
// copied public/ there). Team vs Solo's site has a page per test and per run of its results file: those are found in the
// build, each gets its markdown version, and the site's sitemap.xml is written from the pages the build really has.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DocumentationSchema } from "../src/core/contract.ts";
import { productMarkdown, productLlmsTxt } from "../src/core/product-agents.ts";
import { PI_CACHE_KEEPER } from "../src/core/pi-cache-keeper-site.ts";
import { isSitePage } from "../src/core/product-site.ts";
import { PROVIMUX } from "../src/core/provimux-site.ts";
import { DOCUMENTS } from "../src/core/resources.ts";
import { TEAMVSSOLO } from "../src/core/teamvssolo-site.ts";
import { ROOT } from "./lib/files.ts";

for (const name of DOCUMENTS) {
  const directory = join(ROOT, "dist", "reference-content", "docs", name);
  const text = readFileSync(join(directory, "index.html"), "utf8").replace(/^<!doctype html>/i, "");
  const document = DocumentationSchema.parse(JSON.parse(text));
  writeFileSync(`${directory}.json`, JSON.stringify(document));
  rmSync(directory, { recursive: true });
}

/** The addresses of the pages a build holds under a folder, of the shapes the site's data gives, in order. */
function builtPages(folder: string, at = "/"): string[] {
  const here = join(folder, at);
  if (!existsSync(here)) return [];
  const below = readdirSync(here, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => builtPages(folder, `${at}${entry.name}/`));
  return [...(existsSync(join(here, "index.html")) ? [at] : []), ...below].sort();
}

for (const site of [PROVIMUX, PI_CACHE_KEEPER, TEAMVSSOLO]) {
  const folder = join(ROOT, "dist", site.assets);
  const more = site.families ? builtPages(folder).filter((path) => !site.pages.includes(path) && isSitePage(site, path)) : [];
  const write = (path: string): { path: string; html: string } => {
    const html = readFileSync(join(folder, path, "index.html"), "utf8");
    writeFileSync(join(folder, path, "index.html.md"), productMarkdown(site, path, html));
    return { path, html };
  };
  const pages = site.pages.map(write);
  more.forEach(write);
  // llms.txt names the pages every build has; the pages of the data are linked from those.
  writeFileSync(join(folder, "llms.txt"), productLlmsTxt(site, pages));
  if (site.families) {
    const addresses = [...site.pages, ...more].map((path) => `  <url><loc>${new URL(path, site.site).toString()}</loc></url>`);
    writeFileSync(join(folder, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${addresses.join("\n")}\n</urlset>\n`);
  }
}
