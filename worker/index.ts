// Static assets contain templates and versioned data. Pages consume the public API response contract.
import { API_CATALOG_TYPE, apiCatalog, CONTENT_SIGNAL, linkHeader, llmsTxt, MARKDOWN_TYPE, markdownHref, prefersMarkdown } from "../src/core/agents.ts";
import { apiHeaders, handleApi } from "../src/core/api.ts";
import { PUBLICATION_CACHE, withAssetCache } from "../src/core/cache-control.ts";
import { SITE, SITEMAP_PATH } from "../src/core/crawl.ts";
import type { Summary } from "../src/core/entries.ts";
import { handlePage, isPage, PAGE_SHELL, RETRY_AFTER_S } from "../src/core/pages.ts";
import { movedToPiCacheKeeper, PI_CACHE_KEEPER } from "../src/core/pi-cache-keeper-site.ts";
import { isSitePage, siteRoute, type ProductSite } from "../src/core/product-site.ts";
import { movedToProvimux, PROVIMUX } from "../src/core/provimux-site.ts";
import type { CanonicalModel } from "../src/core/resources.ts";
import type { Meta } from "../src/core/schema.ts";
import { movedToTeamVsSolo, TEAMVSSOLO } from "../src/core/teamvssolo-site.ts";
import { readSnapshot, type AssetBinding } from "../src/core/snapshot.ts";

interface Env { ASSETS: AssetBinding }
const SITE_HOST = new URL(SITE).hostname;
const WWW_HOST = `www.${SITE_HOST}`;

/** The products' own sites, each on its own subdomain (src/core/product-site.ts). */
const PRODUCT_SITES: readonly ProductSite[] = [PROVIMUX, PI_CACHE_KEEPER, TEAMVSSOLO];

/**
 * Where a request at Cloudflare's edge must go instead, or null to serve it. The site has one address, SITE, and each
 * product's site one, its subdomain (PRODUCT_SITES):
 * - www.providers.dev, over http or https, goes to SITE with the same path and query, in one step;
 * - providers.dev and the products' subdomains over plain http go to https, same host, path and query.
 * Only at the edge: Cloudflare sets X-Forwarded-Proto to the visitor's protocol (and overwrites any value the
 * client sent). That header is what tells the edge from `wrangler dev`: with `routes` in wrangler.jsonc a local
 * preview also sees http://providers.dev/… as the request URL and Host, but no X-Forwarded-Proto, so it is never
 * redirected. Any other host is served as it comes.
 */
export function canonicalLocation(request: Request): string | null {
  const proto = request.headers.get("X-Forwarded-Proto")?.toLowerCase();
  if (proto !== "http" && proto !== "https") return null;
  const url = new URL(request.url);
  const www = url.hostname === WWW_HOST;
  const product = PRODUCT_SITES.find((site) => site.host === url.hostname);
  const plain = (url.hostname === SITE_HOST || product !== undefined) && url.protocol === "http:" && proto === "http";
  if (!www && !plain) return null;
  // Path and query are set on SITE, never resolved against it: a path such as //other.host stays a path.
  const target = new URL(product?.site ?? SITE);
  target.pathname = url.pathname;
  target.search = url.search;
  return target.toString();
}

/**
 * A product's subdomain: its static pages and files from the build (src/core/product-site.ts), nothing else. No API,
 * no dataset, no providers.dev page. Each page has its markdown version beside it (`index.html.md`, written by
 * scripts/finalize-site.ts from the built page), also given at the page's own address to an Accept header that asks for
 * markdown; the site's llms.txt names them.
 */
