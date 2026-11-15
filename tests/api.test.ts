import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { publish } from "../scripts/lib/publish.ts";
import { loadUpstream, sync } from "../scripts/lib/sync.ts";
import type { z } from "zod";
import { handleApi, modelsFor, type ApiDeps } from "../src/core/api.ts";
import { snapshotAsset } from "../src/core/assets.ts";
import {
  CanonicalModelDetailSchema,
  CanonicalModelSchema,
  EntryDetailSchema,
  EntrySummarySchema,
  CacheEvaluationRecordSchema,
  LimitEvaluationRecordSchema,
  MetaSchema,
  one,
  pageOf,
  ProviderDetailSchema,
  ProviderSchema,
  ProviderSummarySchema,
} from "../src/core/contract.ts";
import { summarize, type Summary } from "../src/core/entries.ts";
import { entryHref } from "../src/core/format.ts";
import { ENDPOINTS, openapi } from "../src/core/openapi.ts";
import { handlePage } from "../src/core/pages.ts";
import { MARK } from "../src/core/page-shell.ts";
import { CACHE_EVALUATION_PARAMS, LIMIT_EVALUATION_PARAMS, PARAMS, parseQuery, runQuery } from "../src/core/query.ts";
import { canonicalModels, listEvaluations, withoutEntries } from "../src/core/resources.ts";
import type { Catalog, ModelExtension } from "../src/core/schema.ts";
import { depsFrom, fetchReturning, fixtureUpstream, lifetimeRuleBreaks, ROOT, summaryOf, tempDataDir, writeAuthored } from "./helpers.ts";

let deps: ApiDeps;
let published: string;

beforeAll(async () => {
  const dataDir = tempDataDir();
  await sync({ dataDir, fetch: fetchReturning(JSON.stringify(fixtureUpstream())) });
  writeAuthored(dataDir);
  const report = publish({ dataDir, rootDir: ROOT });
  expect(report.errors).toEqual([]);
  published = join(dataDir, "published");
  deps = depsFrom(published);
});

const get = (path: string, init?: RequestInit): Promise<Response> => handleApi(new Request(`https://providers.dev${path}`, init), deps);
const json = async <T = Record<string, unknown>>(path: string): Promise<T> => (await get(path)).json() as Promise<T>;

interface Page {
  total: number;
  limit: number;
  offset: number;
  next_offset: number | null;
  data: Summary[];
}

