// The read-only HTTP API, as one function of (request, published data). The Worker calls it with the
// built snapshot; the tests call it with the same files. It never fetches anything outside the snapshot.
//
// Resources: providers, entries (a model at a provider), models (canonical), evaluations and listings (every model a
// provider offers, since 1.4.0). Every collection
// answers `{ meta, total, limit, offset, next_offset, data }`; every single object `{ meta, data }`.
import type { Index, Summary } from "./entries.ts";
import { API_VERSION, openapi } from "./openapi.ts";
import {
  DEFAULT_LIMIT,
  CORRECTION_PARAMS,
  CACHE_EVALUATION_PARAMS,
  LIMIT_EVALUATION_PARAMS,
  LISTING_PARAMS,
  MODEL_PARAMS,
  parseParams,
  parseQuery,
  PROVIDER_PARAMS,
  PROVIDER_VIEW_PARAMS,
  runQuery,
  utcToday,
  type ParamDoc,
} from "./query.ts";
import { canonicalModels, DOCUMENTS, facets, page, withoutEntries, type CanonicalModelDetail, type Correction, type Documentation, type EvaluationRecord } from "./resources.ts";
import type { Listing } from "./listings.ts";
import type { Meta } from "./schema.ts";

export interface ApiDeps {
  index: Index;
  meta: Meta;
  /** Reads a file of the published snapshot, for example `/data/providers/openai.json`. Null when missing. */
  asset(path: string): Promise<Response | null>;
}

export const BASE = "/api/v1";

export function apiHeaders(meta: Meta, extra: Record<string, string> = {}): Headers {
  return new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
    "Access-Control-Expose-Headers": "ETag, X-Dataset-Version, X-Dataset-Generated-At, X-Upstream-Fetched-At",
    "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
    "X-Content-Type-Options": "nosniff",
    "X-Dataset-Version": meta.dataset_version,
    "X-Dataset-Generated-At": meta.generated_at,
    "X-Upstream-Fetched-At": meta.upstream.fetched_at,
    ...extra,
  });
}

function fail(meta: Meta, status: number, code: string, message: string, details?: unknown, extra: Record<string, string> = {}): Response {
  const body = { error: { code, message, ...(details === undefined ? {} : { details }) } };
  return new Response(JSON.stringify(body), { status, headers: apiHeaders(meta, { "Cache-Control": "no-store", ...extra }) });
}

export function brief(meta: Meta): { dataset_version: string; generated_at: string; upstream_fetched_at: string } {
  return { dataset_version: meta.dataset_version, generated_at: meta.generated_at, upstream_fetched_at: meta.upstream.fetched_at };
}

export function etagMatches(request: Request, etag: string): boolean {
  const header = request.headers.get("If-None-Match");
  if (!header) return false;
  return header.split(",").some((item) => {
    const value = item.trim();
    return value === "*" || value === etag || value === `W/${etag}`;
  });
}

