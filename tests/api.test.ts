import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stringify } from "yaml";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { publish } from "../scripts/lib/publish.ts";
import { loadUpstream, sync } from "../scripts/lib/sync.ts";
import { handleApi, modelsFor, type ApiDeps, type LoadedDeps } from "../src/core/api.ts";
import { snapshotAsset } from "../src/core/assets.ts";
import {
  CanonicalModelDetailSchema,
  EntryDetailSchema,
  EntrySummarySchema,
  ListingSchema,
  MeasuredLimitSchema,
  one,
  pageOf,
  ProviderDetailSchema,
} from "../src/core/contract.ts";
import { emptyCacheLifetime, lifetimeSeconds } from "../src/core/cache.ts";
import { summarize, type Summary } from "../src/core/entries.ts";
import { entryHref } from "../src/core/format.ts";
import { ENDPOINTS, openapi } from "../src/core/openapi.ts";
import { handlePage } from "../src/core/pages.ts";
import { MARK } from "../src/core/page-shell.ts";
import { CACHE_EVALUATION_PARAMS, LIMIT_EVALUATION_PARAMS, PARAMS, parseQuery, runQuery } from "../src/core/query.ts";
import { canonicalModels, inputWindowRange, listEvaluations, withoutEntries } from "../src/core/resources.ts";
import type { Listing, ListingSource } from "../src/core/listings.ts";
import { ext, type Catalog, type Meta, type ModelExtension } from "../src/core/schema.ts";
import { depsFrom, fetchReturning, fixturePi, fixtureUpstream, contractProblems, inputWindowRuleBreaks, lifetimeRuleBreaks, piShort, ROOT, safeBreaks, summaryOf, tempDataDir, writeAuthored, writePiSnapshot } from "./helpers.ts";

