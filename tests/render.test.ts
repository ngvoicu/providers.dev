import { describe, expect, it } from "vitest";
import { CACHE_AGES_S, cacheLifetime, cacheResult, documentedCaching, type CacheEvaluation, type EntryCache, type RetentionProfile } from "../src/core/cache.ts";
import { buildIndex, type Summary } from "../src/core/entries.ts";
import type { Json, JsonObject } from "../src/core/merge.ts";
import { emptyInputWindow, inputWindow, type InputWindow } from "../src/core/limits.ts";
import { entryHtml, evaluationStrip, rowHtml } from "../src/core/render.ts";
import { modelHtml } from "../src/core/detail-view.ts";
import { canonicalModels } from "../src/core/resources.ts";
import { resolve } from "../src/core/resolve.ts";
import { NS, UpstreamModel, type ModelExtension } from "../src/core/schema.ts";
import { pricingOf } from "../src/core/policies.ts";
import { limitOf, NO_CACHE, summaryOf } from "./helpers.ts";
import { duration, usd } from "../src/core/format.ts";
import type { PiBlock, PiCatalog, PiModel } from "../src/core/pi.ts";
import type { MetaPi } from "../src/core/schema.ts";

const row = (more: Partial<Summary>): string => rowHtml(summaryOf(more), { today: { date: new Date("2026-11-13T00:00:00Z"), stale_after_days: 90 } });
const count = (html: string, part: string): number => html.split(part).length - 1;

/** A published evaluation, its results written out as [age, hits, checks]; age 0 is the control. */
function run(id: string, client: string, profile: RetentionProfile, results: [number, number, number][], more: Partial<CacheEvaluation> = {}): CacheEvaluation {
  return {
    id, route: "lab-api", route_label: "Lab API key", client, client_label: `Requests sent through ${client}`, date: "2026-11-04", request_settings: {},
    retention_profile: profile, parameter: null, value: null, late_excluded: 0, note: null, source: `https://example.com/results/${id}.json`,
    results: results.map(([age, hits, checks]) => cacheResult(age === 0 ? "control" : "timed", age, hits, checks)),
    ...more,
  };
}

/** The cache record of an entry as the build makes it: documented caching as models.dev writes it, and its evaluations. */
function cacheOf(cache: Json | undefined, evaluations: CacheEvaluation[] = []): EntryCache {
  const caching = documentedCaching(cache === undefined ? {} : { capabilities: { cache } });
  return { ...NO_CACHE, documented: caching.documented, lifetime: cacheLifetime(caching, evaluations, () => ({ source: "models.dev", date: "2026-11-15" })), evaluations };
}

// The cases of the brief, as the dataset of 2026-11-15 has them (design/safe-cache-lifetime.md, section 10).
const K1_BETA = run("cpa-8.0.53/K1-beta", "cliproxyapi", "long", [[0, 1, 1], [600, 3, 3], [1800, 2, 3], [3900, 0, 3]], { parameter: "cache_control.ttl", value: "1h", request_settings: { format: "messages", ttl: "1h", beta: "extended-cache-ttl-2025-04-11" } });
const K1_NOBETA = run("cpa-8.0.53/K1-nobeta", "cliproxyapi", "long", [[0, 1, 1], [600, 3, 3], [1800, 3, 3], [3900, 0, 3]], { parameter: "cache_control.ttl", value: "1h", request_settings: { format: "messages", ttl: "1h" } });
const CASES = {
  /** anthropic/claude-opus-5-5: long documented 1 h and not contradicted, though the client held 10 minutes. */
  opus: cacheOf({ explicit: { ttl: ["5m", "1h"] } }, [K1_BETA, K1_NOBETA]),
  /** openrouter/google/gemini-3.8-flash: short documented 5 minutes, contradicted; 0 s measured. */
  flash: cacheOf({ explicit: { ttl: ["5m"] } }, [run("openrouter-direct/R5", "direct", "short", [[0, 1, 1], [150, 0, 3], [300, 0, 3]])]),
  /** meta-subscription/muse-wonder-1.0: nothing documented; three clients, one never hit; a long run with a note. */
  wonder: cacheOf(undefined, [
    run("cpa-latest-2026-11-06/L4", "cliproxyapi", "short", [[0, 1, 1], [150, 3, 3], [300, 3, 3], [600, 3, 3], [900, 2, 3]]),
    run("harness-2026-11-07/H5", "muse-code", "short", [[0, 0, 1], [150, 0, 3], [300, 0, 3]], { note: "Muse Code caches its own system prompt but never the conversation" }),
    run("harness-2026-11-07/H6", "agent+cliproxyapi", "short", [[0, 1, 1], [150, 3, 3], [7200, 3, 3]]),
    run("meta-24h-2026-11-10/M2", "agent+cliproxyapi", "long", [[0, 1, 1], [14400, 3, 3], [43200, 0, 3], [86400, 0, 3]], { parameter: "prompt_cache_retention", value: "24h", note: "No age under 4 h was tested in this run" }),
  ]),
  /** alibaba/qwen-mt-plus: documented as not caching. */
  none: cacheOf(false),
  /** Nothing documented, nothing measured. */
  unknown: cacheOf(undefined),
} satisfies Record<string, EntryCache>;

describe("documented cache support on an entry page", () => {
  const entry = (cache: Json | undefined) => {
    const model = UpstreamModel.parse({ id: "m", name: "M", capabilities: { cache } });
    const { catalog } = resolve({
      upstream: { p: { id: "p", name: "P", models: { m: model } } }, additions: [], overrides: [], routes: {},
      access: { default: "api", default_basis: "fixture", patterns: [], providers: {} },
    });
    const index = buildIndex(catalog, "fixture", "2026-11-14T00:00:00Z", "2026-11-14T00:00:00Z");
    const summary = index.entries[0]!;
    const html = entryHtml({ summary, provider: index.providers[0]!, model: catalog.p!.models.m!, today: { date: new Date("2026-11-14T00:00:00Z"), stale_after_days: 90 }, cache_ages_s: CACHE_AGES_S });
    return { summary, html, documented: html.split('<h2 id="cache">')[1]!.split("<h3>Retention</h3>")[0]! };
  };

  it("keeps absent modes unknown on both the API summary and detail page", () => {
    for (const cache of [undefined, {}]) {
      const { summary, documented } = entry(cache);
      expect(summary).toMatchObject({ cache: "unknown", cache_mode_support: { implicit: "unknown", explicit: "unknown" } });
      expect(documented).not.toContain("Unsupported");
    }
    const partial = entry({ implicit: true });
    expect(partial.summary.cache_mode_support).toEqual({ implicit: "supported", explicit: "unknown" });
    expect(partial.documented).toContain("Supported");
    expect(partial.documented).not.toContain("Unsupported");
    const unsupported = entry(false);
    expect(unsupported.summary.cache_mode_support).toEqual({ implicit: "unsupported", explicit: "unsupported" });
    expect(count(unsupported.documented, ">Unsupported</span>")).toBe(2);
  });
});
describe("the entry page", () => {
  const evidence = [{ kind: "documented" as const, url: "https://example.com/docs", date: "2026-11-01" }];
  const { catalog } = resolve({
    upstream: {
      lab: {
        id: "lab", name: "Lab",
        models: {
          bare: UpstreamModel.parse({ id: "bare", name: "Bare" }),
          full: UpstreamModel.parse({
            id: "full", name: "Full", type: "chat", canonical_id: "lab/full", release_date: "2026-10-01", description: "The most capable model for every task, with breakthrough performance.",
            limit: { context: 1000000, output: 64000 }, capabilities: { cache: { explicit: { ttl: ["5m", "1h"], min_tokens: 1024 } } },
            cost: { text: { input: { price: 2, cache: { read: 0.2, write: { "5m": 2.5, "1h": 4 } }, overrides: [{ when: { context: { gt: 200000 } }, price: 4 }] }, output: { price: 10 } }, multipliers: [{ when: { utc_hours: { gte: "16:00" } }, factor: 0.5 }] },
          }),
        },
      },
    },
    additions: [{ id: "lab-login", name: "Lab login", access: "subscription", access_basis: "A login", evidence, models: [{ id: "full", inherits: "lab/full", evidence }] }],
    overrides: [{ provider: "lab", rules: [{ models: ["full"], set: { limit: { output: 128000 } }, reason: "Documented higher", evidence }] }],
    routes: {}, access: { default: "api", default_basis: "fixture", patterns: [], providers: {} }, upstreamDate: "2026-11-13",
  });
  const index = buildIndex(catalog, "fixture", "2026-11-14T00:00:00Z", "2026-11-14T00:00:00Z");
  const page = (ref: string): string => {
    const summary = index.entries.find((entry) => entry.ref === ref)!;
    return entryHtml({ summary, provider: index.providers.find((item) => item.id === summary.provider)!, model: catalog[summary.provider]!.models[summary.model]!, today: { date: new Date("2026-11-14T00:00:00Z"), stale_after_days: 90 }, cache_ages_s: CACHE_AGES_S, imported: "2026-11-13" });
  };
  const pages = { bare: page("lab/bare"), full: page("lab/full"), login: page("lab-login/full") };
  /** The skeleton of a page: its headings, the column heads of its tables, and the labels of its rows. */
  const skeleton = (html: string): string[] =>
    [...html.matchAll(/<h([23])[^>]*>(.*?)<\/h\1>|<th scope="(col|row|colgroup)"[^>]*>(.*?)(?:<div|<\/th>)/gs)].map((match) => (match[1] ? `h${match[1]} ${match[2]}` : `${match[3]} ${match[4]}`).replace(/<[^>]+>/g, "").trim());

  it("has the same sections, tables and rows whatever is known about the entry", () => {
    const bare = skeleton(pages.bare);
    expect(bare.filter((item) => item.startsWith("h"))).toEqual(["h2 Limits", "h3 Input window", "h3 Documented", "h3 Measured tokens", "h2 Price", "h3 Conditional rates", "h3 Request controls", "h2 Prompt caching", "h3 Lifetimes", "h3 Cache modes", "h3 Retention", "h2 pi's catalog", "h2 Provenance", "h2 Data"]);
    expect(bare.filter((item) => item.startsWith("row"))).toEqual([
      "row Input window", "row Documented", "row Measured",
      "row Context window", "row Largest input", "row Maximum output",
      "row Input", "row Output", "row Reasoning output", "row Cache read", "row Cache write",
      "row Service tier", "row Short retention", "row Long retention", "row Automatic implicit", "row Manual explicit", "row Cache retention",
      "row Source", "row Inherited from", "row Corrections", "row Evidence",
    ]);
    // An entry everything is known about has the same skeleton: no section, table or row more, and none less.
    expect(skeleton(pages.full)).toEqual(bare);
    expect(skeleton(pages.login)).toEqual(bare);
    // Where there is nothing, the row says so.
    expect(count(pages.bare, ">Unknown</span>")).toBeGreaterThan(15);
    // Inherited from, Corrections, Evidence, and the prices of other kinds in the source.
    expect(count(pages.bare, '<span class="muted">None</span>')).toBe(4);
    // The other prices of the source and the raw record; a lifetime that was measured adds one for its evaluations.
    for (const html of Object.values(pages)) expect(count(html, "<details")).toBe(2);
    expect(pages.bare).toContain("No conditional rates recorded.");
  });

  it("states values and sources, and no sentence that is not about the entry", () => {
    // The raw record at the foot of the page is the API's answer as it is, and is not read here.
    for (const html of Object.values(pages).map((page) => page.replace(/<pre[\s\S]*?<\/pre>/g, ""))) {
      // The source's own description of the model is in the API, not on the page; the notes on method are in the methodology.
      expect(html).not.toContain("most capable model");
      expect(html).not.toContain("Usable context");
      expect(html).not.toContain("Additional pricing conditions may apply");
      expect(html).not.toContain("independently checked.</p>");
      expect(html).not.toContain("has no entry for this access method. Every value");
    }
    expect(pages.full).toContain('Type <span title="The kind of model, as models.dev records it.">chat</span>');
    expect(pages.bare).toContain(">unknown</span> · Release date unknown");
    // The correction and the inheritance are rows of the provenance table.
    expect(pages.full).toContain("<code>limit.output</code> is <strong>128,000</strong>. models.dev says: 64,000.");
    expect(pages.login).toContain('<a href="/entries/lab/full"><code>lab/full</code></a>');
    expect(pages.login).toContain("<code>cost</code>");
    // The off-peak rule of the API entry reaches the subscription entry with its prices.
    expect(pages.login).toContain("<strong>Off-peak hours</strong>");
    expect(pages.login).toContain("API list prices of");
  });

  it("keeps a condition, its charges and what it applies to in one row group", () => {
    const table = pages.full.slice(pages.full.indexOf('<table class="facts conditional'), pages.full.indexOf("</table>", pages.full.indexOf('<table class="facts conditional')));
    // Two conditions in the fixture: the context above 200,000 tokens, and the hours from 16:00.
    expect(count(table, "<tbody>")).toBe(2);
    expect(count(table, '<th scope="rowgroup"')).toBe(2);
    expect(count(table, '<td class="applies"')).toBe(2);
    for (const group of table.split("<tbody>").slice(1)) expect(count(group, '<th scope="rowgroup"')).toBe(1);
  });
});