describe("GET /api/v1/entries", () => {
  it("streams full exports from gzip assets with unchanged JSON and conditional headers", async () => {
    const compressedDeps = { ...deps, asset: (path: string) => snapshotAsset(path, async (file) => (await deps.asset(file)) ?? new Response(null, { status: 404 })) };
    for (const [url, file] of [["/api.json", "/api.json"], ["/api/v1/catalog", "/data/catalog.json"], ["/data/catalog.json", "/data/catalog.json"]]) {
      const response = await handleApi(new Request(`https://providers.dev${url}`), compressedDeps);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.text()).toBe(await (await deps.asset(file!))!.text());
      const etag = response.headers.get("etag")!;
      expect((await handleApi(new Request(`https://providers.dev${url}`, { headers: { "If-None-Match": etag } }), compressedDeps)).status).toBe(304);
      expect(await (await handleApi(new Request(`https://providers.dev${url}`, { method: "HEAD" }), compressedDeps)).text()).toBe("");
    }
    expect(await snapshotAsset("/api.json", async () => new Response(null, { status: 404 }))).toBeNull();
  });

  it("returns the same pricing and controls on entry, provider, model and catalog routes", async () => {
    const detail = one(EntryDetailSchema).parse(await json("/api/v1/entries/provider-02/lab/model-4"));
    const expected = detail.data.entry.providers_dev;
    const collection = pageOf(EntrySummarySchema).parse(await json("/api/v1/entries?provider=provider-02"));
    const provider = one(ProviderDetailSchema).parse(await json("/api/v1/providers/provider-02?view=full"));
    const model = one(CanonicalModelDetailSchema).parse(await json("/api/v1/models/lab/model-4"));
    const catalog = { providers: (await json<{ data: Catalog }>("/api/v1/catalog")).data };
    for (const summary of [detail.data.summary, collection.data.find((entry) => entry.ref === detail.data.summary.ref)!, provider.data.entries.find((entry) => entry.ref === detail.data.summary.ref)!, model.data.entries.find((entry) => entry.ref === detail.data.summary.ref)!]) {
      expect(summary.pricing).toEqual(expected.pricing);
      expect(summary.request_controls).toEqual(expected.request_controls);
    }
    expect(provider.data.models?.["lab/model-4"]?.providers_dev.pricing).toEqual(expected.pricing);
    expect(catalog.providers["provider-02"]!.models["lab/model-4"]!.providers_dev).toMatchObject({ pricing: expected.pricing, request_controls: expected.request_controls });
  });

  it("returns the same cache lifetime record on entry, provider, model and catalog routes", async () => {
    for (const ref of ["provider-02/lab/model-4", "provider-02/lab/model-2", "provider-03/model-1"]) {
      const detail = one(EntryDetailSchema).parse(await json(`/api/v1/entries/${ref}`));
      const expected = detail.data.entry.providers_dev.cache.lifetime;
      const { provider, model } = { provider: detail.data.summary.provider, model: detail.data.summary.model };
      const collection = pageOf(EntrySummarySchema).parse(await json(`/api/v1/entries?provider=${provider}&limit=200`));
      const full = one(ProviderDetailSchema).parse(await json(`/api/v1/providers/${provider}?view=full`));
      const canonical = one(CanonicalModelDetailSchema).parse(await json(`/api/v1/models/${detail.data.summary.canonical_id}`));
      const catalog = (await json<{ data: Catalog }>("/api/v1/catalog")).data;
      for (const summary of [detail.data.summary, collection.data.find((entry) => entry.ref === ref)!, full.data.entries.find((entry) => entry.ref === ref)!, canonical.data.entries.find((entry) => entry.ref === ref)!]) {
        expect(summary.cache_lifetime, ref).toEqual(expected);
      }
      expect(full.data.models?.[model]?.providers_dev.cache.lifetime).toEqual(expected);
      expect((catalog[provider]!.models[model]!.providers_dev as unknown as ModelExtension).cache.lifetime).toEqual(expected);
    }
    // The fixture's three kinds: lifetimes documented (5m, 1h), documented as not caching, caching without a lifetime.
    const lifetimes = (ref: string) => deps.index.entries.find((entry) => entry.ref === ref)!.cache_lifetime;
    expect([lifetimes("provider-02/lab/model-4").short.safe_s, lifetimes("provider-02/lab/model-4").long.safe_s]).toEqual([300, 3600]);
    expect([lifetimes("provider-02/lab/model-2").short.safe_s, lifetimes("provider-02/lab/model-2").short.basis]).toEqual([0, "documented"]);
    expect([lifetimes("provider-03/model-1").short.safe_s, lifetimes("provider-03/model-1").short.basis]).toEqual([null, "none"]);
  });

  it("adds cache_lifetime to a summary and leaves every other key as it was", () => {
    expect(Object.keys(deps.index.entries[0]!)).toEqual([
      "ref", "provider", "model", "name", "type", "family", "canonical_id", "status", "release_date", "access", "origin", "context", "input", "max_output",
      "cache", "cache_modes", "cache_mode_support", "cache_ttl_s", "cache_ttl_by_mode_s", "cache_retention", "cache_lifetime", "evaluation_count", "cache_results",
      "price_in", "price_out", "price_from", "pricing", "request_controls", "measured_input_accepted", "measured_input_refused", "measured_limit_count", "overridden_fields", "verified", "shard",
    ]);
    // No other key of a summary depends on the lifetime record.
    const exported = JSON.parse(readFileSync(join(published, "site", "api.json"), "utf8")) as Catalog;
    for (const entry of deps.index.entries) {
      const model = structuredClone(exported[entry.provider]!.models[entry.model]!);
      delete (model.providers_dev as unknown as { cache: Partial<ModelExtension["cache"]> }).cache.lifetime;
      const { cache_lifetime: _without, ...rest } = summarize(entry.provider, model, entry.shard);
      const { cache_lifetime: _with, ...published } = entry;
      expect(rest).toEqual(published);
    }
  });

  it("pages through every entry once, in a fixed order", async () => {
    const seen: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page: Page = await json<Page>(`/api/v1/entries?limit=200&offset=${offset}`);
      expect(page.total).toBe(601);
      seen.push(...page.data.map((entry) => entry.ref));
      offset = page.next_offset;
    }
    expect(seen).toHaveLength(601);
    expect(new Set(seen).size).toBe(601);
    expect(seen).toEqual([...seen].sort((a, b) => (a < b ? -1 : 1)));
    const again = await json<Page>("/api/v1/entries?limit=200");
    expect(again.data.map((entry) => entry.ref)).toEqual(seen.slice(0, 200));
  });

  it("defaults to 50 and refuses more than 200", async () => {
    expect((await json<Page>("/api/v1/entries")).data).toHaveLength(50);
    expect((await get("/api/v1/entries?limit=201")).status).toBe(400);
    expect((await get("/api/v1/entries?limit=0")).status).toBe(400);
  });

  it("keeps only the models released in the last N months", async () => {
    const { monthsBefore } = await import("../src/core/query.ts");
    expect(monthsBefore("2026-11-13", 6)).toBe("2026-05-13");
    expect(monthsBefore("2026-01-13", 3)).toBe("2025-10-13");
    expect(monthsBefore("2026-05-31", 3)).toBe("2026-02-28");
    expect(monthsBefore("2026-11-13", 24)).toBe("2024-11-13");

    const entry = (ref: string, release_date: string | null = null) => summaryOf({ ref, provider: "p", model: ref, release_date });
    const entries = [entry("old", "2026-05-12"), entry("edge", "2026-05-13"), entry("new", "2026-10-01"), entry("month", "2026-05"), entry("old-month", "2026-04"), entry("undated")];
    const run = (months: string) => {
      const parsed = parseQuery(new URLSearchParams(`max_age_months=${months}`));
      if (!parsed.ok) throw new Error("not a valid query");
      return runQuery(entries, parsed.query, "2026-11-13").data.map((item) => item.ref);
    };
    // Six months back from 13 November is 13 May. A date known only to the month counts when the month is in range. No date, no match.
    expect(run("6")).toEqual(["edge", "month", "new"]);
    expect(run("1")).toEqual([]);
    expect(run("600")).toEqual(["edge", "month", "new", "old", "old-month"]);

    expect((await get("/api/v1/entries?max_age_months=0")).status).toBe(400);
    expect((await get("/api/v1/entries?max_age_months=601")).status).toBe(400);
    // Every entry of the fixture has a date except the added one, which takes its date from the entry it names.
    const all = await get("/api/v1/entries?max_age_months=600&limit=1");
    expect(((await all.json()) as Page).total).toBe(601);
    // Validators cover the actual representation, including date-relative results.
    expect(all.headers.get("ETag")).toMatch(/^"[0-9a-f]{64}"$/);
    expect((await get("/api/v1/entries?limit=1")).headers.get("ETag")).toMatch(/^"[0-9a-f]+"$/);
    expect((await get("/api/v1/entries?max_age_months=600&limit=1", { headers: { "If-None-Match": all.headers.get("ETag") ?? "" } })).status).toBe(304);
  });

  it("filters by provider, access, origin and type", async () => {
    const byProvider = await json<Page>("/api/v1/entries?provider=provider-03,provider-04&limit=200");
    expect(byProvider.total).toBe(40);
    expect(new Set(byProvider.data.map((entry) => entry.provider))).toEqual(new Set(["provider-03", "provider-04"]));
    const subscription = await json<Page>("/api/v1/entries?access=subscription");
    expect(subscription.data.map((entry) => entry.ref)).toEqual(["added-login/lab/model-2"]);
    expect((await json<Page>("/api/v1/entries?origin=added")).total).toBe(1);
    expect((await json<Page>("/api/v1/entries?origin=modified")).data.map((entry) => entry.ref)).toEqual(["provider-01/model-1"]);
    expect((await json<Page>("/api/v1/entries?type=embedding")).total).toBe(30);
  });

  it("treats min_context and min_output as lower bounds and leaves out unknown values", async () => {
    const context = await json<Page>("/api/v1/entries?min_context=1900000&limit=200");
    expect(context.data.every((entry) => (entry.context ?? 0) >= 1900000)).toBe(true);
    // 30 x model-18 and model-19 (1.9M and 2M), plus the overridden provider-01/model-1 (5M).
    expect(context.total).toBe(61);
    const zero = await json<Page>("/api/v1/entries?min_context=0&limit=1");
    // model-7 has no limit at all: unknown is not zero.
    expect(zero.total).toBe(601 - 30);
    const output = await json<Page>("/api/v1/entries?min_output=0&provider=provider-00&limit=200");
    expect(output.data.some((entry) => entry.max_output === 0)).toBe(true);
    expect(output.total).toBe(19);
  });

  it("tells unsupported caching from unknown caching", async () => {
    const page = (cache: string) => json<Page>(`/api/v1/entries?provider=provider-00&cache=${cache}`);
    expect((await page("yes")).total).toBe(10);
    expect((await page("no")).total).toBe(5);
    expect((await page("unknown")).total).toBe(5);
    const explicit = await json<Page>("/api/v1/entries?provider=provider-00&cache_mode=explicit");
    expect(explicit.total).toBe(5);
    expect(explicit.data[0]?.cache_ttl_s).toEqual([300, 3600]);
  });

  it("searches across ids and names, every word required", async () => {
    expect((await json<Page>("/api/v1/entries?q=provider-05%20model-18")).data.map((entry) => entry.ref)).toEqual(["provider-05/lab/model-18"]);
    expect((await json<Page>("/api/v1/entries?q=nothing-like-this")).total).toBe(0);
    expect((await json<Page>("/api/v1/entries?canonical_id=lab/model-3")).total).toBe(30);
  });

  it("sorts numbers numerically, with unknown last in both directions", async () => {
    const descending = await json<Page>("/api/v1/entries?provider=provider-00&sort=context&order=desc&limit=200");
    const values = descending.data.map((entry) => entry.context);
    expect(values[0]).toBe(2000000);
    expect(values.at(-1)).toBeNull();
    const ascending = await json<Page>("/api/v1/entries?provider=provider-00&sort=context&order=asc&limit=200");
    expect(ascending.data[0]?.context).toBe(100000);
    expect(ascending.data.at(-1)?.context).toBeNull();
  });

  it("rejects unknown and malformed parameters with details", async () => {
    const response = await get("/api/v1/entries?acess=api&min_context=big&cache=maybe&provider=a&provider=b");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; details: { param: string }[] } };
    expect(body.error.code).toBe("invalid_parameters");
    expect(body.error.details.map((detail) => detail.param).sort()).toEqual(["acess", "cache", "min_context", "provider"]);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("lookups", () => {
  it("finds an entry by its path, also where the model id has a slash", async () => {
    const found = await json<{ data: { provider: { id: string }; summary: Summary; entry: { id: string } } }>("/api/v1/entries/provider-02/lab/model-4");
    expect(found.data.entry.id).toBe("lab/model-4");
    expect(found.data.summary.ref).toBe("provider-02/lab/model-4");
    expect(found.data.provider.id).toBe("provider-02");
    const encoded = await json<typeof found>(`/api/v1/entries/provider-02/${encodeURIComponent("lab")}/${encodeURIComponent("model-4")}`);
    expect(encoded.data.entry).toEqual(found.data.entry);
  });

  it("answers 404 and 400 with one error shape", async () => {
    for (const [path, status, code] of [
      ["/api/v1/entries/provider-02/nope", 404, "entry_not_found"],
      ["/api/v1/entries/provider-02", 400, "invalid_parameters"],
      ["/api/v1/entries/provider-02/lab/model-4?x=1", 400, "invalid_parameters"],
      ["/api/v1/providers/nope", 404, "provider_not_found"],
      ["/api/v1/providers/provider-01?view=everything", 400, "invalid_parameters"],
      ["/api/v1/models/lab/nope", 404, "model_not_found"],
      ["/api/v1/evaluations/cache?retention_profile=other", 400, "invalid_parameters"],
      // One kind per list: the filters of the other kind are not parameters here, and there is no list of both.
      ["/api/v1/evaluations/limits?retention_profile=long", 400, "invalid_parameters"],
      ["/api/v1/evaluations/cache?kind=cache", 400, "invalid_parameters"],
      ["/api/v1/evaluations", 404, "not_found"],
      ["/api/v1/nope", 404, "not_found"],
      ["/api/v1/entry?ref=provider-02/lab/model-4", 404, "not_found"],
      ["/api/v1/meta?x=1", 400, "invalid_parameters"],
    ] as const) {
      const response = await get(path);
      expect(response.status, path).toBe(status);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code, path).toBe(code);
      expect(body.error.message.length).toBeGreaterThan(10);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
  });

  it("serves a provider with its entries, and in full on request", async () => {
    const provider = await json<{ data: { provider: { id: string; entry_count: number; env: string[] }; entries: Summary[]; models: Record<string, unknown> | null } }>("/api/v1/providers/provider-01");
    expect(provider.data.provider.id).toBe("provider-01");
    expect(provider.data.provider.entry_count).toBe(20);
    expect(provider.data.entries).toHaveLength(20);
    // The answer has the same keys whatever the view: `models` is null until it is asked for.
    expect(Object.keys(provider.data)).toEqual(["provider", "entries", "models"]);
    expect(provider.data.models).toBeNull();
    const full = await json<typeof provider>("/api/v1/providers/provider-01?view=full");
    expect(Object.keys(full.data)).toEqual(Object.keys(provider.data));
    expect(Object.keys(full.data.models ?? {})).toHaveLength(20);
    expect(full.data.entries).toEqual(provider.data.entries);
  });

  it("lists providers, canonical models and evaluations in the same envelope", async () => {
    const providers = await json<Page & { data: unknown[] }>("/api/v1/providers?limit=200");
    expect(providers.total).toBe(31);
    expect((await json<Page>("/api/v1/providers?access=subscription")).total).toBe(1);
    expect((await json<Page>("/api/v1/providers")).next_offset).toBeNull();
    expect((await json<Page>("/api/v1/providers?limit=10")).next_offset).toBe(10);

    // Twenty canonical models, each served by thirty providers; lab/model-2 also by the added login.
    const models = await json<{ total: number; data: { id: string; entry_count: number; subscription_entry_count: number; context_min: number | null; context_max: number | null }[] }>("/api/v1/models?limit=200");
    expect(models.total).toBe(20);
    expect(models.data[0]).toMatchObject({ id: "lab/model-2", entry_count: 31, subscription_entry_count: 1, context_min: 300000, context_max: 900000 });
    expect(models.data.find((model) => model.id === "lab/model-7")).toMatchObject({ context_min: null, context_max: null });
    expect((await json<Page>("/api/v1/models?q=model-19")).total).toBe(1);
    const model = await json<{ data: { id: string; reference_ref: string | null; entries: Summary[] } }>("/api/v1/models/lab/model-2");
    expect(model.data.entries).toHaveLength(31);
    // No provider is called "lab", so there is no reference entry; the subscription comes first.
    expect(model.data.reference_ref).toBeNull();
    expect(model.data.entries[0]?.ref).toBe("added-login/lab/model-2");

    for (const list of ["cache", "limits"]) expect(await json<Page>(`/api/v1/evaluations/${list}`)).toMatchObject({ total: 0, limit: 50, offset: 0, next_offset: null, data: [] });
  });

  it("serves the catalog and the metadata", async () => {
    // Both answer as every single object does: { meta, data }.
    const catalog = await json<{ meta: { dataset_version: string }; data: Catalog }>("/api/v1/catalog");
    expect(Object.keys(catalog)).toEqual(["meta", "data"]);
    expect(Object.keys(catalog.data)).toHaveLength(31);
    const answer = await json<{ meta: { dataset_version: string }; data: { dataset_version: string; counts: { entries: number; models: number }; cache_ages_s: number[]; upstream: { commit: string } } }>("/api/v1/meta");
    expect(Object.keys(answer)).toEqual(["meta", "data"]);
    expect(answer.meta).toEqual(catalog.meta);
    const meta = answer.data;
    expect(meta.dataset_version).toBe(catalog.meta.dataset_version);
    expect(meta.counts.entries).toBe(601);
    expect(meta.counts.models).toBe(20);
    expect(meta.cache_ages_s.slice(0, 4)).toEqual([150, 300, 450, 600]);
    expect(meta.upstream.commit).toBe("abc123");
  });
});