let deps: LoadedDeps;
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
  const kinds: Record<string, string> = { direct: "direct", proxy: "proxy", agent: "proxy", cli: "own-client" };
  writeFileSync(join(dataDir, "authored", "measurement-labels.yaml"), stringify({ clients: Object.fromEntries(["direct", "proxy", "agent", "cli"].map((id) => [id, { id, label: `Client ${id}`, kind: kinds[id] }])) }));
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
      "ref", "provider", "model", "name", "type", "family", "canonical_id", "status", "release_date", "access", "origin", "context", "input", "max_output", "input_window", "safe",
      "cache", "cache_modes", "cache_mode_support", "cache_retention", "cache_lifetime", "evaluation_count",
      "price_in", "price_out", "price_from", "pricing", "request_controls", "measured_input_accepted", "measured_input_refused", "measured_limit_count", "overridden_fields", "verified", "shard", "pi",
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
    // The fixture's three kinds: measured (the direct window on the login, the proxy's lower values not counted),
    // documented, nothing known (model-7 has no limit).
    const basis = (ref: string) => deps.index.entries.find((entry) => entry.ref === ref)!.input_window;
    expect([basis("added-login/lab/model-2").basis, basis("added-login/lab/model-2").tokens]).toEqual(["measured", 900000]);
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
    // max_output is the safe maximum output: a limit of 0 (model-0) states nothing, and is unknown.
    const output = await json<Page>("/api/v1/entries?min_output=0&provider=provider-00&limit=200");
    expect(output.data.some((entry) => entry.max_output === 0)).toBe(false);
    expect(output.total).toBe(18);
    const model0 = (await json<Page>("/api/v1/entries?provider=provider-00&q=model-0&limit=200")).data.find((entry) => entry.model === "lab/model-0")!;
    expect([model0.max_output, model0.safe.max_output.agreement]).toEqual([null, "none"]);
  });

  it("sorts by the safe input window, filters by it and by disagreement (since 1.4.0)", async () => {
    const all = (await json<Page>("/api/v1/entries?limit=200&sort=input_window&order=desc&provider=provider-00,added-login")).data;
    const values = all.map((entry) => entry.safe.input_window.value);
    const known = values.filter((value): value is number => value !== null);
    expect(known).toEqual([...known].sort((a, b) => b - a));
    expect(values.slice(known.length).every((value) => value === null)).toBe(true);
    expect(values.indexOf(null)).toBe(known.length);
    const atLeast = await json<Page>("/api/v1/entries?min_input_window=1900000&limit=200");
    expect(atLeast.data.every((entry) => entry.safe.input_window.value !== null && entry.safe.input_window.value >= 1900000)).toBe(true);
    expect(atLeast.total).toBe(deps.index.entries.filter((entry) => (entry.safe.input_window.value ?? 0) >= 1900000).length);
    const differ = await json<Page>("/api/v1/entries?disagree=true&limit=200");
    const agree = await json<Page>("/api/v1/entries?disagree=false&limit=1");
    expect(differ.data.every((entry) => entry.safe.differing.length > 0)).toBe(true);
    expect(differ.total + agree.total).toBe(deps.index.entries.length);
    expect(differ.total).toBe(deps.index.entries.filter((entry) => entry.safe.differing.length > 0).length);
    expect((await get("/api/v1/entries?disagree=maybe")).status).toBe(400);
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
    // No schema_version: an integer that was always 1 and that no client could act on, removed before 1.0.0.
    expect(Object.keys(meta).slice(0, 3)).toEqual(["api_version", "upstream_schema", "dataset_version"]);
    expect(meta).not.toHaveProperty("schema_version");
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
      "/api/v1/listings/{provider}": "/api/v1/listings/provider-02",
    };
    for (const path of Object.keys(document.paths).filter((item) => item.startsWith("/api/v1/"))) {
      const response = await get(example[path] ?? path);
      expect(response.status, path).toBe(200);
    }
  });

  it("describes the cache lifetime record: its components and a guide section", async () => {
    const document = await json<{ info: { version: string; contact: unknown; license: unknown }; "x-guide": { id: string; title: string; paragraphs: string[] }[]; components: { schemas: Record<string, { properties?: Record<string, unknown> }> } }>("/api/v1/openapi.json");
    expect(document.info.version).toBe("1.6.1");
    expect(document.info.contact).toEqual({ name: "providers.dev", email: "office@providers.dev", url: "https://providers.dev/docs/contributing/" });
    expect(document.info.license).toEqual({ name: "MIT", url: "https://providers.dev/docs/licensing/" });
    const schemas = document.components.schemas;
    expect(Object.keys(schemas.CacheLifetime!.properties!)).toEqual(["short", "long", "lifetimes"]);
    expect(Object.keys(schemas.SafeLifetime!.properties!)).toEqual(["safe_s", "basis", "source", "date", "documented_s", "measured_s", "documented_status", "clients", "evaluations", "checks", "hits", "checks_inside", "hits_inside", "tested_from_s", "first_miss_s"]);
    expect(JSON.stringify(schemas.SafeLifetime!.properties!.source)).toContain("pi.dev");
    expect(Object.keys(schemas.CacheLifetimeItem!.properties!)).toEqual([
      "retention_profile", "basis", "source", "date", "lifetime_s", "mode", "documented_as", "client", "client_label", "parameter", "value", "evaluations", "evaluation_ids", "checks", "hits", "tested_from_s", "first_miss_s", "results", "client_kind", "chosen",
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
    for (const words of ["lifetimes", "safe_s", "documented_s", "measured_s", "one missed check is enough", "hits_inside of checks_inside", "lowest over the chosen items", "safe.cache_short", "kind that counts", "client_kind", "chosen", "null", "not a guarantee", "documented_status", "not_contradicted"]) expect(text).toContain(words);
    expect(text).not.toContain("fewer than half");
    // documented_status is required and nullable: the two values of the rule, or null.
    const status = schemas.SafeLifetime as unknown as { required: string[]; properties: { documented_status: unknown } };
    expect(status.required).toContain("documented_status");
    expect(JSON.stringify(status.properties.documented_status)).toMatch(/"contradicted","not_contradicted"/);
    expect(JSON.stringify(status.properties.documented_status)).toMatch(/null/);
  });
});

