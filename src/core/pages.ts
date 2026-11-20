// Every page is a view of public API responses. This module has no catalog/index/file-data access.
import { etagMatches, refFromPath, representationTag } from "./api.ts";
import { catalogHtml, modelsHtml, providersHtml, type Envelope, type One } from "./catalog-view.ts";
import { evidenceHtml, modelHtml, providerHtml } from "./detail-view.ts";
import { documentHtml, fillMetaSlots, openapiHtml, type OpenApiDocument } from "./docs-view.ts";
import type { ProviderSummary, Summary } from "./entries.ts";
import { entryHref, escapeHtml as e, type Today } from "./format.ts";
import type { JsonObject } from "./merge.ts";
import { fillShell, PAGE_SHELL } from "./page-shell.ts";
import { parseQuery, serializeQuery, SITE_DEFAULT } from "./query.ts";
import { entryHtml } from "./render.ts";
import { DOCUMENTS, type CanonicalModel, type CanonicalModelDetail, type Correction, type CacheEvaluationRecord, type Documentation, type Facets, type LimitEvaluationRecord } from "./resources.ts";
import type { Meta } from "./schema.ts";

export interface PageDeps {
  /** Dispatch the same HTTP handler used by external API callers, pinned to one publication. */
  api(path: string): Promise<Response>;
  shell(): Promise<Response | null>;
  site: string;
  now(): Date;
}
interface View { title: string; description: string; html: string; canonical?: string }
class ApiError extends Error {
  status: number;
  constructor(status: number) { super(`API response ${status}`); this.status = status; }
}

export function isPage(path: string): boolean {
  return path === "/" || /^(\/providers|\/models|\/entries|\/entry|\/evidence|\/docs|\/support)(\/|$)/.test(path);
}

