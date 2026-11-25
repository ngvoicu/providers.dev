// What search engines and agents' crawlers are told about providers.dev's pages: which address of a page is its
// canonical one, which views of the catalog are kept out of the index, and the sitemaps that list every page.
// The sitemaps are written when the data is built (scripts/lib/publish.ts), from the same index the pages read, and
// served from the publication by the Worker; nothing here reads a request's data.
import { modelsFor } from "./api.ts";
import type { Index } from "./entries.ts";
import { entryHref, modelHref, providerHref } from "./format.ts";
import { DEFAULT_LIMIT } from "./query.ts";
import { DOCUMENTS } from "./resources.ts";

/** The site's one address. The www host and plain http are sent here by the Worker. */
export const SITE = "https://providers.dev";

/** The pages that are not a provider, a model or an entry, at their canonical addresses. */
export const FIXED_PAGES: readonly string[] = [
  "/", "/providers/", "/models/", "/evidence/", "/docs/api/",
  // The support document's page is on provimux.providers.dev.
  ...DOCUMENTS.filter((name) => name !== "support").map((name) => `/docs/${name}/`),
];

/**
 * The canonical query of a list page and whether the page is one to index. `params` is what the page kept of the
 * request (its known parameters, each valid). A plain list and its pages at the default size are indexed, each its own
 * canonical: `offset` stays (written as a number), an offset of 0 and a limit equal to the default are left out, so
 * page one has one address. Anything else (a search, a filter, a sort, another page size, an offset between two pages)
 * is a view to follow but not to index; its canonical keeps every parameter that chooses its rows, in name order.
 * `paged: false` for a page whose offsets page sections independently (the evidence page): only its plain address is
 * indexed.
 */
export function listIndexing(params: URLSearchParams, offsets: readonly string[] = ["offset"], paged = true): { search: string; index: boolean } {
  const kept: [string, string][] = [];
  let index = true;
  for (const [name, value] of params) {
    if (offsets.includes(name) || name === "limit") {
      const number = Number(value);
      if (offsets.includes(name) ? number === 0 : number === DEFAULT_LIMIT) continue;
      if (name === "limit" || !paged || number % DEFAULT_LIMIT !== 0) index = false;
      kept.push([name, String(number)]);
    } else {
      index = false;
      kept.push([name, value]);
    }
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // A list of values stays as the site's links write it (origin=modified,added).
  const search = new URLSearchParams(kept).toString().replace(/%2C/gi, ",");
  return { search: search ? `?${search}` : "", index };
}

/** The most addresses in one sitemap of entries (the protocol allows 50,000). */
export const SITEMAP_ENTRIES = 5000;

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function urlset(site: string, paths: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map((path) => `<url><loc>${xml(new URL(path, site).toString())}</loc></url>\n`).join("")}</urlset>\n`;
}

/**
 * The sitemaps of a publication, by file name: `sitemap.xml`, the index, names the others, each at the root of the
 * site (a sitemap lists only addresses under its own folder). Every address is the canonical address its page states:
 * the fixed pages, every provider, every canonical model and every entry. No lastmod: the data has no date at which
 * a page last changed. No priority or changefreq.
 */
export function sitemapFiles(index: Index, site: string = SITE): Map<string, string> {
  const entries = index.entries.map((summary) => entryHref(summary.ref));
  const files = new Map<string, string>([
    ["sitemap-pages.xml", urlset(site, FIXED_PAGES)],
    ["sitemap-providers.xml", urlset(site, index.providers.map((provider) => providerHref(provider.id)))],
    ["sitemap-models.xml", urlset(site, modelsFor(index).map((model) => modelHref(model.id)))],
  ]);
  for (let start = 0, part = 1; start < Math.max(entries.length, 1); start += SITEMAP_ENTRIES, part += 1) {
    files.set(`sitemap-entries-${part}.xml`, urlset(site, entries.slice(start, start + SITEMAP_ENTRIES)));
  }
  const names = [...files.keys()];
  files.set("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${names.map((name) => `<sitemap><loc>${xml(new URL(`/${name}`, site).toString())}</loc></sitemap>\n`).join("")}</sitemapindex>\n`);
  return files;
}

/** A sitemap's address on the site: /sitemap.xml or /sitemap-{name}.xml. */
export const SITEMAP_PATH = /^\/sitemap(-[a-z0-9]+(-\d+)?)?\.xml$/;