async function productSite(request: Request, env: Env, site: ProductSite): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const url = new URL(request.url);
  const route = siteRoute(site, url.pathname);
  if ("redirect" in route) {
    const target = new URL(route.redirect, url.origin);
    target.search = url.search;
    return new Response(null, { status: 301, headers: { Location: target.toString() } });
  }
  const page = route.status === 200 && isSitePage(site, url.pathname);
  const markdown = page && prefersMarkdown(request.headers.get("Accept"));
  const asset = markdown ? `${route.asset}index.html.md` : route.asset;
  const response = await env.ASSETS.fetch(new Request(new URL(asset, url.origin), request));
  if (route.status === 200 && (response.ok || response.status === 304)) {
    const headers = new Headers(response.headers);
    headers.set("Content-Signal", CONTENT_SIGNAL);
    if (page) {
      headers.set("Vary", "Accept");
      headers.set("Link", markdown ? linkHeader(site.site, [{ href: url.pathname, rel: "canonical" }]) : linkHeader(site.site, [{ href: markdownHref(url.pathname), rel: "alternate", type: "text/markdown" }, { href: "/llms.txt", rel: "describedby" }]));
    }
    // A markdown version names its page as the one to show in search results.
    const of = /^(.*\/)index\.html\.md$/.exec(url.pathname)?.[1];
    if (of !== undefined && isSitePage(site, of)) headers.set("Link", linkHeader(site.site, [{ href: of, rel: "canonical" }]));
    if (markdown || url.pathname.endsWith(".md")) headers.set("Content-Type", MARKDOWN_TYPE);
    else if (url.pathname.endsWith(".txt")) headers.set("Content-Type", "text/plain; charset=utf-8");
    // Astro's hashed stylesheets and fonts, shared with providers.dev, are kept a year; the site's own files are not.
    return withAssetCache(url.pathname, new Response(response.body, { status: response.status, headers }));
  }
  // An address the site does not have, or a file it lacks: the site's own page for it, with status 404.
  const missing = route.status === 404 && response.ok ? response : await env.ASSETS.fetch(new Request(new URL(site.notFound, url.origin)));
  return new Response(request.method === "HEAD" || !missing.ok ? null : missing.body, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

/** The products named at the end of providers.dev's llms.txt, each with its own. */
const LLMS_PRODUCTS = [
  { name: "Provimux", site: PROVIMUX.site, what: "a self-hosted AI gateway, by providers.dev" },
  { name: "pi-cache-keeper", site: PI_CACHE_KEEPER.site, what: "an extension for Pi that makes the prompt cache pay off" },
  { name: "Team vs Solo", site: TEAMVSSOLO.site, what: "a benchmark of coding models, one model alone against a chief model with workers, by providers.dev" },
] as const;

/**
 * providers.dev's /llms.txt, from the publication that serves it: its meta, and as examples an entry with the newest
 * providers.dev evidence and that entry's model, so that every link of it answers (src/core/agents.ts).
 */
async function llms(api: (path: string) => Promise<Response>): Promise<string> {
  const data = async <T>(path: string): Promise<T> => ((await (await api(path)).json()) as { data: T }).data;
  const meta = await data<Meta>("/api/v1/meta");
  // An entry reached by API key with the newest providers.dev evidence, whose model has a page of its own.
  const entries = await data<Summary[]>("/api/v1/entries?sort=verified&order=desc&access=api&limit=50");
  const entry = entries.find((item) => item.canonical_id !== null) ?? entries[0];
  const model = entry?.canonical_id ?? (await data<CanonicalModel[]>("/api/v1/models?limit=1"))[0]?.id ?? null;
  // The entry's markdown address is its page's own `.md`, unless that is another entry's page.
  const twin = entry ? (await api(`/api/v1/entries/${entry.ref.split("/").map(encodeURIComponent).join("/")}.md`)).ok : false;
  const entryMarkdown = entry ? (twin ? `/entries/${entry.ref.split("/").map(encodeURIComponent).join("/")}?format=markdown` : null) : null;
  return llmsTxt({ site: SITE, meta, entry: entry ?? null, entryMarkdown, model, products: LLMS_PRODUCTS });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // The zone redirects nothing; the Worker sends www and plain http to https, before anything else.
    const location = canonicalLocation(request);
    if (location) return new Response(null, { status: 301, headers: { Location: location } });
    const product = PRODUCT_SITES.find((site) => site.host === url.hostname);
    if (product) return productSite(request, env, product);
    // The support page and anything of a product site's build live on that site's subdomain only.
    const moved = movedToProvimux(url) ?? movedToPiCacheKeeper(url) ?? movedToTeamVsSolo(url);
    if (moved) return new Response(null, { status: 301, headers: { Location: moved } });
    const api = url.pathname.startsWith("/api/v1/") || url.pathname === "/api.json" || url.pathname === "/data/catalog.json";
    const data = url.pathname.startsWith("/data/");
    const page = isPage(url.pathname);
    // The sitemaps, written with each publication (src/core/crawl.ts), are read from it.
    const sitemap = SITEMAP_PATH.test(url.pathname);
    // What agents read first: /llms.txt, from the publication, and the API catalogue (src/core/agents.ts).
    const agents = url.pathname === "/llms.txt" || url.pathname === "/.well-known/api-catalog";
    // Implementation assets are internal. CSS, scripts, icons and other public files remain static.
    if (url.pathname.startsWith("/site-shell") || url.pathname.startsWith("/reference-content") || url.pathname.startsWith("/snapshots/") || url.pathname === "/current.json") return new Response("Not found", { status: 404 });
    if (!api && !data && !page && !sitemap && !agents && /\.[a-z0-9]+$/i.test(url.pathname)) return withAssetCache(url.pathname, await env.ASSETS.fetch(request));
    if (url.pathname === "/.well-known/api-catalog") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
      return new Response(request.method === "HEAD" ? null : apiCatalog(SITE), { headers: { "Content-Type": API_CATALOG_TYPE, "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*", Link: linkHeader(SITE, [{ href: "/.well-known/api-catalog", rel: "api-catalog" }]) } });
    }
    try {
      const snapshot = await readSnapshot(env.ASSETS, url.origin);
      if (api) return handleApi(request, snapshot);
      if (url.pathname === "/llms.txt") {
        if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
        const text = await llms((path) => handleApi(new Request(new URL(path, url.origin)), snapshot));
        return new Response(request.method === "HEAD" ? null : text, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": PUBLICATION_CACHE, "Content-Signal": CONTENT_SIGNAL, "X-Dataset-Version": snapshot.meta.dataset_version } });
      }
      if (sitemap) {
        if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
        const asset = await snapshot.asset(`/data/sitemaps${url.pathname}`);
        if (!asset) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
        return new Response(request.method === "HEAD" ? null : asset.body, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": PUBLICATION_CACHE, "X-Dataset-Version": snapshot.meta.dataset_version } });
      }
      if (data) {
        if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
        const asset = await snapshot.asset(url.pathname);
        if (!asset) return new Response("Not found", { status: 404 });
        return new Response(request.method === "HEAD" ? null : asset.body, { headers: apiHeaders(snapshot.meta, { "Content-Type": asset.headers.get("Content-Type") ?? "application/json" }) });
      }
      return handlePage(request, {
        api: (path) => handleApi(new Request(new URL(path, url.origin)), snapshot),
        shell: () => snapshot.asset(PAGE_SHELL), site: SITE, now: () => new Date(),
      });
    } catch {
      // A temporary failure: 503 with Retry-After, never cached.
      const headers = { "Cache-Control": "no-store", "Retry-After": String(RETRY_AFTER_S), "Content-Type": api ? "application/json" : "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" };
      return new Response(request.method === "HEAD" ? null : api ? JSON.stringify({ error: { code: "snapshot_incomplete", message: "The published snapshot is unavailable. Try again shortly." } }) : "The published snapshot is unavailable. Try again shortly.", { status: 503, headers });
    }
  },
};