describe("the cache lifetime in a table row", () => {
  const cell = (cache: EntryCache): string => {
    const html = row({ cache_lifetime: cache.lifetime });
    return html.slice(html.indexOf('<td class="life-col"'), html.indexOf("</td>", html.indexOf('<td class="life-col"')));
  };
  /** The text of a cell, its two lines one after the other. */
  const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  it("prints the safe value of short and long, each with its basis in a word", () => {
    expect(text(cell(CASES.opus))).toBe("Short 5 min documented Long 1 h documented measured 10 min");
    expect(text(cell(CASES.wonder))).toBe("Short 0 s measured Long 4 h measured");
    expect(count(cell(CASES.opus), '<span class="basis documented"')).toBe(2);
    expect(count(cell(CASES.wonder), '<span class="basis measured"')).toBe(2);
  });

  it("names the other lifetime beside the safe one, and marks a documented one a measurement contradicts", () => {
    expect(cell(CASES.opus)).toContain('<span class="life-other">measured 10 min</span>');
    expect(cell(CASES.flash)).toContain('<span class="life-other contradicted">documented 5 min</span>');
    expect(text(cell(CASES.flash))).toBe("Short 0 s measured documented 5 min Long Unknown");
  });

  it("tells not known, does not cache and 0 s measured apart", () => {
    expect(text(cell(CASES.unknown))).toBe("Short Unknown Long Unknown");
    expect(text(cell(CASES.none))).toBe("Short None documented Long None documented");
    expect(text(cell(CASES.flash))).toContain("Short 0 s measured");
    // The source and the date are in the title of each value.
    expect(cell(CASES.opus)).toContain("Long retention, safe lifetime: 3,600 s, documented, models.dev, 2026-11-15. Documented: 3,600 s. Measured: 600 s (1 client, 2 evaluations). 13 of 14 checks hit inside the documented lifetime.");
    expect(cell(CASES.flash)).toContain("Short retention, safe lifetime: 0 s, measured, providers.dev, 2026-11-04.");
  });

  it("links to the entry's lifetimes", () => {
    expect(cell(CASES.opus)).toContain('<a class="plain lifes" href="/entries/p/m#cache"');
  });

  it("names the column of every cell, for where the table is stacked", () => {
    const html = row({ cache_lifetime: CASES.opus.lifetime });
    for (const label of ["Provider", "Input window", "Context", "Max output", "Price in / out", "Released", "Cache lifetime", "Source"]) expect(html).toContain(`data-label="${label}"`);
    expect(count(rowHtml(summaryOf({}), { today: { date: new Date("2026-11-13T00:00:00Z"), stale_after_days: 90 }, hideProvider: true }), 'data-label="Provider"')).toBe(0);
  });

  it("says whose price a subscription entry shows", () => {
    const cost = { text: { input: { price: 4 }, output: { price: 20 } } };
    // The API list price of the same model, named.
    const reference = row({ access: "subscription", price_in: 4, price_out: 20, price_from: "lab/model", pricing: pricingOf({ cost }, "subscription", "lab/model", []) });
    expect(reference).toContain('<span class="price-from">API price</span>');
    expect(reference).toContain("the API list price of lab/model");
    // A price the source lists for a subscription entry, with no API entry to compare it with.
    expect(row({ access: "subscription", price_in: 4, price_out: 20, pricing: pricingOf({ cost }, "subscription", null, []) })).toContain('<span class="price-from">Listed price</span>');
    // No price per token at all.
    const plan = row({ access: "subscription", pricing: pricingOf({ cost: { text: { input: { price: 0 }, output: { price: 0 } } } }, "subscription", null, []) });
    expect(plan).toContain(">In plan</span>");
    expect(plan).not.toContain("$0");
    // An API entry has neither label, and a listed zero is shown as the source has it.
    const api = row({ price_in: 0, price_out: 0, pricing: pricingOf({ cost: { text: { input: { price: 0 }, output: { price: 0 } } } }, "api", null, []) });
    expect(api).toContain("$0");
    expect(api).not.toContain("price-from");
    expect(row({})).not.toContain("In plan");
  });

  it("shows no measured limit in the table: those are on the entry's page", () => {
    expect(row({ measured_limit_count: 2 })).not.toContain("Limits measured");
  });
});