describe("pi's catalog in the API (design/pi-source.md, section d)", () => {
  it("puts the key pi on every entry summary and every full entry, null where pi's catalog has nothing for the entry", async () => {
    // The fixture is built without a pi snapshot: every entry has the key, and it is null.
    const page = await json<{ total: number; data: Summary[] }>("/api/v1/entries?limit=200");
    expect(page.data.length).toBeGreaterThan(0);
    for (const entry of page.data) expect(entry).toHaveProperty("pi", null);
    for (const entry of deps.index.entries) expect(entry.pi).toBeNull();
    const exported = JSON.parse(readFileSync(join(published, "site", "api.json"), "utf8")) as Catalog;
    for (const provider of Object.values(exported)) {
      for (const model of Object.values(provider.models)) expect(model.providers_dev).toHaveProperty("pi", null);
    }
    const one = await json<{ data: { summary: Summary; entry: { providers_dev: ModelExtension } } }>(`/api/v1${entryHref(deps.index.entries[0]!.ref)}`);
    expect(one.data.summary.pi).toBeNull();
    expect(Object.keys(one.data.entry.providers_dev).at(-1)).toBe("pi");
    expect(one.data.entry.providers_dev.pi).toBeNull();
  });

  it("gives /meta a pi key with no snapshot and every count 0, and two licence keys", async () => {
    const meta = (await json<{ data: Meta }>("/api/v1/meta")).data;
    expect(meta.pi).toEqual({
      source: "https://pi.dev/api/models",
      snapshot: null,
      // The fixture's sync asked pi for its catalog and got models.dev's body: a failed pi attempt is recorded.
      sync: { last_attempt_at: expect.any(String), last_attempt_ok: false, last_error: expect.stringMatching(/^the pi feed/) },
      counts: { entries_with_block: 0, left_out_models: 0, unmatched_models: 0 },
    });
    expect(meta.license.pi).toBe("pi (https://github.com/earendil-works/pi), MIT License, Copyright (c) 2025 Mario Zechner");
    expect(meta.license.pi_notice).toBe("The pi block of an entry (providers_dev.pi) is imported from https://pi.dev/api/models. providers.dev is not affiliated with or endorsed by pi.");
    expect(meta.license.data).toBe("MIT");
    // A failed pi attempt does not touch the top-level sync, which speaks of models.dev and the measurements.
    expect(meta.sync.last_error ?? "").not.toMatch(/pi/);
  });

  it("is version 1.6.1, with the six pi components, the keys on the entry, the summary and /meta, and a guide section after Input window", async () => {
    const document = await json<{ info: { version: string; description: string }; "x-guide": { id: string; title: string; paragraphs: string[] }[]; components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> } }>("/api/v1/openapi.json");
    expect(document.info.version).toBe("1.6.1");
    expect(document.info.description).toContain("A second catalog, pi's (MIT), is imported beside it: what it states for an entry is under providers_dev.pi.");
    const schemas = document.components.schemas;
    for (const name of ["PiBlock", "PiCost", "PiCostTier", "PiDifference", "PiSummary", "PiValue"]) expect(schemas[name], name).toBeDefined();
    expect(Object.keys(schemas.PiValue!.properties!)).toEqual(["field", "entry_field", "unit", "standing", "pi", "pi_tiers"]);
    expect(Object.keys(schemas.PiBlock!.properties!)).toEqual(["ref", "provider", "model", "match", "name", "type", "api", "base_url", "reasoning", "input", "context_window", "max_tokens", "cost", "thinking_level_map", "compat", "prompt_cache", "input_limits", "differences", "values"]);
    expect(schemas.PiBlock!.required).toEqual(Object.keys(schemas.PiBlock!.properties!));
    expect(Object.keys(schemas.EntrySummary!.properties!)).toContain("pi");
    expect(schemas.EntrySummary!.required).toContain("pi");
    expect(Object.keys(schemas.EntryExtension!.properties!)).toContain("pi");
    expect(schemas.Meta!.required).toContain("pi");
    const ids = document["x-guide"].map((item) => item.id);
    expect(ids.indexOf("pi")).toBe(ids.indexOf("input-window") + 1);
    const section = document["x-guide"].find((item) => item.id === "pi")!;
    expect(section.title).toBe("pi's catalog");
    expect(section.paragraphs).toHaveLength(6);
    const text = section.paragraphs.join(" ");
    for (const words of ["Since 1.2.0", "models.dev stays the reference", "not an entry", "match", "alias", "not false", "0 stands for no charge and for no price recorded alike", "Prices are compared exactly, with no tolerance", "cost.tiers", "/meta.pi", "unmatched_models", "Since 1.3.0", "subscription", "agrees, differs, only, not_compared or silent", "in no field of the entry", "providers_dev.safe", "Since 1.4.0 pi is also the last source of the safe values"]) expect(text).toContain(words);
  });

  it("gives every pi block of /entries/{provider}/{model} values with nine items (1.3.0)", async () => {
    const dataDir = tempDataDir();
    await sync({ dataDir, fetch: fetchReturning(JSON.stringify(fixtureUpstream())) });
    writeAuthored(dataDir);
    writePiSnapshot(dataDir, fixturePi());
    expect(publish({ dataDir, rootDir: ROOT }).pi).toBe("published");
    const dir = join(dataDir, "published");
    const local = depsFrom(dir);
    expect(await contractProblems(dir)).toEqual([]);
    const listed = local.index.entries.filter((entry) => entry.pi !== null);
    expect(listed.length).toBeGreaterThan(100);
    for (const summary of listed) {
      const answer = (await (await handleApi(new Request(`https://providers.dev/api/v1${entryHref(summary.ref)}`), local)).json()) as { data: { entry: { providers_dev: ModelExtension } } };
      const values = answer.data.entry.providers_dev.pi!.values;
      expect(values.map((item) => item.field), summary.ref).toEqual(["context_window", "max_tokens", "cost.input", "cost.output", "cost.cache_read", "cost.cache_write", "cost.tiers", "prompt_cache.short", "prompt_cache.long"]);
    }
  });

  it("still refuses an origin outside today's list on /entries and /providers", async () => {
    for (const path of ["/api/v1/entries?origin=pi", "/api/v1/providers?origin=pi", "/api/v1/entries?origin=modified,pi"]) {
      const response = await handleApi(new Request(`https://providers.dev${path}`), deps);
      expect(response.status, path).toBe(400);
    }
    const document = await json<{ paths: Record<string, { get: { parameters: { name: string; schema: { items?: { enum?: string[] }; enum?: string[] } }[] } }> }>("/api/v1/openapi.json");
    const allowed = (path: string) => {
      const schema = document.paths[path]!.get.parameters.find((item) => item.name === "origin")!.schema;
      return JSON.stringify(schema);
    };
    expect(allowed("/api/v1/entries")).not.toContain("pi");
    expect(allowed("/api/v1/providers")).not.toContain("pi");
  });
});

