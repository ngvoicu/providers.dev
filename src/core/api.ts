// The read-only HTTP API, as one function of (request, published data). The Worker calls it with the
// built snapshot; the tests call it with the same files. It never fetches anything outside the snapshot.
import type { Index, Summary } from "./entries.ts";
import { openapi } from "./openapi.ts";
import { parseQuery, runQuery, utcToday } from "./query.ts";
import type { Meta } from "./schema.ts";

export interface ApiDeps {
  index: Index;
  meta: Meta;
  /** Reads a file of the published snapshot, for example `/data/providers/openai.json`. Null when missing. */
  asset(path: string): Promise<Response | null>;
}

const BASE = "/api/v1";

function headers(meta: Meta, extra: Record<string, string> = {}): Headers {
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
  return new Response(JSON.stringify(body), { status, headers: headers(meta, { "Cache-Control": "no-store", ...extra }) });
}

export function brief(meta: Meta): { dataset_version: string; generated_at: string; upstream_fetched_at: string } {
  return { dataset_version: meta.dataset_version, generated_at: meta.generated_at, upstream_fetched_at: meta.upstream.fetched_at };
}

function etagMatches(request: Request, etag: string): boolean {
  const header = request.headers.get("If-None-Match");
  if (!header) return false;
  return header.split(",").some((item) => {
    const value = item.trim();
    return value === "*" || value === etag || value === `W/${etag}`;
  });
}

export async function handleApi(request: Request, deps: ApiDeps): Promise<Response> {
  const { meta, index } = deps;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(meta, { "Access-Control-Max-Age": "86400" }) });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return fail(meta, 405, "method_not_allowed", "This API is read-only. Use GET.", undefined, { Allow: "GET, HEAD, OPTIONS" });
  }

  const etag = `"${meta.dataset_version}"`;
  const send = (body: BodyInit | null, tag: string = etag): Response => {
    const responseHeaders = headers(meta, { ETag: tag });
    if (etagMatches(request, tag)) return new Response(null, { status: 304, headers: responseHeaders });
    return new Response(request.method === "HEAD" ? null : body, { status: 200, headers: responseHeaders });
  };
  const sendJson = (value: unknown, tag?: string): Response => send(JSON.stringify(value), tag);
  const sendFile = async (file: string): Promise<Response> => {
    if (etagMatches(request, etag)) return send(null);
    const asset = await deps.asset(file);
    if (!asset) return fail(meta, 503, "snapshot_incomplete", `The published snapshot has no ${file}. Try again after the next publication.`);
    return send(asset.body);
  };
  const noParams = (): Response | null =>
    [...url.searchParams.keys()].length > 0 ? fail(meta, 400, "invalid_parameters", "This endpoint takes no query parameters.") : null;

  if (path === `${BASE}/meta`) return noParams() ?? sendJson(meta);
  if (path === `${BASE}/openapi.json`) return noParams() ?? sendJson(openapi());
  if (path === `${BASE}/catalog`) return noParams() ?? sendFile("/data/catalog.json");
  if (path === `${BASE}/providers`) return noParams() ?? sendFile("/data/providers.json");

  if (path.startsWith(`${BASE}/providers/`)) {
    let id: string;
    try {
      id = decodeURIComponent(path.slice(`${BASE}/providers/`.length));
    } catch {
      return fail(meta, 400, "invalid_parameters", "The provider id is not valid URL encoding.");
    }
    if (!index.providers.some((provider) => provider.id === id)) {
      return fail(meta, 404, "provider_not_found", `No provider "${id}". GET ${BASE}/providers lists them.`);
    }
    return noParams() ?? sendFile(`/data/providers/${id}.json`);
  }

  if (path === `${BASE}/models`) {
    const parsed = parseQuery(url.searchParams, true);
    if (!parsed.ok) return fail(meta, 400, "invalid_parameters", "One or more query parameters are not valid.", parsed.errors);
    // An answer that counts back from today changes with the day, so the day is part of its ETag.
    const today = utcToday();
    const result = runQuery(index.entries, parsed.query, today);
    return sendJson({ meta: brief(meta), ...result }, parsed.query.max_age_months === undefined ? undefined : `"${meta.dataset_version}-${today}"`);
  }

  if (path === `${BASE}/entry`) {
    const allowed = new Set(["ref", "provider", "model"]);
    const unknown = [...url.searchParams.keys()].filter((name) => !allowed.has(name));
    if (unknown.length > 0) return fail(meta, 400, "invalid_parameters", `Unknown parameters: ${unknown.join(", ")}. Use ref, or provider and model.`);
    const ref = url.searchParams.get("ref");
    const provider = url.searchParams.get("provider");
    const model = url.searchParams.get("model");
    const wanted = ref ?? (provider && model ? `${provider}/${model}` : null);
    if (!wanted || (ref && (provider || model))) {
      return fail(meta, 400, "invalid_parameters", "Give either ref=provider/model, or provider= and model=.");
    }
    const summary = index.entries.find((entry) => entry.ref === wanted);
    if (!summary) return fail(meta, 404, "entry_not_found", `No entry "${wanted}". GET ${BASE}/models?q=… searches them.`);
    if (etagMatches(request, etag)) return send(null);
    const full = await loadEntry(deps, summary);
    if (!full) return fail(meta, 503, "snapshot_incomplete", "The published snapshot is missing this entry's file. Try again after the next publication.");
    const info = index.providers.find((item) => item.id === summary.provider);
    return sendJson({ meta: brief(meta), data: { provider: info, summary, model: full } });
  }

  return fail(meta, 404, "not_found", `No such endpoint. GET ${BASE}/openapi.json describes the API.`);
}

export async function loadEntry(deps: Pick<ApiDeps, "asset">, summary: Summary): Promise<unknown | null> {
  const asset = await deps.asset(`/data/entries/${summary.provider}/${summary.shard}.json`);
  if (!asset) return null;
  const shard = (await asset.json()) as Record<string, unknown>;
  return shard[summary.model] ?? null;
}