describe("the cache lifetimes on an entry page", () => {
  const { catalog } = resolve({
    upstream: { lab: { id: "lab", name: "Lab", models: { m: UpstreamModel.parse({ id: "m", name: "M" }) } } },
    additions: [], overrides: [], routes: {}, access: { default: "api", default_basis: "fixture", patterns: [], providers: {} }, upstreamDate: "2026-11-15",
  });
  const index = buildIndex(catalog, "fixture", "2026-11-15T00:00:00Z", "2026-11-15T00:00:00Z");
  const now = new Date("2026-11-15T00:00:00Z");
  /** The page of an entry whose cache record is `cache`: the record on the full entry and on its summary, as the API has it. */
  const page = (cache: EntryCache): string => {
    const model = structuredClone(catalog.lab!.models.m!) as JsonObject;
    (model[NS] as unknown as ModelExtension).cache = cache;
    return entryHtml({ summary: { ...index.entries[0]!, cache_lifetime: cache.lifetime, evaluation_count: cache.evaluations.length }, provider: index.providers[0]!, model, today: { date: now, stale_after_days: 90 }, cache_ages_s: CACHE_AGES_S, imported: "2026-11-15" });
  };
  const section = (html: string): string => html.slice(html.indexOf('<h2 id="cache">'), html.indexOf("<h3>Cache modes</h3>"));
  const tiles = (html: string): string => html.slice(html.indexOf('<div class="tiles'), html.indexOf("</div>\n\n<section"));
  const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  /** The rows of a table body: one item or one profile, its cells as text. */
  const bodies = (html: string): string[] => [...section(html).matchAll(/<tbody class="([^"]+)">([\s\S]*?)<\/tbody>/g)].map((match) => `${match[1]}: ${text(match[2]!)}`);

  it("starts with the safe lifetime of short and long, its basis, source and date", () => {
    expect(text(tiles(page(CASES.opus)))).toContain("Cache lifetime, short 5 min documented models.dev · 2026-11-15 Cache lifetime, long 1 h documented models.dev · 2026-11-15 Measured 10 min");
    expect(text(tiles(page(CASES.flash)))).toContain("Cache lifetime, short 0 s measured providers.dev · 2026-11-04 Documented 5 min, contradicted Cache lifetime, long Unknown");
    expect(text(tiles(page(CASES.unknown)))).toContain("Cache lifetime, short Unknown Not documented or measured Cache lifetime, long Unknown");
  });

  it("lists every documented and measured lifetime in one table, by retention, each with its basis, source and date", () => {
    const rows = bodies(page(CASES.opus));
    expect(rows.map((body) => body.split(":")[0])).toEqual(["profile", "item documented", "profile", "item documented", "item measured"]);
    expect(rows[0]).toContain("Short retention Safe lifetime 5 min documented models.dev 2026-11-15 Documented 5 min Measured Not measured Inside the documented lifetime Not applicable");
    expect(rows[1]).toBe("item documented: 5 min documented models.dev 2026-11-15 Manual explicit As documented: 5m Not applicable");
    expect(rows[3]).toBe("item documented: 1 h documented models.dev 2026-11-15 Manual explicit As documented: 1h Not applicable");
    // One client, its setting, its checks and ages, its results by age, then its two evaluations.
    expect(rows[4]).toContain("item measured: 10 min measured providers.dev 2026-11-04 Requests sent through cliproxyapi Sent cache_control.ttl=1h · 13 of 20 checks hit Tested from 10 min · First miss 30 min · Also checked: 1 h 5 min 0% (0/6) 2 evaluations");
  });

  it("shows where a documented lifetime stands beside a worse measurement, and where a measurement contradicts it", () => {
    const opus = bodies(page(CASES.opus))[2]!;
    expect(opus).toContain("Long retention Safe lifetime 1 h documented models.dev 2026-11-15 Documentation not contradicted Documented 1 h Measured 10 min · 1 client Inside the documented lifetime 13 of 14 checks hit");
    const flash = bodies(page(CASES.flash));
    expect(flash[0]).toContain("Short retention Safe lifetime 0 s measured providers.dev 2026-11-04 Documentation contradicted Documented 5 min Measured 0 s · 1 client Inside the documented lifetime 1 of 7 checks hit");
    // The contradicted documented lifetime stays in the list, beside the measurement.
    expect(flash[1]).toContain("item documented: 5 min documented models.dev");
    expect(flash[2]).toContain("item measured: 0 s measured providers.dev 2026-11-04 Requests sent through direct No lifetime asked for · 1 of 7 checks hit Tested from 2.5 min · First miss 2.5 min");
    expect(section(page(CASES.flash))).toContain('<span class="case contradicted"');
    expect(section(page(CASES.wonder))).not.toContain('class="case');
  });

  it("prints the documentation label from documented_status and from nothing else", () => {
    /** The record with the key of one profile changed by hand, every other key as the build made it. */
    const withStatus = (cache: EntryCache, profile: RetentionProfile, status: "contradicted" | "not_contradicted" | null): EntryCache => {
      const changed = structuredClone(cache);
      changed.lifetime[profile].documented_status = status;
      return changed;
    };
    const label = (html: string): string[] => [...section(html).matchAll(/<span class="case[^"]*"[^>]*>([^<]+)<\/span>/g)].map((match) => match[1]!);
    const cellOf = (cache: EntryCache): string => row({ cache_lifetime: cache.lifetime });
    // As built.
    expect(CASES.flash.lifetime.short.documented_status).toBe("contradicted");
    expect(CASES.opus.lifetime.long.documented_status).toBe("not_contradicted");
    expect(label(page(CASES.flash))).toEqual(["Documentation contradicted"]);
    expect(label(page(CASES.opus))).toEqual(["Documentation not contradicted"]);
    // Changed by hand: the other label, or none, whatever basis, documented_s and measured_s say.
    const flashNot = withStatus(CASES.flash, "short", "not_contradicted");
    expect(label(page(flashNot))).toEqual(["Documentation not contradicted"]);
    expect(text(tiles(page(flashNot)))).toContain("Documented 5 min Cache lifetime, long");
    expect(tiles(page(flashNot))).not.toContain("contradicted");
    expect(cellOf(flashNot)).toContain('<span class="life-other">documented 5 min</span>');
    const flashNone = withStatus(CASES.flash, "short", null);
    expect(label(page(flashNone))).toEqual([]);
    expect(tiles(page(flashNone))).not.toContain("contradicted");
    expect(cellOf(flashNone)).not.toContain("contradicted");
    expect(label(page(withStatus(CASES.opus, "long", "contradicted")))).toEqual(["Documentation contradicted"]);
    expect(label(page(withStatus(CASES.opus, "long", null)))).toEqual([]);
    // A label on a profile with nothing documented or measured, had the API one, is printed too: the page checks nothing.
    expect(label(page(withStatus(CASES.wonder, "short", "not_contradicted")))).toEqual(["Documentation not contradicted"]);
    // Documented as not caching, with a measurement that found caching: no label.
    const none = cacheOf(false, [run("caches", "direct", "short", [[0, 1, 1], [300, 3, 3]])]);
    expect(none.lifetime.short).toMatchObject({ documented_s: 0, measured_s: 300, documented_status: null });
    expect(label(page(none))).toEqual([]);
  });

  it("gives each client its own measured lifetime and keeps an evaluation's note in sight with it", () => {
    const rows = bodies(page(CASES.wonder));
    expect(rows.map((body) => body.split(":")[0])).toEqual(["profile", "item measured", "item measured", "item measured", "profile", "item measured"]);
    expect(rows[1]).toMatch(/^item measured: 2 h measured .* Requests sent through agent\+cliproxyapi/);
    expect(rows[2]).toMatch(/^item measured: 10 min measured .* Requests sent through cliproxyapi/);
    expect(rows[3]).toMatch(/^item measured: 0 s measured .* Requests sent through muse-code .* First miss at once Note Muse Code caches its own system prompt but never the conversation 1 evaluation/);
    expect(rows[5]).toMatch(/^item measured: 4 h measured .* Sent prompt_cache_retention=24h · 4 of 10 checks hit Tested from 4 h · First miss 12 h Note No age under 4 h was tested in this run 1 evaluation/);
    // The note is on the lifetime's row, not only in its evaluation, which is collapsed.
    const item = section(page(CASES.wonder)).split('<tbody class="item measured">')[3]!;
    expect(item.indexOf("Muse Code caches its own")).toBeLessThan(item.indexOf('<tr class="run">'));
  });

  it("opens from a measured lifetime onto each evaluation: its setting, date, raw result and own results by age", () => {
    const item = section(page(CASES.opus)).split('<tbody class="item measured">')[1]!.split("</tbody>")[0]!;
    expect(count(item, '<details class="runs"><summary>2 evaluations</summary></details>')).toBe(1);
    const runs = item.split('<tr class="run">').slice(1);
    expect(runs).toHaveLength(2);
    expect(text(runs[0]!)).toContain("cpa-8.0.53/K1-beta 2026-11-04 Lab API key · format=messages, ttl=1h, beta=extended-cache-ttl-2025-04-11 · Also checked: 1 h 5 min 0% (0/3) Raw result");
    expect(runs[0]).toContain('<a href="https://example.com/results/cpa-8.0.53/K1-beta.json" rel="noopener">Raw result</a>');
    expect(text(runs[1]!)).toContain("cpa-8.0.53/K1-nobeta 2026-11-04 Lab API key · format=messages, ttl=1h");
  });

  it("labels a lifetime asked by prompt_cache_options.ttl as sent, on the entry page and in the evidence strip", () => {
    // openai/gpt-6.1-sol: documented 30m and 12h; one evaluation that sent {"prompt_cache_options": {"ttl": "12h"}}.
    const sol = run("openai-12h/S1", "direct", "long", [[0, 1, 1], [1800, 3, 3], [43200, 3, 3], [86400, 0, 3]], { parameter: "prompt_cache_options.ttl", value: "12h", request_settings: { prompt_cache_options: { ttl: "12h" } } });
    const html = page(cacheOf({ explicit: { ttl: ["30m", "12h"] } }, [sol]));
    const rows = bodies(html);
    expect(rows.map((body) => body.split(":")[0])).toEqual(["profile", "item documented", "profile", "item documented", "item measured"]);
    expect(rows[4]).toMatch(/^item measured: 12 h measured .* Requests sent through direct Sent prompt_cache_options\.ttl=12h · 7 of 10 checks hit Tested from 30 min · First miss 24 h/);
    const item = section(html).split('<tbody class="item measured">')[1]!;
    expect(text(item.split('<tr class="run">')[1]!)).toContain("openai-12h/S1 2026-11-04 Lab API key · prompt_cache_options.ttl=12h");
    const strip = evaluationStrip(sol, CACHE_AGES_S);
    expect(strip).toContain('title="Long retention: the requests sent prompt_cache_options.ttl=12h. Evaluated on 2026-11-04."');
    expect(text(strip)).toMatch(/^Long 12h /);
  });

  it("shows a result by age as a whole percentage, the exact one with the counts in its title", () => {
    const html = section(page(CASES.opus));
    // The item's results: K1-beta and K1-nobeta added up at 30 minutes, 5 of 6.
    expect(html).toContain('<span class="most" title="After 30 min: 5 of 6 re-sends served from the cache (83.33%)">83<small>5/6</small></span>');
    // An evaluation's own: 2 of 3.
    expect(html).toContain('<span class="most" title="After 30 min: 2 of 3 re-sends served from the cache (66.67%)">67<small>2/3</small></span>');
    expect(html).toContain('title="At once: 2 of 2 re-sends served from the cache (100%)">100<small>2/2</small></span>');
  });

  it("tells not known, does not cache and 0 s measured apart", () => {
    const unknown = bodies(page(CASES.unknown));
    expect(unknown).toEqual([
      "profile: Short retention Safe lifetime Unknown Documented Not documented Measured Not measured Inside the documented lifetime Not applicable",
      "profile: Long retention Safe lifetime Unknown Documented Not documented Measured Not measured Inside the documented lifetime Not applicable",
    ]);
    const none = bodies(page(CASES.none));
    expect(none[0]).toContain("Short retention Safe lifetime None documented models.dev 2026-11-15 Documented None Measured Not measured");
    expect(none[1]).toBe("item documented: None documented models.dev 2026-11-15 Documented as not caching Not applicable");
    expect(none[3]).toBe("item documented: None documented models.dev 2026-11-15 Documented as not caching Not applicable");
    expect(bodies(page(CASES.flash))[2]).toContain("0 s measured");
  });
});

describe("stale evidence", () => {
  // The threshold is the one the API publishes in /api/v1/meta; the renderer has none of its own.
  const { catalog } = resolve({
    upstream: { lab: { id: "lab", name: "Lab", models: { m: UpstreamModel.parse({ id: "m", name: "M" }) } } },
    additions: [], overrides: [], routes: {}, access: { default: "api", default_basis: "fixture", patterns: [], providers: {} }, upstreamDate: "2026-11-15",
  });
  const index = buildIndex(catalog, "fixture", "2026-11-15T00:00:00Z", "2026-11-15T00:00:00Z");
  const date = new Date("2026-11-15T00:00:00Z");
  const page = (cache: EntryCache, staleAfterDays: number): string => {
    const model = structuredClone(catalog.lab!.models.m!) as JsonObject;
    (model[NS] as unknown as ModelExtension).cache = cache;
    return entryHtml({ summary: { ...index.entries[0]!, cache_lifetime: cache.lifetime, evaluation_count: cache.evaluations.length }, provider: index.providers[0]!, model, today: { date, stale_after_days: staleAfterDays }, cache_ages_s: CACHE_AGES_S, imported: "2026-11-15" });
  };

  it("marks a providers.dev date by the threshold it is given, and says that number in the hover text", () => {
    // The evaluation of the flash case is from 2026-11-04: 11 days before 2026-11-15.
    const fresh = page(CASES.flash, 90);
    expect(fresh).not.toContain("· stale");
    const stale = page(CASES.flash, 10);
    expect(stale).toContain("2026-11-04 · stale");
    expect(stale).toContain("More than 10 days ago.");
    expect(stale).toContain('title="Evaluated more than 10 days ago."');
    expect(stale).not.toMatch(/90 days/);
    // Exactly the threshold is not more than it.
    expect(page(CASES.flash, 11)).not.toContain("· stale");
    // A models.dev date is never stale.
    expect(page(CASES.opus, 1)).toContain('<span class="muted date" title="Imported from models.dev on this date.">2026-11-15</span>');
  });

  it("marks the newest evidence of a row by the threshold it is given", () => {
    const row = (staleAfterDays: number): string => rowHtml(summaryOf({ origin: "modified", verified: "2026-11-04" }), { today: { date, stale_after_days: staleAfterDays } });
    expect(row(90)).not.toContain("· stale");
    expect(row(7)).toContain("2026-11-04 · stale");
    expect(row(7)).toContain("more than 7 days ago.");
  });
});

describe("the age columns of results by age", () => {
  // The columns are the ages the API publishes in /api/v1/meta (`cache_ages_s`); the renderer has none of its own.
  const { catalog } = resolve({
    upstream: { lab: { id: "lab", name: "Lab", models: { m: UpstreamModel.parse({ id: "m", name: "M" }) } } },
    additions: [], overrides: [], routes: {}, access: { default: "api", default_basis: "fixture", patterns: [], providers: {} }, upstreamDate: "2026-11-15",
  });
  const index = buildIndex(catalog, "fixture", "2026-11-15T00:00:00Z", "2026-11-15T00:00:00Z");
  const page = (cache: EntryCache, ages: readonly number[]): string => {
    const model = structuredClone(catalog.lab!.models.m!) as JsonObject;
    (model[NS] as unknown as ModelExtension).cache = cache;
    return entryHtml({ summary: { ...index.entries[0]!, cache_lifetime: cache.lifetime, evaluation_count: cache.evaluations.length }, provider: index.providers[0]!, model, today: { date: new Date("2026-11-15T00:00:00Z"), stale_after_days: 90 }, cache_ages_s: ages, imported: "2026-11-15" });
  };
  const heads = (html: string): string[] => [...html.matchAll(/<th scope="col" class="age"[^>]*>([^<]+)<\/th>/g)].map((match) => match[1]!);
  const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  it("draws the columns of the ages it is given, and the spans that go with them", () => {
    // A publication whose ages are 10 minutes and 1 h 5: the control and those two columns, nothing else.
    const html = page(CASES.opus, [600, 3900]);
    expect(heads(html)).toEqual(["At once", "10 min", "1 h 5"]);
    expect(html).toContain('<th scope="colgroup" colspan="3" class="span">');
    expect(html).toContain('<td class="profile-facts" colspan="4">');
    expect(html).toContain('<td class="heat-none" colspan="3" data-label="Results by age">');
    // Three cells on the measured lifetime's row and on each of its two evaluations.
    expect(html.match(/<td class="heat( unchecked)?"/g)).toHaveLength(3 * 3);
    // A column the ages now have shows its result: 1 h 5, 0 of 6, where the published ladder has no column for it.
    expect(html).toContain('<td class="heat" data-label="1 h 5"><span class="none" title="After 1 h 5 min: 0 of 6 re-sends served from the cache (0%)">0<small>0/6</small></span></td>');
    // With the published ladder, the same entry has its 19 columns.
    expect(heads(page(CASES.opus, CACHE_AGES_S))).toHaveLength(1 + CACHE_AGES_S.length);
  });

  it("says what the ages and the cells are: to a screen reader over the ages, in sight in their hover texts and the legend", () => {
    const html = page(CASES.opus, [600, 3900]);
    // The heading over the ages is read out and not shown.
    expect(html).toContain('<th scope="colgroup" colspan="3" class="span"><span class="sr-only">Time since the prompt was cached · served from the cache, in percent, with hits/checks</span></th>');
    // Each age says what it is in its hover text.
    expect(html).toContain('<th scope="col" class="age" title="At once: the prompt sent again immediately. It shows that the prompt was cached at all.">At once</th>');
    expect(html).toContain('<th scope="col" class="age" title="The prompt sent again 10 min after it was cached.">10 min</th>');
    expect(html).toContain('<th scope="col" class="age" title="The prompt sent again 1 h 5 min after it was cached.">1 h 5</th>');
    // The legend: a sample cell and what a cell and its column are, then the colours.
    expect(html).toContain('<span class="legend-head"><span class="heat-key most" aria-hidden="true">67<small>2/3</small></span>');
    expect(text(html)).toContain("67 2/3 Checks served from the cache, in percent and as hits/checks, by time since the prompt was cached 100 All 67 Half or more 33 Fewer 0 None · Not checked at that age Methodology");
  });

  it("still shows a result at an age that has no column, in words beside its lifetime and its evaluation", () => {
    const html = page(CASES.opus, [600, 3900]);
    // 30 minutes has no column here: the lifetime (5 of 6) and each evaluation (2 of 3, 3 of 3) say it in words.
    expect(heads(html)).not.toContain("30 min");
    expect(text(html)).toContain("First miss 30 min · Also checked: 30 min 83% (5/6) 2 evaluations");
    expect(text(html)).toContain("cpa-8.0.53/K1-beta 2026-11-04 Lab API key · format=messages, ttl=1h, beta=extended-cache-ttl-2025-04-11 · Also checked: 30 min 67% (2/3) Raw result");
    expect(text(html)).toContain("Also checked: 30 min 100% (3/3) Raw result");
    // 1 h 5 has a column, so it is no longer in words.
    expect(text(html)).not.toContain("Also checked: 1 h 5");
  });
});

describe("the deleted cache fields", () => {
  // `cache_ttl_s`, `cache_ttl_by_mode_s`, `cache_results`, `providers_dev.cache.results` and `documented.modes.<mode>.ttl`
  // were folded into the lifetime record and deleted. The documented texts stay in `capabilities.cache`, as imported.
  const { catalog } = resolve({
    upstream: { lab: { id: "lab", name: "Lab", models: { m: UpstreamModel.parse({ id: "m", name: "M", capabilities: { cache: { explicit: { ttl: ["5m", "1h"] } } } }) } } },
    additions: [], overrides: [], routes: {}, access: { default: "api", default_basis: "fixture", patterns: [], providers: {} }, upstreamDate: "2026-11-15",
  });
  const index = buildIndex(catalog, "fixture", "2026-11-15T00:00:00Z", "2026-11-15T00:00:00Z");
  const model = catalog.lab!.models.m!;
  const cache = (model[NS] as unknown as ModelExtension).cache;

  it("are in neither the summary nor the entry", () => {
    for (const key of ["cache_ttl_s", "cache_ttl_by_mode_s", "cache_results"]) expect(index.entries[0]).not.toHaveProperty(key);
    expect(Object.keys(cache)).toEqual(["documented", "retention", "lifetime", "evaluations"]);
    expect(Object.keys(cache.documented.modes.explicit)).toEqual(["support", "min_tokens", "max_breakpoints", "targets"]);
  });

  it("are read from the lifetime record, and from capabilities.cache as imported", () => {
    expect(cache.lifetime.lifetimes.map((item) => [item.retention_profile, item.mode, item.documented_as, item.lifetime_s])).toEqual([["short", "explicit", "5m", 300], ["long", "explicit", "1h", 3600]]);
    expect(model.capabilities).toEqual({ cache: { explicit: { ttl: ["5m", "1h"] } } });
    expect(rowHtml(index.entries[0]!, { today: { date: new Date("2026-11-15T00:00:00Z"), stale_after_days: 90 } })).toContain("1 h");
  });
});

// The input window as the API publishes it (design/usable-input-window.md, sections 2 and 10): the five cases of 2.2,
// made by the rule from the numbers of the design's worked examples. A page prints the record: what is a lower bound is
// `bound`, the published value is `basis`, the label of the documentation is `documented_status`, a measurement's words
// are its `kind`.
describe("the input window", () => {
  const sourceOf = () => ({ source: "models.dev" as const, date: "2026-11-15" });
  const login = { route: "codex-subscription", route_label: "ChatGPT plan through the Codex login", client: "cliproxyapi", client_label: "Requests sent through CLIProxyAPI" };
  const bracket = (date: string) => limitOf({ ...login, input_accepted: 915011, input_refused: 922500, date });
  const CASES = {
    /** anthropic/claude-opus-5-5 (example 9): a window documented, not measured. */
    documented: inputWindow({ context: 1000000, output: 128000 }, [], [], sourceOf),
    /** openai-codex/gpt-6.1-sol (example 1): an input limit documented, a bracket under it. */
    notContradicted: inputWindow({ context: 1050000, input: 922000, output: 128000 }, [], [bracket("2026-11-13")], sourceOf),
    /** A documented window the route names smaller (test a of 4.2). */
    contradicted: inputWindow({ context: 1000000 }, [], [limitOf({ ...login, context: 900000, date: "2026-11-08" })], sourceOf),
    /** openai-codex/gpt-6-astra (example 3): nothing documented, a bracket. */
    measured: inputWindow(undefined, [], [bracket("2026-11-11")], sourceOf),
    /** devin/claude-opus-5-5 (example 11): nothing known. */
    none: emptyInputWindow(),
  } satisfies Record<string, InputWindow>;
  /** claude-subscription/claude-opus-5-5 (example 6): the window the route names, written onto the added entry. */
  const named = inputWindow({ context: 1000000, output: 128000 }, ["context", "output"], [limitOf({ ...login, context: 1000000, output: 128000, date: "2026-11-08" })], sourceOf);

  const { catalog } = resolve({
    upstream: { lab: { id: "lab", name: "Lab", models: { m: UpstreamModel.parse({ id: "m", name: "M" }) } } },
    additions: [], overrides: [], routes: {}, access: { default: "api", default_basis: "fixture", patterns: [], providers: {} }, upstreamDate: "2026-11-15",
  });
  const index = buildIndex(catalog, "fixture", "2026-11-15T00:00:00Z", "2026-11-15T00:00:00Z");
  /** The page of an entry whose record is `w`, on the full entry and on its summary, as the API has it. */
  const page = (w: InputWindow, more: Partial<Summary> = {}, date = new Date("2026-11-16T00:00:00Z")): string => {
    const model = structuredClone(catalog.lab!.models.m!) as JsonObject;
    (model[NS] as unknown as ModelExtension).limits.input_window = w;
    return entryHtml({ summary: { ...index.entries[0]!, input_window: w, ...more }, provider: index.providers[0]!, model, today: { date, stale_after_days: 90 }, cache_ages_s: CACHE_AGES_S, imported: "2026-11-15" });
  };
  const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const table = (html: string): string => html.slice(html.indexOf('<h3 id="input-window">'), html.indexOf("<h3>Documented</h3>"));
  /** The rows of the Input window table, each as "label | value | source"; a row label without its hint. */
  const lines = (html: string): string[] =>
    [...table(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].slice(1).map((row) =>
      [...row[1]!.matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/g)].map((cell) => text(cell[1] === "th" ? cell[2]!.split("<div")[0]! : cell[2]!)).join(" | "));
  const tile = (html: string): string => text(html.slice(html.indexOf('<div class="tiles'), html.indexOf("Context window</div>")));
  /** The Input window cell of a row of the entry table. */
  const cell = (w: InputWindow, more: Partial<Summary> = {}): string => {
    const html = row({ input_window: w, ...more });
    const at = html.indexOf('<td class="num window-col"');
    return html.slice(at, html.indexOf("</td>", at));
  };

  it("is built from the five cases of the record", () => {
    expect([CASES.documented, CASES.notContradicted, CASES.contradicted, CASES.measured, CASES.none].map((w) => [w.basis, w.documented_tokens !== null, w.measured_tokens !== null, w.documented_status])).toEqual([
      ["documented", true, false, null], ["documented", true, true, "not_contradicted"], ["measured", true, true, "contradicted"], ["measured", false, true, null], ["none", false, false, null],
    ]);
  });

  it("has the same three rows on every entry, the value, the documented figure and the measurements", () => {
    for (const w of [...Object.values(CASES), named]) expect(lines(page(w)).map((line) => line.split(" | ")[0])).toEqual(["Input window", "Documented", "Measured"]);
    expect(lines(page(CASES.none))).toEqual(["Input window | Unknown | –", "Documented | Not documented | –", "Measured | Not measured | –"]);
  });

  it("prints each row of the five cases as the record has it", () => {
    expect(lines(page(CASES.documented))).toEqual([
      "Input window | 1,000,000 tokens documented Input and output together | models.dev 2026-11-15",
      "Documented | 1,000,000 tokens limit.context | models.dev 2026-11-15",
      "Measured | Not measured | –",
    ]);
    expect(lines(page(CASES.notContradicted))).toEqual([
      "Input window | 922,000 tokens documented Input alone | models.dev 2026-11-15",
      "Documented | 922,000 tokens limit.input Documentation not contradicted | models.dev 2026-11-15",
      "Measured | at least 915,011 tokens 915,011 accepted · 922,500 refused | Requests sent through CLIProxyAPI 2026-11-13 · Raw result",
    ]);
    expect(lines(page(CASES.contradicted))).toEqual([
      "Input window | 900,000 tokens measured Input and output together | providers.dev 2026-11-08",
      "Documented | 1,000,000 tokens limit.context Documentation contradicted | models.dev 2026-11-15",
      "Measured | 900,000 tokens Window named by the route | Requests sent through CLIProxyAPI 2026-11-08 · Raw result",
    ]);
    expect(lines(page(CASES.measured))).toEqual([
      "Input window | at least 915,011 tokens measured Input alone | providers.dev 2026-11-11",
      "Documented | Not documented | –",
      "Measured | at least 915,011 tokens 915,011 accepted · 922,500 refused | Requests sent through CLIProxyAPI 2026-11-11 · Raw result",
    ]);
    // A window written onto an added entry from a measurement is a measurement: not documented.
    expect(lines(page(named))).toEqual([
      "Input window | 1,000,000 tokens measured Input and output together | providers.dev 2026-11-08",
      "Documented | Not documented | –",
      "Measured | 1,000,000 tokens Window named by the route | Requests sent through CLIProxyAPI 2026-11-08 · Raw result",
    ]);
    expect(table(page(CASES.measured))).toContain('<a href="https://example.com/result" rel="noopener">Raw result</a>');
  });

  it("gives each measurement its own line, in the order of the record, under one row heading", () => {
    const two = inputWindow(undefined, [], [bracket("2026-11-11"), limitOf({ client: "direct", client_label: "Straight to the provider", input_accepted: 950000, input_read: 940000, date: "2026-11-12", source: "https://example.com/other" })], sourceOf);
    expect(two.measurements.map((item) => item.client)).toEqual(["cliproxyapi", "direct"]);
    expect(lines(page(two)).slice(2)).toEqual([
      "Measured | at least 915,011 tokens 915,011 accepted · 922,500 refused | Requests sent through CLIProxyAPI 2026-11-11 · Raw result",
      "at least 940,000 tokens 950,000 accepted · 940,000 read to the end · nothing refused | Straight to the provider 2026-11-12 · Raw result",
    ]);
    expect(table(page(two))).toContain('<th scope="row" rowspan="2">Measured');
    // The reverse order in the record is the order on the page: nothing is sorted here.
    expect(lines(page({ ...two, measurements: [...two.measurements].reverse() })).slice(2).map((line) => line.split(" tokens")[0])).toEqual(["Measured | at least 940,000", "at least 915,011"]);
  });

  it("says at least, and ≥, where bound says so and from nothing else", () => {
    // A documented value with `at_least`, and a measured bracket with `limit`: the page follows `bound`, not the basis or the kind.
    const atLeast = { ...CASES.notContradicted, bound: "at_least" as const };
    expect(lines(page(atLeast))[0]).toBe("Input window | at least 922,000 tokens documented Input alone | models.dev 2026-11-15");
    expect(text(cell(atLeast))).toBe("≥ 922K documented");
    const limit = { ...CASES.measured, bound: "limit" as const };
    expect(lines(page(limit))[0]).toBe("Input window | 915,011 tokens measured Input alone | providers.dev 2026-11-11");
    expect(text(cell(limit))).toBe("915K measured");
    expect(tile(page(limit))).not.toContain("at least");
    // A measurement's line reads its own bound, and the tile reads `measured_bound` for the other figure.
    const item = { ...CASES.notContradicted, measured_bound: "limit" as const, measurements: [{ ...CASES.notContradicted.measurements[0]!, bound: "limit" as const }] };
    expect(lines(page(item))[2]).toBe("Measured | 915,011 tokens 915,011 accepted · 922,500 refused | Requests sent through CLIProxyAPI 2026-11-13 · Raw result");
    expect(tile(page(item))).toContain("Measured 915,011");
    expect(tile(page(item))).not.toContain("at least");
    // The lower bound is rounded down in the compact number, the limit as usual.
    const wonder = { ...CASES.measured, tokens: 1047604 };
    expect(text(cell(wonder))).toBe("≥ 1.04M measured");
    expect(text(cell({ ...wonder, bound: "limit" }))).toBe("1.05M measured");
  });

  it("prints the label of the documentation from documented_status, and a measurement's words from its kind", () => {
    const status = (documented_status: InputWindow["documented_status"]) => lines(page({ ...CASES.notContradicted, documented_status }))[1];
    expect(status("contradicted")).toBe("Documented | 922,000 tokens limit.input Documentation contradicted | models.dev 2026-11-15");
    expect(status("not_contradicted")).toBe("Documented | 922,000 tokens limit.input Documentation not contradicted | models.dev 2026-11-15");
    expect(status(null)).toBe("Documented | 922,000 tokens limit.input | models.dev 2026-11-15");
    expect(table(page({ ...CASES.notContradicted, documented_status: "contradicted" }))).toContain('<span class="case contradicted"');
    const base = CASES.notContradicted.measurements[0]!;
    const kind = (item: Partial<InputWindow["measurements"][number]>) => lines(page({ ...CASES.notContradicted, measurements: [{ ...base, ...item }] }))[2]!.split(" | ")[1];
    expect(kind({ kind: "window" })).toBe("at least 915,011 tokens Window named by the route · an input of 915,011 accepted");
    expect(kind({ kind: "window", accepted: null })).toBe("at least 915,011 tokens Window named by the route");
    expect(kind({ kind: "bracket" })).toBe("at least 915,011 tokens 915,011 accepted · 922,500 refused");
    expect(kind({ kind: "accepted", refused: null, read: 915011 })).toBe("at least 915,011 tokens 915,011 accepted · 915,011 read to the end · nothing refused");
    expect(kind({ kind: "bracket", read: 900000 })).toBe("at least 915,011 tokens 915,011 accepted · 922,500 refused · 900,000 read to the end");
  });

  it("starts the page with the value, its basis, source and date, and the other of the two figures", () => {
    expect(tile(page(CASES.notContradicted))).toBe("Input window 922,000 tokens documented models.dev · 2026-11-15 Input alone Measured at least 915,011");
    expect(tile(page(CASES.measured))).toBe("Input window at least 915,011 tokens measured providers.dev · 2026-11-11 Input alone");
    expect(tile(page(CASES.contradicted))).toBe("Input window 900,000 tokens measured providers.dev · 2026-11-08 Input and output together Documented 1,000,000, contradicted");
    expect(page(CASES.contradicted)).toContain('<div class="contradicted">Documented 1,000,000, contradicted</div>');
    expect(tile(page(CASES.documented))).toBe("Input window 1,000,000 tokens documented models.dev · 2026-11-15 Input and output together");
    expect(tile(page(named))).toBe("Input window 1,000,000 tokens measured providers.dev · 2026-11-08 Input and output together");
    expect(tile(page(CASES.none))).toBe("Input window Unknown Not documented or measured");
    // The input window is the first of the tiles.
    expect(page(CASES.measured)).toMatch(/<div class="tiles tiles-five mt-6">\s*<div class="tile"><div class="label">Input window<\/div>/);
  });

  it("shows the value in the entry table with its basis, and what it rests on in the hover text", () => {
    expect(text(cell(CASES.notContradicted))).toBe("922K documented");
    expect(text(cell(CASES.measured))).toBe("≥ 915K measured");
    expect(text(cell(CASES.contradicted))).toBe("900K measured");
    expect(text(cell(CASES.none))).toBe("Unknown");
    expect(cell(CASES.measured)).toContain('<a class="plain window" href="/entries/p/m#input-window"');
    expect(cell(CASES.measured)).toContain('title="Input window: at least 915,011 tokens, input alone. Measured by providers.dev, 2026-11-11: the largest input seen accepted; 922,500 tokens refused. Not documented."');
    expect(cell(CASES.notContradicted)).toContain('title="Input window: 922,000 tokens, input alone. Documented in limit.input, models.dev, 2026-11-15. Measured: at least 915,011 tokens (1 client, 1 evaluation). Documentation not contradicted."');
    expect(cell(CASES.contradicted)).toContain('title="Input window: 900,000 tokens, input and output together. Measured by providers.dev, 2026-11-08: the window the route named. Documented: 1,000,000 tokens in limit.context, models.dev. Documentation contradicted."');
    expect(cell(CASES.documented)).toContain('title="Input window: 1,000,000 tokens, input and output together. Documented in limit.context, models.dev, 2026-11-15. Not measured."');
    expect(cell(CASES.none)).toContain('title="Input window: unknown. Nothing documented or measured."');
  });

  it("reads no limit from measured_input_accepted or measured_input_refused: the Context column is limit.context and nothing else", () => {
    const options = { today: { date: new Date("2026-11-16T00:00:00Z"), stale_after_days: 90 } };
    const evaluated = { measured_input_accepted: 915011, measured_input_refused: 922500, measured_limit_count: 1 };
    const blank = { measured_input_accepted: null, measured_input_refused: null };
    for (const w of [...Object.values(CASES), named]) {
      expect(rowHtml(summaryOf({ input_window: w, ...evaluated }), options)).toBe(rowHtml(summaryOf({ input_window: w, ...evaluated, ...blank }), options));
      expect(page(w, evaluated)).toBe(page(w, blank));
    }
    // An entry with no context window documented: before, its Context cell said "≥ 915K input" from the summary.
    const html = row({ input_window: CASES.measured, ...evaluated });
    const context = html.slice(html.indexOf('data-label="Context"'), html.indexOf("</td>", html.indexOf('data-label="Context"')));
    expect(text(`<td ${context}`)).toBe("Unknown");
    expect(html).not.toContain("limit-measured");
  });

  it("marks a providers.dev date stale by the published threshold, and never models.dev's", () => {
    const later = new Date("2027-03-01T00:00:00Z");
    expect(lines(page(CASES.measured, {}, later))).toEqual([
      "Input window | at least 915,011 tokens measured Input alone | providers.dev 2026-11-11 · stale",
      "Documented | Not documented | –",
      "Measured | at least 915,011 tokens 915,011 accepted · 922,500 refused | Requests sent through CLIProxyAPI 2026-11-11 · stale · Raw result",
    ]);
    expect(lines(page(CASES.notContradicted, {}, later)).slice(0, 2).join(" ")).not.toContain("stale");
    expect(lines(page(CASES.notContradicted, {}, later))[2]).toContain("2026-11-13 · stale");
  });
});

describe("the input window of a model", () => {
  const sourceOf = () => ({ source: "models.dev" as const, date: "2026-11-15" });
  const login = { route: "lab-subscription", route_label: "Lab plan", client: "cliproxyapi", client_label: "Requests sent through CLIProxyAPI" };
  /** A window documented as the context window: input and output together. */
  const window = (context: number): InputWindow => inputWindow({ context }, [], [], sourceOf);
  /** An input limit documented under a larger context window: input alone. */
  const input = (tokens: number, context = 1050000): InputWindow => inputWindow({ context, input: tokens }, [], [], sourceOf);
  /** Nothing documented, a measurement that saw `accepted` taken and more refused: a lower bound. */
  const atLeast = (accepted: number): InputWindow => inputWindow(undefined, [], [limitOf({ ...login, input_accepted: accepted, input_refused: accepted + 7500, date: "2026-11-11" })], sourceOf);
  const none = emptyInputWindow();
  /** A model of the lab "lab" with one entry per window and context, the API's own way (canonicalModels): the lab's entry first. */
  const modelOf = (windows: [string, InputWindow, number?][]) =>
    canonicalModels(windows.map(([provider, w, context]) => summaryOf({ ref: `${provider}/m`, provider, model: "m", canonical_id: "lab/m", input_window: w, context: context ?? w.documented_tokens })))[0]!;
  const page = (windows: [string, InputWindow, number?][]): string => modelHtml(modelOf(windows), { lab: "Lab", p: "P", q: "Q", r: "R" }, "2026-11-15", { date: new Date("2026-11-16T00:00:00Z"), stale_after_days: 90 });
  const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const tiles = (html: string): string[] => html.slice(html.indexOf('<div class="tiles'), html.indexOf("</div>\n", html.indexOf('<div class="tiles'))).split('<div class="tile">').slice(1);
  /** The text of the Input window tile, the first. */
  const tile = (windows: [string, InputWindow, number?][]): string => text(tiles(page(windows))[0]!);
  /** The hover text of the tile's value. */
  const hover = (windows: [string, InputWindow, number?][]): string => /<div class="value small"><span title="([^"]*)"/.exec(tiles(page(windows))[0]!)?.[1] ?? "";

  it("is the first of five tiles, the three limits together, then the two counts", () => {
    const html = page([["lab", window(1000000)], ["p", input(850000)]]);
    expect(html).toContain('<div class="tiles tiles-five');
    expect(tiles(html).map((one) => text(one.split('<div class="value')[0]!))).toEqual(["Input window", "Context window", "Maximum output", "Entries", "With providers.dev evidence"]);
  });

  it("gives the smallest to the largest among its entries, and the lab's own entry with what kind of figure it is", () => {
    expect(tile([["lab", window(1000000)], ["p", input(850000)], ["q", window(1000000)]])).toBe("Input window 850K to 1M tokens Smallest to largest among its entries At Lab: 1M, input and output together");
    expect(hover([["lab", window(1000000)], ["p", input(850000)], ["q", window(1000000)]])).toBe("Smallest: 850,000 tokens, documented, p/m. Largest: 1,000,000 tokens, documented, lab/m.");
  });

  it("is not the context window: an input limit under a larger window shows beside it as what it is", () => {
    const tiled = tiles(page([["lab", input(922000), 1050000], ["p", input(922000), 1050000], ["q", window(271999)]])).map(text);
    expect(tiled[0]).toBe("Input window 272K to 922K tokens Smallest to largest among its entries At Lab: 922K, input alone");
    expect(tiled[1]).toBe("Context window 272K to 1.05M tokens Smallest to largest among its entries");
  });

  it("counts the entries with no input window, and compares only the others", () => {
    expect(tile([["lab", window(1000000)], ["p", none], ["q", input(850000)]])).toBe("Input window 850K to 1M tokens Smallest to largest among its entries; unknown at 1 of 3 At Lab: 1M, input and output together");
    expect(tile([["lab", none], ["p", window(1000000)], ["q", input(850000)]])).toBe("Input window 850K to 1M tokens Smallest to largest among its entries; unknown at 1 of 3 At Lab: unknown");
  });

  it("marks an end that is a lower bound with ≥, rounded down, and says what ≥ is", () => {
    // At the low end: devin/gpt-6-1-terra, at least 921,500 under documented 922,000.
    expect(tile([["lab", input(922000)], ["p", atLeast(921500)], ["q", input(1050000)]])).toBe("Input window ≥ 921K to 1.05M tokens Smallest to largest among its entries ≥ marks a lower bound At Lab: 922K, input alone");
    expect(hover([["lab", input(922000)], ["p", atLeast(921500)], ["q", input(1050000)]])).toBe("Smallest: at least 921,500 tokens, measured, p/m. Largest: 1,050,000 tokens, documented, q/m.");
    // At the high end.
    expect(tile([["lab", input(922000)], ["p", atLeast(1049999)]])).toBe("Input window 922K to ≥ 1.04M tokens Smallest to largest among its entries ≥ marks a lower bound At Lab: 922K, input alone");
    // Between the ends a lower bound changes neither.
    expect(tile([["lab", input(922000)], ["p", atLeast(950000)], ["q", input(1050000)]])).toBe("Input window 922K to 1.05M tokens Smallest to largest among its entries At Lab: 922K, input alone");
    // The lab's own entry a lower bound.
    expect(tile([["lab", atLeast(915011)], ["p", input(922000)]])).toBe("Input window ≥ 915K to 922K tokens Smallest to largest among its entries ≥ marks a lower bound At Lab: ≥ 915K, input alone");
  });

  it("ranks a lower bound above the same number that is not one: the smallest is the exact one, the largest the one that may be more", () => {
    expect(tile([["lab", window(1000000)], ["p", atLeast(1000000)], ["q", input(850000)]])).toBe("Input window 850K to ≥ 1M tokens Smallest to largest among its entries ≥ marks a lower bound At Lab: 1M, input and output together");
    expect(tile([["lab", input(922000)], ["p", atLeast(922000)], ["q", input(1050000)]])).toBe("Input window 922K to 1.05M tokens Smallest to largest among its entries At Lab: 922K, input alone");
    expect(tile([["lab", window(1000000)], ["p", atLeast(1000000)]])).toBe("Input window 1M to ≥ 1M tokens Smallest to largest among its entries ≥ marks a lower bound At Lab: 1M, input and output together");
  });

  it("gives a single value once, and says at how many entries", () => {
    expect(tile([["lab", window(1000000)], ["p", window(1000000)], ["q", window(1000000)]])).toBe("Input window 1M tokens The same at all 3 entries At Lab: 1M, input and output together");
    expect(hover([["lab", window(1000000)], ["p", window(1000000)], ["q", window(1000000)]])).toBe("1,000,000 tokens, documented, lab/m, the same at every entry that has one.");
    expect(tile([["p", window(1000000)], ["q", window(1000000)]])).toBe("Input window 1M tokens The same at both entries");
    expect(tile([["lab", window(256000)]])).toBe("Input window 256K tokens Its only entry At Lab: 256K, input and output together");
    expect(tile([["lab", none], ["p", window(1000000)], ["q", window(1000000)]])).toBe("Input window 1M tokens The same at every entry that has one; unknown at 1 of 3 At Lab: unknown");
    expect(tile([["lab", atLeast(915011)], ["p", atLeast(915011)]])).toBe("Input window ≥ 915K tokens The same at both entries ≥ marks a lower bound At Lab: ≥ 915K, input alone");
  });

  it("says Unknown, never 0, where no entry has an input window", () => {
    expect(tile([["lab", none], ["p", none], ["q", none]])).toBe("Input window Unknown Not documented or measured at any of its 3 entries At Lab: unknown");
    expect(tile([["p", none]])).toBe("Input window Unknown Not documented or measured");
  });

  it("writes two values in full where they round to the same figure", () => {
    expect(tile([["p", window(921600)], ["q", input(922000)]])).toBe("Input window 921,600 to 922,000 tokens Smallest to largest among its entries");
  });

  it("prints the ends and the count the API publishes, and compares nothing itself", () => {
    const model = modelOf([["lab", window(1000000)], ["p", input(850000)]]);
    const html = (more: Partial<typeof model>): string => text(tiles(modelHtml({ ...model, ...more }, { lab: "Lab" }, "2026-11-15", { date: new Date("2026-11-16T00:00:00Z"), stale_after_days: 90 }))[0]!);
    expect(html({})).toBe("Input window 850K to 1M tokens Smallest to largest among its entries At Lab: 1M, input and output together");
    // Whatever the fields say is what the tile says, whatever the entries under it hold.
    expect(html({ input_window_min: { entry_ref: "x/m", tokens: 128000, bound: "limit", basis: "documented", scope: "input" }, input_window_unknown_count: 5 })).toBe("Input window 128K to 1M tokens Smallest to largest among its entries; unknown at 5 of 2 At Lab: 1M, input and output together");
    expect(html({ input_window_min: null, input_window_max: null })).toBe("Input window Unknown Not documented or measured at any of its 2 entries At Lab: 1M, input and output together");
    // The lab's line is input_window_reference, not the lab's entry looked up in entries.
    expect(html({ input_window_reference: { entry_ref: "lab/m", tokens: 922000, bound: "limit", basis: "documented", scope: "input" } })).toBe("Input window 850K to 1M tokens Smallest to largest among its entries At Lab: 922K, input alone");
    expect(html({ input_window_reference: null })).toBe("Input window 850K to 1M tokens Smallest to largest among its entries At Lab: unknown");
    expect(html({ reference_ref: null })).toBe("Input window 850K to 1M tokens Smallest to largest among its entries");
  });
});

