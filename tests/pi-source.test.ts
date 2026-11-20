// pi's catalog in the dataset (design/pi-source.md, sections c to f and i): the block, its differences, /meta.pi.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { publish } from "../scripts/lib/publish.ts";
import { piProviderFile, sync } from "../scripts/lib/sync.ts";
import { pretty } from "../scripts/lib/files.ts";
import { summarize, type Summary } from "../src/core/entries.ts";
import type { JsonObject } from "../src/core/merge.ts";
import { PiBlockSchema, PiSummarySchema } from "../src/core/contract.ts";
import { piDifferences, type PiCatalog, type PiModel } from "../src/core/pi.ts";
import { resolve, type ResolveInput } from "../src/core/resolve.ts";
import { ext, type AccessRules, type Catalog, type CatalogRules, type Evidence, type Meta, type OverrideFile, type UpstreamCatalog } from "../src/core/schema.ts";
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

  it("4. agreeing values give no difference; so do prices that differ only beyond the sixth decimal", () => {
    expect(piDifferences(agreeing(), entry({ context: 200000, output: 8000 }, plainCost))).toEqual([]);
    const close = agreeing({ cost: { input: 1.0000001, output: 3.9999999, cacheRead: 0.1000004, cacheWrite: 1.25 } });
    expect(piDifferences(close, entry({ context: 200000, output: 8000 }, plainCost))).toEqual([]);
    // Unrounded values are listed where they do differ.
    const apart = agreeing({ cost: { input: 1.000001, output: 4, cacheRead: 0.1, cacheWrite: 1.25 } });
    expect(piDifferences(apart, entry({ context: 200000, output: 8000 }, plainCost))).toMatchObject([{ field: "cost.input", pi: 1.000001, published: 1 }]);
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

describe("the pi snapshot in the data build (step 4)", () => {
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
