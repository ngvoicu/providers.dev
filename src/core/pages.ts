// Every page is a view of public API responses. This module has no catalog/index/file-data access.
import { etagMatches, refFromPath, representationTag } from "./api.ts";
import { catalogHtml, modelsHtml, providersHtml, type Envelope, type One } from "./catalog-view.ts";
import { evidenceHtml, modelHtml, providerHtml } from "./detail-view.ts";
import { listIndexing } from "./crawl.ts";
import { apiDocsMeta, catalogMeta, documentMeta, entryMeta, errorMeta, evidenceMeta, modelMeta, modelsMeta, providerMeta, providersMeta } from "./page-meta.ts";
import { catalogPage, documentGraph, homeGraph, jsonLdScript, webApi, type JsonLd } from "./structured-data.ts";
import { documentHtml, fillMetaSlots, openapiHtml, type OpenApiDocument } from "./docs-view.ts";
import type { ProviderSummary, Summary } from "./entries.ts";
import { entryHref, escapeHtml as e, modelHref, providerHref, type Today } from "./format.ts";
import type { Listing } from "./listings.ts";
import type { JsonObject } from "./merge.ts";
import { fillShell, PAGE_SHELL } from "./page-shell.ts";
import { MODEL_PARAMS, PARAMS, parseParams, parseQuery, PROVIDER_PARAMS, serializeQuery, SITE_DEFAULT, type ParamDoc } from "./query.ts";
import { entryHtml, piRechecked } from "./render.ts";
import { DOCUMENTS, type CanonicalModel, type CanonicalModelDetail, type Correction, type CacheEvaluationRecord, type Documentation, type Facets, type LimitEvaluationRecord } from "./resources.ts";
import type { Meta } from "./schema.ts";

export interface PageDeps {
  /** Dispatch the same HTTP handler used by external API callers, pinned to one publication. */
  api(path: string): Promise<Response>;
  shell(): Promise<Response | null>;
  site: string;
  now(): Date;
}
/**
 * A page: its title, description and body, its canonical address (path and query, built from the ids the API returns,
 * never from the address as it was asked), whether it is a page to index (false: a filtered, sorted or searched
 * view, `noindex, follow`), and its structured data. `title` is the full title (src/core/page-meta.ts).
 */
interface View { title: string; description: string; html: string; canonical: string; index?: boolean; ld?: JsonLd[] }
/** A temporary failure: crawlers and clients are asked to come back after this many seconds. */
export const RETRY_AFTER_S = 300;
class ApiError extends Error {
  status: number;
  constructor(status: number) { super(`API response ${status}`); this.status = status; }
}

/** The page offsets of the evidence page, one per paged section. */
const EVIDENCE_PARAMS: ParamDoc[] = (["corrections_offset", "cache_offset", "limits_offset"] as const).map((name) => ({ name, kind: "integer", description: "Items to skip." }));

/**
 * The pages' own lenient step in front of the API's validator, which stays strict. A page is often reached by a link
 * that carries more than its filters (utm_source=chatgpt.com, fbclid, ref, …) or a filter a person mistyped: the page
 * keeps of the query only the parameters `docs` describes whose value the API accepts (the first, where a name is
 * repeated) and leaves out everything else, as if it were not in the address. The browser's explorer does the same
 * (src/client/explorer.ts, readUrl).
 */
export function pageParams(search: URLSearchParams, docs: readonly ParamDoc[]): URLSearchParams {
  const known = new Set(docs.map((doc) => doc.name as string));
  const kept = new URLSearchParams();
  for (const [name, value] of search) {
    if (!known.has(name) || kept.has(name) || value.trim() === "") continue;
    if (parseParams(new URLSearchParams([[name, value]]), docs, true).ok) kept.set(name, value);
  }
  return kept;
}

export function isPage(path: string): boolean {
  return path === "/" || /^(\/providers|\/models|\/entries|\/entry|\/evidence|\/docs)(\/|$)/.test(path);
}