describe("the input window in the OpenAPI document", () => {
  it("has the two components, the key on the entry and the summary, input_read on an evaluation, and a guide section after Unknown values", async () => {
    const document = await json<{ info: { version: string }; "x-guide": { id: string; title: string; paragraphs: string[] }[]; components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> } }>("/api/v1/openapi.json");
    expect(document.info.version).toBe("1.6.1");
    const schemas = document.components.schemas;
    expect(Object.keys(schemas.InputWindow!.properties!)).toEqual([
      "tokens", "basis", "bound", "scope", "source", "date", "documented_tokens", "documented_field", "documented_source", "documented_date", "documented_status",
      "measured_tokens", "measured_bound", "measured_kind", "measured_refused", "measured_date", "clients", "evaluations", "measurements",
    ]);
    expect(schemas.InputWindow!.required).toEqual(Object.keys(schemas.InputWindow!.properties!));
    expect(Object.keys(schemas.InputWindowMeasurement!.properties!)).toEqual(["client", "client_label", "route", "route_label", "date", "tokens", "bound", "kind", "accepted", "refused", "named", "read", "source", "client_kind", "chosen"]);
    expect(Object.keys(schemas.EntrySummary!.properties!)).toContain("input_window");
    expect(Object.keys(schemas.MeasuredLimit!.properties!)).toContain("input_read");
    expect(JSON.stringify(schemas.EntryExtension)).toContain("input_window");
    const ids = document["x-guide"].map((item) => item.id);
    expect(ids.indexOf("safe-values")).toBe(ids.indexOf("unknown") + 1);
    expect(ids.indexOf("input-window")).toBe(ids.indexOf("safe-values") + 1);
    const section = document["x-guide"].find((item) => item.id === "input-window")!;
    expect(section.title).toBe("Input window");
    const text = section.paragraphs.join(" ");
    for (const words of ["providers_dev.limits.input_window", "safe.input_window", "most direct measurement", "never 0", "system prompt", "99 %", "101 %", "912,780", "931,220", "lowest", "at_least", "measured_refused", "scope", "limit.input", "limit.context", "from_measurement", "none stated", "window", "bracket", "input_read", "limit-not-counted", "measured_input_accepted", "not contradicted is not confirmed", "probe's count"]) expect(text).toContain(words);
    expect(text).toContain("912,780 or less) above an accepted one");
    expect(text).not.toContain("below an accepted one");
  });
});

