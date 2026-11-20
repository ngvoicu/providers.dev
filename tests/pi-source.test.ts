// pi's catalog in the dataset (design/pi-source.md, sections c to f and i): the block, its differences, /meta.pi.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { publish } from "../scripts/lib/publish.ts";
import { piProviderFile, sync } from "../scripts/lib/sync.ts";
import { pretty } from "../scripts/lib/files.ts";
import { summarize, type Summary } from "../src/core/entries.ts";
import type { JsonObject } from "../src/core/merge.ts";
import { PiBlockSchema, PiDifferenceSchema, PiSummarySchema } from "../src/core/contract.ts";
import { PiAliases, piBlock, piDifferences, PiFeed, type PiCatalog, type PiModel, type PiReport } from "../src/core/pi.ts";
import { resolve, type ResolveInput } from "../src/core/resolve.ts";
import { ext, UpstreamModel, type AccessRules, type Catalog, type CatalogRules, type Evidence, type Meta, type OverrideFile, type UpstreamCatalog } from "../src/core/schema.ts";
import { fetchReturning, fixturePi, fixtureUpstream, ROOT, tempDataDir, writeAuthored } from "./helpers.ts";

const evidence: Evidence[] = [{ kind: "documented", url: "https://example.com/docs", date: "2026-11-01" }];
const access: AccessRules = { default: "api", default_basis: "default", patterns: [], providers: {} };

/** A pi model with every field the import requires, and `more` over it. */
function piModel(provider: string, id: string, more: Partial<PiModel> & Record<string, unknown> = {}): PiModel {
  return {
    id, name: `Pi ${id}`, api: "openai-completions", provider, baseUrl: `https://api.${provider}.example/v1`, reasoning: false, input: ["text"],
    cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8000, type: "chat",
    ...more,
  } as PiModel;
}

/** One provider with entries that state what the cases compare against. */
function upstream(): UpstreamCatalog {
  return {
    lab: {
      id: "lab",
      name: "Lab",
      models: {
        plain: { id: "plain", name: "Plain", family: "plain", release_date: "2026-05-01", limit: { context: 200000, output: 8000 }, cost: { text: { input: { price: 1, cache: { read: 0.1 } }, output: { price: 4 } } } },
        other: { id: "other", name: "Other", limit: { context: 100000, output: 4000 } },
        old: { id: "old", name: "Old", family: "old", release_date: "2025-03-01", limit: { context: 100000, output: 4000 } },
        gone: { id: "gone", name: "Gone", limit: { context: 100000, output: 4000 } },
      },
    },
  };
}

const releasedBefore2026: CatalogRules = { exclude: [], exclude_released: [{ id: "released-2025", from: "2025-01-01", before: "2026-01-01", leaves_out: "Models released in 2025", reason: "Editorial choice.", date: "2026-11-16" }], placeholder_release_dates: [] };
const excludeGone: OverrideFile = { provider: "lab", rules: [{ models: ["gone"], exclude: true, reason: "Withdrawn", evidence }] };

function input(pi: PiCatalog | undefined, more: Partial<ResolveInput> = {}): ResolveInput {
  return { upstream: upstream(), additions: [], overrides: [], access, routes: {}, ...(pi ? { pi: { catalog: pi } } : {}), ...more };
}

const blockOf = (catalog: Catalog, provider: string, model: string) => ext(catalog[provider]!.models[model]!).pi;
const summaries = (catalog: Catalog): Summary[] => Object.entries(catalog).flatMap(([id, provider]) => Object.values(provider.models).map((model) => summarize(id, model, 0)));

/** An entry for piDifferences: its limit and cost as published. */
const entry = (limit: JsonObject | undefined, cost: JsonObject | undefined) => ({ limit, cost });
const plainCost = { text: { input: { price: 1, cache: { read: 0.1, write: 1.25 } }, output: { price: 4 } } };
const agreeing = (more: Partial<PiModel> = {}) => piModel("lab", "plain", { cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 }, ...more });