export async function handlePage(request: Request, deps: PageDeps): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  // The support document has one address, /support/, not /docs/support/.
  if (path === "/docs/support") return Response.redirect(new URL("/support/", url.origin).toString(), 301);
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
      const params = new URLSearchParams(url.search);
      if (!params.has("sort")) for (const [name, value] of new URLSearchParams(SITE_DEFAULT)) if (!params.has(name)) params.set(name, value);
      const parsed = parseQuery(params, true);
      if (!parsed.ok) throw new ApiError(400);
      const [result, facets] = await Promise.all([read<Envelope<Summary>>(`/api/v1/entries?${serializeQuery(parsed.query)}`), one<Facets>("/api/v1/facets")]);
      view = { title: "AI model catalog", description: "Context, output, pricing and prompt caching by model, provider and access method.", html: catalogHtml(result, parsed.query, facets, meta, url, today) };
    } else if (path === "/providers") {
      view = { title: "Providers", description: "Providers and access methods in the catalog.", html: providersHtml(await read<Envelope<ProviderSummary>>(`/api/v1/providers${url.search}`), url) };
    } else if (path.startsWith("/providers/")) {
      const { provider, entries } = await one<{ provider: ProviderSummary; entries: Summary[] }>(`/api/v1${path}`);
      view = { title: provider.name, description: `${provider.name}: ${provider.entry_count} model entries.`, html: providerHtml(provider, entries, imported, today) };
    } else if (path === "/models") {
      view = { title: "Models", description: "Canonical models and the providers that serve them.", html: modelsHtml(await read<Envelope<CanonicalModel>>(`/api/v1/models${url.search}`), url) };
    } else if (path.startsWith("/models/")) {
      if (!refFromPath(path.slice("/models/".length))) throw new ApiError(404);
      const [model, facets] = await Promise.all([one<CanonicalModelDetail>(`/api/v1${path}`), one<Facets>("/api/v1/facets")]);
      view = { title: model.name, description: `${model.name}: ${model.entry_count} entries across providers and access methods.`, html: modelHtml(model, Object.fromEntries(facets.providers.map((provider) => [provider.id, provider.name])), imported, today) };
    } else if (path.startsWith("/entries/")) {
      if (!refFromPath(path.slice("/entries/".length))) throw new ApiError(404);
      const { provider, summary, entry } = await one<{ provider: ProviderSummary; summary: Summary; entry: JsonObject }>(`/api/v1${path}`);
      const facts = [summary.context === null ? "" : `context window ${summary.context.toLocaleString("en-US")} tokens`, summary.max_output === null ? "" : `maximum output ${summary.max_output.toLocaleString("en-US")} tokens`].filter(Boolean);
      view = { title: `${summary.name} at ${provider.name}`, description: `${summary.name} at ${provider.name} (${summary.ref})${facts.length ? `: ${facts.join(", ")}` : ""}. Limits, prices and prompt caching, with sources.`, canonical: entryHref(summary.ref), html: entryHtml({ summary, provider, model: entry, imported, today, cache_ages_s: meta.cache_ages_s, pi: meta.pi }) };
    } else if (path === "/evidence") {
      const [corrections, added, cache, measured] = await Promise.all([
        read<Envelope<Correction>>(`/api/v1/corrections?offset=${encodeURIComponent(url.searchParams.get("corrections_offset") ?? "0")}`),
        all<ProviderSummary>("/api/v1/providers?origin=added"),
        read<Envelope<CacheEvaluationRecord>>(`/api/v1/evaluations/cache?offset=${encodeURIComponent(url.searchParams.get("cache_offset") ?? "0")}`),
        read<Envelope<LimitEvaluationRecord>>(`/api/v1/evaluations/limits?offset=${encodeURIComponent(url.searchParams.get("limits_offset") ?? "0")}`),
      ]);
      view = { title: "Evidence", description: "Corrections and evaluations with sources and dates.", html: evidenceHtml(meta, corrections, added, cache, measured, url, today) };
    } else if (path === "/docs/api") {
      view = { title: "API", description: "The providers.dev API: endpoints, parameters, response schemas and examples.", html: openapiHtml(await read<OpenApiDocument>("/api/v1/openapi.json")) };
    } else if (path === "/support" || (path.startsWith("/docs/") && (DOCUMENTS as readonly string[]).includes(path.slice("/docs/".length)))) {
      const document = await one<Documentation>(`/api/v1/docs/${path.split("/").at(-1)}`);
      view = { title: document.title, description: document.description, html: documentHtml(fillMetaSlots(document, meta)) };
    } else throw new ApiError(404);
  } catch (error) {
    status = error instanceof ApiError && (error.status === 400 || error.status === 404) ? error.status : 503;
    const title = status === 404 ? "Nothing at this address" : status === 400 ? "Invalid filters" : "The catalog is temporarily unavailable";
    view = { title, description: title, html: `<h1>${title}</h1><p class="lead mt-3">${status === 400 ? 'Use the <a href="/docs/api/">documented API parameters</a> for this view.' : status === 404 ? "This provider or model may no longer be listed." : "The API could not load a complete published snapshot. Try again shortly."}</p><p class="mt-6"><a class="button" href="/">Search the catalog</a></p>` };
  }
  const shell = await deps.shell();
  if (!shell) return new Response("Page template unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
  const nav = [["/", "Catalog"], ["/providers/", "Providers"], ["/models/", "Models"], ["/evidence/", "Evidence"], ["/docs/api/", "API"], ["/docs/methodology/", "Methodology"]];
  const html = fillShell(await shell.text(), {
    title: e(view.title), description: e(view.description), canonical: e(new URL(view.canonical ?? url.pathname, deps.site).toString()), html: view.html,
    nav: nav.map(([href, label]) => `<a href="${href}"${href === "/" ? path === "/" || path.startsWith("/entr") ? ' aria-current="page"' : "" : `${path}/`.startsWith(href!) || ((path === "/docs/licensing" || path === "/docs/contributing") && label === "Methodology") ? ' aria-current="page"' : ""}>${label}</a>`).join(""),
    dataset: meta ? `<li>Version <code>${e(meta.dataset_version)}</code></li><li>Published ${e(meta.generated_at.slice(0, 10))} ${e(meta.generated_at.slice(11, 16))} UTC</li><li>models.dev imported ${e(meta.upstream.fetched_at.slice(0, 10))}${meta.upstream.commit ? ` (<a href="https://github.com/anomalyco/models.dev/commit/${e(meta.upstream.commit)}"><code>${e(meta.upstream.commit.slice(0, 7))}</code></a>)` : ""}</li>${meta.sync.last_attempt_ok === false ? '<li class="stale">The last import failed. This is the last good snapshot.</li>' : ""}${meta.pi.snapshot ? `<li>pi's catalog fetched ${e(meta.pi.snapshot.fetched_at.slice(0, 10))}${meta.pi.snapshot.checked_at > meta.pi.snapshot.fetched_at ? `, last checked ${e(meta.pi.snapshot.checked_at.slice(0, 10))}` : ""}</li>` : ""}${meta.pi.sync.last_attempt_ok === false ? `<li class="stale">${meta.pi.snapshot ? "The last import of pi's catalog failed. Its data is the last good snapshot." : "The last import of pi's catalog failed. This dataset has no pi data."}</li>` : ""}` : '<li>Metadata unavailable</li>',
  });
  const etag = await representationTag(html);
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", ETag: etag, "Cache-Control": status === 200 ? "public, max-age=300, stale-while-revalidate=3600" : "no-store" });
  if (meta) { headers.set("X-Dataset-Version", meta.dataset_version); headers.set("X-Dataset-Generated-At", meta.generated_at); }
  if (status === 200 && etagMatches(request, etag)) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : html, { status, headers });
}

export { PAGE_SHELL };
