// What agents are given besides the pages: the markdown version of each page and how it is asked for, /llms.txt, and
// the API catalogue at /.well-known/api-catalog (RFC 9727). The markdown is the page itself (src/core/markdown.ts,
// called by handlePage); this module says where it is and builds the two small files, from public API answers only.
import { entryHref, modelHref } from "./format.ts";
import type { Summary } from "./entries.ts";
import type { Meta } from "./schema.ts";

/** The owner's content signals, the same in robots.txt and in a response's header: search, AI input and AI training. */
export const CONTENT_SIGNAL = "search=yes, ai-input=yes, ai-train=yes";
export const MARKDOWN_TYPE = "text/markdown; charset=utf-8";
/** A page's markdown version is asked for by this query too: the one address that is never another page's. */
export const MARKDOWN_QUERY = "format";
export const MARKDOWN_QUERY_VALUE = "markdown";

/**
 * Whether a request's Accept header asks for markdown rather than HTML (RFC 9110, 12.5.1): `text/markdown` named
 * outright, with a quality above 0 and at least that of `text/html`. The quality of each type is that of the most
 * specific range that matches it (`text/html` before `text/*` before `*\/*`). A wildcard alone never selects
 * markdown, and no header means HTML: a browser never names text/markdown.
 */
export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  const best = { markdown: { q: 0, specificity: -1 }, html: { q: 0, specificity: -1 } };
  for (const part of accept.split(",")) {
    const [range = "", ...params] = part.split(";").map((item) => item.trim().toLowerCase());
    const [type, subtype] = range.split("/");
    if (!type || !subtype) continue;
    let q = 1;
    for (const param of params) {
      const match = /^q\s*=\s*([0-9.]+)$/.exec(param);
      if (match) q = Math.min(1, Math.max(0, Number(match[1]) || 0));
    }
    for (const [key, sub] of [["markdown", "markdown"], ["html", "html"]] as const) {
      const specificity = type === "*" && subtype === "*" ? 0 : type === "text" && subtype === "*" ? 1 : type === "text" && subtype === sub ? 2 : -1;
      if (specificity < 0) continue;
      const current = best[key];
      if (specificity > current.specificity) best[key] = { q, specificity };
      else if (specificity === current.specificity) current.q = Math.max(current.q, q);
    }
  }
  return best.markdown.specificity === 2 && best.markdown.q > 0 && best.markdown.q >= best.html.q;
}

/**
 * The page a markdown address stands for, or null: `index.html.md` after an address that ends in `/` (the home, a
 * list, a provider, a model, a document), `.md` after an entry's address. Never decoded: the page's own address,
 * as asked.
 */
export function markdownBase(pathname: string): string | null {
  if (pathname.endsWith("/index.html.md")) {
    const base = pathname.slice(0, -"index.html.md".length);
    return base.startsWith("/entries/") ? null : base;
  }
  if (pathname.startsWith("/entries/") && pathname.endsWith(".md")) {
    const base = pathname.slice(0, -".md".length);
    return base.endsWith("/") || base === "/entries" ? null : base;
  }
  return null;
}

/** The markdown address of a page's canonical address (path and query). */
export function markdownHref(canonical: string): string {
  const [path = "/", query] = canonical.split("?");
  const address = path.endsWith("/") ? `${path}index.html.md` : `${path}.md`;
  return query ? `${address}?${query}` : address;
}

/** The markdown address of an entry whose `.md` address is another entry's page: its page with the format query. */
export function entryMarkdownQuery(ref: string): string {
  return `${entryHref(ref)}?${MARKDOWN_QUERY}=${MARKDOWN_QUERY_VALUE}`;
}

/** A Link header's value of some relations, each target absolute. */
export function linkHeader(site: string, links: readonly { href: string; rel: string; type?: string }[]): string {
  return links.map(({ href, rel, type }) => `<${new URL(href, site).toString()}>; rel="${rel}"${type ? `; type="${type}"` : ""}`).join(", ");
}

/** The links of the API that the home page and the API guide carry in their header: where the API is described. */
export const API_LINKS = [
  { href: "/api/v1/openapi.json", rel: "service-desc", type: "application/json" },
  { href: "/docs/api/", rel: "service-doc", type: "text/html" },
  { href: "/.well-known/api-catalog", rel: "api-catalog" },
] as const;

/**
 * /.well-known/api-catalog (RFC 9727): a linkset whose catalogue names one API by a working endpoint of it, and that
 * endpoint's description (the OpenAPI document, served as application/json) and documentation (the API guide).
 * `/api/v1/` itself answers 404, so it is not named.
 */