describe("the pi block (step 4)", () => {
  it("1. a matched entry carries the block with every key and match id; its summary the short form; an unlisted entry has null", () => {
    const pi: PiCatalog = { lab: { plain: piModel("lab", "plain"), stray: piModel("lab", "stray") } };
    const result = resolve(input(pi));
    const block = blockOf(result.catalog, "lab", "plain")!;
    expect(PiBlockSchema.parse(block)).toEqual(block);
    expect(Object.keys(block)).toEqual(Object.keys(PiBlockSchema.shape));
    expect(block).toMatchObject({ ref: "lab/plain", provider: "lab", model: "plain", match: "id", name: "Pi plain", api: "openai-completions" });
    const summary = summarize("lab", result.catalog.lab!.models.plain!, 0);
    expect(summary.pi).toEqual({ ref: "lab/plain", api: "openai-completions", match: "id", difference_count: 0 });
    expect(PiSummarySchema.parse(summary.pi)).toEqual(summary.pi);
    // A pi model with no entry adds nothing and is counted unmatched; an entry pi does not list has null.
    expect(result.catalog.lab!.models.stray).toBeUndefined();
    expect(blockOf(result.catalog, "lab", "other")).toBeNull();
    expect(summarize("lab", result.catalog.lab!.models.other!, 0).pi).toBeNull();
    expect(result.pi!.totals).toEqual({ models: 2, matched_id: 1, matched_alias: 0, left_out: 0, unmatched: 1 });
  });

  it("2. a pi model whose entry an override or a catalog rule leaves out is left out, and nothing is published for it", () => {
    const pi: PiCatalog = { lab: { gone: piModel("lab", "gone"), old: piModel("lab", "old"), plain: piModel("lab", "plain") } };
    const result = resolve(input(pi, { overrides: [excludeGone], catalogRules: releasedBefore2026 }));
    expect(Object.keys(result.catalog.lab!.models).sort()).toEqual(["other", "plain"]);
    expect(result.pi!.totals).toEqual({ models: 3, matched_id: 1, matched_alias: 0, left_out: 2, unmatched: 0 });
  });

  it.each<[string, Partial<PiModel>, JsonObject | undefined, JsonObject | undefined, object]>([
    ["context_window", { contextWindow: 1000000 }, { context: 1048576, output: 8000 }, plainCost, { field: "context_window", entry_field: "limit.context", unit: "tokens", pi: 1000000, published: 1048576 }],
    ["max_tokens", { maxTokens: 64000 }, { context: 200000, output: 65536 }, plainCost, { field: "max_tokens", entry_field: "limit.output", unit: "tokens", pi: 64000, published: 65536 }],
    ["cost.input", { cost: { input: 1.32, output: 4, cacheRead: 0.1, cacheWrite: 1.25 } }, { context: 200000, output: 8000 }, plainCost, { field: "cost.input", entry_field: "cost.text.input.price", unit: "usd_per_million_tokens", pi: 1.32, published: 1 }],
    ["cost.output", { cost: { input: 1, output: 3.96, cacheRead: 0.1, cacheWrite: 1.25 } }, { context: 200000, output: 8000 }, plainCost, { field: "cost.output", entry_field: "cost.text.output.price", pi: 3.96, published: 4 }],
    ["cost.cache_read", { cost: { input: 1, output: 4, cacheRead: 0.2, cacheWrite: 1.25 } }, { context: 200000, output: 8000 }, plainCost, { field: "cost.cache_read", entry_field: "cost.text.input.cache.read", pi: 0.2, published: 0.1 }],
    ["cost.cache_write", { cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 2 } }, { context: 200000, output: 8000 }, plainCost, { field: "cost.cache_write", entry_field: "cost.text.input.cache.write", pi: 2, published: 1.25 }],
    ["cost.tiers", { cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25, tiers: [{ inputTokensAbove: 200000, input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 }] } }, { context: 200000, output: 8000 }, plainCost, { field: "cost.tiers", entry_field: "cost.text", pi: null, published: null, pi_tiers: [{ input_tokens_above: 200000, input: 2, output: 8, cache_read: 0.2, cache_write: 2.5 }], published_tiers: [] }],
  ])("3. a difference in %s is listed with both values", (_field, more, limit, cost, expected) => {
    const differences = piDifferences(agreeing(more), entry(limit, cost));
    expect(differences).toHaveLength(1);
    expect(differences[0]).toMatchObject({ pi_tiers: null, published_tiers: null, ...expected });
    expect(Object.keys(differences[0]!)).toEqual(["field", "entry_field", "unit", "pi", "published", "pi_tiers", "published_tiers"]);
  });

  it("3. several differences come in the fixed order of the table", () => {
    const model = agreeing({ contextWindow: 1, maxTokens: 2, cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9, tiers: [{ inputTokensAbove: 5, input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }] } });
    expect(piDifferences(model, entry({ context: 200000, output: 8000 }, plainCost)).map((item) => item.field)).toEqual(["context_window", "max_tokens", "cost.input", "cost.output", "cost.cache_read", "cost.cache_write", "cost.tiers"]);
  });

  it("4. agreeing values give no difference; prices that differ only beyond the sixth decimal differ (no tolerance)", () => {
    expect(piDifferences(agreeing(), entry({ context: 200000, output: 8000 }, plainCost))).toEqual([]);
    const close = agreeing({ cost: { input: 1.0000001, output: 3.9999999, cacheRead: 0.1000004, cacheWrite: 1.25 } });
    expect(piDifferences(close, entry({ context: 200000, output: 8000 }, plainCost))).toMatchObject([
      { field: "cost.input", pi: 1.0000001, published: 1 },
      { field: "cost.output", pi: 3.9999999, published: 4 },
      { field: "cost.cache_read", pi: 0.1000004, published: 0.1 },
    ]);
    // Unrounded values are listed where they do differ.
    const apart = agreeing({ cost: { input: 1.000001, output: 4, cacheRead: 0.1, cacheWrite: 1.25 } });
    expect(piDifferences(apart, entry({ context: 200000, output: 8000 }, plainCost))).toMatchObject([{ field: "cost.input", pi: 1.000001, published: 1 }]);
  });

  describe("4, third review: two prices agree exactly when they are the same number", () => {
    // The reviewer's pairs. Rounded to 6 decimals the first would be 0.030037 and 0.030038, the second 0.030037 twice;
    // `Math.round(x * 1e6)` called the first equal and the second different.
    const pairs: [string, number, number][] = [
      ["0.030037499999999998 and 0.0300376 are a difference: the numbers are not the same", 0.030037499999999998, 0.0300376],
      ["0.0300374 and 0.030037499999999998 are a difference too: the numbers are not the same, equal at 6 decimals or not", 0.0300374, 0.030037499999999998],
    ];
    it.each(pairs)("as a plain price: %s", (_name, pi, published) => {
      const model = agreeing({ cost: { input: pi, output: 4, cacheRead: 0.1, cacheWrite: 1.25 } });
      expect(piDifferences(model, entry(undefined, { text: { input: { price: published, cache: { read: 0.1, write: 1.25 } }, output: { price: 4 } } }))).toEqual([
        { field: "cost.input", entry_field: "cost.text.input.price", unit: "usd_per_million_tokens", pi, published, pi_tiers: null, published_tiers: null },
      ]);
    });
    it.each(pairs)("inside a tier: %s", (_name, pi, published) => {
      const model = agreeing({ cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25, tiers: [{ inputTokensAbove: 32000, input: pi, output: 8, cacheRead: 0, cacheWrite: 0 }] } });
      const cost = { text: { input: { price: 1, cache: { read: 0.1, write: 1.25 }, overrides: [{ when: { context: { gt: 32000 } }, price: published }] }, output: { price: 4, overrides: [{ when: { context: { gt: 32000 } }, price: 8 }] } } };
      expect(piDifferences(model, entry(undefined, cost))).toMatchObject([{ field: "cost.tiers", pi_tiers: [{ input_tokens_above: 32000, input: pi }], published_tiers: [{ input_tokens_above: 32000, input: published }] }]);
    });
    it("1.50 in one feed and 1.5 in the other are the same number: no difference, plain or in a tier", () => {
      const feeds = JSON.parse('{"pi": {"input": 1.50, "output": 4, "cacheRead": 0.1, "cacheWrite": 1.25, "tiers": [{"inputTokensAbove": 32000, "input": 1.50, "output": 8, "cacheRead": 0, "cacheWrite": 0}]}, "entry": {"text": {"input": {"price": 1.5, "cache": {"read": 0.1, "write": 1.25}, "overrides": [{"when": {"context": {"gt": 32000}}, "price": 1.5}]}, "output": {"price": 4, "overrides": [{"when": {"context": {"gt": 32000}}, "price": 8}]}}}}');
      expect(piDifferences(agreeing({ cost: feeds.pi }), entry(undefined, feeds.entry))).toEqual([]);
    });
  });

  it("5. no difference where the entry has no value, where pi's price or a limit is 0, where the cache write is keyed by lifetime, where the price has a unit", () => {
    const differing = piModel("lab", "plain", { contextWindow: 5, maxTokens: 5, cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } });
    // The entry has no value.
    expect(piDifferences(differing, entry(undefined, undefined))).toEqual([]);
    expect(piDifferences(differing, entry({}, { text: {} }))).toEqual([]);
    // A limit of 0 on the entry's side, or on pi's.
    expect(piDifferences(differing, entry({ context: 0, output: 0 }, undefined))).toEqual([]);
    expect(piDifferences(piModel("lab", "plain", { contextWindow: 0, maxTokens: 0 }), entry({ context: 200000, output: 8000 }, undefined))).toEqual([]);
    // pi's price of 0 is also its "no price recorded"; the entry's 0 is a listed zero price and is compared.
    const free = piModel("lab", "plain", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(piDifferences(free, entry(undefined, plainCost))).toEqual([]);
    expect(piDifferences(piModel("lab", "plain", { cost: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 } }), entry(undefined, { text: { input: { price: 0 }, output: { price: 4 } } }))).toMatchObject([{ field: "cost.input", pi: 1, published: 0 }]);
    // A cache write keyed by lifetime.
    expect(piDifferences(piModel("lab", "plain", { cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 9 } }), entry(undefined, { text: { input: { price: 1, cache: { read: 0.1, write: { "5m": 1.25, "1h": 2 } } }, output: { price: 4 } } }))).toEqual([]);
    // A price per character.
    expect(piDifferences(differing, entry(undefined, { text: { input: { price: 1, unit: "character", cache: { read: 0.1 } }, output: { price: 4, unit: "character" } } }))).toEqual([]);
  });

  describe("6. tiers", () => {
    const tierCost = (inputWhen: JsonObject, outputWhen: JsonObject = inputWhen): JsonObject => ({
      text: {
        input: { price: 1, cache: { read: 0.1, write: 1.25 }, overrides: [{ when: inputWhen, price: 2, cache: { read: 0.2, write: 2.5 } }] },
        output: { price: 4, overrides: [{ when: outputWhen, price: 8 }] },
      },
    });
    const withTier = (above: number, input = 2) => agreeing({ cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25, tiers: [{ inputTokensAbove: above, input, output: 8, cacheRead: 0.2, cacheWrite: 2.5 }] } });

    it("equal tiers written with gt on one side and gte on the other agree", () => {
      expect(piDifferences(withTier(32000), entry(undefined, tierCost({ context: { gt: 32000 } })))).toEqual([]);
      expect(piDifferences(withTier(32000), entry(undefined, tierCost({ context: { gte: 32001 } })))).toEqual([]);
      expect(piDifferences(withTier(32000), entry(undefined, tierCost({ context: { gte: 32001 } }, { context: { gt: 32000 } })))).toEqual([]);
    });

    it("a price that differs only in a tier gives exactly one cost.tiers item with both lists", () => {
      const differences = piDifferences(withTier(32000, 3), entry(undefined, tierCost({ context: { gt: 32000 } })));
      expect(differences).toEqual([{
        field: "cost.tiers", entry_field: "cost.text", unit: "usd_per_million_tokens", pi: null, published: null,
        pi_tiers: [{ input_tokens_above: 32000, input: 3, output: 8, cache_read: 0.2, cache_write: 2.5 }],
        published_tiers: [{ input_tokens_above: 32000, input: 2, output: 8, cache_read: 0.2, cache_write: 2.5 }],
      }]);
    });

    it("thresholds one token apart give one item; tiers on one side only give one", () => {
      expect(piDifferences(withTier(31999), entry(undefined, tierCost({ context: { gt: 32000 } }))).map((item) => item.field)).toEqual(["cost.tiers"]);
      expect(piDifferences(withTier(32000), entry(undefined, plainCost)).map((item) => item.field)).toEqual(["cost.tiers"]);
      expect(piDifferences(agreeing(), entry(undefined, tierCost({ context: { gt: 32000 } })))).toMatchObject([{ field: "cost.tiers", pi_tiers: [], published_tiers: [{ input_tokens_above: 32000 }] }]);
    });

    it("an override on service tier or time of day is not a tier, nor one with two conditions", () => {
      for (const when of [{ service_tier: { equals: "priority" } }, { utc_hours: { gte: "01:00", lt: "04:00" } }, { context: { gt: 32000 }, service_tier: { equals: "flex" } }, { context: { lt: 32000 } }]) {
        expect(piDifferences(agreeing(), entry(undefined, tierCost(when as unknown as JsonObject))), JSON.stringify(when)).toEqual([]);
      }
    });
  });

  it("7. a difference follows the published value, after every override", () => {
    const pi: PiCatalog = { lab: { plain: piModel("lab", "plain", { contextWindow: 1000000 }) } };
    expect(blockOf(resolve(input(pi)).catalog, "lab", "plain")!.differences).toMatchObject([{ field: "context_window", pi: 1000000, published: 200000 }]);
    const to = (context: number): OverrideFile => ({ provider: "lab", rules: [{ models: ["plain"], set: { limit: { context } }, reason: "documented", evidence }] });
    expect(blockOf(resolve(input(pi, { overrides: [to(1000000)] })).catalog, "lab", "plain")!.differences).toEqual([]);
    expect(blockOf(resolve(input(pi, { overrides: [to(500000)] })).catalog, "lab", "plain")!.differences).toMatchObject([{ field: "context_window", pi: 1000000, published: 500000 }]);
  });

  it("8. headers, inputLimits.images.resize, lab, enabled, providers and free appear nowhere in the published catalog", () => {
    const pi: PiCatalog = {
      lab: {
        plain: piModel("lab", "plain", { headers: { "X-Secret-Header": "1" }, inputLimits: { maxRequestBytes: 10, images: { maxPerRequest: 5, resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 5, jpegQuality: 80 } } }, lab: "PiLabName", enabled: true, providers: ["a"], free: true, another: 1 } as Partial<PiModel> & Record<string, unknown>),
      },
    };
    const { catalog } = resolve(input(pi));
    const text = JSON.stringify(catalog) + JSON.stringify(summaries(catalog));
    for (const key of ["headers", "X-Secret-Header", "resize", "jpegQuality", "PiLabName", "enabled", "\"providers\":", "\"free\":", "another"]) expect(text, key).not.toContain(key);
    expect(blockOf(catalog, "lab", "plain")!.input_limits).toEqual({ max_request_bytes: 10, max_images_per_request: 5, max_images_per_message: null });
  });

  it("9. what the feed does not state is null, \"\" as base_url is null, absent tiers are [], and no flag is filled in", () => {
    const pi: PiCatalog = { lab: { plain: piModel("lab", "plain", { baseUrl: "" }), other: piModel("lab", "other", { compat: { supportsStore: false }, thinkingLevelMap: { minimal: null, high: "high" }, promptCache: { short: 300 } }) } };
    const { catalog } = resolve(input(pi));
    expect(blockOf(catalog, "lab", "plain")).toMatchObject({ base_url: null, compat: null, thinking_level_map: null, prompt_cache: null, input_limits: { max_request_bytes: null, max_images_per_request: null, max_images_per_message: null }, cost: { tiers: [] } });
    expect(blockOf(catalog, "lab", "other")).toMatchObject({ base_url: "https://api.lab.example/v1", compat: { supportsStore: false }, thinking_level_map: { minimal: null, high: "high" }, prompt_cache: { short_s: 300, long_s: null } });
    expect(Object.keys(blockOf(catalog, "lab", "other")!.compat!)).toEqual(["supportsStore"]);
  });

  it("10. nothing existing moves: the same providers and entries, every record and summary equal without pi, the same exclusions", () => {
    const upstreamCatalog = fixtureUpstream();
    const pi = fixturePi(12, 30);
    // An override leaves out one entry and a release rule every model released in January and February 2026.
    const exclude: OverrideFile = { provider: "provider-01", rules: [{ models: ["model-3"], exclude: true, reason: "Withdrawn", evidence }] };
    const early: CatalogRules = { exclude: [], exclude_released: [{ id: "early-2026", from: "2026-01-01", before: "2026-03-01", leaves_out: "Early 2026", reason: "Editorial choice.", date: "2026-11-16" }], placeholder_release_dates: [] };
    const base: ResolveInput = { upstream: upstreamCatalog, additions: [], overrides: [exclude], access, routes: {}, catalogRules: early };
    const without = resolve(structuredClone(base));
    const withPi = resolve({ ...structuredClone(base), pi: { catalog: pi } });
    expect(withPi.pi!.totals.matched_id).toBeGreaterThan(0);
    expect(withPi.pi!.totals.left_out).toBeGreaterThan(0);
    expect(withPi.exclusions).toEqual(without.exclusions);
    const refs = (catalog: Catalog) => Object.entries(catalog).flatMap(([id, provider]) => Object.keys(provider.models).map((model) => `${id}/${model}`));
    expect(refs(withPi.catalog)).toEqual(refs(without.catalog));
    expect(Object.keys(withPi.catalog)).toEqual(Object.keys(without.catalog));
    const strip = (catalog: Catalog) => {
      const copy = structuredClone(catalog);
      for (const provider of Object.values(copy)) for (const model of Object.values(provider.models)) delete (model.providers_dev as JsonObject).pi;
      return copy;
    };
    expect(strip(withPi.catalog)).toEqual(strip(without.catalog));
    const plain = (items: Summary[]) => items.map(({ pi: _pi, ...rest }) => rest);
    expect(plain(summaries(withPi.catalog))).toEqual(plain(summaries(without.catalog)));
    expect(summaries(withPi.catalog).filter((summary) => summary.pi !== null).length).toBe(withPi.pi!.totals.matched_id);
  });
});