describe("HTTP behaviour", () => {
  it("answers 304 to a matching If-None-Match and sends freshness headers", async () => {
    const first = await get("/api/v1/entries");
    const etag = first.headers.get("ETag")!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(first.headers.get("X-Dataset-Version")).toBe(deps.meta.dataset_version);
    expect(first.headers.get("Cache-Control")).toContain("max-age=300");
    for (const path of ["/api/v1/entries", "/api/v1/catalog", "/api/v1/entries/provider-02/lab/model-4", "/api/v1/providers/provider-01", "/api/v1/models", "/api/v1/evaluations/cache", "/api/v1/evaluations/limits", "/api/v1/meta"]) {
      const tag = (await get(path)).headers.get("ETag");
      const second = await get(path, { headers: { "If-None-Match": `W/${tag}, "other"` } });
      expect(second.status, path).toBe(304);
      expect(await second.text()).toBe("");
    }
    expect((await get("/api/v1/entries", { headers: { "If-None-Match": '"stale"' } })).status).toBe(200);
  });

  it("is read-only and open to any origin", async () => {
    const post = await get("/api/v1/entries", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    const preflight = await get("/api/v1/entries", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const head = await get("/api/v1/meta", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("describes every endpoint and parameter in the OpenAPI document", async () => {
    const document = await json<{ paths: Record<string, { get: { parameters?: { name: string; in: string }[] } }>; components: { schemas: Record<string, unknown> } }>("/api/v1/openapi.json");
    expect(document).toEqual(JSON.parse(JSON.stringify(openapi())));
    expect(Object.keys(document.paths).sort()).toEqual([...ENDPOINTS.map((endpoint) => endpoint.path), "/api.json"].sort());
    const query = (path: string): string[] => document.paths[path]!.get.parameters!.filter((parameter) => parameter.in === "query").map((parameter) => parameter.name);
    expect(query("/api/v1/entries")).toEqual(PARAMS.map((param) => param.name));
    expect(query("/api/v1/evaluations/cache")).toEqual(CACHE_EVALUATION_PARAMS.map((param) => param.name));
    expect(query("/api/v1/evaluations/limits")).toEqual(LIMIT_EVALUATION_PARAMS.map((param) => param.name));
    // No reference in the document points at nothing.
    const text = JSON.stringify(document);
    for (const [, path] of text.matchAll(/"\$ref":"#\/([^"]+)"/g)) {
      const target = path!.split("/").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], document);
      expect(target, path).toBeDefined();
    }
    expect(text).not.toContain("#/$defs/");
    const example: Record<string, string> = {
      "/api/v1/docs/{document}": "/api/v1/docs/methodology",
      "/api/v1/entries/{provider}/{model}": "/api/v1/entries/provider-02/model-1",
      "/api/v1/providers/{provider}": "/api/v1/providers/provider-02",
      "/api/v1/models/{lab}/{model}": "/api/v1/models/lab/model-1",
    };
    for (const path of Object.keys(document.paths).filter((item) => item.startsWith("/api/v1/"))) {
      const response = await get(example[path] ?? path);
      expect(response.status, path).toBe(200);
    }
  });

  it("describes the cache lifetime record: its components and a guide section", async () => {
    const document = await json<{ info: { version: string }; "x-guide": { id: string; title: string; paragraphs: string[] }[]; components: { schemas: Record<string, { properties?: Record<string, unknown> }> } }>("/api/v1/openapi.json");
    expect(document.info.version).toBe("1.3.0");
    const schemas = document.components.schemas;
    expect(Object.keys(schemas.CacheLifetime!.properties!)).toEqual(["short", "long", "lifetimes"]);
    expect(Object.keys(schemas.SafeLifetime!.properties!)).toEqual(["safe_s", "basis", "source", "date", "documented_s", "measured_s", "clients", "evaluations", "checks", "hits", "checks_inside", "hits_inside", "tested_from_s", "first_miss_s"]);
    expect(Object.keys(schemas.CacheLifetimeItem!.properties!)).toEqual([
      "retention_profile", "basis", "source", "date", "lifetime_s", "mode", "documented_as", "client", "client_label", "parameter", "value", "evaluations", "evaluation_ids", "checks", "hits", "tested_from_s", "first_miss_s", "results",
    ]);
    expect(Object.keys(schemas.EntryCache!.properties!)).toContain("lifetime");
    expect(Object.keys(schemas.EntrySummary!.properties!)).toContain("cache_lifetime");
    const section = document["x-guide"].find((item) => item.id === "cache-lifetimes");
    expect(section?.title).toBe("Cache lifetimes");
    const text = section!.paragraphs.join(" ");
    for (const words of ["lifetimes", "safe_s", "documented_s", "measured_s", "fewer than half", "hits_inside of checks_inside", "lowest over the clients", "null", "not a guarantee"]) expect(text).toContain(words);
  });
});

describe("the contract", () => {
  /** Every answer of the API is checked against the definition the OpenAPI document is generated from. */
  const holds = async (dir: string): Promise<void> => {
    const local = depsFrom(dir);
    const ask = async (path: string): Promise<unknown> => (await handleApi(new Request(`https://providers.dev${path}`), local)).json();
    const valid = (schema: z.ZodType, value: unknown, what: string): void => {
      const result = schema.safeParse(value);
      expect(result.success ? [] : result.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`), what).toEqual([]);
    };
    valid(one(MetaSchema), await ask("/api/v1/meta"), "meta");
    for (const entry of local.index.entries) valid(EntrySummarySchema, entry, entry.ref);
    for (const provider of local.index.providers) valid(ProviderSummarySchema, provider, provider.id);
    valid(pageOf(EntrySummarySchema), await ask("/api/v1/entries?limit=200"), "entries");
    valid(pageOf(ProviderSummarySchema), await ask("/api/v1/providers?limit=200"), "providers");
    valid(pageOf(CanonicalModelSchema), await ask("/api/v1/models?limit=200"), "models");
    valid(pageOf(CacheEvaluationRecordSchema), await ask("/api/v1/evaluations/cache?limit=200"), "cache evaluations");
    valid(pageOf(LimitEvaluationRecordSchema), await ask("/api/v1/evaluations/limits?limit=200"), "limit evaluations");
    const model = modelsFor(local.index)[0]!;
    valid(one(CanonicalModelDetailSchema), await ask(`/api/v1/models/${model.id}`), model.id);
    // Every entry in full, straight from the export: thousands of them, so no request each.
    const exported = JSON.parse(readFileSync(join(dir, "site", "api.json"), "utf8")) as Catalog;
    for (const [id, provider] of Object.entries(exported)) valid(ProviderSchema, provider, id);
    // The entries that carry the most: one with evaluations where there is one, and the first.
    const picks = [local.index.entries.find((entry) => entry.evaluation_count > 0), local.index.entries.find((entry) => entry.measured_limit_count > 0), local.index.entries[0]].filter((entry) => entry !== undefined);
    for (const entry of picks) {
      valid(one(EntryDetailSchema), await ask(`/api/v1${entryHref(entry.ref)}`), entry.ref);
      valid(one(ProviderDetailSchema), await ask(`/api/v1/providers/${entry.provider}?view=full`), entry.provider);
      valid(one(ProviderDetailSchema), await ask(`/api/v1/providers/${entry.provider}`), entry.provider);
    }

    // One structure. Everything providers.dev publishes of its own has the same keys on every object of its kind:
    // what is not known is null, what is empty is an empty list, and nothing is left out.
    const shapes = (items: readonly object[]): string[] => [...new Set(items.map((item) => Object.keys(item).sort().join(",")))];
    const same = (items: readonly object[], what: string): void => expect(shapes(items).length, `${what}: ${shapes(items).slice(0, 2).join(" | ")}`).toBeLessThanOrEqual(1);
    same(local.index.entries, "entry summaries");
    // The summaries also list their keys in one order.
    expect(new Set(local.index.entries.map((entry) => Object.keys(entry).join(","))).size).toBe(1);
    same(local.index.providers, "provider summaries");
    same(local.index.providers.map((provider) => provider.providers_dev), "providers_dev of a provider");
    const extensions = Object.values(exported).flatMap((provider) => Object.values(provider.models).map((entry) => entry.providers_dev as unknown as ModelExtension));
    same(extensions, "providers_dev of an entry");
    same(extensions.map((extension) => extension.limits), "limits");
    same(extensions.map((extension) => extension.cache), "cache");
    same(extensions.map((extension) => extension.cache.retention), "cache.retention");
    same(extensions.map((extension) => extension.cache.lifetime), "cache.lifetime");
    same(extensions.flatMap((extension) => [extension.cache.lifetime.short, extension.cache.lifetime.long]), "cache.lifetime.short and long");
    same(extensions.flatMap((extension) => extension.cache.lifetime.lifetimes), "cache.lifetime.lifetimes");
    same(extensions.map((extension) => extension.pricing), "pricing");
    same(extensions.flatMap((extension) => extension.pricing.rules ?? []), "pricing rules");
    same(extensions.flatMap((extension) => extension.request_controls.items), "request controls");
    same(extensions.flatMap((extension) => extension.cache.evaluations), "cache evaluations");
    same(extensions.flatMap((extension) => extension.cache.evaluations.flatMap((evaluation) => evaluation.results)), "cache results");
    same(extensions.flatMap((extension) => extension.cache.results ?? []), "cache summary lines");
    same(extensions.flatMap((extension) => extension.limits.measured), "limit evaluations");
    same(extensions.flatMap((extension) => extension.provenance), "corrections");
    same(extensions.flatMap((extension) => [...extension.evidence, ...extension.provenance.flatMap((change) => change.evidence)]), "evidence");
    for (const list of ["cache", "limits"]) same(((await ask(`/api/v1/evaluations/${list}?limit=200`)) as { data: object[] }).data, `the list of ${list} evaluations`);
    same(modelsFor(local.index).map(withoutEntries), "canonical models");

    // The cache lifetime record of every entry keeps the rules of section 2.6 of design/safe-cache-lifetime.md, and its
    // safe value is the documented lifetime exactly where no counted evaluation contradicts it, redone from evaluations[].
    const broken = Object.entries(exported).flatMap(([id, provider]) =>
      Object.entries(provider.models).flatMap(([modelId, entry]) => {
        const cache = (entry.providers_dev as unknown as ModelExtension).cache;
        return lifetimeRuleBreaks(cache.lifetime, cache.evaluations, cache.documented).map((rule) => `${id}/${modelId}: ${rule}`);
      }),
    );
    expect(broken).toEqual([]);

    // The models.dev part of an entry nobody corrected is the import, unchanged.
    const upstream = loadUpstream(join(dir, ".."))!.catalog;
    const changed: string[] = [];
    let compared = 0;
    for (const [id, provider] of Object.entries(exported)) {
      for (const [modelId, entry] of Object.entries(provider.models)) {
        const extension = entry.providers_dev as unknown as ModelExtension;
        if (extension.origin !== "upstream" || extension.provenance.length > 0) continue;
        const { providers_dev: _ours, ...imported } = entry;
        compared += 1;
        if (!isDeepStrictEqual(imported, upstream[id]?.models[modelId])) changed.push(`${id}/${modelId}`);
      }
    }
    expect(compared).toBeGreaterThan(0);
    expect(changed).toEqual([]);
  };

  it("holds for every answer of the fixture", async () => {
    await holds(published);
  });

  const real = join(ROOT, "data", "published");
  it.skipIf(!existsSync(join(real, "site", "api.json")))("holds for every answer of the real published snapshot", async () => {
    await holds(real);
  }, 120_000);
});

describe("entry pages", () => {
  const shell = `<html><head><title>${MARK.title} · providers.dev</title><meta name="description" content="${MARK.description}"><link rel="canonical" href="${MARK.canonical}"></head><body><div id="entry">${MARK.html}</div></body></html>`;
  const page = (path: string, init?: RequestInit, pageShell = shell, index = deps.index): Promise<Response> =>
    handlePage(new Request(`https://providers.dev${path}`, init), {
      api: (path) => handleApi(new Request(`https://providers.dev${path}`), { ...deps, index }),
      site: "https://providers.dev",
      now: () => new Date("2026-11-13T12:00:00Z"),
      shell: async () => new Response(pageShell),
    });

  it("gives every entry its own page, title, description and canonical address", async () => {
    const response = await page("/entries/provider-02/lab/model-4");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("<title>Model 4 at Provider 2 · providers.dev</title>");
    expect(html).toContain('<link rel="canonical" href="https://providers.dev/entries/provider-02/lab/model-4">');
    expect(html).toContain("context window 500,000 tokens");
    expect(html).toContain("<h1>Model 4</h1>");
    expect(html).not.toContain("%%PAGE");
    // The page is the API's entry, drawn: the address of the same entry in the API is on it.
    expect(html).toContain("/api/v1/entries/provider-02/lab/model-4");
    const again = await page("/entries/provider-02/lab/model-4", { headers: { "If-None-Match": response.headers.get("ETag") ?? "" } });
    expect(again.status).toBe(304);
  });

  it("answers 404 for an entry that does not exist and sends the old address on", async () => {
    expect((await page("/entries/provider-02/nope")).status).toBe(404);
    expect((await page("/entries/provider-02")).status).toBe(404);
    const old = await page(`/entry/?ref=${encodeURIComponent("provider-02/lab/model-4")}`);
    expect(old.status).toBe(301);
    expect(old.headers.get("Location")).toBe("https://providers.dev/entries/provider-02/lab/model-4");
    expect((await page("/entry/")).status).toBe(404);
    expect((await page("/entries/provider-02/lab/model-4", { method: "POST" })).status).toBe(405);
  });

  it("invalidates cached HTML when the shell or rendered content changes without a dataset change", async () => {
    const path = "/entries/provider-02/lab/model-4";
    const first = await page(path);
    const tag = first.headers.get("ETag")!;
    const changedShell = shell.replace("</head>", '<link rel="stylesheet" href="/new-build.css"></head>');
    const rebuilt = await page(path, { headers: { "If-None-Match": tag } }, changedShell);
    expect(rebuilt.status).toBe(200);
    expect(rebuilt.headers.get("ETag")).not.toBe(tag);
    expect(await rebuilt.text()).toContain("/new-build.css");
    const index = structuredClone(deps.index);
    index.entries.find((entry) => entry.ref === "provider-02/lab/model-4")!.name = "New presentation";
    const rendered = await page(path, { headers: { "If-None-Match": tag } }, shell, index);
    expect(rendered.status).toBe(200);
    expect(rendered.headers.get("ETag")).not.toBe(tag);
    expect(await rendered.text()).toContain("New presentation");
    const head = await page(path, { method: "HEAD" });
    expect(head.headers.get("ETag")).toBe(tag);
    expect(await head.text()).toBe("");
    expect((await page(path, { headers: { "If-None-Match": `W/${tag}` } })).status).toBe(304);
  });
});

describe("one dataset for the website and the API", () => {
  const check = (dir: string): void => {
    const local = depsFrom(dir);
    const exported = JSON.parse(readFileSync(join(dir, "site", "api.json"), "utf8")) as Catalog;
    const browserIndex = JSON.parse(readFileSync(join(dir, "site", "data", "index.json"), "utf8"));
    // The internal snapshot index is the index the API answers from.
    expect(browserIndex).toEqual(local.index);
    // Every summary is exactly what the compatibility export says about that entry.
    const refs = new Set<string>();
    for (const entry of local.index.entries) {
      refs.add(entry.ref);
      const model = exported[entry.provider]!.models[entry.model]!;
      expect(summarize(entry.provider, model, entry.shard)).toEqual(entry);
    }
    const total = Object.values(exported).reduce((sum, provider) => sum + Object.keys(provider.models).length, 0);
    expect(refs.size).toBe(total);
  };

  it("holds for the fixture", async () => {
    check(published);
    // The API uses the shared query engine for these parameters.
    const params = new URLSearchParams("min_context=500000&cache=yes&sort=context&order=desc&limit=7&offset=3");
    const parsed = parseQuery(params, false);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const browser = runQuery(deps.index.entries, parsed.query);
    const api = await json<Page>(`/api/v1/entries?${params}`);
    expect(api.data).toEqual(browser.data);
    expect(api.total).toBe(browser.total);
    // The full entry from the API is the entry in the export.
    const exported = JSON.parse(readFileSync(join(published, "site", "api.json"), "utf8")) as Catalog;
    const entry = await json<{ data: { entry: unknown } }>("/api/v1/entries/provider-01/model-1");
    expect(entry.data.entry).toEqual(exported["provider-01"]!.models["model-1"]);
    expect((entry.data.entry as { limit: { context: number } }).limit.context).toBe(5000000);
    // The lists the pages are built from are the lists the API returns.
    const fromApi = await json<{ data: unknown[] }>("/api/v1/models?limit=200");
    expect(fromApi.data).toEqual(canonicalModels(deps.index.entries).map(withoutEntries));
    const listed = listEvaluations(exported, deps.index);
    for (const [list, kind] of [["cache", "cache"], ["limits", "limit"]] as const) {
      const evaluations = await json<{ data: unknown[] }>(`/api/v1/evaluations/${list}?limit=200`);
      expect(evaluations.data).toEqual(listed.filter((item) => item.kind === kind).slice(0, 200));
    }
  });

  const real = join(ROOT, "data", "published");
  it.skipIf(!existsSync(join(real, "site", "api.json")))("holds for the real published snapshot", () => {
    check(real);
  });
});