describe("the input window of a model", () => {
  const known = (tokens: number, bound: "limit" | "at_least", scope: "input" | "window" = "window") =>
    ({ ...summaryOf().input_window, tokens, bound, scope, basis: bound === "at_least" ? "measured" : "documented" }) as Summary["input_window"];
  const entries = (windows: [string, Summary["input_window"]][]): Summary[] => windows.map(([ref, input_window]) => summaryOf({ ref, input_window }));

  it("gives the smallest and the largest input_window among its entries, each with its entry, and counts those with none", () => {
    expect(inputWindowRange(entries([["a/m", known(1000000, "limit")], ["b/m", summaryOf().input_window], ["c/m", known(850000, "limit", "input")], ["d/m", known(921500, "at_least", "input")]]))).toEqual({
      input_window_min: { entry_ref: "c/m", tokens: 850000, bound: "limit", basis: "documented", scope: "input" },
      input_window_max: { entry_ref: "a/m", tokens: 1000000, bound: "limit", basis: "documented", scope: "window" },
      input_window_unknown_count: 1,
    });
    expect(inputWindowRange(entries([["a/m", summaryOf().input_window], ["b/m", summaryOf().input_window]]))).toEqual({ input_window_min: null, input_window_max: null, input_window_unknown_count: 2 });
    expect(inputWindowRange([])).toEqual({ input_window_min: null, input_window_max: null, input_window_unknown_count: 0 });
  });

  it("counts a lower bound as the larger at an equal number, and takes the first in the model's order where records rank the same", () => {
    const tie = inputWindowRange(entries([["a/m", known(1000000, "limit")], ["b/m", known(1000000, "at_least", "input")], ["c/m", known(1000000, "limit")]]));
    expect([tie.input_window_min?.entry_ref, tie.input_window_min?.bound, tie.input_window_max?.entry_ref, tie.input_window_max?.bound]).toEqual(["a/m", "limit", "b/m", "at_least"]);
    const low = inputWindowRange(entries([["a/m", known(922000, "limit", "input")], ["b/m", known(921500, "at_least", "input")], ["c/m", known(1050000, "limit", "input")]]));
    expect([low.input_window_min?.entry_ref, low.input_window_min?.bound, low.input_window_max?.entry_ref]).toEqual(["b/m", "at_least", "c/m"]);
  });

  it("gives the input window of the reference entry, the lab's own, and null where there is none or it is not known", () => {
    const model = (windows: [string, Summary["input_window"]][]) => canonicalModels(windows.map(([provider, input_window]) => summaryOf({ ref: `${provider}/m`, provider, model: "m", canonical_id: "lab/m", input_window })))[0]!;
    expect(model([["p", known(850000, "limit", "input")], ["lab", known(1000000, "limit")]])).toMatchObject({ reference_ref: "lab/m", input_window_reference: { entry_ref: "lab/m", tokens: 1000000, bound: "limit", basis: "documented", scope: "window" } });
    expect(model([["p", known(850000, "limit", "input")], ["lab", summaryOf().input_window]])).toMatchObject({ reference_ref: "lab/m", input_window_reference: null });
    expect(model([["p", known(850000, "limit", "input")], ["q", known(1000000, "limit")]])).toMatchObject({ reference_ref: null, input_window_reference: null });
  });

  it("is on every model of the list and of the detail, always with the four keys, as the entries under it say", async () => {
    const list = await json<{ data: Record<string, unknown>[] }>("/api/v1/models?limit=200");
    for (const model of list.data) for (const key of ["input_window_min", "input_window_max", "input_window_unknown_count", "input_window_reference"]) expect(model, `${String(model.id)} ${key}`).toHaveProperty(key);
    const detail = await json<{ data: { entries: Summary[] } & Record<string, unknown> }>("/api/v1/models/lab/model-2");
    expect(detail.data).toMatchObject(inputWindowRange(detail.data.entries));
    expect(detail.data.input_window_min).not.toBeNull();
    const document = await json<{ components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> } }>("/api/v1/openapi.json");
    for (const name of ["CanonicalModel", "CanonicalModelDetail"]) expect(document.components.schemas[name]!.required).toEqual(expect.arrayContaining(["input_window_min", "input_window_max", "input_window_unknown_count", "input_window_reference"]));
    expect(Object.keys(document.components.schemas.ModelInputWindowEnd!.properties!)).toEqual(["entry_ref", "tokens", "bound", "basis", "scope"]);
  });
});