// pi's block on an entry's page and in a row (design/pi-source.md, section h; step 6). The page prints the block and
// /api/v1/meta.pi as they are: every number it shows is one of theirs, and what pi does not state says so.
describe("pi's catalog on an entry's page and in a row", () => {
  const piModel = (id: string, more: Partial<PiModel> = {}): PiModel => ({
    id, name: `Pi ${id}`, api: "openai-completions", provider: "lab", baseUrl: "https://api.lab.example/v1", reasoning: true, input: ["text", "image"],
    cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 }, contextWindow: 190000, maxTokens: 8000, type: "chat", ...more,
  }) as PiModel;
  const pi: PiCatalog = {
    lab: {
      // Differs in its context window and in its tiers; every optional field stated.
      full: piModel("full", {
        cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25, tiers: [{ inputTokensAbove: 199999, input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 }] },
        compat: { supportsStore: false, thinkingFormat: "openai", chatTemplateArgs: { enable_thinking: { $var: "thinking.enabled" } } },
        thinkingLevelMap: { off: "none", minimal: null, high: "high" },
        promptCache: { short: 300, long: 3600 },
        inputLimits: { maxRequestBytes: 20971520, images: { maxPerRequest: 3600 } },
      }),
      // Nothing optional stated, and every price 0.
      bare: piModel("bare", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 }),
    },
  };
  const { catalog } = resolve({
    upstream: {
      lab: {
        id: "lab", name: "Lab",
        models: {
          full: UpstreamModel.parse({ id: "full", name: "Full", limit: { context: 200000, output: 8000 }, cost: { text: { input: { price: 1, cache: { read: 0.1, write: 1.25 }, overrides: [{ when: { context: { gt: 200000 } }, price: 2, cache: { read: 0.2 } }] }, output: { price: 4, overrides: [{ when: { context: { gt: 200000 } }, price: 8 }] } } } }),
          bare: UpstreamModel.parse({ id: "bare", name: "Bare", limit: { context: 100000, output: 4000 } }),
          unlisted: UpstreamModel.parse({ id: "unlisted", name: "Unlisted" }),
        },
      },
    },
    additions: [], overrides: [], routes: {}, access: { default: "api", default_basis: "fixture", patterns: [], providers: {} }, upstreamDate: "2026-11-13",
    pi: { catalog: pi },
  });
  const index = buildIndex(catalog, "fixture", "2026-11-14T00:00:00Z", "2026-11-14T00:00:00Z");
  const meta = (more: Partial<MetaPi["sync"]> = {}): MetaPi => ({
    source: "https://pi.dev/api/models",
    snapshot: { fetched_at: "2026-11-12T14:19:45.000Z", checked_at: "2026-11-14T04:17:12.000Z", etag: '"p1"', last_modified: null, revision: null, sha256: "ab".repeat(32), providers: 1, models: 2 },
    sync: { last_attempt_at: "2026-11-14T04:17:12.000Z", last_attempt_ok: true, last_error: null, ...more },
    counts: { entries_with_block: 2, left_out_models: 0, unmatched_models: 0 },
  });
  const page = (model: string, piMeta: MetaPi = meta()): string => {
    const summary = index.entries.find((entry) => entry.ref === `lab/${model}`)!;
    return entryHtml({ summary, provider: index.providers[0]!, model: catalog.lab!.models[model]!, today: { date: new Date("2026-11-14T00:00:00Z"), stale_after_days: 90 }, cache_ages_s: CACHE_AGES_S, imported: "2026-11-13", pi: piMeta });
  };
  const section = (html: string): string => html.split('<section aria-labelledby="pi">')[1]!.split("</section>")[0]!;
  const blockOf = (model: string): PiBlock => (catalog.lab!.models[model]![NS] as unknown as ModelExtension).pi!;
  /** What a reader sees: the text of the HTML, without its tags and the hover texts. */
  const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  const numbersOf = (value: unknown): number[] => (typeof value === "number" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(numbersOf) : []);

  it("the blocks are as the cases need them: one with differences and every field, one with nothing optional", () => {
    expect(blockOf("full").differences.map((item) => item.field)).toEqual(["context_window", "cost.tiers"]);
    expect(blockOf("bare")).toMatchObject({ compat: null, thinking_level_map: null, prompt_cache: null, differences: [] });
    expect(blockOf("bare").input_limits).toEqual({ max_request_bytes: null, max_images_per_request: null, max_images_per_message: null });
    expect(index.entries.find((entry) => entry.ref === "lab/unlisted")!.pi).toBeNull();
  });

  it("every value on the page is in the API answers it was drawn from", () => {
    for (const model of ["full", "bare"]) {
      const block = blockOf(model);
      const shown = text(section(page(model)));
      // Every date is the fetch, the check or the last attempt of /meta.pi.
      const dates = [...shown.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((match) => match[0]);
      expect(dates.length).toBeGreaterThan(0);
      for (const date of dates) expect(["2026-11-12", "2026-11-14"]).toContain(date);
      // Every number is one of the block's, written as the page writes it; "1M" is the unit of a price.
      const allowed = new Set<string>();
      for (const value of numbersOf(block)) for (const written of [value.toLocaleString("en-US"), usd(value).slice(1)]) allowed.add(written);
      for (const value of numbersOf(block.prompt_cache)) allowed.add(duration(value).split(" ")[0]!);
      const rest = shown.replace(/\d{4}-\d{2}-\d{2}/g, " ").replace(/\/ 1M\b/g, " ").replace(/per 1M tokens/g, " ").replace(/<code>[^<]*<\/code>/g, " ");
      const names = [block.ref, block.provider, block.model, block.name, block.base_url ?? "", ...Object.keys(block.compat ?? {}), ...Object.values(block.compat ?? {}).map((value) => JSON.stringify(value)), ...Object.entries(block.thinking_level_map ?? {}).flat().map(String)].sort((x, y) => y.length - x.length);
      const numbers = [...names.reduce((left, name) => left.replaceAll(name, " "), rest).matchAll(/\$?(\d[\d,]*(?:\.\d+)?)/g)].map((match) => match[1]!);
      expect(numbers.length).toBeGreaterThanOrEqual(model === "full" ? 20 : 2);
      for (const number of numbers) expect(allowed, `${model}: ${number}`).toContain(number);
    }
    // And each stated value is on the page.
    const full = section(page("full"));
    for (const value of ["190,000", "200,000", "199,999", "20,971,520", "3,600", "5 min", "1 h", "openai-completions", "https://api.lab.example/v1"]) expect(text(full)).toContain(value);
  });

  it("a flag absent from compat is not shown as false, and nothing pi does not state is shown as no", () => {
    // The values pi states, without the hints under the row names (one of which says that an absent flag is not false).
    const values = (html: string): string => text([...section(html).matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => match[1]).join(" | "));
    const bare = section(page("bare"));
    expect(values(page("bare"))).not.toMatch(/\bfalse\b/);
    expect(bare).toContain("None stated");
    expect(text(bare)).not.toContain("supportsStore");
    // Thinking levels, cache lifetimes and every price 0: not stated, never "no", never free.
    expect(text(bare).match(/Not stated/g)!.length).toBeGreaterThanOrEqual(6);
    expect(text(bare)).not.toMatch(/\bfree\b|\$0\b/i);
    // On the other block, false is shown only where pi states it, by its flag's name.
    const full = section(page("full"));
    expect(values(page("full")).match(/\bfalse\b/g)).toEqual(["false"]);
    expect(full).toContain("<dt><code>supportsStore</code></dt><dd><code>false</code></dd>");
    expect(full).toContain("<dt>minimal</dt><dd><span class=\"muted\" title=\"pi marks this level as not supported.\">not supported</span></dd>");
    // pi's tier cache-write of 0 is not stated; the entry's tier, which states none, says so too.
    expect(text(full)).toMatch(/Above 199,999 In \$2 Out \$8 Cache read \$0\.20 Cache write Not stated/);
    expect(text(full)).toMatch(/Above 200,000 In \$2 Out \$8 Cache read \$0\.20 Cache write Not stated/);
  });

  it("has the same tables and rows on every entry pi lists, and one line on an entry it does not", () => {
    const skeleton = (html: string): string[] => [...section(html).matchAll(/<h3[^>]*>(.*?)<\/h3>|<th scope="(?:col|row)"[^>]*>(.*?)(?:<div|<\/th>)/gs)].map((match) => (match[1] ?? match[2]!).replace(/<[^>]+>/g, "").trim());
    expect(skeleton(page("bare"))).toEqual(skeleton(page("full")).map((item) => item.replace("2 differences", "no difference")));
    expect(skeleton(page("full"))).toContain("Request limits");
    const unlisted = section(page("unlisted"));
    expect(text(unlisted).trim()).toBe("pi's catalog pi's model catalog does not list this entry. Fetched 2026-11-12 from pi.dev/api/models Last checked 2026-11-14 , unchanged");
  });

  it("says when pi's catalog was fetched and last checked, and that the last import failed when /meta says so", () => {
    const fine = page("full");
    expect(text(section(fine))).toContain("Fetched 2026-11-12 from pi.dev/api/models Last checked 2026-11-14 , unchanged");
    expect(fine).toMatch(/>pi\.dev<span class="pi-differ">2 differ<span class="sr-only"> from this page<\/span><\/span><\/span><span class="muted date" title="Fetched from pi&#39;s catalog 2026-11-12 14:19 UTC\. Last checked 2026-11-14 04:17 UTC: unchanged since the fetch\.">2026-11-12<\/span>/);
    expect(fine).not.toContain("failed");
    const failed = page("full", meta({ last_attempt_at: "2026-11-15T04:17:00.000Z", last_attempt_ok: false, last_error: "pi.dev answered HTTP 503" }));
    expect(text(section(failed))).toContain("The last import, 2026-11-15, failed: this is the last good one");
    expect(failed).toContain(">2026-11-12 · last import failed</span>");
    expect(text(section(page("unlisted", meta({ last_attempt_ok: false }))))).toContain("failed: this is the last good one");
  });

  it("a row with a block has the pi.dev badge and nothing about differences; a row without one has none", () => {
    const listed = row({ ref: "lab/full", provider: "lab", model: "full", pi: { ref: "lab/full", api: "openai-completions", match: "id", difference_count: 2 } });
    expect(listed).toContain('<span class="origin pi" title="pi&#39;s model catalog (pi.dev) also lists this entry. Imported beside models.dev, not verified by providers.dev. The entry&#39;s page shows what pi states.">pi.dev</span>');
    expect(listed).not.toContain("<a class=\"origin");
    expect(listed).not.toMatch(/differ|otherwise|agree/i);
    const paired = row({ ref: "lab/full", provider: "lab", model: "full", pi: { ref: "lab-pi/Full", api: "openai-completions", match: "alias", difference_count: 0 } });
    expect(paired).toContain("also lists this entry, as lab-pi/Full.");
    expect(row({})).not.toContain("pi.dev");
  });
});