/** A data directory after a sync of models.dev (pi answered with models.dev's body, so it failed) and our authored files. */
async function dataDir(): Promise<string> {
  const dir = tempDataDir();
  await sync({ dataDir: dir, fetch: fetchReturning(JSON.stringify(fixtureUpstream())) });
  writeAuthored(dir);
  return dir;
}
/** Write data/pi/ as the sync would, and the pi key of sync-status.json. */
function writePi(dir: string, catalog: PiCatalog, status: object = { last_attempt_at: "2026-11-20T14:19:45.000Z", status: "updated" }): void {
  mkdirSync(join(dir, "pi", "providers"), { recursive: true });
  for (const [id, models] of Object.entries(catalog)) writeFileSync(join(dir, "pi", "providers", `${id}.json`), piProviderFile(id, models));
  const models = Object.values(catalog).reduce((sum, items) => sum + Object.keys(items).length, 0);
  writeFileSync(join(dir, "pi", "meta.json"), pretty({ source: "https://pi.dev/api/models", fetched_at: "2026-11-20T14:19:45.000Z", checked_at: "2026-11-20T14:19:45.000Z", etag: '"p1"', revision: "sha256-dd93eb27", sha256: "ab".repeat(32), providers: Object.keys(catalog).length, models }));
  const path = join(dir, "sync-status.json");
  writeFileSync(path, pretty({ ...JSON.parse(readFileSync(path, "utf8")), pi: status }));
}
const published = (dir: string) => ({
  meta: JSON.parse(readFileSync(join(dir, "published", "site", "data", "meta.json"), "utf8")) as Meta,
  catalog: JSON.parse(readFileSync(join(dir, "published", "site", "api.json"), "utf8")) as Catalog,
  index: JSON.parse(readFileSync(join(dir, "published", "site", "data", "index.json"), "utf8")) as { entries: Summary[] },
});
const blocks = (catalog: Catalog) => Object.values(catalog).flatMap((provider) => Object.values(provider.models)).filter((model) => (model.providers_dev as JsonObject).pi !== null).length;

