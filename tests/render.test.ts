import { describe, expect, it } from "vitest";
import { cacheLifetime, cacheResult, documentedCache, type CacheEvaluation, type EntryCache, type RetentionProfile } from "../src/core/cache.ts";
import { buildIndex, type Summary } from "../src/core/entries.ts";
import type { Json, JsonObject } from "../src/core/merge.ts";
import { entryHtml, rowHtml } from "../src/core/render.ts";
import { resolve } from "../src/core/resolve.ts";
import { NS, UpstreamModel, type ModelExtension } from "../src/core/schema.ts";
import { pricingOf } from "../src/core/policies.ts";
import { NO_CACHE, summaryOf } from "./helpers.ts";

const row = (more: Partial<Summary>): string => rowHtml(summaryOf(more), { now: new Date("2026-11-13T00:00:00Z") });
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
  const documented = documentedCache(cache === undefined ? {} : { capabilities: { cache } });
  return { ...NO_CACHE, documented, lifetime: cacheLifetime(documented, evaluations, () => ({ source: "models.dev", date: "2026-11-15" })), results: null, evaluations };
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
    const html = entryHtml({ summary, provider: index.providers[0]!, model: catalog.p!.models.m!, now: new Date("2026-11-14T00:00:00Z") });
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
    return entryHtml({ summary, provider: index.providers.find((item) => item.id === summary.provider)!, model: catalog[summary.provider]!.models[summary.model]!, now: new Date("2026-11-14T00:00:00Z"), imported: "2026-11-13" });
  };
  const pages = { bare: page("lab/bare"), full: page("lab/full"), login: page("lab-login/full") };
  /** The skeleton of a page: its headings, the column heads of its tables, and the labels of its rows. */
  const skeleton = (html: string): string[] =>
    [...html.matchAll(/<h([23])[^>]*>(.*?)<\/h\1>|<th scope="(col|row|colgroup)"[^>]*>(.*?)(?:<div|<\/th>)/gs)].map((match) => (match[1] ? `h${match[1]} ${match[2]}` : `${match[3]} ${match[4]}`).replace(/<[^>]+>/g, "").trim());

  it("has the same sections, tables and rows whatever is known about the entry", () => {
    const bare = skeleton(pages.bare);
    expect(bare.filter((item) => item.startsWith("h"))).toEqual(["h2 Limits", "h3 Documented", "h3 Measured tokens", "h2 Price", "h3 Conditional rates", "h3 Request controls", "h2 Prompt caching", "h3 Lifetimes", "h3 Cache modes", "h3 Retention", "h2 Provenance", "h2 Data"]);
    expect(bare.filter((item) => item.startsWith("row"))).toEqual([
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
    for (const label of ["Provider", "Context", "Max output", "Price in / out", "Released", "Cache lifetime", "Source"]) expect(html).toContain(`data-label="${label}"`);
    expect(count(rowHtml(summaryOf({}), { now: new Date("2026-11-13T00:00:00Z"), hideProvider: true }), 'data-label="Provider"')).toBe(0);
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
    return entryHtml({ summary: { ...index.entries[0]!, cache_lifetime: cache.lifetime, evaluation_count: cache.evaluations.length }, provider: index.providers[0]!, model, now, imported: "2026-11-15" });
  };
  const section = (html: string): string => html.slice(html.indexOf('<h2 id="cache">'), html.indexOf("<h3>Cache modes</h3>"));
  const tiles = (html: string): string => html.slice(html.indexOf('<div class="tiles'), html.indexOf("</div>\n\n<section"));
  const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  /** The rows of a table body: one item or one profile, its cells as text. */
  const bodies = (html: string): string[] => [...section(html).matchAll(/<tbody class="([^"]+)">([\s\S]*?)<\/tbody>/g)].map((match) => `${match[1]}: ${text(match[2]!)}`);

  it("starts with the safe lifetime of short and long, its basis, source and date", () => {
    expect(text(tiles(page(CASES.opus)))).toContain("Cache lifetime, short 5 min documented models.dev · 2026-11-15 Cache lifetime, long 1 h documented models.dev · 2026-11-15 Measured 10 min");
    expect(text(tiles(page(CASES.flash)))).toContain("Cache lifetime, short 0 s measured providers.dev · 2026-11-04 Documented 5 min, contradicted Cache lifetime, long Unknown");
    expect(text(tiles(page(CASES.unknown)))).toContain("Cache lifetime, short Unknown Not documented or evaluated Cache lifetime, long Unknown");
  });

  it("lists every documented and measured lifetime in one table, by retention, each with its basis, source and date", () => {
    const rows = bodies(page(CASES.opus));
    expect(rows.map((body) => body.split(":")[0])).toEqual(["profile", "item documented", "profile", "item documented", "item measured"]);
    expect(rows[0]).toContain("Short retention Safe lifetime 5 min documented models.dev 2026-11-15 Documented 5 min Measured Not evaluated Inside the documented lifetime Not applicable");
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
      "profile: Short retention Safe lifetime Unknown Documented Not documented Measured Not evaluated Inside the documented lifetime Not applicable",
      "profile: Long retention Safe lifetime Unknown Documented Not documented Measured Not evaluated Inside the documented lifetime Not applicable",
    ]);
    const none = bodies(page(CASES.none));
    expect(none[0]).toContain("Short retention Safe lifetime None documented models.dev 2026-11-15 Documented None Measured Not evaluated");
    expect(none[1]).toBe("item documented: None documented models.dev 2026-11-15 Documented as not caching Not applicable");
    expect(none[3]).toBe("item documented: None documented models.dev 2026-11-15 Documented as not caching Not applicable");
    expect(bodies(page(CASES.flash))[2]).toContain("0 s measured");
  });
});

