import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stringify } from "yaml";
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
  MeasuredLimitSchema,
  MetaSchema,
  one,
  pageOf,
  ProviderDetailSchema,
  ProviderSchema,
  ProviderSummarySchema,
} from "../src/core/contract.ts";
import { emptyCacheLifetime, lifetimeSeconds } from "../src/core/cache.ts";
import { summarize, type Summary } from "../src/core/entries.ts";
import { entryHref } from "../src/core/format.ts";
import { ENDPOINTS, openapi } from "../src/core/openapi.ts";
import { handlePage } from "../src/core/pages.ts";
import { MARK } from "../src/core/page-shell.ts";
import { CACHE_EVALUATION_PARAMS, LIMIT_EVALUATION_PARAMS, PARAMS, parseQuery, runQuery } from "../src/core/query.ts";
import { canonicalModels, listEvaluations, withoutEntries } from "../src/core/resources.ts";
import type { Catalog, ModelExtension } from "../src/core/schema.ts";
import { depsFrom, fetchReturning, fixtureUpstream, inputWindowRuleBreaks, lifetimeRuleBreaks, ROOT, summaryOf, tempDataDir, writeAuthored } from "./helpers.ts";

let deps: ApiDeps;
let published: string;

beforeAll(async () => {
  const dataDir = tempDataDir();
  await sync({ dataDir, fetch: fetchReturning(JSON.stringify(fixtureUpstream())) });
  writeAuthored(dataDir);
  writeFixtureLimits(dataDir);
  const report = publish({ dataDir, rootDir: ROOT });
  expect(report.errors).toEqual([]);
  published = join(dataDir, "published");
  deps = depsFrom(published);
});

/**
 * Limit evaluations for the fixture, all on the one added entry (added-login/lab/model-2, whose provider file states
 * limit.context 900,000), so that no other entry and no count of the fixture changes: a window named equal to the
 * documented one, with a date of its own; a bracket from a folder date, well under it; an accepted size read to the
 * end; and an accepted size with nothing else, which does not count.
 */