describe("listings: the contract and the two paths (1.5.0)", () => {
  /** A snapshot whose listings file holds `data`: the rest is the fixture's. */
  const withListings = (data: Listing[]): ApiDeps => ({
    ...deps,
    asset: async (path: string) => {
      if (path === "/data/listings.json") return new Response(JSON.stringify({ meta: {}, data: data.map((item) => ({ ...item, models: null })) }));
      const own = data.find((item) => path === `/data/listings/${item.provider}.json`);
      return own ? new Response(JSON.stringify({ meta: {}, data: own })) : path.startsWith("/data/listings/") ? null : deps.asset(path);
    },
  });
  const ask = async (local: ApiDeps, path: string): Promise<Response> => handleApi(new Request(`https://providers.dev${path}`), local);
  const sources = { name: null, owner: null, released: null, context_window: null, max_input: null, max_output: null, input_modalities: null, output_modalities: null, reasoning: { supported: null, levels: null, budget_min: null, budget_max: null, can_disable: null, dynamic: null, disable_with: null }, web_search: null, aliases: null, variants: null, plans: null, hidden: null };
  const model = { id: "m", name: null, owner: null, entry: null, canonical: null, released: null, context_window: null, max_input: null, max_output: null, input_modalities: null, output_modalities: null, reasoning: null, web_search: null, aliases: [], variants: [], plans: [], hidden: null, listed_by: ["listed"] as ListingSource[], sources };
  const listing = (provider: string): Listing => ({ provider, basis: "listed", listed_at: "2026-11-22", lists: { listed: { listed_at: "2026-11-22", model_count: 1 }, "providers.dev": null, "models.dev": null, "pi.dev": null }, client: "provimux", client_label: "Provimux", evidence: [], model_count: 1, models: [model] });

  it("answers an empty page when there is no listing", async () => {
    const response = await ask(withListings([]), "/api/v1/listings?view=full");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(pageOf(ListingSchema).safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ total: 0, offset: 0, next_offset: null, data: [] });
  });

  it("gives models only with view=full, with the same keys in both views, and filters by provider and basis", async () => {
    const local = withListings([listing("a"), listing("b")]);
    const short = (await (await ask(local, "/api/v1/listings")).json()) as { data: Listing[] };
    const full = (await (await ask(local, "/api/v1/listings?view=full")).json()) as { data: Listing[] };
    expect(short.data.map((item) => item.models)).toEqual([null, null]);
    expect(full.data.map((item) => item.models)).toEqual([[model], [model]]);
    expect(Object.keys(short.data[0]!)).toEqual(Object.keys(full.data[0]!));
    for (const item of [...short.data, ...full.data]) expect(ListingSchema.safeParse(item).success).toBe(true);
    expect(((await (await ask(local, "/api/v1/listings?provider=b")).json()) as { data: Listing[] }).data.map((item) => item.provider)).toEqual(["b"]);
    expect(((await (await ask(local, "/api/v1/listings?basis=models.dev")).json()) as { total: number }).total).toBe(0);
    expect((await ask(local, "/api/v1/listings?basis=router")).status).toBe(400);
    expect((await ask(local, "/api/v1/listings?view=all")).status).toBe(400);
  });

  it("holds a page in full to 40 listings, 40 by default, and pages through every one; view=summary keeps 1 to 200 (1.5.1)", async () => {
    const local = withListings(Array.from({ length: 95 }, (_, i) => listing(`p${String(i).padStart(2, "0")}`)));
    const first = (await (await ask(local, "/api/v1/listings?view=full")).json()) as { limit: number; next_offset: number | null; data: Listing[] };
    expect([first.limit, first.data.length, first.next_offset]).toEqual([40, 40, 40]);
    expect((await ask(local, "/api/v1/listings?view=full&limit=40")).status).toBe(200);
    for (const limit of [41, 49, 200]) {
      const refused = await ask(local, `/api/v1/listings?view=full&limit=${limit}`);
      expect(refused.status, `limit ${limit}`).toBe(400);
      expect(((await refused.json()) as { error: unknown }).error).toEqual({ code: "invalid_parameters", message: "One or more query parameters are not valid.", details: [{ param: "limit", message: "Must be between 1 and 40 with view=full." }] });
    }
    // Beyond 200 the message is the one of every list.
    expect(((await (await ask(local, "/api/v1/listings?view=full&limit=201")).json()) as { error: { details: unknown } }).error.details).toEqual([{ param: "limit", message: "Must be between 1 and 200." }]);
    const seen: string[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      const shown = (await (await ask(local, `/api/v1/listings?view=full&offset=${offset}`)).json()) as { next_offset: number | null; data: Listing[] };
      seen.push(...shown.data.map((item) => item.provider));
      offset = shown.next_offset;
    }
    expect(seen).toEqual(Array.from({ length: 95 }, (_, i) => `p${String(i).padStart(2, "0")}`));
    const summary = (await (await ask(local, "/api/v1/listings?limit=200")).json()) as { limit: number; data: Listing[] };
    expect([summary.limit, summary.data.length]).toEqual([200, 95]);
    expect(((await (await ask(local, "/api/v1/listings")).json()) as { limit: number }).limit).toBe(50);
  });

  it("gives one listing with its models, 404 listing_not_found otherwise", async () => {
    const local = withListings([listing("provider-02")]);
    const one = (await (await ask(local, "/api/v1/listings/provider-02")).json()) as { data: Listing };
    expect(one.data.models).toEqual([model]);
    const known = await ask(local, "/api/v1/listings/provider-03");
    expect(known.status).toBe(404);
    expect(((await known.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "listing_not_found", message: expect.stringContaining("has no listing") });
    expect(((await (await ask(local, "/api/v1/listings/nobody")).json()) as { error: { message: string } }).error.message).toContain('No provider "nobody"');
    expect((await ask(local, "/api/v1/listings/provider-02?view=full")).status).toBe(400);
  });

  it("is in the OpenAPI document: two paths, the Listing components with every key required, meta.listings, and a guide section", async () => {
    const document = (await (await get("/api/v1/openapi.json")).json()) as { paths: Record<string, unknown>; "x-guide": { id: string; paragraphs: string[] }[]; components: { schemas: Record<string, { properties: Record<string, unknown>; required: string[] }> } };
    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining(["/api/v1/listings", "/api/v1/listings/{provider}"]));
    const schemas = document.components.schemas;
    for (const name of ["Listing", "ListingModel", "ListingReasoning", "ListingSources", "ListingReasoningSources", "ListingList", "ListingLists"]) expect(schemas[name]!.required, name).toEqual(Object.keys(schemas[name]!.properties));
    expect(Object.keys(schemas.Listing!.properties)).toEqual(["provider", "basis", "listed_at", "lists", "client", "client_label", "evidence", "model_count", "models"]);
    expect(Object.keys(schemas.ListingModel!.properties).slice(-2)).toEqual(["listed_by", "sources"]);
    expect(Object.keys(schemas.ListingLists!.properties)).toEqual(["listed", "providers.dev", "models.dev", "pi.dev"]);
    expect(Object.keys((schemas.Meta!.properties.listings as { properties: Record<string, unknown> }).properties)).toEqual(["count", "models", "by_basis", "source", "fetched_at", "checked_at", "listed_at", "sync"]);
    const text = document["x-guide"].find((section) => section.id === "listings")!.paragraphs.join(" ");
    for (const words of ["Since 1.5.0", "need not be an entry", "Since 1.6.0 the models of a listing are every model any of the four lists", "listed_by", "Until 1.5.1 the models were taken whole from basis", "no prices, allowances or quotas"]) expect(text).toContain(words);
    const meta = (await (await get("/api/v1/meta")).json()) as { data: Meta };
    expect(meta.data.listings.source).toBe("https://raw.githubusercontent.com/ngvoicu/groundtruth/main/listed.json");
  });
});