describe("the pi snapshot in the data build (step 4)", () => {
  it("11. without a pi snapshot the dataset builds with pi null everywhere; a snapshot that does not fit PiFeed does the same, with a warning", async () => {
    const dir = await dataDir();
    expect(publish({ dataDir: dir, rootDir: ROOT }).errors).toEqual([]);
    let out = published(dir);
    expect(blocks(out.catalog)).toBe(0);
    expect(out.index.entries.every((entry) => entry.pi === null)).toBe(true);
    expect(out.meta.pi.snapshot).toBeNull();
    expect(out.meta.pi.counts).toEqual({ entries_with_block: 0, left_out_models: 0, unmatched_models: 0 });
    expect(out.meta.issues.filter((issue) => issue.code.startsWith("pi-"))).toEqual([]);
    const before = out.meta.dataset_version;

    writePi(dir, fixturePi(12, 30));
    const broken = JSON.parse(readFileSync(join(dir, "pi", "providers", "provider-03.json"), "utf8"));
    broken.models["model-1"].contextWindow = "big";
    writeFileSync(join(dir, "pi", "providers", "provider-03.json"), JSON.stringify(broken));
    const report = publish({ dataDir: dir, rootDir: ROOT });
    expect(report.ok).toBe(true);
    out = published(dir);
    expect(blocks(out.catalog)).toBe(0);
    expect(out.meta.pi.snapshot).toBeNull();
    expect(out.meta.pi.counts).toEqual({ entries_with_block: 0, left_out_models: 0, unmatched_models: 0 });
    expect(out.meta.issues.filter((issue) => issue.code.startsWith("pi-"))).toMatchObject([{ level: "warning", code: "pi-snapshot-unreadable", target: "data/pi" }]);
    expect(out.meta.dataset_version).toBe(before);

    // Not JSON at all: the same.
    writeFileSync(join(dir, "pi", "providers", "provider-03.json"), "{");
    expect(publish({ dataDir: dir, rootDir: ROOT }).issues.map((issue) => issue.code)).toContain("pi-snapshot-unreadable");
  });

  it("12. meta.pi: the three counts add up to the snapshot's models, blocks are counted, and sync follows sync-status.json", async () => {
    const dir = await dataDir();
    // fixtureUpstream has provider-00..29 with 20 models each; fixturePi provider-00..11 with 30, so 10 of each 30 have no entry.
    writePi(dir, fixturePi(12, 30));
    writeFileSync(join(dir, "authored", "catalog-rules.yaml"), stringify(releasedBefore2026));
    expect(publish({ dataDir: dir, rootDir: ROOT }).errors).toEqual([]);
    const out = published(dir);
    const counts = out.meta.pi.counts;
    expect(counts.entries_with_block + counts.left_out_models + counts.unmatched_models).toBe(360);
    expect(counts.entries_with_block).toBe(blocks(out.catalog));
    expect(counts.entries_with_block).toBe(out.index.entries.filter((entry) => entry.pi !== null).length);
    // 12 providers x 20 equal ids, of which the overridden provider-01/model-1 stays; none is released in 2025.
    expect(counts).toEqual({ entries_with_block: 240, left_out_models: 0, unmatched_models: 120 });
    expect(out.meta.pi.snapshot).toMatchObject({ fetched_at: "2026-11-20T14:19:45.000Z", etag: '"p1"', last_modified: null, revision: "sha256-dd93eb27", providers: 12, models: 360 });
    expect(out.meta.pi.sync).toEqual({ last_attempt_at: "2026-11-20T14:19:45.000Z", last_attempt_ok: true, last_error: null });
    expect(readFileSync(join(dir, "published", "site", "data", "LICENSE-pi.txt"), "utf8")).toContain("Copyright (c) 2025 Mario Zechner");
    expect(readFileSync(join(dir, "published", "site", "data", "NOTICE.txt"), "utf8")).toMatch(/pi\.dev\/api\/models[\s\S]*Imported 2026-11-20T14:19:45\.000Z at catalog revision sha256-dd93eb27[\s\S]*not affiliated with or endorsed by pi/);
    // One credit per part (release review, blocker 8): the providers.dev statement excepts providers_dev.pi.
    const notice = readFileSync(join(dir, "published", "site", "data", "NOTICE.txt"), "utf8").replace(/\n/g, " ");
    expect(notice).toContain("Everything under a `providers_dev` key except `providers_dev.pi`, every entry whose `providers_dev.origin` is \"added\" (its `providers_dev.pi` excepted), and every field listed in a `providers_dev.provenance` array is by providers.dev");
    expect(notice).toContain("The pi block of an entry (providers_dev.pi) is imported from the model catalog of pi");

    // A failed pi attempt: last_attempt_ok false with its error; the top-level sync is left alone.
    const topBefore = out.meta.sync;
    writePi(dir, fixturePi(12, 30), { last_attempt_at: "2026-11-21T04:17:00.000Z", status: "failed", error: "pi.dev answered HTTP 503" });
    expect(publish({ dataDir: dir, rootDir: ROOT }).errors).toEqual([]);
    const failed = published(dir).meta;
    expect(failed.pi.sync).toEqual({ last_attempt_at: "2026-11-21T04:17:00.000Z", last_attempt_ok: false, last_error: "pi.dev answered HTTP 503" });
    expect(failed.sync).toEqual(topBefore);
    expect(failed.pi.counts).toEqual(counts);
  });
});