function writeFixtureLimits(dataDir: string): void {
  const row = { route: "login", model: "lab/model-2", models_dev: "added-login/lab/model-2", source: "results/limits-2026-11-09/limits.jsonl" };
  mkdirSync(join(dataDir, "sources"), { recursive: true });
  writeFileSync(join(dataDir, "sources", "observed.json"), JSON.stringify({
    schema: 1, repository: "https://github.com/example/probe", routes: { login: "The added login" }, clients: {}, cache: [],
    limits: [
      { ...row, client: "direct", context: 900000, date: "2026-11-10" },
      { ...row, client: "proxy", input_accepted: 850000, input_refused: 880000 },
      { ...row, client: "agent", input_accepted: 600000, input_read: 600000, date: "2026-11-11" },
      { ...row, client: "cli", input_accepted: 990000, note: "answered; not checked that it was read" },
    ],
  }));
  writeFileSync(join(dataDir, "authored", "measurement-labels.yaml"), stringify({ clients: Object.fromEntries(["direct", "proxy", "agent", "cli"].map((id) => [id, { id, label: `Client ${id}` }])) }));
}

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
      "ref", "provider", "model", "name", "type", "family", "canonical_id", "status", "release_date", "access", "origin", "context", "input", "max_output", "input_window",
      "cache", "cache_modes", "cache_mode_support", "cache_retention", "cache_lifetime", "evaluation_count",
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

  it("returns the same input window record on entry, provider, model and catalog routes", async () => {
    for (const ref of ["added-login/lab/model-2", "provider-02/lab/model-4", "provider-03/model-7"]) {
      const detail = one(EntryDetailSchema).parse(await json(`/api/v1/entries/${ref}`));
      const expected = detail.data.entry.providers_dev.limits.input_window;
      const { provider, model } = { provider: detail.data.summary.provider, model: detail.data.summary.model };
      const collection = pageOf(EntrySummarySchema).parse(await json(`/api/v1/entries?provider=${provider}&limit=200`));
      const full = one(ProviderDetailSchema).parse(await json(`/api/v1/providers/${provider}?view=full`));
      const canonical = one(CanonicalModelDetailSchema).parse(await json(`/api/v1/models/${detail.data.summary.canonical_id}`));
      const catalog = (await json<{ data: Catalog }>("/api/v1/catalog")).data;
      for (const summary of [detail.data.summary, collection.data.find((entry) => entry.ref === ref)!, full.data.entries.find((entry) => entry.ref === ref)!, canonical.data.entries.find((entry) => entry.ref === ref)!]) {
        expect(summary.input_window, ref).toEqual(expected);
      }
      expect(full.data.models?.[model]?.providers_dev.limits.input_window).toEqual(expected);
      expect((catalog[provider]!.models[model]!.providers_dev as unknown as ModelExtension).limits.input_window).toEqual(expected);
    }
    // The fixture's three kinds: measured over a contradicted window, documented, nothing known (model-7 has no limit).
    const basis = (ref: string) => deps.index.entries.find((entry) => entry.ref === ref)!.input_window;
    expect([basis("added-login/lab/model-2").basis, basis("added-login/lab/model-2").tokens]).toEqual(["measured", 600000]);
    expect([basis("provider-02/lab/model-4").basis, basis("provider-02/lab/model-4").tokens, basis("provider-02/lab/model-4").source]).toEqual(["documented", 500000, "models.dev"]);
    expect([basis("provider-03/model-7").basis, basis("provider-03/model-7").tokens]).toEqual(["none", null]);
  });

  it("adds input_window to a summary and leaves every other key as it was", () => {
    const exported = JSON.parse(readFileSync(join(published, "site", "api.json"), "utf8")) as Catalog;
    for (const entry of deps.index.entries) {
      const model = structuredClone(exported[entry.provider]!.models[entry.model]!);
      delete (model.providers_dev as unknown as { limits: Partial<ModelExtension["limits"]> }).limits.input_window;
      const { input_window: _without, ...rest } = summarize(entry.provider, model, entry.shard);
      const { input_window: _with, ...published } = entry;
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
    expect(explicit.data[0]?.cache_lifetime.lifetimes.map((item) => [item.mode, item.lifetime_s])).toEqual([["explicit", 300], ["explicit", 3600]]);
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

  it("sorts by the safe cache lifetime, 0 a value and unknown last, and filters by its basis", async () => {
    type Basis = "documented" | "measured" | "none";
    // An entry by its short and long safe lifetime: [safe_s, basis] each.
    const entry = (ref: string, short: [number | null, Basis], long: [number | null, Basis]) => {
      const lifetime = emptyCacheLifetime();
      Object.assign(lifetime.short, { safe_s: short[0], basis: short[1] });
      Object.assign(lifetime.long, { safe_s: long[0], basis: long[1] });
      const [provider, model] = ref.split("/") as [string, string];
      return summaryOf({ ref, provider, model, cache_lifetime: lifetime });
    };
    const entries = [
      entry("b/hour", [300, "documented"], [3600, "documented"]),
      entry("a/zero", [0, "measured"], [null, "none"]),
      entry("c/unknown", [null, "none"], [null, "none"]),
      entry("a/hour", [600, "measured"], [3600, "documented"]),
      entry("a/day", [null, "none"], [86400, "measured"]),
      entry("a/none", [0, "documented"], [0, "documented"]),
    ];
    const run = (search: string): string[] => {
      const parsed = parseQuery(new URLSearchParams(search));
      if (!parsed.ok) throw new Error(`not a valid query: ${search}`);
      return runQuery(entries, parsed.query).data.map((item) => item.ref);
    };
    // 0 is a value and sorts before every lifetime; null comes last in either order; a tie goes by provider, then model.
    expect(run("sort=cache_short")).toEqual(["a/none", "a/zero", "b/hour", "a/hour", "a/day", "c/unknown"]);
    expect(run("sort=cache_short&order=desc")).toEqual(["a/hour", "b/hour", "a/none", "a/zero", "a/day", "c/unknown"]);
    expect(run("sort=cache_long")).toEqual(["a/none", "a/hour", "b/hour", "a/day", "a/zero", "c/unknown"]);
    expect(run("sort=cache_long&order=desc")).toEqual(["a/day", "a/hour", "b/hour", "a/none", "a/zero", "c/unknown"]);
    // The basis of the short or of the long profile; an entry with neither known matches neither value.
    expect(run("lifetime_basis=documented")).toEqual(["a/hour", "a/none", "b/hour"]);
    expect(run("lifetime_basis=measured")).toEqual(["a/day", "a/hour", "a/zero"]);
    expect(run("lifetime_basis=documented,measured")).toEqual(["a/day", "a/hour", "a/none", "a/zero", "b/hour"]);
    expect((await get("/api/v1/entries?lifetime_basis=none")).status).toBe(400);
    expect((await get("/api/v1/entries?sort=cache")).status).toBe(400);
    // Through the API, on the fixture: unknown last in both orders.
    for (const order of ["asc", "desc"]) {
      const page = await json<Page>(`/api/v1/entries?sort=cache_long&order=${order}&limit=200`);
      const values = page.data.map((item) => item.cache_lifetime.long.safe_s);
      const known = values.filter((value) => value !== null);
      expect(values.slice(0, known.length)).toEqual(known);
      expect(known).toEqual([...known].sort((a, b) => (order === "asc" ? a - b : b - a)));
    }
    // The fixture has documented lifetimes and no measured one.
    const documented = await json<Page>("/api/v1/entries?lifetime_basis=documented&limit=200");
    expect(documented.total).toBeGreaterThan(0);
    expect(documented.data.every((item) => item.cache_lifetime.short.basis === "documented" || item.cache_lifetime.long.basis === "documented")).toBe(true);
    expect((await json<Page>("/api/v1/entries?lifetime_basis=measured")).total).toBe(0);
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

    expect(await json<Page>("/api/v1/evaluations/cache")).toMatchObject({ total: 0, limit: 50, offset: 0, next_offset: null, data: [] });
    expect(await json<Page>("/api/v1/evaluations/limits")).toMatchObject({ total: 4, limit: 50, offset: 0, next_offset: null });
  });

  it("serves the catalog and the metadata", async () => {
    // Both answer as every single object does: { meta, data }.
    const catalog = await json<{ meta: { dataset_version: string }; data: Catalog }>("/api/v1/catalog");
    expect(Object.keys(catalog)).toEqual(["meta", "data"]);
    expect(Object.keys(catalog.data)).toHaveLength(31);
    const answer = await json<{ meta: { dataset_version: string }; data: { dataset_version: string; counts: { entries: number; models: number }; cache_ages_s: number[]; stale_after_days: number; upstream: { commit: string } } }>("/api/v1/meta");
    expect(Object.keys(answer)).toEqual(["meta", "data"]);
    expect(answer.meta).toEqual(catalog.meta);
    const meta = answer.data;
    expect(meta.dataset_version).toBe(catalog.meta.dataset_version);
    expect(meta.counts.entries).toBe(601);
    expect(meta.counts.models).toBe(20);
    expect(meta.cache_ages_s.slice(0, 4)).toEqual([150, 300, 450, 600]);
    // The age after which providers.dev evidence is shown as stale: published once, read by every page.
    expect(meta.stale_after_days).toBe(90);
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
    expect(document.info.version).toBe("2.1.0");
    const schemas = document.components.schemas;
    expect(Object.keys(schemas.CacheLifetime!.properties!)).toEqual(["short", "long", "lifetimes"]);
    expect(Object.keys(schemas.SafeLifetime!.properties!)).toEqual(["safe_s", "basis", "source", "date", "documented_s", "measured_s", "documented_status", "clients", "evaluations", "checks", "hits", "checks_inside", "hits_inside", "tested_from_s", "first_miss_s"]);
    expect(Object.keys(schemas.CacheLifetimeItem!.properties!)).toEqual([
      "retention_profile", "basis", "source", "date", "lifetime_s", "mode", "documented_as", "client", "client_label", "parameter", "value", "evaluations", "evaluation_ids", "checks", "hits", "tested_from_s", "first_miss_s", "results",
    ]);
    expect(Object.keys(schemas.EntryCache!.properties!)).toEqual(["documented", "retention", "lifetime", "evaluations"]);
    expect(Object.keys(schemas.EntrySummary!.properties!)).toContain("cache_lifetime");
    // The fields folded into the record are gone from the contract (task 6).
    expect(schemas).not.toHaveProperty("CacheSummaryRow");
    expect(Object.keys(schemas.CacheModeDocumentation!.properties!)).toEqual(["support", "min_tokens", "max_breakpoints", "targets"]);
    for (const key of ["cache_ttl_s", "cache_ttl_by_mode_s", "cache_results"]) expect(Object.keys(schemas.EntrySummary!.properties!)).not.toContain(key);
    expect(JSON.stringify(document)).not.toMatch(/cache_results|cache_ttl_s|cache_ttl_by_mode_s|cache\.results/);
    const section = document["x-guide"].find((item) => item.id === "cache-lifetimes");
    expect(section?.title).toBe("Cache lifetimes");
    const text = section!.paragraphs.join(" ");
    for (const words of ["lifetimes", "safe_s", "documented_s", "measured_s", "fewer than half", "hits_inside of checks_inside", "lowest over the clients", "null", "not a guarantee", "documented_status", "not_contradicted"]) expect(text).toContain(words);
    // documented_status is required and nullable: the two values of the rule, or null.
    const status = schemas.SafeLifetime as unknown as { required: string[]; properties: { documented_status: unknown } };
    expect(status.required).toContain("documented_status");
    expect(JSON.stringify(status.properties.documented_status)).toMatch(/"contradicted","not_contradicted"/);
    expect(JSON.stringify(status.properties.documented_status)).toMatch(/null/);
  });
});

describe("the input window in the OpenAPI document", () => {
  it("has the two components, the key on the entry and the summary, input_read on an evaluation, and a guide section after Unknown values", async () => {
    const document = await json<{ info: { version: string }; "x-guide": { id: string; title: string; paragraphs: string[] }[]; components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> } }>("/api/v1/openapi.json");
    expect(document.info.version).toBe("2.1.0");
    const schemas = document.components.schemas;
    expect(Object.keys(schemas.InputWindow!.properties!)).toEqual([
      "tokens", "basis", "bound", "scope", "source", "date", "documented_tokens", "documented_field", "documented_source", "documented_date", "documented_status",
      "measured_tokens", "measured_bound", "measured_kind", "measured_refused", "measured_date", "clients", "evaluations", "measurements",
    ]);
    expect(schemas.InputWindow!.required).toEqual(Object.keys(schemas.InputWindow!.properties!));
    expect(Object.keys(schemas.InputWindowMeasurement!.properties!)).toEqual(["client", "client_label", "route", "route_label", "date", "tokens", "bound", "kind", "accepted", "refused", "named", "read", "source"]);
    expect(Object.keys(schemas.EntrySummary!.properties!)).toContain("input_window");
    expect(Object.keys(schemas.MeasuredLimit!.properties!)).toContain("input_read");
    expect(JSON.stringify(schemas.EntryExtension)).toContain("input_window");
    const ids = document["x-guide"].map((item) => item.id);
    expect(ids.indexOf("input-window")).toBe(ids.indexOf("unknown") + 1);
    const section = document["x-guide"].find((item) => item.id === "input-window")!;
    expect(section.title).toBe("Input window");
    const text = section.paragraphs.join(" ");
    for (const words of ["providers_dev.limits.input_window", "never 0", "system prompt", "99 %", "101 %", "912,780", "931,220", "lowest", "at_least", "measured_refused", "scope", "limit.input", "limit.context", "from_measurement", "none stated", "window", "bracket", "input_read", "limit-not-counted", "measured_input_accepted", "not contradicted is not confirmed", "probe's count"]) expect(text).toContain(words);
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
    same(local.index.entries.map((entry) => entry.input_window), "input_window of a summary");
    // context, input, max_output and the three measured_* keys of every summary are what they were: limit as published,
    // and the widest accepted, the narrowest refused and the number of limit evaluations, whether they count or not.
    const asBefore: string[] = [];
    for (const entry of local.index.entries) {
      const full = exported[entry.provider]!.models[entry.model]!;
      const limit = (typeof full.limit === "object" && full.limit !== null ? full.limit : {}) as Record<string, unknown>;
      const number = (value: unknown) => (typeof value === "number" ? value : null);
      const measured = (full.providers_dev as unknown as ModelExtension).limits.measured;
      const accepted = measured.flatMap((item) => (item.input_accepted === null ? [] : [item.input_accepted]));
      const refused = measured.flatMap((item) => (item.input_refused === null ? [] : [item.input_refused]));
      const expected = {
        context: number(limit.context), input: number(limit.input), max_output: number(limit.output),
        measured_input_accepted: accepted.length > 0 ? Math.max(...accepted) : null, measured_input_refused: refused.length > 0 ? Math.min(...refused) : null, measured_limit_count: measured.length,
      };
      const actual = { context: entry.context, input: entry.input, max_output: entry.max_output, measured_input_accepted: entry.measured_input_accepted, measured_input_refused: entry.measured_input_refused, measured_limit_count: entry.measured_limit_count };
      if (!isDeepStrictEqual(actual, expected)) asBefore.push(entry.ref);
      if (!isDeepStrictEqual(entry.input_window, (full.providers_dev as unknown as ModelExtension).limits.input_window)) asBefore.push(`${entry.ref} input_window`);
    }
    expect(asBefore).toEqual([]);
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
    same(extensions.flatMap((extension) => extension.limits.measured), "limit evaluations");
    same(extensions.map((extension) => extension.limits.input_window), "limits.input_window");
    same(extensions.flatMap((extension) => extension.limits.input_window.measurements), "limits.input_window.measurements");
    expect(Object.keys(extensions[0]!.limits)).toEqual(["measured", "from_measurement", "input_window"]);
    // Every limit evaluation has every key of the contract, input_read among them, on the entry and in the list.
    const limitKeys = Object.keys(MeasuredLimitSchema.shape);
    expect(limitKeys).toContain("input_read");
    const measuredLimits = extensions.flatMap((extension) => extension.limits.measured);
    expect(measuredLimits.length).toBeGreaterThan(0);
    for (const item of measuredLimits) expect(Object.keys(item)).toEqual(limitKeys);
    const limitList = ((await ask("/api/v1/evaluations/limits?limit=200")) as { total: number; data: object[] });
    expect(limitList.total).toBe(measuredLimits.length);
    for (const item of limitList.data) expect(Object.keys(item)).toEqual(["kind", "entry_ref", "entry_name", "access", ...limitKeys]);
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

    // The input window record of every entry keeps the rules of section 2.6 of design/usable-input-window.md, redone
    // from the published entry alone: its limit, limits.from_measurement and limits.measured.
    const windowBreaks = Object.entries(exported).flatMap(([id, provider]) =>
      Object.entries(provider.models).flatMap(([modelId, entry]) => {
        const limits = (entry.providers_dev as unknown as ModelExtension).limits;
        return inputWindowRuleBreaks(limits.input_window, (entry as { limit?: unknown }).limit, limits.from_measurement, limits.measured).map((rule) => `${id}/${modelId}: ${rule}`);
      }),
    );
    expect(windowBreaks).toEqual([]);

    // Nothing of the deleted fields is lost: every documented lifetime text and every counted result is in exactly one
    // place of the record. Each text of capabilities.cache.<mode>.ttl (as published) that is a duration is the
    // documented_as of one documented item of that mode, as many times as it is listed; each counted evaluation is
    // named by exactly one measured item, and each result of it is added into that item's results and no other.
    const lost: string[] = [];
    const key = (result: { kind: string; age_s: number }): string => `${result.kind}:${result.age_s}`;
    for (const [id, provider] of Object.entries(exported)) {
      for (const [modelId, entry] of Object.entries(provider.models)) {
        const ref = `${id}/${modelId}`;
        const cache = (entry.providers_dev as unknown as ModelExtension).cache;
        const capabilities = (entry as { capabilities?: { cache?: unknown } }).capabilities;
        const imported = capabilities && typeof capabilities.cache === "object" && capabilities.cache !== null ? (capabilities.cache as Record<string, unknown>) : {};
        for (const mode of ["implicit", "explicit"] as const) {
          const detail = imported[mode] as { ttl?: unknown } | undefined;
          const texts = (typeof detail === "object" && detail !== null && Array.isArray(detail.ttl) ? detail.ttl : []).filter((text): text is string => typeof text === "string" && lifetimeSeconds(text) !== undefined);
          const items = cache.lifetime.lifetimes.filter((item) => item.basis === "documented" && item.mode === mode).map((item) => item.documented_as);
          if (JSON.stringify([...texts].sort()) !== JSON.stringify([...items].sort())) lost.push(`${ref} ${mode}: ttl ${JSON.stringify(texts)}, items ${JSON.stringify(items)}`);
        }
        const measured = cache.lifetime.lifetimes.filter((item) => item.basis === "measured");
        const sums = new Map<string, { hits: number; checks: number }>();
        const add = (result: { kind: string; age_s: number; hits: number; checks: number }, sign: number): void => {
          const sum = sums.get(key(result)) ?? { hits: 0, checks: 0 };
          sums.set(key(result), { hits: sum.hits + sign * result.hits, checks: sum.checks + sign * result.checks });
        };
        for (const evaluation of cache.evaluations) {
          const counted = evaluation.results.some((result) => result.kind === "timed") || evaluation.results.some((result) => result.kind === "control" && result.hits < result.checks);
          const holders = measured.filter((item) => item.evaluation_ids.includes(evaluation.id));
          if (holders.length !== (counted ? 1 : 0)) lost.push(`${ref} ${evaluation.id}: in ${holders.length} items`);
          if (counted) for (const result of evaluation.results) add(result, 1);
        }
        for (const item of measured) {
          const own = new Map<string, { hits: number; checks: number }>();
          for (const evaluation of cache.evaluations.filter((run) => item.evaluation_ids.includes(run.id))) {
            for (const result of evaluation.results) {
              const sum = own.get(key(result)) ?? { hits: 0, checks: 0 };
              own.set(key(result), { hits: sum.hits + result.hits, checks: sum.checks + result.checks });
            }
          }
          const published = new Map((item.results ?? []).map((result) => [key(result), { hits: result.hits, checks: result.checks }]));
          if (!isDeepStrictEqual(own, published)) lost.push(`${ref} item ${item.client} ${item.value}: results are not those of its evaluations`);
          for (const result of item.results ?? []) add(result, -1);
        }
        if ([...sums.values()].some((sum) => sum.hits !== 0 || sum.checks !== 0)) lost.push(`${ref}: the items' results do not add up to the counted evaluations' results`);
      }
    }
    expect(lost).toEqual([]);

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

  it("gives the fixture's added entry its documented window, contradicted by a bracket under it", () => {
    const window = deps.index.entries.find((entry) => entry.ref === "added-login/lab/model-2")!;
    const record = JSON.parse(readFileSync(join(published, "site", "api.json"), "utf8"))["added-login"].models["lab/model-2"].providers_dev.limits.input_window;
    expect(window.measured_limit_count).toBe(4);
    // 880,000 refused is at or below 99 % of the documented 900,000: contradicted, and the lowest client decides.
    expect(record).toMatchObject({ tokens: 600000, basis: "measured", bound: "at_least", scope: "input", documented_tokens: 900000, documented_field: "limit.context", documented_source: "providers.dev", documented_date: "2026-11-01", documented_status: "contradicted", measured_kind: "accepted", measured_date: "2026-11-11", clients: 3, evaluations: 3 });
    expect(record.measurements.map((item: { client: string; kind: string; tokens: number }) => [item.client, item.kind, item.tokens])).toEqual([["agent", "accepted", 600000], ["proxy", "bracket", 850000], ["direct", "window", 900000]]);
    expect(deps.meta.issues.filter((issue) => issue.code === "limit-not-counted").map((issue) => issue.target)).toEqual(["added-login/lab/model-2#limits"]);
  });

  // The counts of section 7 of design/usable-input-window.md were taken on the dataset built from the models.dev
  // import c18a3cf and the measurements file 4ce313b6. Checked where the real snapshot is built from those two.
  const realMeta = existsSync(join(real, "site", "data", "meta.json")) ? (JSON.parse(readFileSync(join(real, "site", "data", "meta.json"), "utf8")) as { upstream: { commit: string | null }; measurements: { sha256: string } | null }) : null;
  const designInputs = realMeta?.upstream.commit?.startsWith("c18a3cf") === true && realMeta.measurements?.sha256.startsWith("4ce313b6") === true;
  it.skipIf(!designInputs)("gives the counts of the design on the real published snapshot built from its inputs", () => {
    const index = depsFrom(real).index;
    const exported = JSON.parse(readFileSync(join(real, "site", "api.json"), "utf8")) as Catalog;
    const window = (entry: Summary) => (exported[entry.provider]!.models[entry.model]!.providers_dev as unknown as ModelExtension).limits.input_window;
    const count = (keep: (entry: Summary) => boolean) => index.entries.filter(keep).length;
    expect([count((entry) => window(entry).basis === "documented"), count((entry) => window(entry).basis === "measured"), count((entry) => window(entry).basis === "none")]).toEqual([5744, 7, 354]);
    expect([count((entry) => window(entry).documented_field === "limit.input" && window(entry).basis === "documented"), count((entry) => window(entry).documented_field === "limit.context" && window(entry).basis === "documented")]).toEqual([813, 4931]);
    expect(count((entry) => window(entry).basis === "documented" && window(entry).evaluations > 0)).toBe(10);
    expect(count((entry) => window(entry).documented_status === "contradicted")).toBe(0);
    expect([count((entry) => window(entry).basis === "measured" && window(entry).bound === "limit"), count((entry) => window(entry).basis === "measured" && window(entry).bound === "at_least")]).toEqual([4, 3]);
    expect([count((entry) => window(entry).basis === "none" && entry.context === 0), count((entry) => window(entry).basis === "none" && entry.origin === "added")]).toEqual([335, 19]);
  });
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