describe("the contract", () => {
  /** Every answer of the API is checked against the definition the OpenAPI document is generated from. */
  const holds = async (dir: string): Promise<void> => {
    const local = depsFrom(dir);
    const ask = async (path: string): Promise<unknown> => (await handleApi(new Request(`https://providers.dev${path}`), local)).json();
    expect(await contractProblems(dir)).toEqual([]);
    const exported = JSON.parse(readFileSync(join(dir, "site", "api.json"), "utf8")) as Catalog;

    // One structure. Everything providers.dev publishes of its own has the same keys on every object of its kind:
    // what is not known is null, what is empty is an empty list, and nothing is left out.
    const shapes = (items: readonly object[]): string[] => [...new Set(items.map((item) => Object.keys(item).sort().join(",")))];
    const same = (items: readonly object[], what: string): void => expect(shapes(items).length, `${what}: ${shapes(items).slice(0, 2).join(" | ")}`).toBeLessThanOrEqual(1);
    same(local.index.entries, "entry summaries");
    same(local.index.entries.map((entry) => entry.input_window), "input_window of a summary");
    // context, input and the three measured_* keys of every summary are what they were (limit as published, max_output
    // the safe maximum output since 1.4.0):
    // and the widest accepted, the narrowest refused and the number of limit evaluations, whether they count or not.
    const asBefore: string[] = [];
    for (const entry of local.index.entries) {
      const full = exported[entry.provider]!.models[entry.model]!;
      const limit = (typeof full.limit === "object" && full.limit !== null ? full.limit : {}) as Record<string, unknown>;
      const number = (value: unknown) => (typeof value === "number" ? value : null);
      const measured = (full.providers_dev as unknown as ModelExtension).limits.measured;
      const accepted = measured.flatMap((item) => (item.input_accepted === null ? [] : [item.input_accepted]));
      const refused = measured.flatMap((item) => (item.input_refused === null ? [] : [item.input_refused]));
      const safe = (full.providers_dev as unknown as ModelExtension).safe;
      // max_output is the safe maximum output since 1.4.0; a published limit.output above 0 that no measurement wrote is
      // models.dev's or providers.dev's statement, and the safe value where nothing was measured.
      const output = number(limit.output);
      if (output !== null && output > 0 && !(full.providers_dev as unknown as ModelExtension).limits.from_measurement.includes("output") && safe.max_output.sources.every((item) => item.source !== "measured") && safe.max_output.value !== output) asBefore.push(`${entry.ref} max_output`);
      if (!isDeepStrictEqual(entry.safe, safe)) asBefore.push(`${entry.ref} safe`);
      const expected = {
        context: number(limit.context), input: number(limit.input), max_output: safe.max_output.value,
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
    same(extensions.map((extension) => extension.safe), "safe");
    same(extensions.flatMap((extension) => [extension.safe.input_window, extension.safe.max_output, extension.safe.cache_short, extension.safe.cache_long]), "a safe value");
    same(extensions.flatMap((extension) => [extension.safe.input_window, extension.safe.max_output, extension.safe.cache_short, extension.safe.cache_long].flatMap((value) => value.sources)), "a source's value");
    same(extensions.flatMap((extension) => extension.safe.price.sources), "a source's price");
    expect(safeBreaks(exported)).toEqual([]);
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
    // The listings (1.5.0): every listing, model, reasoning record and sources record has the same keys, in both views.
    const listings: Listing[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      const shown = (await ask(`/api/v1/listings?view=full&offset=${offset}`)) as { data: Listing[]; next_offset: number | null };
      listings.push(...shown.data);
      offset = shown.next_offset;
    }
    same(listings, "listings");
    same(((await ask("/api/v1/listings?limit=200")) as { data: Listing[] }).data, "listings without view=full");
    const listed = listings.flatMap((listing) => listing.models ?? []);
    same(listed, "listed models");
    same(listed.flatMap((model) => (model.reasoning ? [model.reasoning] : [])), "reasoning of a listed model");
    same(listed.map((model) => model.sources), "sources of a listed model");
    same(listed.map((model) => model.sources.reasoning), "sources.reasoning of a listed model");
    same(listings.flatMap((listing) => listing.evidence), "evidence of a listing");

    // The cache lifetime record of every entry keeps the rules of section 2.6 of design/safe-cache-lifetime.md, and its
    // safe value is the documented lifetime exactly where no counted evaluation contradicts it, redone from evaluations[].
    const broken = Object.entries(exported).flatMap(([id, provider]) =>
      Object.entries(provider.models).flatMap(([modelId, entry]) => {
        const cache = (entry.providers_dev as unknown as ModelExtension).cache;
        const extension = entry.providers_dev as unknown as ModelExtension;
        return lifetimeRuleBreaks(cache.lifetime, cache.evaluations, cache.documented, extension.access).map((rule) => `${id}/${modelId}: ${rule}`);
      }),
    );
    expect(broken).toEqual([]);

    // The input window record of every entry keeps the rules of section 2.6 of design/usable-input-window.md, redone
    // from the published entry alone: its limit, limits.from_measurement and limits.measured.
    const windowBreaks = Object.entries(exported).flatMap(([id, provider]) =>
      Object.entries(provider.models).flatMap(([modelId, entry]) => {
        const limits = (entry.providers_dev as unknown as ModelExtension).limits;
        return inputWindowRuleBreaks(limits.input_window, (entry as { limit?: unknown }).limit, limits.from_measurement, limits.measured, (entry.providers_dev as unknown as ModelExtension).access).map((rule) => `${id}/${modelId}: ${rule}`);
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

  it("gives the fixture's added login the window measured directly; the proxy's lower values are evidence and count for nothing", () => {
    const window = deps.index.entries.find((entry) => entry.ref === "added-login/lab/model-2")!;
    const extension = JSON.parse(readFileSync(join(published, "site", "api.json"), "utf8"))["added-login"].models["lab/model-2"].providers_dev as ModelExtension;
    const record = extension.limits.input_window;
    expect(window.measured_limit_count).toBe(4);
    // On a login the vendor's own client counts first; it measured nothing that counts, so direct does: the named window.
    expect(record).toMatchObject({ tokens: 900000, basis: "measured", bound: "limit", scope: "window", documented_tokens: 900000, documented_field: "limit.context", documented_source: "providers.dev", documented_date: "2026-11-01", documented_status: "not_contradicted", measured_kind: "window", measured_date: "2026-11-10", clients: 1, evaluations: 1 });
    expect(record.measurements.map((item) => [item.client, item.kind, item.tokens, item.client_kind, item.chosen])).toEqual([["agent", "accepted", 600000, "proxy", false], ["proxy", "bracket", 850000, "proxy", false], ["direct", "window", 900000, "direct", true]]);
    // providers.dev's figure from the entry's file beside it agrees.
    expect(extension.safe.input_window).toMatchObject({ value: 900000, source: "measured", agreement: "agree", sources: [{ source: "measured", client: "direct", client_kind: "direct" }, { source: "providers.dev", value: 900000, scope: "window", date: "2026-11-01" }] });
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

  it("marks Not counted the limit evaluations whose item the API publishes with chosen false, and no other", async () => {
    // added-login/lab/model-2, a login: the direct window counts; the proxy's bracket and the agent's read size do not;
    // the vendor's client gave no window, so it has no item to say anything of.
    const html = await (await page("/entries/added-login/lab/model-2")).text();
    const rows = [...html.slice(html.indexOf("<h3>Limit evaluations")).matchAll(/<tr( class="not-counted")?><td data-label="Date">[\s\S]*?<div class="hint">([^<]*)(<span class="chip not-counted")?/g)].map((match) => [match[2]!.trim(), Boolean(match[1]) && Boolean(match[3])]);
    expect(rows.sort()).toEqual([["Client agent", true], ["Client cli", false], ["Client direct", false], ["Client proxy", true]]);
    const record = (await json<{ data: { entry: { providers_dev: ModelExtension } } }>("/api/v1/entries/added-login/lab/model-2")).data.entry.providers_dev.limits.input_window.measurements;
    expect(record.filter((item) => !item.chosen).map((item) => item.client).sort()).toEqual(["agent", "proxy"]);
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
      // summarize() writes pi null; the build writes the block in short from the entry's checked block.
      expect({ ...summarize(entry.provider, model, entry.shard), pi: piShort(ext(model).pi) }).toEqual(entry);
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