describe("the alias file and the report (step 5)", () => {
  const listed = (note: string): Evidence[] => [{ kind: "listed", url: "https://pi.dev/api/models", date: "2026-11-20", note }];
  const aliases = (providers: object) => PiAliases.parse({ providers });
  /** The catalog of these cases: lab (as above) with one more entry, and a second provider. */
  const catalogWith = (): UpstreamCatalog => {
    const catalog = upstream();
    catalog.lab!.models["gpt-6-1-sol"] = { id: "gpt-6-1-sol", name: "GPT 6.1 Sol" };
    catalog.acme = { id: "acme", name: "Acme", models: { "model-x": { id: "model-x", name: "X" } } };
    return catalog;
  };
  const run = (pi: PiCatalog, file?: PiAliases, more: Partial<ResolveInput> = {}) => resolve({ upstream: catalogWith(), additions: [], overrides: [], access, routes: {}, pi: { catalog: pi, ...(file ? { aliases: file } : {}) }, ...more });
  const piCodes = (issues: { code: string }[]) => issues.filter((issue) => issue.code.startsWith("pi-")).map((issue) => issue.code);

  it("13. a provider same_as: its models reach the paired provider's entries by equal model id, with pi's spelling and match alias", () => {
    const pi: PiCatalog = { "lab-pi": { plain: piModel("lab-pi", "plain"), other: piModel("lab-pi", "other"), nothing: piModel("lab-pi", "nothing") } };
    const result = run(pi, aliases({ "lab-pi": { same_as: "lab", reason: "The same base URL.", evidence: listed("lab-pi: https://api.lab.example/v1") } }));
    expect(blockOf(result.catalog, "lab", "plain")).toMatchObject({ ref: "lab-pi/plain", provider: "lab-pi", model: "plain", match: "alias" });
    expect(blockOf(result.catalog, "lab", "other")).toMatchObject({ ref: "lab-pi/other", match: "alias" });
    expect(result.catalog["lab-pi"]).toBeUndefined();
    expect(result.pi!.totals).toEqual({ models: 3, matched_id: 0, matched_alias: 2, left_out: 0, unmatched: 1 });
    expect(result.pi!.providers).toMatchObject([{ pi_provider: "lab-pi", state: "paired", catalog_provider: "lab", models: 3, matched: 2, unmatched: 1 }]);
    expect(piCodes(result.issues)).toEqual([]);
  });

  it("14. a model same_as gives match alias; a pi model with the entry's own id keeps the entry against an alias that points at it", () => {
    const line = aliases({ lab: { checked: "2026-11-21", models: { "plain-v1": { same_as: "plain" } } } });
    const alone = run({ lab: { "plain-v1": piModel("lab", "plain-v1") } }, line);
    expect(blockOf(alone.catalog, "lab", "plain")).toMatchObject({ ref: "lab/plain-v1", provider: "lab", model: "plain-v1", match: "alias" });

    const both = run({ lab: { plain: piModel("lab", "plain"), "plain-v1": piModel("lab", "plain-v1") } }, line);
    expect(blockOf(both.catalog, "lab", "plain")).toMatchObject({ ref: "lab/plain", match: "id" });
    expect(both.issues.filter((issue) => issue.code === "pi-alias-conflict")).toMatchObject([{ level: "warning", target: "pi/lab/plain-v1" }]);
    expect(both.pi!.unmatched).toEqual([{ pi_provider: "lab", pi_model: "plain-v1", name: "Pi plain-v1", why: "alias-conflict", alike: [] }]);
    expect(both.pi!.totals).toEqual({ models: 2, matched_id: 1, matched_alias: 0, left_out: 0, unmatched: 1 });

    // Two aliases at one entry, neither with its ids: the first by pi provider id, then pi model id, keeps it.
    const two = run({ lab: { "plain-a": piModel("lab", "plain-a"), "plain-b": piModel("lab", "plain-b") } }, aliases({ lab: { checked: "2026-11-21", models: { "plain-b": { same_as: "plain" }, "plain-a": { same_as: "plain" } } } }));
    expect(blockOf(two.catalog, "lab", "plain")).toMatchObject({ ref: "lab/plain-a" });
    expect(two.pi!.unmatched.map((item) => [item.pi_model, item.why])).toEqual([["plain-b", "alias-conflict"]]);
  });

  it("15. orphans, a collision and a redundant line are reported, none as an error, and the build succeeds with each", async () => {
    const pi: PiCatalog = {
      lab: { plain: piModel("lab", "plain"), "other-v2": piModel("lab", "other-v2") },
      "lab-pi": { plain: piModel("lab-pi", "plain") },
      "ghost-pi": { m: piModel("ghost-pi", "m") },
    };
    const file = aliases({
      lab: { same_as: "acme", reason: "r", evidence: listed("x"), checked: "2026-11-21", models: { plain: { same_as: "plain" }, "other-v2": { same_as: "missing" }, "gone-model": { same_as: "other" } } },
      "ghost-pi": { same_as: "nowhere", reason: "r", evidence: listed("x") },
      "gone-pi": { same_as: "acme-two", reason: "r", evidence: listed("x") },
    });
    const result = run(pi, file);
    const codes = result.issues.filter((issue) => issue.code.startsWith("pi-")).map((issue) => `${issue.code} ${issue.target}`).sort();
    expect(codes).toEqual([
      "pi-alias-orphan pi/ghost-pi",
      "pi-alias-orphan pi/gone-pi",
      "pi-alias-orphan pi/lab/gone-model",
      "pi-alias-orphan pi/lab/other-v2",
      "pi-alias-redundant pi/lab/plain",
      "pi-provider-collides pi/lab",
    ]);
    expect(result.issues.filter((issue) => issue.code.startsWith("pi-")).every((issue) => issue.level !== "error")).toBe(true);
    expect(result.issues.find((issue) => issue.code === "pi-alias-redundant")!.level).toBe("notice");
    // The catalog's own provider is used: lab/plain is matched by equal ids, and acme gets nothing.
    expect(blockOf(result.catalog, "lab", "plain")).toMatchObject({ match: "id" });
    expect(blockOf(result.catalog, "acme", "model-x")).toBeNull();
    expect(result.pi!.unmatched.map((item) => [item.pi_provider, item.pi_model, item.why])).toEqual([["ghost-pi", "m", "alias-orphan"], ["lab", "other-v2", "alias-orphan"], ["lab-pi", "plain", "provider-absent"]]);

    // The build succeeds with all of them.
    const dir = await dataDir();
    writePi(dir, fixturePi(12, 30));
    writeFileSync(join(dir, "authored", "pi-aliases.yaml"), stringify({ providers: { "provider-00": { same_as: "provider-01", reason: "r", evidence: listed("x"), checked: "2026-11-21", models: { "lab/model-0": { same_as: "lab/model-0" }, "model-1": { same_as: "missing" }, "not-in-pi": { same_as: "model-3" } } }, "provider-99": { same_as: "nowhere", reason: "r", evidence: listed("x") } } }));
    const report = publish({ dataDir: dir, rootDir: ROOT });
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(new Set(report.issues.filter((issue) => issue.code.startsWith("pi-")).map((issue) => issue.code))).toEqual(new Set(["pi-provider-collides", "pi-alias-orphan", "pi-alias-redundant"]));
  });

  it("16. nothing by similarity: gpt-6.1-sol is not gpt-6-1-sol, and is unmatched with the entry's id under alike", () => {
    const result = run({ lab: { "gpt-6.1-sol": piModel("lab", "gpt-6.1-sol") } });
    expect(blockOf(result.catalog, "lab", "gpt-6-1-sol")).toBeNull();
    expect(result.pi!.unmatched).toEqual([{ pi_provider: "lab", pi_model: "gpt-6.1-sol", name: "Pi gpt-6.1-sol", why: "no-entry", alike: ["gpt-6-1-sol"] }]);
  });

  it("17. a pi provider the catalog does not have and the file does not pair: nothing published, no issue, its models provider-absent", () => {
    const pi: PiCatalog = { radius: { a: piModel("radius", "a", { baseUrl: "https://api.lab.example/v1" }), b: piModel("radius", "b") } };
    const result = run(pi);
    const plain = run({});
    expect(Object.keys(result.catalog)).toEqual(Object.keys(plain.catalog));
    expect(piCodes(result.issues)).toEqual([]);
    expect(result.pi!.unmatched.map((item) => [item.pi_model, item.why])).toEqual([["a", "provider-absent"], ["b", "provider-absent"]]);
    expect(result.pi!.providers).toEqual([{ pi_provider: "radius", state: "absent", catalog_provider: null, models: 2, matched: 0, left_out: 0, unmatched: 2, same_host: [] }]);
  });

  it("18. the report adds up, sits beside site/, is named by nothing under it, and is not written without a pi snapshot", async () => {
    const dir = await dataDir();
    expect(publish({ dataDir: dir, rootDir: ROOT }).errors).toEqual([]);
    expect(existsSync(join(dir, "published", "pi-report.json"))).toBe(false);

    writePi(dir, fixturePi(12, 30));
    writeFileSync(join(dir, "authored", "catalog-rules.yaml"), stringify({ exclude: [], exclude_released: [{ id: "early-2026", from: "2026-01-01", before: "2026-03-01", leaves_out: "Early 2026", reason: "Editorial choice.", date: "2026-11-16" }], placeholder_release_dates: [] }));
    expect(publish({ dataDir: dir, rootDir: ROOT }).errors).toEqual([]);
    const report = JSON.parse(readFileSync(join(dir, "published", "pi-report.json"), "utf8")) as PiReport;
    const meta = published(dir).meta;
    const { totals } = report;
    expect(totals.matched_id + totals.matched_alias + totals.left_out + totals.unmatched).toBe(totals.models);
    expect(totals.models).toBe(meta.pi.snapshot!.models);
    expect(meta.pi.counts).toEqual({ entries_with_block: totals.matched_id + totals.matched_alias, left_out_models: totals.left_out, unmatched_models: totals.unmatched });
    expect(totals.left_out).toBeGreaterThan(0);
    expect(report.left_out.every((item) => item.by === "early-2026")).toBe(true);
    expect(report.providers.reduce((sum, provider) => sum + provider.models, 0)).toBe(totals.models);
    expect(report.unmatched.length).toBe(totals.unmatched);
    const sorted = [...report.unmatched].sort((a, b) => (a.pi_provider === b.pi_provider ? (a.pi_model < b.pi_model ? -1 : 1) : a.pi_provider < b.pi_provider ? -1 : 1));
    expect(report.unmatched).toEqual(sorted);
    // Nothing under site/ is the report or names it.
    const files = readdirSync(join(dir, "published", "site"), { recursive: true }).map(String);
    expect(files.some((file) => file.includes("pi-report"))).toBe(false);
    for (const file of ["api.json", "data/meta.json", "data/index.json", "_headers"]) expect(readFileSync(join(dir, "published", "site", file), "utf8")).not.toContain("pi-report");
  });

  it.each<[string, object, RegExp]>([
    ["an unknown key on the file", { providers: {}, only_pi: true }, /pi-aliases\.yaml: \(file\): Unrecognized key: "only_pi"/],
    ["an unknown key on a provider line", { providers: { fireworks: { same_as: "fireworks-ai", reason: "r", evidence: [{ kind: "listed", url: "https://pi.dev/api/models", date: "2026-11-20" }], new: true } } }, /pi-aliases\.yaml: providers\.fireworks: Unrecognized key: "new"/],
    ["an unknown key on a model line", { providers: { openrouter: { checked: "2026-11-21", models: { "a/b": { same_as: "a/c", inherits: "x" } } } } }, /pi-aliases\.yaml: providers\.openrouter\.models\.a\/b: Unrecognized key: "inherits"/],
    ["a provider same_as without evidence", { providers: { fireworks: { same_as: "fireworks-ai", reason: "r" } } }, /pi-aliases\.yaml: providers\.fireworks\.evidence: A provider line with same_as needs evidence\./],
    ["two pi provider ids with one same_as", { providers: { a: { same_as: "x", reason: "r", evidence: [{ kind: "listed", url: "https://pi.dev/api/models", date: "2026-11-20" }] }, b: { same_as: "x", reason: "r", evidence: [{ kind: "listed", url: "https://pi.dev/api/models", date: "2026-11-20" }] } } }, /pi-aliases\.yaml: providers\.b\.same_as: Two pi provider ids, a and b, have the same same_as x\./],
    ["model lines without checked", { providers: { openrouter: { models: { "a/b": { same_as: "a/c" } } } } }, /pi-aliases\.yaml: providers\.openrouter\.checked: /],
    ["a line with neither same_as nor a model", { providers: { openrouter: {} } }, /pi-aliases\.yaml: providers\.openrouter: A provider line needs same_as or at least one model line\./],
  ])("19. a pi-aliases.yaml with %s fails publish(), naming the file and the path", async (_name, content, words) => {
    const dir = await dataDir();
    writePi(dir, fixturePi(12, 30));
    expect(publish({ dataDir: dir, rootDir: ROOT }).errors).toEqual([]);
    const before = readFileSync(join(dir, "published", "site", "data", "meta.json"), "utf8");
    writeFileSync(join(dir, "authored", "pi-aliases.yaml"), stringify(content));
    const report = publish({ dataDir: dir, rootDir: ROOT });
    expect(report.ok).toBe(false);
    expect(report.errors.some((error) => words.test(error)), report.errors.join("\n")).toBe(true);
    expect(readFileSync(join(dir, "published", "site", "data", "meta.json"), "utf8")).toBe(before);
  });

  it("20. the file in the repository parses against PiAliases, with the eight pairings of the design", () => {
    const file = PiAliases.parse(parseYaml(readFileSync(join(ROOT, "data", "authored", "pi-aliases.yaml"), "utf8")));
    expect(Object.fromEntries(Object.entries(file.providers).filter(([, line]) => line.same_as).map(([id, line]) => [id, line.same_as]))).toEqual({
      fireworks: "fireworks-ai", together: "togetherai", "vercel-ai-gateway": "vercel", "kimi-coding": "kimi-code-plan-cn",
      "zai-coding-cn": "zhipuai-coding-plan", "ant-ling": "bailing", "qwen-token-plan": "alibaba-token-plan", "qwen-token-plan-cn": "alibaba-token-plan-cn",
    });
    for (const line of Object.values(file.providers)) for (const item of line.evidence ?? []) expect(item.date).toBe("2026-11-20");
  });
});

