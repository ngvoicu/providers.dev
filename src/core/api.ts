// The read-only HTTP API, as one function of (request, published data). The Worker calls it with the
// built snapshot; the tests call it with the same files. It never fetches anything outside the snapshot.
//
// Resources: providers, entries (a model at a provider), models (canonical) and evaluations. Every collection
// answers `{ meta, total, limit, offset, next_offset, data }`; every single object `{ meta, data }`.
import type { Index, Summary } from "./entries.ts";
import { openapi } from "./openapi.ts";
import {
  DEFAULT_LIMIT,
  EVALUATION_PARAMS,
  MODEL_PARAMS,
  parseParams,
  parseQuery,
  PROVIDER_PARAMS,
  PROVIDER_VIEW_PARAMS,
  runQuery,
  utcToday,
  type ParamDoc,
} from "./query.ts";
import { canonicalModels, page, withoutEntries, type CanonicalModelDetail, type EvaluationRecord } from "./resources.ts";
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

  const etag = `"${meta.dataset_version}"`;
  const send = (body: BodyInit | null, tag: string = etag): Response => {
    const responseHeaders = apiHeaders(meta, { ETag: tag });
    if (etagMatches(request, tag)) return new Response(null, { status: 304, headers: responseHeaders });
    return new Response(request.method === "HEAD" ? null : body, { status: 200, headers: responseHeaders });
  };
  const sendJson = (value: unknown, tag?: string): Response => send(JSON.stringify(value), tag);
  const one = (data: unknown): Response => sendJson({ meta: brief(meta), data });
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

  if (path === `${BASE}/meta`) {
    const values = params([]);
    return values instanceof Response ? values : sendJson(meta);
  }
  if (path === `${BASE}/openapi.json`) {
    const values = params([]);
    return values instanceof Response ? values : sendJson(openapi());
  }
  if (path === `${BASE}/catalog`) {
    const values = params([]);
    return values instanceof Response ? values : sendFile("/data/catalog.json");
  }

  // ---- providers
  if (path === `${BASE}/providers`) {
    const values = params(PROVIDER_PARAMS);
    if (values instanceof Response) return values;
    const access = values.access as string[] | undefined;
    const origin = values.origin as string[] | undefined;
    const found = index.providers.filter((provider) => (!access || access.includes(provider.access)) && (!origin || origin.includes(provider.origin)));
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
    if (etagMatches(request, etag)) return send(null);
    const entries = index.entries.filter((entry) => entry.provider === id).sort((a, b) => a.name.localeCompare(b.name) || a.model.localeCompare(b.model));
    if (values.view !== "full") return one({ provider, entries });
    const asset = await deps.asset(`/data/providers/${id}.json`);
    if (!asset) return missing(`/data/providers/${id}.json`);
    const full = (await asset.json()) as { data: { models: Record<string, unknown> } };
    return one({ provider, entries, models: full.data.models });
  }

  // ---- entries: a model at a provider
  if (path === `${BASE}/entries`) {
    const parsed = parseQuery(url.searchParams, true);
    if (!parsed.ok) return fail(meta, 400, "invalid_parameters", "One or more query parameters are not valid.", parsed.errors);
    // An answer that counts back from today changes with the day, so the day is part of its ETag.
    const today = utcToday();
    const result = runQuery(index.entries, parsed.query, today);
    return sendJson({ meta: brief(meta), ...result }, parsed.query.max_age_months === undefined ? undefined : `"${meta.dataset_version}-${today}"`);
  }
  const entryPath = under("entries");
  if (entryPath !== null) {
    const ref = refFromPath(entryPath);
    if (!ref) return fail(meta, 400, "invalid_parameters", `Name the entry as ${BASE}/entries/{provider}/{model}. The model id may contain slashes.`);
    const values = params([]);
    if (values instanceof Response) return values;
    const summary = index.entries.find((entry) => entry.ref === ref);
    if (!summary) return fail(meta, 404, "entry_not_found", `No entry "${ref}". GET ${BASE}/entries?q=… searches them.`);
    if (etagMatches(request, etag)) return send(null);
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

  // ---- evaluations
  if (path === `${BASE}/evaluations`) {
    const values = params(EVALUATION_PARAMS);
    if (values instanceof Response) return values;
    if (etagMatches(request, etag)) return send(null);
    const asset = await deps.asset("/data/evaluations.json");
    if (!asset) return missing("/data/evaluations.json");
    const all = ((await asset.json()) as { data: EvaluationRecord[] }).data;
    const providers = values.provider as string[] | undefined;
    const clients = values.client as string[] | undefined;
    const found = all.filter(
      (item) =>
        (!values.kind || item.kind === values.kind) &&
        (!providers || providers.includes(item.entry_ref.slice(0, item.entry_ref.indexOf("/")))) &&
        (!values.entry || item.entry_ref === values.entry) &&
        (!values.retention_profile || (item.kind === "cache" && item.retention_profile === values.retention_profile)) &&
        (!clients || clients.includes(item.client)),
    );
    return sendJson({ meta: brief(meta), ...page(found, ...paging(values)) });
  }

  return fail(meta, 404, "not_found", `No such endpoint. GET ${BASE}/openapi.json describes the API.`);
}

export async function loadEntry(deps: Pick<ApiDeps, "asset">, summary: Summary): Promise<Record<string, unknown> | null> {
  const asset = await deps.asset(`/data/entries/${summary.provider}/${summary.shard}.json`);
  if (!asset) return null;
  const shard = (await asset.json()) as Record<string, Record<string, unknown>>;
  return shard[summary.model] ?? null;
}