describe("the old cache fields", () => {
  // `cache_ttl_s`, `cache_ttl_by_mode_s`, `cache_results`, `providers_dev.cache.results` and `documented.modes.<mode>.ttl`
  // are to be deleted from the API. No renderer reads them: a page is the same with them removed, and with them set to
  // values that disagree with the record.
  const { catalog } = resolve({
    upstream: { lab: { id: "lab", name: "Lab", models: { m: UpstreamModel.parse({ id: "m", name: "M", capabilities: { cache: { explicit: { ttl: ["5m", "1h"] } } } }) } } },
    additions: [], overrides: [], routes: {}, access: { default: "api", default_basis: "fixture", patterns: [], providers: {} }, upstreamDate: "2026-11-15",
  });
  const index = buildIndex(catalog, "fixture", "2026-11-15T00:00:00Z", "2026-11-15T00:00:00Z");
  const now = new Date("2026-11-15T00:00:00Z");
  const model = structuredClone(catalog.lab!.models.m!) as JsonObject;
  // The published entry, and an evaluation on it so that every old field has something in it.
  const cache = (model[NS] as unknown as ModelExtension).cache;
  cache.evaluations = [K1_BETA, K1_NOBETA];
  cache.lifetime = cacheLifetime(cache.documented, cache.evaluations, () => ({ source: "models.dev", date: "2026-11-15" }));
  const summary: Summary = { ...index.entries[0]!, cache_lifetime: cache.lifetime, evaluation_count: 2 };

  type Fields = { summary: JsonObject; cache: JsonObject };
  /** The summary and the entry with the five fields changed by `change`. */
  const variant = (change: (fields: Fields) => void): { summary: Summary; model: JsonObject } => {
    const copy = structuredClone(model);
    const fields = { summary: structuredClone(summary) as unknown as JsonObject, cache: (copy[NS] as JsonObject).cache as JsonObject };
    change(fields);
    return { summary: fields.summary as unknown as Summary, model: copy };
  };
  const removed = variant(({ summary, cache }) => {
    for (const key of ["cache_ttl_s", "cache_ttl_by_mode_s", "cache_results"]) delete summary[key];
    delete cache.results;
    for (const mode of Object.values((cache.documented as JsonObject).modes as JsonObject)) delete (mode as JsonObject).ttl;
  });
  const wrong = variant(({ summary, cache }) => {
    summary.cache_ttl_s = [86400];
    summary.cache_ttl_by_mode_s = { implicit: [86400], explicit: [86400] };
    summary.cache_results = [{ retention_profile: "short", parameter: null, value: null, evaluations: 9, evaluation_ids: ["x"], last_date: "2020-01-01", results: [{ kind: "timed", age_s: 450, hits: 0, checks: 9, hit_rate_pct: 0 }] }];
    cache.results = summary.cache_results;
    for (const mode of Object.values((cache.documented as JsonObject).modes as JsonObject)) (mode as JsonObject).ttl = ["24h"];
  });
  // The raw record at the foot of the entry page is the API's answer printed as it is; everything else is rendered.
  const rendered = (view: { summary: Summary; model: JsonObject }): string =>
    entryHtml({ summary: view.summary, provider: index.providers[0]!, model: view.model, now, imported: "2026-11-15" }).replace(/<pre[\s\S]*?<\/pre>/g, "");

  it("are in the published entry and summary today", () => {
    expect(summary).toHaveProperty("cache_ttl_s", [300, 3600]);
    expect(cache.documented.modes.explicit).toHaveProperty("ttl", ["5m", "1h"]);
  });

  it("are not read by the table row", () => {
    const expected = rowHtml(summary, { now });
    expect(rowHtml(removed.summary, { now })).toBe(expected);
    expect(rowHtml(wrong.summary, { now })).toBe(expected);
    expect(expected).toContain("1 h");
  });

  it("are not read by the entry page", () => {
    const expected = rendered({ summary, model });
    expect(rendered(removed)).toBe(expected);
    expect(rendered(wrong)).toBe(expected);
    expect(expected).not.toContain("2020-01-01");
    expect(expected).not.toContain("0 of 9");
    expect(expected).not.toContain("<code>24h</code>");
  });
});