/** A validator for the actual representation, including metadata and contract/template changes. */
export async function representationTag(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `"${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
}

/**
 * A JSON body written piece by piece and never assembled: each part is a string, or a stream of bytes passed through
 * as it comes (a published file). The bytes are those of the one JSON text the parts make.
 */
export function streamedBody(parts: () => AsyncIterable<string | ReadableStream<Uint8Array>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let iterator: AsyncIterator<string | ReadableStream<Uint8Array>> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      iterator ??= parts()[Symbol.asyncIterator]();
      for (;;) {
        if (reader) {
          const chunk = await reader.read();
          if (!chunk.done) {
            controller.enqueue(chunk.value);
            return;
          }
          reader = null;
        }
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        if (typeof next.value === "string") {
          if (next.value.length > 0) {
            controller.enqueue(encoder.encode(next.value));
            return;
          }
        } else reader = next.value.getReader();
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason);
      await iterator?.return?.();
    },
  });
}

/** A JSON array of `items`, one item a part. */
export async function* jsonArray(items: readonly unknown[]): AsyncIterable<string> {
  yield "[";
  for (let i = 0; i < items.length; i += 1) yield `${i === 0 ? "" : ","}${JSON.stringify(items[i])}`;
  yield "]";
}

/** The canonical models of an index, worked out once per index. */
const modelsOf = new WeakMap<Index, CanonicalModelDetail[]>();
export function modelsFor(index: Index): CanonicalModelDetail[] {
  let models = modelsOf.get(index);
  if (!models) modelsOf.set(index, (models = canonicalModels(index.entries)));
  return models;
}

/** The entry a path names: the provider is the first segment, the model id is the rest, slashes and all. */
export function refFromPath(rest: string): string | null {
  try {
    const ref = rest.split("/").map(decodeURIComponent).join("/");
    return ref.includes("/") && !ref.startsWith("/") && !ref.endsWith("/") ? ref : null;
  } catch {
    return null;
  }
}

export async function handleApi(request: Request, deps: ApiDeps): Promise<Response> {
  const { meta, index } = deps;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: apiHeaders(meta, { "Access-Control-Max-Age": "86400" }) });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return fail(meta, 405, "method_not_allowed", "This API is read-only. Use GET.", undefined, { Allow: "GET, HEAD, OPTIONS" });
  }

  const etag = await representationTag(`${meta.dataset_version}:${meta.generated_at}:${path}`);
  const send = (body: BodyInit | null, tag: string = etag): Response => {
    const responseHeaders = apiHeaders(meta, { ETag: tag });
    if (etagMatches(request, tag)) return new Response(null, { status: 304, headers: responseHeaders });
    return new Response(request.method === "HEAD" ? null : body, { status: 200, headers: responseHeaders });
  };
  const sendJson = async (value: unknown): Promise<Response> => {
    const body = JSON.stringify(value);
    return send(body, await representationTag(body));
  };
  /**
   * A large answer, streamed and never assembled. Its validator is made of what decides its bytes: the version of the
   * API, the publication, the path and the query, so it is known before the body is.
   */
  const sendStreamed = async (parts: () => AsyncIterable<string | ReadableStream<Uint8Array>>): Promise<Response> => {
    const tag = await representationTag(`${API_VERSION}:${meta.dataset_version}:${meta.generated_at}:${path}?${url.searchParams.toString()}`);
    if (etagMatches(request, tag) || request.method === "HEAD") return send(null, tag);
    return send(streamedBody(parts), tag);
  };
  const one = (data: unknown): Promise<Response> => sendJson({ meta: brief(meta), data });
  const missing = (file: string): Response => fail(meta, 503, "snapshot_incomplete", `The published snapshot has no ${file}. Try again after the next publication.`);
  const sendFile = async (file: string): Promise<Response> => {
    if (etagMatches(request, etag)) return send(null);
    const asset = await deps.asset(file);
    return asset ? send(asset.body) : missing(file);
  };
  /** The validated parameters of this request, or the 400 that says what is wrong with them. */
  const params = (docs: readonly ParamDoc[]): Record<string, unknown> | Response => {
    const parsed = parseParams(url.searchParams, docs, true);
    return parsed.ok ? parsed.values : fail(meta, 400, "invalid_parameters", "One or more query parameters are not valid.", parsed.errors);
  };
  const paging = (values: Record<string, unknown>): [number, number] => [(values.limit as number | undefined) ?? DEFAULT_LIMIT, (values.offset as number | undefined) ?? 0];
  const under = (prefix: string): string | null => (path.startsWith(`${BASE}/${prefix}/`) ? path.slice(`${BASE}/${prefix}/`.length) : null);

  // The compatibility exports share headers and conditional/HEAD behaviour with the versioned API.
  if (path === "/api.json" || path === "/data/catalog.json") return sendFile(path);

  if (path === `${BASE}/meta`) {
    const values = params([]);
    return values instanceof Response ? values : one(meta);
  }
  if (path === `${BASE}/openapi.json`) {
    const values = params([]);
    return values instanceof Response ? values : sendJson(openapi());
  }
  if (path === `${BASE}/catalog`) {
    const values = params([]);
    return values instanceof Response ? values : sendFile("/data/catalog.json");
  }
  if (path === `${BASE}/facets`) {
    const values = params([]);
    return values instanceof Response ? values : one(facets(index));
  }
  if (path === `${BASE}/corrections`) {
    const values = params(CORRECTION_PARAMS);
    if (values instanceof Response) return values;
    const asset = await deps.asset("/data/corrections.json");
    if (!asset) return missing("/data/corrections.json");
    const all = ((await asset.json()) as { data: Correction[] }).data;
    const found = all.filter((item) => !values.provider || item.provider === values.provider);
    return sendJson({ meta: brief(meta), ...page(found, ...paging(values)) });
  }
  const document = under("docs");
  if (document !== null) {
    const values = params([]);
    if (values instanceof Response) return values;
    if (!(DOCUMENTS as readonly string[]).includes(document)) return fail(meta, 404, "not_found", "No such reference document.");
    const asset = await deps.asset(`/reference-content/docs/${document}.json`);
    if (!asset) return missing(`the ${document} document`);
    return one(await asset.json() as Documentation);
  }

  // ---- providers
  if (path === `${BASE}/providers`) {
    const values = params(PROVIDER_PARAMS);
    if (values instanceof Response) return values;
    const access = values.access as string[] | undefined;
    const origin = values.origin as string[] | undefined;
    const words = String(values.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const found = index.providers.filter((provider) => (!access || access.includes(provider.access)) && (!origin || origin.includes(provider.origin)) && words.every((word) => `${provider.id} ${provider.name}`.toLowerCase().includes(word)))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return sendJson({ meta: brief(meta), ...page(found, ...paging(values)) });
  }
  const providerId = under("providers");
  if (providerId !== null) {
    let id: string;
    try {
      id = decodeURIComponent(providerId);
    } catch {
      return fail(meta, 400, "invalid_parameters", "The provider id is not valid URL encoding.");
    }
    const provider = index.providers.find((item) => item.id === id);
    if (!provider) return fail(meta, 404, "provider_not_found", `No provider "${id}". GET ${BASE}/providers lists them.`);
    const values = params(PROVIDER_VIEW_PARAMS);
    if (values instanceof Response) return values;
    const entries = index.entries.filter((entry) => entry.provider === id).sort((a, b) => a.name.localeCompare(b.name) || a.model.localeCompare(b.model));
    // The same keys in both views: `models` is null until it is asked for. The full entries are the published file
    // of the provider's models, passed through as it is; the answer is streamed, never assembled.
    const asset = values.view === "full" ? await deps.asset(`/data/provider-models/${id}.json`) : null;
    if (values.view === "full" && !asset?.body) return missing(`/data/provider-models/${id}.json`);
    return sendStreamed(async function* () {
      yield `{"meta":${JSON.stringify(brief(meta))},"data":{"provider":${JSON.stringify(provider)},"entries":`;
      yield* jsonArray(entries);
      yield ',"models":';
      yield asset?.body ?? "null";
      yield "}}";
    });
  }

  // ---- listings: every model a provider offers, measured or not. Since 1.4.0.
  if (path === `${BASE}/listings`) {
    const values = params(LISTING_PARAMS);
    if (values instanceof Response) return values;
    const asset = await deps.asset("/data/listings.json");
    if (!asset) return missing("/data/listings.json");
    // Every listing with models: null. The same keys in both views: `models` is null until it is asked for.
    const all = ((await asset.json()) as { data: Listing[] }).data;
    const providers = values.provider as string[] | undefined;
    const bases = values.basis as string[] | undefined;
    const found = all.filter((item) => (!providers || providers.includes(item.provider)) && (!bases || bases.includes(item.basis)));
    const shown = page(found, ...paging(values));
    if (values.view !== "full") return sendJson({ meta: brief(meta), ...shown });
    // In full: the file of each listing of the page, and nothing more.
    const full = await Promise.all(shown.data.map((item) => loadListing(deps, item.provider)));
    if (full.some((item) => item === null)) return missing("a listing's file");
    return sendJson({ meta: brief(meta), ...shown, data: full });
  }
  const listingId = under("listings");
  if (listingId !== null) {
    let id: string;
    try {
      id = decodeURIComponent(listingId);
    } catch {
      return fail(meta, 400, "invalid_parameters", "The provider id is not valid URL encoding.");
    }
    const values = params([]);
    if (values instanceof Response) return values;
    const asset = await deps.asset("/data/listings.json");
    if (!asset) return missing("/data/listings.json");
    const known = ((await asset.json()) as { data: Listing[] }).data.some((item) => item.provider === id);
    const listing = known ? await loadListing(deps, id) : null;
    if (known && !listing) return missing("this listing's file");
    if (!listing) {
      const provider = index.providers.some((item) => item.id === id);
      return fail(meta, 404, "listing_not_found", provider ? `The provider "${id}" has no listing: no source has a model list for it.` : `No provider "${id}". GET ${BASE}/listings lists the listings.`);
    }
    return one(listing);
  }

  // ---- entries: a model at a provider
  if (path === `${BASE}/entries`) {
    const parsed = parseQuery(url.searchParams, true);
    if (!parsed.ok) return fail(meta, 400, "invalid_parameters", "One or more query parameters are not valid.", parsed.errors);
    // The representation hash changes when a date-relative result changes.
    const today = utcToday();
    const result = runQuery(index.entries, parsed.query, today);
    return sendJson({ meta: brief(meta), ...result });
  }
  const entryPath = under("entries");
  if (entryPath !== null) {
    const ref = refFromPath(entryPath);
    if (!ref) return fail(meta, 400, "invalid_parameters", `Name the entry as ${BASE}/entries/{provider}/{model}. The model id may contain slashes.`);
    const values = params([]);
    if (values instanceof Response) return values;
    const summary = index.entries.find((entry) => entry.ref === ref);
    if (!summary) return fail(meta, 404, "entry_not_found", `No entry "${ref}". GET ${BASE}/entries?q=… searches them.`);
    const entry = await loadEntry(deps, summary);
    if (!entry) return missing("this entry's file");
    return one({ provider: index.providers.find((item) => item.id === summary.provider), summary, entry });
  }

  // ---- models: canonical
  if (path === `${BASE}/models`) {
    const values = params(MODEL_PARAMS);
    if (values instanceof Response) return values;
    const words = String(values.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const found = modelsFor(index).filter((model) => (!values.lab || model.lab === values.lab) && words.every((word) => `${model.id} ${model.name}`.toLowerCase().includes(word)));
    return sendJson({ meta: brief(meta), ...page(found.map(withoutEntries), ...paging(values)) });
  }
  const modelPath = under("models");
  if (modelPath !== null) {
    const id = refFromPath(modelPath);
    if (!id) return fail(meta, 400, "invalid_parameters", `Name the model as ${BASE}/models/{lab}/{model}.`);
    const values = params([]);
    if (values instanceof Response) return values;
    const model = modelsFor(index).find((item) => item.id === id);
    if (!model) return fail(meta, 404, "model_not_found", `No canonical model "${id}". GET ${BASE}/models?q=… searches them.`);
    return one(model);
  }

  // ---- evaluations: two lists, since a cache evaluation and a limit evaluation are different records
  const kind = path === `${BASE}/evaluations/cache` ? "cache" : path === `${BASE}/evaluations/limits` ? "limit" : null;
  if (path === `${BASE}/evaluations`) return fail(meta, 404, "not_found", `Evaluations are listed by kind: GET ${BASE}/evaluations/cache and GET ${BASE}/evaluations/limits.`);
  if (kind) {
    const values = params(kind === "cache" ? CACHE_EVALUATION_PARAMS : LIMIT_EVALUATION_PARAMS);
    if (values instanceof Response) return values;
    const asset = await deps.asset("/data/evaluations.json");
    if (!asset) return missing("/data/evaluations.json");
    const all = ((await asset.json()) as { data: EvaluationRecord[] }).data;
    const providers = values.provider as string[] | undefined;
    const clients = values.client as string[] | undefined;
    const found = all.filter(
      (item) =>
        item.kind === kind &&
        (!providers || providers.includes(item.entry_ref.slice(0, item.entry_ref.indexOf("/")))) &&
        (!values.entry || item.entry_ref === values.entry) &&
        (!values.retention_profile || (item.kind === "cache" && item.retention_profile === values.retention_profile)) &&
        (!clients || clients.includes(item.client)),
    );
    return sendJson({ meta: brief(meta), ...page(found, ...paging(values)) });
  }

  return fail(meta, 404, "not_found", `No such endpoint. GET ${BASE}/openapi.json describes the API.`);
}

/** One listing in full, from its own file of the snapshot. Null when missing. */
export async function loadListing(deps: Pick<ApiDeps, "asset">, provider: string): Promise<Listing | null> {
  const asset = await deps.asset(`/data/listings/${encodeURIComponent(provider)}.json`);
  return asset ? ((await asset.json()) as { data: Listing }).data : null;
}

export async function loadEntry(deps: Pick<ApiDeps, "asset">, summary: Summary): Promise<Record<string, unknown> | null> {
  const asset = await deps.asset(`/data/entries/${summary.provider}/${summary.shard}.json`);
  if (!asset) return null;
  const shard = (await asset.json()) as Record<string, Record<string, unknown>>;
  return shard[summary.model] ?? null;
}