export async function handlePage(request: Request, deps: PageDeps): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const url = new URL(request.url);
  /** An address of the site in full, as a canonical link and structured data name it. */
  const absolute = (address: string): string => new URL(address, deps.site).toString();
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/entry" && url.searchParams.get("ref")?.includes("/")) return Response.redirect(new URL(entryHref(url.searchParams.get("ref")!), url.origin).toString(), 301);
  const read = async <T>(api: string): Promise<T> => {
    const response = await deps.api(api);
    if (!response.ok) throw new ApiError(response.status);
    return await response.json() as T;
  };
  const one = async <T>(api: string): Promise<T> => (await read<One<T>>(api)).data;
  const all = async <T>(api: string): Promise<T[]> => {
    const items: T[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const result: Envelope<T> = await read(`${api}${api.includes("?") ? "&" : "?"}limit=200&offset=${offset}`);
      items.push(...result.data);
      offset = result.next_offset;
    }
    return items;
  };
  /** The page's address with only the parameters it uses: what its own links and forms carry on. */
  const kept = (params: URLSearchParams): URL => new URL(`${url.pathname}${params.toString() ? `?${params}` : ""}`, url.origin);
  /** A page past the last one of a list is not a page of it: the not-found page. */
  const within = <T>(result: Envelope<T>): Envelope<T> => {
    if (result.offset > 0 && result.data.length === 0) throw new ApiError(404);
    return result;
  };
  const now = new Date(`${deps.now().toISOString().slice(0, 10)}T00:00:00Z`);
  let status = 200;
  let meta: Meta | undefined;
  let view: View;
  try {
    meta = await one<Meta>("/api/v1/meta");
    const imported = meta.upstream.fetched_at.slice(0, 10);
    // Staleness is the published threshold applied to today: the one thing a page works out.
    const today: Today = { date: now, stale_after_days: meta.stale_after_days };
    if (path === "/") {
      const own = pageParams(url.searchParams, PARAMS);
      const params = new URLSearchParams(own);
      if (!params.has("sort")) for (const [name, value] of new URLSearchParams(SITE_DEFAULT)) if (!params.has(name)) params.set(name, value);
      const parsed = parseQuery(params, true);
      if (!parsed.ok) throw new ApiError(400);
      const [result, facets] = await Promise.all([read<Envelope<Summary>>(`/api/v1/entries?${serializeQuery(parsed.query)}`).then(within), one<Facets>("/api/v1/facets")]);
      const listing = listIndexing(own);
      const about = catalogMeta(meta, result, listing.index);
      const canonical = `/${listing.search}`;
      view = { ...about, html: catalogHtml(result, parsed.query, facets, meta, kept(own), today), canonical, index: listing.index, ld: canonical === "/" ? homeGraph(meta, about) : catalogPage(absolute(canonical), about, { type: "CollectionPage" }) };
    } else if (path === "/providers") {
      const params = pageParams(url.searchParams, PROVIDER_PARAMS);
      const own = kept(params);
      const listing = listIndexing(params);
      const result = within(await read<Envelope<ProviderSummary>>(`/api/v1/providers${own.search}`));
      const about = providersMeta(result, listing.index);
      const canonical = `/providers/${listing.search}`;
      view = { ...about, html: providersHtml(result, own), canonical, index: listing.index, ld: catalogPage(absolute(canonical), about, { type: "CollectionPage" }) };
    } else if (path.startsWith("/providers/")) {
      // The provider's model list, where a source has one: the API answers 404 for a provider it has no listing for.
      const [{ provider, entries }, listing] = await Promise.all([
        one<{ provider: ProviderSummary; entries: Summary[] }>(`/api/v1${path}`),
        one<Listing>(`/api/v1/listings/${path.slice("/providers/".length)}`).catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        }),
      ]);
      const about = providerMeta(provider);
      const canonical = providerHref(provider.id);
      view = { ...about, html: providerHtml(provider, entries, listing, imported, today, meta.pi), canonical, ld: catalogPage(absolute(canonical), about, { crumbs: [["Providers", absolute("/providers/")], [provider.name, absolute(canonical)]] }) };
    } else if (path === "/models") {
      const params = pageParams(url.searchParams, MODEL_PARAMS);
      const own = kept(params);
      const listing = listIndexing(params);
      const result = within(await read<Envelope<CanonicalModel>>(`/api/v1/models${own.search}`));
      const about = modelsMeta(result, listing.index);
      const canonical = `/models/${listing.search}`;
      view = { ...about, html: modelsHtml(result, own), canonical, index: listing.index, ld: catalogPage(absolute(canonical), about, { type: "CollectionPage" }) };
    } else if (path.startsWith("/models/")) {
      if (!refFromPath(path.slice("/models/".length))) throw new ApiError(404);
      const [model, facets] = await Promise.all([one<CanonicalModelDetail>(`/api/v1${path}`), one<Facets>("/api/v1/facets")]);
      const about = modelMeta(model);
      const canonical = modelHref(model.id);
      view = { ...about, html: modelHtml(model, Object.fromEntries(facets.providers.map((provider) => [provider.id, provider.name])), imported, today, meta.pi), canonical, ld: catalogPage(absolute(canonical), about, { crumbs: [["Models", absolute("/models/")], [model.name, absolute(canonical)]] }) };
    } else if (path.startsWith("/entries/")) {
      if (!refFromPath(path.slice("/entries/".length))) throw new ApiError(404);
      const { provider, summary, entry } = await one<{ provider: ProviderSummary; summary: Summary; entry: JsonObject }>(`/api/v1${path}`);
      const about = entryMeta(summary, provider.name);
      const canonical = entryHref(summary.ref);
      view = { ...about, canonical, html: entryHtml({ summary, provider, model: entry, imported, today, cache_ages_s: meta.cache_ages_s, pi: meta.pi }), ld: catalogPage(absolute(canonical), about, { crumbs: [["Providers", absolute("/providers/")], [provider.name, absolute(providerHref(provider.id))], [summary.name, absolute(canonical)]] }) };
    } else if (path === "/evidence") {
      const own = pageParams(url.searchParams, EVIDENCE_PARAMS);
      const offset = (name: string): string => own.get(name) ?? "0";
      const [corrections, added, cache, measured] = await Promise.all([
        read<Envelope<Correction>>(`/api/v1/corrections?offset=${offset("corrections_offset")}`).then(within),
        all<ProviderSummary>("/api/v1/providers?origin=added"),
        read<Envelope<CacheEvaluationRecord>>(`/api/v1/evaluations/cache?offset=${offset("cache_offset")}`).then(within),
        read<Envelope<LimitEvaluationRecord>>(`/api/v1/evaluations/limits?offset=${offset("limits_offset")}`).then(within),
      ]);
      // Its three sections page apart, so a later page of one repeats the first page of the others: only /evidence/ is indexed.
      const listing = listIndexing(own, EVIDENCE_PARAMS.map(({ name }) => name), false);
      const about = evidenceMeta(meta, listing.index);
      const canonical = `/evidence/${listing.search}`;
      view = { ...about, html: evidenceHtml(meta, corrections, added, cache, measured, kept(own), today), canonical, index: listing.index, ld: catalogPage(absolute(canonical), about) };
    } else if (path === "/docs/api") {
      const openapi = await read<OpenApiDocument>("/api/v1/openapi.json");
      const about = apiDocsMeta(openapi.info);
      view = { ...about, html: openapiHtml(openapi), canonical: "/docs/api/", ld: documentGraph(absolute("/docs/api/"), about, "API", true, webApi(openapi.info)) };
    } else if (path.startsWith("/docs/") && (DOCUMENTS as readonly string[]).includes(path.slice("/docs/".length)) && path !== "/docs/support") {
      // The support document is in the API; its page is on provimux.providers.dev (the Worker sends /support/ there).
      const name = path.split("/").at(-1)!;
      const document = await one<Documentation>(`/api/v1/docs/${name}`);
      const about = documentMeta(name, document);
      // Licensing is a notice, not an article.
      view = { ...about, html: documentHtml(fillMetaSlots(document, meta)), canonical: `/docs/${name}/`, ld: documentGraph(absolute(`/docs/${name}/`), about, document.title, name !== "licensing") };
    } else throw new ApiError(404);
  } catch (error) {
    status = error instanceof ApiError && (error.status === 400 || error.status === 404) ? error.status : 503;
    const title = status === 404 ? "Nothing at this address" : status === 400 ? "Invalid filters" : "The catalog is temporarily unavailable";
    view = { ...errorMeta(title), canonical: "", html: `<h1>${title}</h1><p class="lead mt-3">${status === 400 ? 'Use the <a href="/docs/api/">documented API parameters</a> for this view.' : status === 404 ? "This page, provider or model may no longer be listed." : "The API could not load a complete published snapshot. Try again shortly."}</p><p class="mt-6"><a class="button" href="/">Search the catalog</a></p>` };
  }
  // One address per page: the same path with or without its final slash is sent to the canonical one, query and all.
  const canonicalPath = view.canonical.split("?")[0]!;
  if (status === 200 && url.pathname !== canonicalPath && url.pathname.replace(/\/+$/, "") === canonicalPath.replace(/\/+$/, "")) {
    const location = new URL(canonicalPath, url.origin);
    location.search = url.search;
    return new Response(null, { status: 301, headers: { Location: location.toString() } });
  }
  const shell = await deps.shell();
  if (!shell) return new Response("Page template unavailable", { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": String(RETRY_AFTER_S) } });
  // An error page has no canonical and is not indexed; a view of a list is followed but not indexed.
  const robots = status !== 200 ? "noindex" : view.index === false ? "noindex, follow" : null;
  // The page's own head: its canonical address (also og:url), the robots meta where it is not to be indexed, its structured data.
  const canonical = status === 200 ? e(absolute(view.canonical)) : null;
  const head = `${canonical ? `<link rel="canonical" href="${canonical}"><meta property="og:url" content="${canonical}">` : ""}${robots ? `<meta name="robots" content="${robots}">` : ""}${status === 200 && view.ld ? jsonLdScript(view.ld) : ""}`;
  const nav = [["/", "Catalog"], ["/providers/", "Providers"], ["/models/", "Models"], ["/evidence/", "Evidence"], ["/docs/api/", "API"], ["/docs/methodology/", "Methodology"]];
  const html = fillShell(await shell.text(), {
    title: e(view.title), description: e(view.description), head, html: view.html,
    nav: nav.map(([href, label]) => `<a href="${href}"${href === "/" ? path === "/" || path.startsWith("/entr") ? ' aria-current="page"' : "" : `${path}/`.startsWith(href!) || ((path === "/docs/licensing" || path === "/docs/contributing") && label === "Methodology") ? ' aria-current="page"' : ""}>${label}</a>`).join(""),
    dataset: meta ? `<li>Version <code>${e(meta.dataset_version)}</code></li><li>Published ${e(meta.generated_at.slice(0, 10))} ${e(meta.generated_at.slice(11, 16))} UTC</li><li>models.dev imported ${e(meta.upstream.fetched_at.slice(0, 10))}${meta.upstream.commit ? ` (<a href="https://github.com/anomalyco/models.dev/commit/${e(meta.upstream.commit)}"><code>${e(meta.upstream.commit.slice(0, 7))}</code></a>)` : ""}</li>${meta.sync.last_attempt_ok === false ? '<li class="stale">The last import failed. This is the last good snapshot.</li>' : ""}${meta.pi.snapshot ? `<li>Pi's catalog fetched ${e(meta.pi.snapshot.fetched_at.slice(0, 10))}${piRechecked(meta.pi) ? `, last checked ${e(meta.pi.snapshot.checked_at.slice(0, 10))}` : ""}</li>` : ""}${meta.pi.sync.last_attempt_ok === false ? `<li class="stale">${meta.pi.snapshot ? "The last import of Pi's catalog failed. Its data is the last good snapshot." : "The last import of Pi's catalog failed. This dataset has no Pi data."}</li>` : ""}` : '<li>Metadata unavailable</li>',
  });
  const etag = await representationTag(html);
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", ETag: etag, "Cache-Control": status === 200 ? "public, max-age=300, stale-while-revalidate=3600" : "no-store" });
  // An error page is never a page to index.
  if (status !== 200) headers.set("X-Robots-Tag", "noindex");
  if (status === 503) headers.set("Retry-After", String(RETRY_AFTER_S));
  if (meta) { headers.set("X-Dataset-Version", meta.dataset_version); headers.set("X-Dataset-Generated-At", meta.generated_at); }
  if (status === 200 && etagMatches(request, etag)) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : html, { status, headers });
}

export { PAGE_SHELL };