export function apiCatalog(site: string): string {
  const at = (path: string): string => new URL(path, site).toString();
  return JSON.stringify({
    linkset: [
      { anchor: at("/.well-known/api-catalog"), item: [{ href: at("/api/v1/entries") }] },
      {
        anchor: at("/api/v1/entries"),
        "service-desc": [{ href: at("/api/v1/openapi.json"), type: "application/json" }],
        "service-doc": [{ href: at("/docs/api/"), type: "text/html" }],
      },
    ],
  });
}
export const API_CATALOG_TYPE = 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';

interface LlmsInput {
  site: string;
  meta: Meta;
  /** An entry to show as the example: the one with the newest providers.dev evidence. */
  entry: Pick<Summary, "ref" | "provider" | "canonical_id"> | null;
  /** The markdown address of that entry. */
  entryMarkdown: string | null;
  /** A canonical model to show as the example: the entry's, or the first of the list. */
  model: string | null;
  products: readonly { name: string; site: string; what: string }[];
}

/**
 * providers.dev's /llms.txt: what the site is, from the words its home page and methodology use, the dataset's
 * version and counts from /api/v1/meta, and its main pages in their markdown form. Every link answers: the examples
 * are an entry and a model of the publication that serves this file.
 */
export function llmsTxt(input: LlmsInput): string {
  const { site, meta } = input;
  const at = (path: string): string => new URL(path, site).toString();
  const count = (value: number): string => value.toLocaleString("en-US");
  const lines = [
    "# providers.dev",
    "",
    "> AI models as each provider and access method exposes them: context window, maximum output, price and prompt caching, with one value per quantity and the sources behind it. A read-only JSON API, no key.",
    "",
    "Each quantity has one value, from the first source that states it: what providers.dev measured, providers.dev's corrections, models.dev, then Pi's model catalog. A warning marks a value whose sources do not all agree. Unknown is not zero.",
    "",
    `Dataset ${meta.dataset_version}, published ${meta.generated_at}: ${count(meta.counts.entries)} entries (a model at a provider, by one access method), ${count(meta.counts.providers)} providers, ${count(meta.counts.models)} models.`,
    "",
    "Every page has a markdown version with the same content: add `.md` to an entry's address (`/entries/{provider}/{model}.md`), add `index.html.md` to any other page's address (they end in `/`), or ask for the page itself with `Accept: text/markdown`.",
    "",
    "## API",
    "",
    `- [OpenAPI document](${at("/api/v1/openapi.json")}): every path, parameter and field (JSON)`,
    `- [API guide](${at("/docs/api/index.html.md")}): the paths, their parameters, and how to search and filter`,
    `- [Dataset version and counts](${at("/api/v1/meta")}): \`GET /api/v1/meta\``,
    ...(input.entry
      ? [
          `- [One entry, as JSON](${at(`/api/v1${entryHref(input.entry.ref)}`)}): \`GET /api/v1/entries/{provider}/{model}\` (the model id may contain slashes)`,
          `- [The same entry's page, in markdown](${at(input.entryMarkdown ?? `${entryHref(input.entry.ref)}.md`)})`,
          `- [Entries of one provider, ten at a time](${at(`/api/v1/entries?provider=${encodeURIComponent(input.entry.provider)}&limit=10`)}): \`GET /api/v1/entries?provider={provider}&limit=10\``,
        ]
      : []),
    ...(input.model ? [`- [One model at every provider, as JSON](${at(`/api/v1${modelHref(input.model).replace(/\/$/, "")}`)}): \`GET /api/v1/models/{lab}/{model}\``, `- [The same model's page, in markdown](${at(markdownHref(modelHref(input.model)))})`] : []),
    "",
    "## Docs",
    "",
    `- [Methodology](${at("/docs/methodology/index.html.md")}): where each value comes from`,
    `- [Contributing](${at("/docs/contributing/index.html.md")}): how to propose a correction, a model or a measurement`,
    `- [Licensing and attribution](${at("/docs/licensing/index.html.md")})`,
    "",
    "## Browse",
    "",
    `- [Catalog](${at("/index.html.md")}): every entry, a page at a time`,
    `- [Providers](${at("/providers/index.html.md")}): every provider and how it is reached`,
    `- [Models](${at("/models/index.html.md")}): canonical models across providers and access methods`,
    `- [Evidence](${at("/evidence/index.html.md")}): corrections and evaluations, with sources and dates`,
    "",
    "## Optional",
    "",
    ...input.products.map((product) => `- [${product.name}](${new URL("/llms.txt", product.site).toString()}): ${product.what}`),
    `- [The whole catalog as one JSON file](${at("/api.json")}): every entry in full, a large file`,
    "",
  ];
  return lines.join("\n");
}