describe("the release review: tiers that cannot be compared (blockers 1 and 5)", () => {
  const plainPi = piModel("lab", "plain", { cost: { input: 2, output: 4, cacheRead: 0.1, cacheWrite: 0 } });

  it.each<[string, JsonObject]>([
    ["context.gte: 0", { text: { input: { price: 2, overrides: [{ when: { context: { gte: 0 } }, price: 7 }] } } }],
    ["context.gt: 32.5", { text: { input: { price: 2, overrides: [{ when: { context: { gt: 32.5 } }, price: 7 }] } } }],
    ["context.gt: 1e300, not a safe whole number", { text: { input: { price: 2, overrides: [{ when: { context: { gt: 1e300 } }, price: 7 }] } } }],
    ["context.lt: 32000", { text: { input: { price: 2, overrides: [{ when: { context: { lt: 32000 } }, price: 7 }] } } }],
    ["context with two comparisons", { text: { input: { price: 2, overrides: [{ when: { context: { gt: 1000, lt: 32000 } }, price: 7 }] } } }],
    ["one good tier and one that is not whole tokens", { text: { input: { price: 2, overrides: [{ when: { context: { gt: 32000 } }, price: 7 }, { when: { context: { gt: 64000.5 } }, price: 9 }] }, output: { price: 4 } } }],
  ])("1. an override on the context that is not a tier of whole tokens (%s) leaves the tiers uncompared, and the block fits the contract", (_name, cost) => {
    expect(UpstreamModel.safeParse({ id: "plain", name: "Plain", cost }).success).toBe(true);
    const block = piBlock("lab", plainPi, "id", { limit: { context: 200000, output: 8000 }, cost });
    expect(block.differences.filter((item) => item.field === "cost.tiers")).toEqual([]);
    expect(PiBlockSchema.safeParse(block).success).toBe(true);
    // pi's tiers do not make an item either: the entry's cannot be read.
    const tiered = piModel("lab", "plain", { cost: { input: 2, output: 4, cacheRead: 0.1, cacheWrite: 0, tiers: [{ inputTokensAbove: 31999, input: 7, output: 8, cacheRead: 0.2, cacheWrite: 0 }] } });
    expect(piDifferences(tiered, { cost }).filter((item) => item.field === "cost.tiers")).toEqual([]);
  });

  it("1. gt: 0 and gte: 1 are tiers above 0 tokens", () => {
    for (const when of [{ context: { gt: 0 } }, { context: { gte: 1 } }]) {
      const cost = { text: { input: { price: 2, overrides: [{ when, price: 7 }] } } };
      expect(piDifferences(plainPi, { cost })).toMatchObject([{ field: "cost.tiers", published_tiers: [{ input_tokens_above: 0, input: 7 }] }]);
    }
  });

  it.each<[string, JsonObject]>([
    ["an input side priced per character", { text: { input: { unit: "character", price: 2, overrides: [{ when: { context: { gt: 32000 } }, price: 7, cache: { read: 3 } }] }, output: { price: 4 } } }],
    ["an output side priced per character", { text: { input: { price: 2 }, output: { unit: "character", price: 4, overrides: [{ when: { context: { gt: 32000 } }, price: 8 }] } } }],
    ["a side per character with no tier of its own", { text: { input: { unit: "character", price: 2 }, output: { price: 4, overrides: [{ when: { context: { gt: 32000 } }, price: 8 }] } } }],
    ["a tier with a unit of its own", { text: { input: { price: 2, overrides: [{ when: { context: { gt: 32000 } }, price: 7, unit: "character" }] }, output: { price: 4 } } }],
  ])("5. %s: no value in another unit stands in a difference labelled USD per million tokens", (_name, cost) => {
    expect(UpstreamModel.safeParse({ id: "plain", name: "Plain", cost }).success).toBe(true);
    const tiered = piModel("lab", "plain", { cost: { input: 2, output: 4, cacheRead: 0.1, cacheWrite: 0, tiers: [{ inputTokensAbove: 128000, input: 9, output: 9, cacheRead: 0.9, cacheWrite: 0 }] } });
    for (const model of [plainPi, tiered]) {
      const differences = piDifferences(model, { cost });
      expect(differences.filter((item) => item.field === "cost.tiers")).toEqual([]);
      const text = JSON.stringify(differences);
      expect(text).not.toContain(":7");
      expect(text).not.toContain(":3");
    }
  });

  it("5, second review: `unit: \"token\"` is a price per million tokens, on a tier and on a side alike, and its differences are listed", () => {
    // The reviewer's fixture: a tier above 100, pi 3, the entry 7, with the entry's tier marked `unit: "token"`.
    const piTier = piModel("lab", "plain", { cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, tiers: [{ inputTokensAbove: 100, input: 3, output: 2, cacheRead: 0, cacheWrite: 0 }] } });
    const onTier = { text: { input: { price: 1, overrides: [{ when: { context: { gt: 100 } }, price: 7, unit: "token" }] }, output: { price: 2 } } };
    expect(UpstreamModel.safeParse({ id: "plain", name: "Plain", cost: onTier }).success).toBe(true);
    expect(piDifferences(piTier, { cost: onTier })).toMatchObject([{ field: "cost.tiers", pi_tiers: [{ input_tokens_above: 100, input: 3 }], published_tiers: [{ input_tokens_above: 100, input: 7 }] }]);
    // `token` on the input side: a tier only the entry has is listed, and the side's plain price is compared.
    const piPlain = piModel("lab", "plain", { cost: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 } });
    const onSide = { text: { input: { unit: "token", price: 1, overrides: [{ when: { context: { gt: 100 } }, price: 7 }] }, output: { unit: "token", price: 2 } } };
    expect(UpstreamModel.safeParse({ id: "plain", name: "Plain", cost: onSide }).success).toBe(true);
    expect(piDifferences(piPlain, { cost: onSide })).toMatchObject([{ field: "cost.input", pi: 5, published: 1 }, { field: "cost.tiers", pi_tiers: [], published_tiers: [{ input_tokens_above: 100, input: 7 }] }]);
  });

  it.each([undefined, "token", "character", "second"])("5, second review: a side's unit, a tier's unit and the plain prices decide alike, unit %s", (unit) => {
    const compared = unit === undefined || unit === "token";
    const model = piModel("lab", "plain", { cost: { input: 5, output: 6, cacheRead: 0.5, cacheWrite: 0, tiers: [{ inputTokensAbove: 100, input: 3, output: 6, cacheRead: 0, cacheWrite: 0 }] } });
    const tier = { when: { context: { gt: 100 } }, price: 7 };
    const onSide = { text: { input: { price: 1, cache: { read: 0.1 }, ...(unit ? { unit } : {}), overrides: [tier] }, output: { price: 2, ...(unit ? { unit } : {}) } } };
    const onTier = { text: { input: { price: 5, cache: { read: 0.5 }, overrides: [{ ...tier, ...(unit ? { unit } : {}) }] }, output: { price: 6 } } };
    expect(piDifferences(model, { cost: onSide }).map((item) => item.field)).toEqual(compared ? ["cost.input", "cost.output", "cost.cache_read", "cost.tiers"] : []);
    expect(piDifferences(model, { cost: onTier }).map((item) => item.field)).toEqual(compared ? ["cost.tiers"] : []);
  });

  it("1. no value models.dev's schema accepts, on either side of a grid of edge values, gives a block the contract refuses", () => {
    // Each axis holds the edge values of a field the block reads: thresholds that are negative, zero, fractional, huge or
    // unsafe; every comparison; prices negative, zero, many-decimal, huge; units; cache writes as a number, keyed by
    // lifetime or negative; limits zero, fractional, huge. Every combination models.dev's schema accepts is built.
    const thresholds = [-1, 0, 1, 32.5, 32000, 2 ** 53, 1e300];
    const operators = ["gt", "gte", "lt", "lte", "equals"];
    const prices = [-5, 0, 0.1234567, 1e308];
    const units = [undefined, "token", "character"];
    const writes: unknown[] = [undefined, 1.25, -1, { "5m": 1.25, "1h": 2 }];
    const limits = [undefined, 0, 0.5, 200000, 1e308];
    const piTiers = [undefined, [], [{ inputTokensAbove: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }], [{ inputTokensAbove: 31999, input: 1e308, output: 7, cacheRead: 0.1234567, cacheWrite: 2 }]];
    let built = 0;
    const refused: string[] = [];
    for (const threshold of thresholds) for (const operator of operators) for (const price of prices) for (const unit of units) for (const write of writes) {
      const input: JsonObject = { price, ...(unit ? { unit } : {}), cache: { read: price, ...(write === undefined ? {} : { write: write as number }) }, overrides: [{ when: { context: { [operator]: threshold } }, price, cache: { read: price } }] };
      const cost: JsonObject = { text: { input, output: { price, ...(unit ? { unit } : {}), overrides: [{ when: { context: { [operator]: threshold } }, price }] } } };
      for (const context of limits) {
        const limit: JsonObject = context === undefined ? {} : { context, output: context };
        if (!UpstreamModel.safeParse({ id: "m", name: "M", cost, limit }).success) continue;
        for (const tiers of piTiers) {
          const model = piModel("lab", "m", { contextWindow: 1000, maxTokens: 0, cost: { input: 2, output: 0, cacheRead: 0.5, cacheWrite: 3, ...(tiers ? { tiers } : {}) } });
          expect(PiFeed.safeParse({ lab: { m: model } }).success).toBe(true);
          const block = piBlock("lab", model, "id", { limit, cost });
          built += 1;
          const checked = PiBlockSchema.safeParse(block);
          if (!checked.success) refused.push(`${operator} ${threshold}, price ${price}, unit ${unit}, write ${JSON.stringify(write)}, limit ${context}: ${checked.error.issues[0]?.path.join(".")}`);
          for (const item of block.differences) expect(PiDifferenceSchema.safeParse(item).success).toBe(true);
        }
      }
    }
    expect(built).toBeGreaterThan(10000);
    expect(refused.slice(0, 5)).toEqual([]);
  });
});

