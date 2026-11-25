// Static assets contain templates and versioned data. Pages consume the public API response contract.
import { apiHeaders, handleApi } from "../src/core/api.ts";
import { SITE, SITEMAP_PATH } from "../src/core/crawl.ts";
import { handlePage, isPage, PAGE_SHELL, RETRY_AFTER_S } from "../src/core/pages.ts";
import { movedToPiCacheKeeper, PI_CACHE_KEEPER } from "../src/core/pi-cache-keeper-site.ts";
import { siteRoute, type ProductSite } from "../src/core/product-site.ts";
import { movedToProvimux, PROVIMUX } from "../src/core/provimux-site.ts";
import { readSnapshot, type AssetBinding } from "../src/core/snapshot.ts";

interface Env { ASSETS: AssetBinding }
const SITE_HOST = new URL(SITE).hostname;
const WWW_HOST = `www.${SITE_HOST}`;

/** The products' own sites, each on its own subdomain (src/core/product-site.ts). */
const PRODUCT_SITES: readonly ProductSite[] = [PROVIMUX, PI_CACHE_KEEPER];

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
 * no dataset, no providers.dev page.
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
  const response = await env.ASSETS.fetch(new Request(new URL(route.asset, url.origin), request));
  if (route.status === 200 && (response.ok || response.status === 304)) return response;
  // An address the site does not have, or a file it lacks: the site's own page for it, with status 404.
  const page = route.status === 404 && response.ok ? response : await env.ASSETS.fetch(new Request(new URL(site.notFound, url.origin)));
  return new Response(request.method === "HEAD" || !page.ok ? null : page.body, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
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
    const moved = movedToProvimux(url) ?? movedToPiCacheKeeper(url);
    if (moved) return new Response(null, { status: 301, headers: { Location: moved } });
    const api = url.pathname.startsWith("/api/v1/") || url.pathname === "/api.json" || url.pathname === "/data/catalog.json";
    const data = url.pathname.startsWith("/data/");
    const page = isPage(url.pathname);
    // The sitemaps, written with each publication (src/core/crawl.ts), are read from it.
    const sitemap = SITEMAP_PATH.test(url.pathname);
    // Implementation assets are internal. CSS, scripts, icons and other public files remain static.
    if (url.pathname.startsWith("/site-shell") || url.pathname.startsWith("/reference-content") || url.pathname.startsWith("/snapshots/") || url.pathname === "/current.json") return new Response("Not found", { status: 404 });
    if (!api && !data && !page && !sitemap && /\.[a-z0-9]+$/i.test(url.pathname)) return env.ASSETS.fetch(request);
    try {
      const snapshot = await readSnapshot(env.ASSETS, url.origin);
      if (api) return handleApi(request, snapshot);
      if (sitemap) {
        if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
        const asset = await snapshot.asset(`/data/sitemaps${url.pathname}`);
        if (!asset) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
        return new Response(request.method === "HEAD" ? null : asset.body, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600", "X-Dataset-Version": snapshot.meta.dataset_version } });
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