describe("the release review: a saved snapshot that is not whole (blocker 4)", () => {
  /** A whole snapshot of 12 providers of 30 models, then damaged by `damage`. */
  const damaged = async (damage: (pi: string) => void) => {
    const dir = await dataDir();
    writePi(dir, fixturePi(12, 30));
    damage(join(dir, "pi"));
    return dir;
  };
  const file = (pi: string, id: string) => join(pi, "providers", `${id}.json`);
  const edit = (pi: string, id: string, change: (provider: { id: string; models: Record<string, PiModel> }) => void) => {
    const provider = JSON.parse(readFileSync(file(pi, id), "utf8"));
    change(provider);
    writeFileSync(file(pi, id), JSON.stringify(provider));
  };

  it("a whole snapshot is taken", async () => {
    const dir = await damaged(() => {});
    expect(publish({ dataDir: dir, rootDir: ROOT }).issues.map((issue) => issue.code)).not.toContain("pi-snapshot-unreadable");
    expect(published(dir).meta.pi.snapshot).toMatchObject({ providers: 12, models: 360 });
  });

  it.each([
    ["a model whose id is not its key (the review's Flash and Pro)", (pi: string) => edit(pi, "provider-03", (provider) => { provider.models["model-1"]!.id = "model-2"; }), 'the model "provider-03/model-1" has the id "model-2"'],
    ["a model whose provider is not its file's", (pi: string) => edit(pi, "provider-03", (provider) => { provider.models["model-1"]!.provider = "provider-04"; }), 'names the provider "provider-04"'],
    ["a provider file missing (the review's deepseek.json)", (pi: string) => rmSync(file(pi, "provider-05")), "11 provider files, meta.json says 12"],
    ["a provider file named otherwise than its id", (pi: string) => writeFileSync(join(pi, "providers", "provider-99.json"), readFileSync(file(pi, "provider-05"))), 'providers/provider-99.json holds the provider "provider-05"'],
    ["a model missing", (pi: string) => edit(pi, "provider-03", (provider) => { delete provider.models["model-1"]; }), "359 models, meta.json says 360"],
  ])("%s: the build takes no pi data and warns pi-snapshot-unreadable", async (_name, damage, why) => {
    const dir = await damaged(damage);
    const report = publish({ dataDir: dir, rootDir: ROOT });
    expect(report.ok).toBe(true);
    const out = published(dir);
    expect(blocks(out.catalog)).toBe(0);
    expect(out.meta.pi.snapshot).toBeNull();
    expect(out.meta.pi.counts).toEqual({ entries_with_block: 0, left_out_models: 0, unmatched_models: 0 });
    const warnings = out.meta.issues.filter((issue) => issue.code.startsWith("pi-"));
    expect(warnings).toMatchObject([{ level: "warning", code: "pi-snapshot-unreadable", target: "data/pi" }]);
    expect(warnings[0]!.message).toContain(why);
  });
});
