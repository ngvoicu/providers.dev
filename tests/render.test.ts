import { describe, expect, it } from "vitest";
import { CACHE_AGES_S, cacheLifetime, cacheResult, documentedCaching, type CacheEvaluation, type EntryCache, type RetentionProfile } from "../src/core/cache.ts";
import { buildIndex, type Summary } from "../src/core/entries.ts";
import type { Json, JsonObject } from "../src/core/merge.ts";
import { emptyInputWindow, inputWindow, type InputWindow } from "../src/core/limits.ts";
import { entryHtml, evaluationStrip, piRechecked, rowHtml, tableHead } from "../src/core/render.ts";
import { modelHtml, modelsTableHtml, providerHtml } from "../src/core/detail-view.ts";
import type { ProviderSummary } from "../src/core/entries.ts";
import type { Listing, ListingLists, ListingModel, ListingReasoning, ListingSource, ListingSources } from "../src/core/listings.ts";
import { canonicalModels } from "../src/core/resources.ts";
import { resolve } from "../src/core/resolve.ts";
import { NS, UpstreamModel, type ModelExtension } from "../src/core/schema.ts";
import { pricingOf } from "../src/core/policies.ts";
import { finishLifetime, finishWindow, layPiOver, lifetimeSafe, limitOf, NO_CACHE, piShort, resolveWithPi, summaryOf } from "./helpers.ts";
import { exact, usdUnrounded } from "../src/core/format.ts";
import { span } from "../src/core/safe-view.ts";
import type { PiBlock, PiCatalog, PiModel } from "../src/core/pi.ts";
import type { MetaPi } from "../src/core/schema.ts";
import { emptySafeValues, type EntryAccess, type SafeValue, type SafeValues, type SourceValue } from "../src/core/safe.ts";

const row = (more: Partial<Summary>): string => rowHtml(summaryOf(more), { today: { date: new Date("2026-11-13T00:00:00Z"), stale_after_days: 90 } });
const count = (html: string, part: string): number => html.split(part).length - 1;

/** A published evaluation, its results written out as [age, hits, checks]; age 0 is the control. */
function run(id: string, client: string, profile: RetentionProfile, results: [number, number, number][], more: Partial<CacheEvaluation> = {}): CacheEvaluation {
  return {
    id, route: "lab-api", route_label: "Lab API key", client, client_label: `Requests sent through ${client}`, date: "2026-11-04", request_settings: {},
    retention_profile: profile, parameter: null, value: null, late_excluded: 0, note: null, source: `https://example.com/results/${id}.json`,
    results: results.map(([age, hits, checks]) => cacheResult(age === 0 ? "control" : "timed", age, hits, checks)),
    client_kind: client === "direct" ? "direct" : client === "muse-code" ? "own_client" : "proxy",
    ...more,
  };
}

/** The cache record of an entry as the build makes it: documented caching as models.dev writes it, and its evaluations. */
function cacheOf(cache: Json | undefined, evaluations: CacheEvaluation[] = [], access: EntryAccess = "api"): EntryCache {
  const caching = documentedCaching(cache === undefined ? {} : { capabilities: { cache } });
  return { ...NO_CACHE, documented: caching.documented, lifetime: finishLifetime(cacheLifetime(caching, evaluations, () => ({ source: "models.dev", date: "2026-11-15" }), access), evaluations), evaluations };
}

// The cases of the brief, as the dataset of 2026-11-15 has them (design/safe-cache-lifetime.md, section 10).
const K1_BETA = run("cpa-8.0.53/K1-beta", "cliproxyapi", "long", [[0, 1, 1], [600, 3, 3], [1800, 2, 3], [3900, 0, 3]], { parameter: "cache_control.ttl", value: "1h", request_settings: { format: "messages", ttl: "1h", beta: "extended-cache-ttl-2025-04-11" } });
const K1_NOBETA = run("cpa-8.0.53/K1-nobeta", "cliproxyapi", "long", [[0, 1, 1], [600, 3, 3], [1800, 3, 3], [3900, 0, 3]], { parameter: "cache_control.ttl", value: "1h", request_settings: { format: "messages", ttl: "1h" } });
const AN_OPUS_1H = run("direct-2026-11-17/an-opus-1h", "direct", "long", [[0, 1, 1], [3600, 3, 3], [3900, 0, 3]], { date: "2026-11-17", parameter: "cache_control.ttl", value: "1h", request_settings: { format: "messages", ttl: "1h" } });
const CASES = {
  /**
   * anthropic/claude-opus-5-5: long documented 1 h; measured directly through the hour (a miss at 65 minutes), which
   * agrees; the two runs through the proxy held 10 minutes and do not count on an API-key entry.
   */
  opus: cacheOf({ explicit: { ttl: ["5m", "1h"] } }, [K1_BETA, K1_NOBETA, AN_OPUS_1H]),
  /** openrouter/google/gemini-3.8-flash: short documented 5 minutes, contradicted; 0 s measured. */
  flash: cacheOf({ explicit: { ttl: ["5m"] } }, [run("openrouter-direct/R5", "direct", "short", [[0, 1, 1], [150, 0, 3], [300, 0, 3]])]),
  /** meta-subscription/muse-wonder-1.0: nothing documented; three clients, one never hit; a long run with a note. */
  wonder: cacheOf(undefined, [
    run("cpa-latest-2026-11-06/L4", "cliproxyapi", "short", [[0, 1, 1], [150, 3, 3], [300, 3, 3], [600, 3, 3], [900, 2, 3]]),
    run("harness-2026-11-07/H5", "muse-code", "short", [[0, 0, 1], [150, 0, 3], [300, 0, 3]], { note: "Muse Code caches its own system prompt but never the conversation" }),
    run("harness-2026-11-07/H6", "agent+cliproxyapi", "short", [[0, 1, 1], [150, 3, 3], [7200, 3, 3]]),
    run("meta-24h-2026-11-10/M2", "agent+cliproxyapi", "long", [[0, 1, 1], [14400, 3, 3], [43200, 0, 3], [86400, 0, 3]], { parameter: "prompt_cache_retention", value: "24h", note: "No age under 4 h was tested in this run" }),
  ], "subscription"),
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
    expect(bare.filter((item) => item.startsWith("h"))).toEqual(["h2 Limits", "h3 Limit evaluations tokens", "h2 Price", "h3 Conditional rates", "h3 Request controls", "h2 Prompt caching", "h3 Cache evaluations", "h3 Cache modes", "h3 Retention", "h2 How pi calls the model", "h2 Provenance", "h2 Data"]);
    // One row per quantity, its safe value: one window, "Context window", and no row of documented or measured figures.
    expect(bare.filter((item) => item.startsWith("row"))).toEqual([
      "row Context window", "row Maximum output",
      "row Input", "row Output", "row Reasoning output", "row Cache read", "row Cache write",
      "row Service tier", "row Cache lifetime, short", "row Cache lifetime, long", "row Automatic implicit", "row Manual explicit", "row Cache retention",
      "row Source", "row Inherited from", "row Corrections", "row Evidence",
    ]);
    // Five tiles, one per safe value.
    expect([...pages.bare.matchAll(/<div class="tile"><div class="label">([^<]+)</g)].map((match) => match[1])).toEqual(["Context window", "Maximum output", "Price", "Cache lifetime, short", "Cache lifetime, long"]);
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

describe("the safe values in a table row", () => {
  /** A row whose safe lifetimes are those the build makes of `cache`. */
  const lifeRow = (cache: EntryCache, more: Partial<Summary> = {}): string => row({ cache_lifetime: cache.lifetime, safe: { ...emptySafeValues(), ...lifetimeSafe(cache.lifetime, cache.evaluations) }, ...more });
  const cellOf = (html: string, at: string): string => html.slice(html.indexOf(at), html.indexOf("</td>", html.indexOf(at)));
  const cell = (cache: EntryCache): string => cellOf(lifeRow(cache), '<td class="life-col"');
  /** The text of a cell, its two lines one after the other, without the lists the warnings open. */
  const text = (html: string): string => html.replace(/<div class="warn-tip"[\s\S]*?<\/div>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  it("prints the safe value of short and long, and nothing of its source, basis or date", () => {
    expect(text(cell(CASES.opus))).toBe("Short 5 min Long 1 h");
    // A login: Muse Code, the vendor's own client, never hit (None); the long lifetime only a proxy measured.
    expect(text(cell(CASES.wonder))).toBe("Short None Long 4 h");
    for (const cache of Object.values(CASES)) expect(text(cell(cache))).not.toMatch(/basis|measured|documented|models\.dev|providers\.dev|\d{4}-\d\d-\d\d/i);
    for (const cache of Object.values(CASES)) expect(cell(cache)).not.toMatch(/class="basis|life-other/);
  });

  it("warns where the sources of a lifetime disagree, and its list prints each source's value with its date", () => {
    const flash = cell(CASES.flash);
    expect(text(flash)).toBe("Short None Long Unknown");
    expect(count(flash, 'class="warn-sign"')).toBe(1);
    expect(flash).toContain('<button type="button" class="warn-sign" popovertarget="warn-p/m-cache_short" aria-label="Not all sources agree: Cache lifetime, short">');
    const at = flash.indexOf('<div class="warn-tip"');
    const list = flash.slice(at, flash.indexOf("</div>", at));
    expect(list.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).toBe("Not all sources agree Cache lifetime, short Measured None (the value on this page) 2026-11-04 Requests sent through direct · first miss at 2.5 min · Raw result models.dev 5 min 2026-11-15 How a value is chosen");
    // Where the sources agree, or one states the value, no warning.
    for (const cache of [CASES.opus, CASES.wonder, CASES.none, CASES.unknown]) expect(cell(cache)).not.toContain("warn-sign");
  });

  it("tells not known and does not cache apart: Unknown and None", () => {
    expect(text(cell(CASES.unknown))).toBe("Short Unknown Long Unknown");
    expect(text(cell(CASES.none))).toBe("Short None Long None");
    // The exact seconds are in the title of each value.
    expect(cell(CASES.opus)).toContain('title="3,600 s.">1 h</a>');
  });

  it("links each value to the entry's prompt caching", () => {
    expect(cell(CASES.opus)).toContain('<a class="plain" href="/entries/p/m#cache"');
  });

  it("names the column of every cell, for where the table is stacked", () => {
    const html = lifeRow(CASES.opus);
    for (const label of ["Provider", "Context window", "Max output", "Price in / out", "Released", "Cache lifetime", "Source"]) expect(html).toContain(`data-label="${label}"`);
    expect(html).not.toMatch(/data-label="(Input window|Context)"/);
    expect(count(rowHtml(summaryOf({}), { today: { date: new Date("2026-11-13T00:00:00Z"), stale_after_days: 90 }, hideProvider: true }), 'data-label="Provider"')).toBe(0);
  });

  it("prints the context window and the maximum output from safe, compact, ≥ and rounded down on a lower bound", () => {
    const window = (more: Partial<SafeValue>): SafeValue => ({ ...emptySafeValues().input_window, ...more });
    const safe = { ...emptySafeValues(), input_window: window({ value: 921500, at_least: true, scope: "input", window_tokens: 1050000, source: "measured", agreement: "single" }), max_output: { ...emptySafeValues().max_output, value: 128000, source: "models.dev", agreement: "single" } } satisfies SafeValues;
    // limit.context, input_window and max_output of the summary say otherwise: the cells read safe and nothing else.
    const html = row({ safe, context: 2000000, max_output: 64000, input_window: { ...emptyInputWindow(), tokens: 900000, basis: "documented", bound: "limit", scope: "input", source: "models.dev" } });
    expect(text(cellOf(html, '<td class="num window-col"'))).toBe("≥ 921K");
    expect(cellOf(html, '<td class="num window-col"')).toContain('href="/entries/p/m#limits" title="At least 921,500 tokens. 1,050,000 including the response.">≥ 921K</a>');
    expect(text(cellOf(html, '<td class="num" data-label="Max output"'))).toBe("128K");
    expect(html).not.toMatch(/2M|900K|64K/);
    expect(text(cellOf(row({}), '<td class="num window-col"'))).toBe("Unknown");
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

describe("prompt caching on an entry page", () => {
  const { catalog } = resolve({
    upstream: { lab: { id: "lab", name: "Lab", models: { m: UpstreamModel.parse({ id: "m", name: "M" }) } } },
    additions: [], overrides: [], routes: {}, access: { default: "api", default_basis: "fixture", patterns: [], providers: {} }, upstreamDate: "2026-11-15",
  });
  const index = buildIndex(catalog, "fixture", "2026-11-15T00:00:00Z", "2026-11-15T00:00:00Z");
  const now = new Date("2026-11-15T00:00:00Z");
  /** The page of an entry whose cache record is `cache`, with the safe lifetimes the build makes of it, as the API has them. */
  const page = (cache: EntryCache): string => {
    const model = structuredClone(catalog.lab!.models.m!) as JsonObject;
    (model[NS] as unknown as ModelExtension).cache = cache;
    const safe = { ...index.entries[0]!.safe, ...lifetimeSafe(cache.lifetime, cache.evaluations) };
    return entryHtml({ summary: { ...index.entries[0]!, safe, cache_lifetime: cache.lifetime, evaluation_count: cache.evaluations.length }, provider: index.providers[0]!, model, today: { date: now, stale_after_days: 90 }, cache_ages_s: CACHE_AGES_S, imported: "2026-11-15" });
  };
  const section = (html: string): string => html.slice(html.indexOf('<h2 id="cache">'), html.indexOf("<h3>Cache modes</h3>"));
  const tiles = (html: string): string => html.slice(html.indexOf('<div class="tiles'), html.indexOf("</div>\n\n<section"));
  const text = (html: string): string => html.replace(/<div class="warn-tip"[\s\S]*?<\/div>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  /** The two rows of the topic's table, as text. */
  const rows = (html: string): string => text(section(html).slice(0, section(html).indexOf("<h3>Cache evaluations</h3>")));
  /** The rows of the table of evaluations: one item or one profile, its cells as text. */
  const bodies = (html: string): string[] => [...section(html).matchAll(/<tbody class="([^"]+)">([\s\S]*?)<\/tbody>/g)].map((match) => `${match[1]}: ${text(match[2]!)}`);

  it("gives the two lifetimes in their tiles and their rows: the safe value and nothing else", () => {
    expect(text(tiles(page(CASES.opus)))).toContain("Cache lifetime, short 5 min Cache lifetime, long 1 h");
    expect(rows(page(CASES.opus))).toBe("Prompt caching Lifetime Value Cache lifetime, short Without asking for a lifetime, or with the shortest one 5 min Cache lifetime, long When the request asks for a longer lifetime 1 h");
    expect(text(tiles(page(CASES.flash)))).toContain("Cache lifetime, short None Cache lifetime, long Unknown");
    expect(text(tiles(page(CASES.unknown)))).toContain("Cache lifetime, short Unknown Cache lifetime, long Unknown");
    for (const cache of Object.values(CASES)) expect(text(tiles(page(cache))) + rows(page(cache)), JSON.stringify(cache.lifetime.short)).not.toMatch(/measured|documented|models\.dev|providers\.dev|contradicted|\d{4}-\d\d-\d\d/i);
  });

  it("warns on the row and the tile where the sources disagree, and nowhere else", () => {
    // flash: 5 minutes documented, a miss at 2.5 minutes measured directly.
    const html = page(CASES.flash);
    expect(count(html, 'popovertarget="warn-tile-cache_short"')).toBe(1);
    expect(count(html, 'popovertarget="warn-row-cache_short"')).toBe(1);
    expect(count(html, 'class="warn-sign"')).toBe(2);
    // opus: the measurement and models.dev agree on both.
    expect(page(CASES.opus)).not.toContain("warn-sign");
  });

  it("lists the lifetime each client held, those that count first and the others marked as not counted; no documented lifetime", () => {
    // anthropic/claude-opus-5-5, an API-key entry: requests straight to the provider count; the proxy's do not.
    const opus = bodies(page(CASES.opus));
    expect(opus.map((body) => body.split(":")[0])).toEqual(["profile", "profile", "item measured", "item measured not-counted"]);
    expect(opus[0]).toBe("profile: Short retention No evaluation");
    expect(opus[1]).toBe("profile: Long retention 2 clients and settings");
    expect(opus[2]).toMatch(/^item measured: 1 h 2026-11-17 Requests sent through direct Sent cache_control\.ttl=1h · 4 of 7 checks hit/);
    expect(opus[3]).toContain("item measured not-counted: 10 min 2026-11-04 Requests sent through cliproxyapi Not counted Sent cache_control.ttl=1h · 13 of 20 checks hit Tested from 10 min · First miss 30 min · Also checked: 1 h 5 min 0% (0/6) 2 evaluations");
    expect(section(page(CASES.opus))).not.toMatch(/item documented|Safe lifetime|Documentation (not )?contradicted|class="basis/);
  });

  it("gives each client its own lifetime and keeps an evaluation's note in sight with it; on a login the vendor's own client counts first", () => {
    const rows = bodies(page(CASES.wonder));
    expect(rows.map((body) => body.split(":")[0])).toEqual(["profile", "item measured", "item measured not-counted", "item measured not-counted", "profile", "item measured"]);
    expect(rows[1]).toMatch(/^item measured: None .* Requests sent through muse-code .* First miss at once Note Muse Code caches its own system prompt but never the conversation 1 evaluation/);
    expect(rows[2]).toMatch(/^item measured not-counted: 2 h .* Requests sent through agent\+cliproxyapi Not counted/);
    expect(rows[3]).toMatch(/^item measured not-counted: 10 min .* Requests sent through cliproxyapi Not counted/);
    expect(rows[5]).toMatch(/^item measured: 4 h .* Sent prompt_cache_retention=24h · 4 of 10 checks hit Tested from 4 h · First miss 12 h Note No age under 4 h was tested in this run 1 evaluation/);
    // The note is on the lifetime's row, not only in its evaluation, which is collapsed.
    const item = section(page(CASES.wonder)).split('<tbody class="item measured">')[1]!;
    expect(item.indexOf("Muse Code caches its own")).toBeLessThan(item.indexOf('<tr class="run">'));
  });

  it("opens from a lifetime onto each evaluation: its setting, date, raw result and own results by age", () => {
    const item = section(page(CASES.opus)).split('<tbody class="item measured not-counted">')[1]!.split("</tbody>")[0]!;
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
    expect(rows.map((body) => body.split(":")[0])).toEqual(["profile", "profile", "item measured"]);
    expect(rows[2]).toMatch(/^item measured: 12 h .* Requests sent through direct Sent prompt_cache_options\.ttl=12h · 7 of 10 checks hit Tested from 30 min · First miss 24 h/);
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

  it("tells not known and does not cache apart, and a lifetime of 0 is None whatever its source", () => {
    expect(bodies(page(CASES.unknown))).toEqual(["profile: Short retention No evaluation", "profile: Long retention No evaluation"]);
    expect(rows(page(CASES.unknown))).toContain("Cache lifetime, short Without asking for a lifetime, or with the shortest one Unknown");
    expect(rows(page(CASES.none))).toContain("Cache lifetime, short Without asking for a lifetime, or with the shortest one None");
    expect(bodies(page(CASES.flash))[1]).toMatch(/^item measured: None 2026-11-04/);
    expect(section(page(CASES.flash))).not.toContain(">0 s<");
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
    const safe = { ...index.entries[0]!.safe, ...lifetimeSafe(cache.lifetime, cache.evaluations) };
    return entryHtml({ summary: { ...index.entries[0]!, safe, cache_lifetime: cache.lifetime, evaluation_count: cache.evaluations.length }, provider: index.providers[0]!, model, today: { date, stale_after_days: staleAfterDays }, cache_ages_s: CACHE_AGES_S, imported: "2026-11-15" });
  };

  it("marks a providers.dev date by the threshold it is given, and says that number in the hover text", () => {
    // The evaluation of the flash case is from 2026-11-04: 11 days before 2026-11-15.
    const fresh = page(CASES.flash, 90);
    expect(fresh).not.toContain("· stale");
    const stale = page(CASES.flash, 10);
    // The lifetime the client held, its evaluation, and the measured line of the warning.
    expect(stale).toContain('title="The newest evaluation, more than 10 days ago.">2026-11-04 · stale</span>');
    expect(stale).toContain('title="Evaluated more than 10 days ago."');
    expect(stale).toContain('<span class="warn-date stale" title="More than 10 days ago.">2026-11-04 · stale</span>');
    expect(stale).not.toMatch(/90 days/);
    // Exactly the threshold is not more than it.
    expect(page(CASES.flash, 11)).not.toContain("· stale");
    // A models.dev date is never stale: at the head of the page, and in the warning.
    const old = page(CASES.flash, 1);
    expect(old).toContain('<span class="muted date" title="Imported from models.dev on this date.">2026-11-15</span>');
    expect(old).toContain('<span class="warn-src">models.dev</span><span class="warn-val">5 min</span><span class="warn-date">2026-11-15</span>');
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
    const safe = { ...index.entries[0]!.safe, ...lifetimeSafe(cache.lifetime, cache.evaluations) };
    return entryHtml({ summary: { ...index.entries[0]!, safe, cache_lifetime: cache.lifetime, evaluation_count: cache.evaluations.length }, provider: index.providers[0]!, model, today: { date: new Date("2026-11-15T00:00:00Z"), stale_after_days: 90 }, cache_ages_s: ages, imported: "2026-11-15" });
  };
  const heads = (html: string): string[] => [...html.matchAll(/<th scope="col" class="age"[^>]*>([^<]+)<\/th>/g)].map((match) => match[1]!);
  const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  it("draws the columns of the ages it is given, and the spans that go with them", () => {
    // A publication whose ages are 10 minutes and 1 h 5: the control and those two columns, nothing else.
    const html = page(CASES.opus, [600, 3900]);
    expect(heads(html)).toEqual(["At once", "10 min", "1 h 5"]);
    expect(html).toContain('<th scope="colgroup" colspan="3" class="span">');
    expect(html).toContain('<td class="profile-facts" colspan="4">');
    // Three cells on each measured lifetime's row and on each of its evaluations: the proxy's item with two, the direct one with one.
    expect(html.match(/<td class="heat( unchecked)?"/g)).toHaveLength(3 * 5);
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

// The context window: the page's one window, the safe input window (design/sources-side-by-side.md, section 8). The
// row and the tile are labelled "Context window" and show `safe.input_window.value`; the note under it is
// `window_tokens`, exactly where it is not null. Nothing else of the entry is read for it.
describe("the context window", () => {
  const { catalog } = resolve({
    upstream: { lab: { id: "lab", name: "Lab", models: { m: UpstreamModel.parse({ id: "m", name: "M" }) } } },
    additions: [], overrides: [], routes: {}, access: { default: "api", default_basis: "fixture", patterns: [], providers: {} }, upstreamDate: "2026-11-15",
  });
  const index = buildIndex(catalog, "fixture", "2026-11-15T00:00:00Z", "2026-11-15T00:00:00Z");
  const statement = (more: Partial<SourceValue>): SourceValue => ({ source: "models.dev", value: null, withheld: false, at_least: false, below: null, scope: null, date: "2026-11-15", evidence_url: null, client: null, client_label: null, client_kind: null, evaluation_id: null, ...more });
  const window = (more: Partial<SafeValue>): SafeValue => ({ ...emptySafeValues().input_window, ...more });
  /** openai-codex/gpt-6.1-sol: a lower bound through the proxy on a login, models.dev's cap, pi's window, and a larger total. */
  const SOL = window({
    value: 921500, at_least: true, scope: "input", window_tokens: 1050000, source: "measured", date: "2026-11-17", agreement: "differ",
    sources: [
      statement({ source: "measured", value: 921500, at_least: true, below: 922300, scope: "input", date: "2026-11-17", evidence_url: "https://example.com/limits-codex.jsonl", client: "cliproxyapi", client_label: "Requests sent through Provimux", client_kind: "proxy" }),
      statement({ value: 922000, scope: "input" }),
      statement({ source: "pi.dev", value: 500000, scope: "window", date: "2026-11-20" }),
    ],
  });
  /** anthropic/claude-opus-5-5: a window two catalogs state alike. */
  const OPUS = window({ value: 1000000, scope: "window", source: "models.dev", date: "2026-11-15", agreement: "agree", sources: [statement({ value: 1000000, scope: "window" }), statement({ source: "pi.dev", value: 1000000, scope: "window", date: "2026-11-20" })] });
  /** openai/gpt-6.2-astra: models.dev's cap under its larger context, pi's smaller window. */
  const ASTRA = window({ value: 922000, scope: "input", window_tokens: 1050000, source: "models.dev", date: "2026-11-15", agreement: "differ", sources: [statement({ value: 922000, scope: "input" }), statement({ source: "pi.dev", value: 272000, scope: "window", date: "2026-11-20" })] });
  const page = (input_window: SafeValue, more: Partial<Summary> = {}): string => {
    const model = structuredClone(catalog.lab!.models.m!) as JsonObject;
    return entryHtml({ summary: { ...index.entries[0]!, safe: { ...emptySafeValues(), input_window, differing: input_window.agreement === "differ" ? ["input_window"] : [] }, ...more }, provider: index.providers[0]!, model, today: { date: new Date("2026-11-18T00:00:00Z"), stale_after_days: 90 }, cache_ages_s: CACHE_AGES_S, imported: "2026-11-15" });
  };
  const strip = (html: string): string => html.replace(/<div class="warn-tip"[\s\S]*?<\/div>/g, "");
  const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const limits = (html: string): string => html.slice(html.indexOf('<h2 id="limits">'), html.indexOf("<h3>Limit evaluations"));
  const tile = (html: string): string => html.slice(html.indexOf('<div class="tile"><div class="label">Context window'), html.indexOf('<div class="tile"><div class="label">Maximum output'));
  const listOf = (html: string, id: string): string => { const at = html.indexOf(`<div class="warn-tip" id="${id}"`); return html.slice(at, html.indexOf("</div>", at) + 6); };

  it("is labelled Context window and shows safe.input_window.value, at least where at_least, in the tile and in its row", () => {
    expect(text(strip(tile(page(SOL))))).toBe("Context window at least 921,500 tokens 1,050,000 including the response");
    expect(text(strip(limits(page(SOL))))).toBe("Limits Limit Value Context window The most input one request can carry, in tokens at least 921,500 tokens 1,050,000 including the response Maximum output The most one response can hold. A maximum, not a default Unknown");
    expect(text(strip(tile(page(OPUS))))).toBe("Context window 1,000,000 tokens");
    expect(text(strip(tile(page(window({})))))).toBe("Context window Unknown");
    for (const html of [page(SOL), page(OPUS)]) expect(html).not.toMatch(/Input window|Largest input|>Documented<|>Measured<\/h3>/);
  });

  it("carries the note exactly where window_tokens is not null, and compares nothing to put it there", () => {
    expect(count(page(ASTRA), "1,050,000 including the response")).toBe(2);
    expect(page(OPUS)).not.toContain("including the response");
    // A note the API publishes is printed whatever the value; none is made of limit.context.
    expect(count(page({ ...OPUS, window_tokens: 2000000 }), "2,000,000 including the response")).toBe(2);
    expect(page(OPUS, { context: 2000000, input: 900000 })).not.toMatch(/2,000,000|900,000|including the response/);
  });

  it("warns exactly where agreement is differ, and its list names the measurement: client, refused size, raw result", () => {
    const html = page(SOL);
    expect(count(html, 'class="warn-sign"')).toBe(2);
    expect(text(listOf(html, "warn-row-input_window"))).toBe("Not all sources agree Context window Measured at least 921,500 tokens (the value on this page) 2026-11-17 Requests sent through Provimux · 922,300 refused · Raw result models.dev 922,000 tokens 2026-11-15 pi.dev 500,000 tokens 2026-11-20 How a value is chosen");
    expect(listOf(html, "warn-row-input_window")).toContain('<a href="https://example.com/limits-codex.jsonl" rel="noopener">Raw result</a>');
    expect(page(OPUS)).not.toContain("warn-sign");
    // The same sources with agreement "agree": no warning, whatever the numbers.
    expect(page({ ...SOL, agreement: "agree" })).not.toContain("warn-sign");
  });

  it("reads nothing else of the entry: not limit.context, not the input window record, not the measured fields of a summary", () => {
    const html = strip(page(OPUS, { context: 2000000, input: 1500000, measured_input_accepted: 1200000, measured_input_refused: 1300000, input_window: { ...emptyInputWindow(), tokens: 1100000, basis: "measured", bound: "at_least", scope: "input", source: "providers.dev" } }));
    expect(html).not.toMatch(/2,000,000|1,500,000|1,200,000|1,300,000|1,100,000/);
  });

  it("marks a limit evaluation the API says does not count (chosen false) Not counted, as the cache table does, and one that counts not", () => {
    // openrouter/openai/gpt-6.1-sol: a window named through the proxy on an API-key entry, not counted; one direct, counted.
    const model = structuredClone(catalog.lab!.models.m!) as JsonObject;
    const extension = model[NS] as unknown as ModelExtension;
    const proxy = limitOf({ route: "openrouter", route_label: "OpenRouter API key", client: "cliproxyapi", client_label: "Requests sent through Provimux", client_kind: "proxy", context: 1050000, date: "2026-11-17", source: "https://example.com/proxy.jsonl" });
    const direct = limitOf({ route: "openrouter", route_label: "OpenRouter API key", context: 1050000, date: "2026-11-18", source: "https://example.com/direct.jsonl" });
    extension.limits.measured = [proxy, direct];
    extension.limits.input_window = inputWindow({ context: 1050000, input: 922000 }, [], [proxy, direct], () => ({ source: "models.dev", date: "2026-11-15" }));
    expect(extension.limits.input_window.measurements.map((item) => [item.client, item.chosen])).toEqual([["cliproxyapi", false], ["direct", true]]);
    const html = entryHtml({ summary: { ...index.entries[0]!, safe: { ...emptySafeValues(), input_window: OPUS } }, provider: index.providers[0]!, model, today: { date: new Date("2026-11-18T00:00:00Z"), stale_after_days: 90 }, cache_ages_s: CACHE_AGES_S, imported: "2026-11-15" });
    const rows = [...html.slice(html.indexOf("<h3>Limit evaluations")).matchAll(/<tr( class="not-counted")?><td data-label="Date">([\s\S]*?)<\/tr>/g)].map((match) => [Boolean(match[1]), text(match[2]!).includes("Not counted"), text(match[2]!).slice(0, 10)]);
    expect(rows).toEqual([[true, true, "2026-11-17"], [false, false, "2026-11-18"]]);
    // The marker is the API's: with the item counted, the same row says nothing.
    extension.limits.input_window.measurements.forEach((item) => (item.chosen = true));
    const counted = entryHtml({ summary: { ...index.entries[0]!, safe: { ...emptySafeValues(), input_window: OPUS } }, provider: index.providers[0]!, model, today: { date: new Date("2026-11-18T00:00:00Z"), stale_after_days: 90 }, cache_ages_s: CACHE_AGES_S, imported: "2026-11-15" });
    expect(counted.slice(counted.indexOf("<h3>Limit evaluations"))).not.toContain("Not counted");
  });

  it("is the list's Context window column, sorted by input_window, with no second window column", () => {
    const head = tableHead({ sortable: true });
    expect(head).toContain('<button type="button" data-sort="input_window"');
    expect([...head.matchAll(/data-sort="([^"]+)"[^>]*>([^<]+)</g)].map((match) => `${match[1]} ${match[2]}`)).toEqual(["name Model", "provider Provider", "input_window Context window", "max_output Max output", "price_in Price in / out", "release_date Released", "verified Source"]);
    expect(head).not.toMatch(/documented|measured|Input window|>Context</);
  });
});

// The page's three rules (design/sources-side-by-side.md, section 8): a quantity is its safe value and nothing else; the
// warning is `agreement: "differ"` (for the price, `differs`) and nothing else; the page works nothing out.
describe("the safe values of an entry page", () => {
  const { catalog } = resolve({
    upstream: { lab: { id: "lab", name: "Lab", models: { m: UpstreamModel.parse({ id: "m", name: "M", cost: { text: { input: { price: 0.083333, cache: { read: 0.0083333 } }, output: { price: 4 } } } }) } } },
    additions: [], overrides: [], routes: {}, access: { default: "api", default_basis: "fixture", patterns: [], providers: {} }, upstreamDate: "2026-11-15",
  });
  const index = buildIndex(catalog, "fixture", "2026-11-15T00:00:00Z", "2026-11-15T00:00:00Z");
  const stated = (source: SourceValue["source"], value: number, more: Partial<SourceValue> = {}): SourceValue => ({ source, value, withheld: false, at_least: false, below: null, scope: null, date: source === "pi.dev" ? "2026-11-12" : "2026-11-15", evidence_url: null, client: null, client_label: null, client_kind: null, evaluation_id: null, ...more });
  const number = (unit: "tokens" | "seconds", sources: SourceValue[], agreement: SafeValue["agreement"]): SafeValue => ({ value: sources[0]?.value ?? null, unit, at_least: false, scope: null, window_tokens: null, source: sources[0]?.source ?? null, date: sources[0]?.date ?? null, agreement, sources });
  const base = index.entries[0]!;
  /** Every quantity stated by models.dev and pi alike, or otherwise where `differ`. */
  const safeOf = (differ: boolean): SafeValues => {
    const pair = (unit: "tokens" | "seconds", value: number, other: number): SafeValue => number(unit, [stated("models.dev", value), stated("pi.dev", differ ? other : value)], differ ? "differ" : "agree");
    const price = base.safe.price;
    return {
      input_window: pair("tokens", 200000, 190000), max_output: pair("tokens", 32000, 16000), cache_short: pair("seconds", 300, 600), cache_long: pair("seconds", 3600, 0),
      price: { ...price, agreement: differ ? "differ" : "agree", differs: differ ? ["input", "cache_read", "tiers"] : [], sources: [...price.sources, { ...price.sources[0]!, source: "pi.dev", input: differ ? 0.1 : 0.083333, date: "2026-11-12", tiers: differ ? [{ input_tokens_above: 200000, input: 0.2, output: 8, cache_read: null, cache_write: null }] : [] }] },
      differing: differ ? ["input_window", "max_output", "cache_short", "cache_long", "price"] : [],
    };
  };
  const page = (safe: SafeValues): string => entryHtml({ summary: { ...base, safe }, provider: index.providers[0]!, model: catalog.lab!.models.m!, today: { date: new Date("2026-11-16T00:00:00Z"), stale_after_days: 90 }, cache_ages_s: CACHE_AGES_S, imported: "2026-11-15" });
  const strip = (html: string): string => html.replace(/<div class="warn-tip"[\s\S]*?<\/div>/g, "");
  const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  /** The places a value is printed: the tiles, and the tables of the three topics, without the evidence under them. */
  const cells = (html: string): string => strip([
    html.slice(html.indexOf('<div class="tiles'), html.indexOf("<h3>Limit evaluations")),
    html.slice(html.indexOf('<h2 id="price">'), html.indexOf("<h3>Request controls</h3>")),
    html.slice(html.indexOf('<h2 id="cache">'), html.indexOf("<h3>Cache evaluations</h3>")),
  ].join(" "));
  const signs = (html: string): string[] => [...html.matchAll(/popovertarget="warn-([^"]+)"/g)].map((match) => match[1]!);

  it("warns on each of the five quantities exactly where its agreement is differ, in its tile and its row; on the price, on the parts of differs", () => {
    expect(signs(page(safeOf(true)))).toEqual(["tile-input_window", "tile-max_output", "tile-price", "tile-cache_short", "tile-cache_long", "row-input_window", "row-max_output", "price-input", "price-cache_read", "price-rates", "row-cache_short", "row-cache_long"]);
    expect(signs(page(safeOf(false)))).toEqual([]);
    // agreement alone decides: the same numbers that differ, published as agreeing, carry no warning.
    const told = safeOf(true);
    for (const key of ["input_window", "max_output", "cache_short", "cache_long"] as const) told[key].agreement = "agree";
    told.price = { ...told.price, agreement: "agree", differs: [] };
    expect(signs(page({ ...told, differing: [] }))).toEqual([]);
  });

  it("names no source, basis or date in a cell, whatever the sources and their agreement", () => {
    for (const html of [page(safeOf(true)), page(safeOf(false))]) {
      expect(text(cells(html))).not.toMatch(/models\.dev|providers\.dev|pi\.dev|\bpi\b|measured|documented|contradicted|\d{4}-\d\d-\d\d/i);
      expect(html).not.toMatch(/class="(basis|case|pi-note|pi-line)/);
    }
  });

  it("prints every price with every digit the API states, in a row, a tile and a warning", () => {
    const html = page(safeOf(true));
    expect(text(strip(html))).toContain("Input $0.083333 / 1M tokens");
    expect(text(strip(html))).toContain("Cache read $0.0083333 / 1M tokens");
    expect(text(cells(html))).toContain("Price $0.083333 / $4");
    expect(html).toContain('<span class="warn-val">$0.083333 <span class="unit">/ 1M</span>');
    expect(html).not.toMatch(/\$0\.0833\b|\$0\.0083\b/);
  });

  it("prints a lifetime of 0 as None and no lifetime as Unknown, whatever the source", () => {
    const safe = safeOf(false);
    safe.cache_short = number("seconds", [stated("measured", 0, { client_label: "Requests sent straight to the provider", client_kind: "direct" })], "single");
    safe.cache_long = number("seconds", [], "none");
    expect(text(cells(page(safe)))).toContain("Cache lifetime, short None Cache lifetime, long Unknown");
  });
});

describe("the context window of a model", () => {
  const sourceOf = () => ({ source: "models.dev" as const, date: "2026-11-15" });
  const login = { route: "lab-subscription", route_label: "Lab plan", client: "cliproxyapi", client_label: "Requests sent through Provimux" };
  /** A window documented as the context window: input and output together. */
  const window = (context: number): InputWindow => finishWindow(inputWindow({ context }, [], [], sourceOf));
  /** An input limit documented under a larger context window: input alone. */
  const input = (tokens: number, context = 1050000): InputWindow => finishWindow(inputWindow({ context, input: tokens }, [], [], sourceOf));
  /** Nothing documented, a measurement that saw `accepted` taken and more refused: a lower bound. */
  const atLeast = (accepted: number): InputWindow => finishWindow(inputWindow(undefined, [], [limitOf({ ...login, input_accepted: accepted, input_refused: accepted + 7500, date: "2026-11-11" })], sourceOf));
  const none = emptyInputWindow();
  /** A model of the lab "lab" with one entry per window and context, the API's own way (canonicalModels): the lab's entry first. */
  const modelOf = (windows: [string, InputWindow, number?][]) =>
    canonicalModels(windows.map(([provider, w, context]) => summaryOf({ ref: `${provider}/m`, provider, model: "m", canonical_id: "lab/m", input_window: w, context: context ?? w.documented_tokens })))[0]!;
  const page = (windows: [string, InputWindow, number?][]): string => modelHtml(modelOf(windows), { lab: "Lab", p: "P", q: "Q", r: "R" }, "2026-11-15", { date: new Date("2026-11-16T00:00:00Z"), stale_after_days: 90 });
  const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const tiles = (html: string): string[] => html.slice(html.indexOf('<div class="tiles'), html.indexOf("</div>\n", html.indexOf('<div class="tiles'))).split('<div class="tile">').slice(1);
  /** The text of the Context window tile, the first. */
  const tile = (windows: [string, InputWindow, number?][]): string => text(tiles(page(windows))[0]!);
  /** The hover text of the tile's value. */
  const hover = (windows: [string, InputWindow, number?][]): string => /<div class="value small"><span title="([^"]*)"/.exec(tiles(page(windows))[0]!)?.[1] ?? "";

  it("is the first of four tiles, the two limits together, then the two counts: one window, as on an entry's page", () => {
    const html = page([["lab", window(1000000)], ["p", input(850000)]]);
    expect(html).toContain('<div class="tiles mt-6">');
    expect(tiles(html).map((one) => text(one.split('<div class="value')[0]!))).toEqual(["Context window", "Maximum output", "Entries", "With providers.dev evidence"]);
    expect(html).not.toContain("Input window");
  });

  it("gives the smallest to the largest among its entries, and the lab's own entry with what kind of figure it is", () => {
    expect(tile([["lab", window(1000000)], ["p", input(850000)], ["q", window(1000000)]])).toBe("Context window 850K to 1M tokens Smallest to largest among its entries At Lab: 1M");
    expect(hover([["lab", window(1000000)], ["p", input(850000)], ["q", window(1000000)]])).toBe("Smallest: 850,000 tokens, p/m. Largest: 1,000,000 tokens, lab/m.");
  });

  it("is the safe input window: an input limit under a larger window is the figure, and limit.context is not shown", () => {
    const tiled = tiles(page([["lab", input(922000), 1050000], ["p", input(922000), 1050000], ["q", window(271999)]])).map(text);
    expect(tiled[0]).toBe("Context window 272K to 922K tokens Smallest to largest among its entries At Lab: 922K");
    expect(tiled.join(" ")).not.toContain("1.05M");
  });

  it("counts the entries with no input window, and compares only the others", () => {
    expect(tile([["lab", window(1000000)], ["p", none], ["q", input(850000)]])).toBe("Context window 850K to 1M tokens Smallest to largest among its entries; unknown at 1 of 3 At Lab: 1M");
    expect(tile([["lab", none], ["p", window(1000000)], ["q", input(850000)]])).toBe("Context window 850K to 1M tokens Smallest to largest among its entries; unknown at 1 of 3 At Lab: unknown");
  });

  it("marks an end that is a lower bound with ≥, rounded down, and says what ≥ is", () => {
    // At the low end: devin/gpt-6-1-terra, at least 921,500 under documented 922,000.
    expect(tile([["lab", input(922000)], ["p", atLeast(921500)], ["q", input(1050000)]])).toBe("Context window ≥ 921K to 1.05M tokens Smallest to largest among its entries ≥ marks a lower bound At Lab: 922K");
    expect(hover([["lab", input(922000)], ["p", atLeast(921500)], ["q", input(1050000)]])).toBe("Smallest: at least 921,500 tokens, p/m. Largest: 1,050,000 tokens, q/m.");
    // At the high end.
    expect(tile([["lab", input(922000)], ["p", atLeast(1049999)]])).toBe("Context window 922K to ≥ 1.04M tokens Smallest to largest among its entries ≥ marks a lower bound At Lab: 922K");
    // Between the ends a lower bound changes neither.
    expect(tile([["lab", input(922000)], ["p", atLeast(950000)], ["q", input(1050000)]])).toBe("Context window 922K to 1.05M tokens Smallest to largest among its entries At Lab: 922K");
    // The lab's own entry a lower bound.
    expect(tile([["lab", atLeast(915011)], ["p", input(922000)]])).toBe("Context window ≥ 915K to 922K tokens Smallest to largest among its entries ≥ marks a lower bound At Lab: ≥ 915K");
  });

  it("ranks a lower bound above the same number that is not one: the smallest is the exact one, the largest the one that may be more", () => {
    expect(tile([["lab", window(1000000)], ["p", atLeast(1000000)], ["q", input(850000)]])).toBe("Context window 850K to ≥ 1M tokens Smallest to largest among its entries ≥ marks a lower bound At Lab: 1M");
    expect(tile([["lab", input(922000)], ["p", atLeast(922000)], ["q", input(1050000)]])).toBe("Context window 922K to 1.05M tokens Smallest to largest among its entries At Lab: 922K");
    expect(tile([["lab", window(1000000)], ["p", atLeast(1000000)]])).toBe("Context window 1M to ≥ 1M tokens Smallest to largest among its entries ≥ marks a lower bound At Lab: 1M");
  });

  it("gives a single value once, and says at how many entries", () => {
    expect(tile([["lab", window(1000000)], ["p", window(1000000)], ["q", window(1000000)]])).toBe("Context window 1M tokens The same at all 3 entries At Lab: 1M");
    expect(hover([["lab", window(1000000)], ["p", window(1000000)], ["q", window(1000000)]])).toBe("1,000,000 tokens, lab/m, the same at every entry that has one.");
    expect(tile([["p", window(1000000)], ["q", window(1000000)]])).toBe("Context window 1M tokens The same at both entries");
    expect(tile([["lab", window(256000)]])).toBe("Context window 256K tokens Its only entry At Lab: 256K");
    expect(tile([["lab", none], ["p", window(1000000)], ["q", window(1000000)]])).toBe("Context window 1M tokens The same at every entry that has one; unknown at 1 of 3 At Lab: unknown");
    expect(tile([["lab", atLeast(915011)], ["p", atLeast(915011)]])).toBe("Context window ≥ 915K tokens The same at both entries ≥ marks a lower bound At Lab: ≥ 915K");
  });

  it("says Unknown, never 0, where no entry has an input window", () => {
    expect(tile([["lab", none], ["p", none], ["q", none]])).toBe("Context window Unknown No source states one at any of its 3 entries At Lab: unknown");
    expect(tile([["p", none]])).toBe("Context window Unknown No source states one");
  });

  it("writes two values in full where they round to the same figure", () => {
    expect(tile([["p", window(921600)], ["q", input(922000)]])).toBe("Context window 921,600 to 922,000 tokens Smallest to largest among its entries");
  });

  it("prints the ends and the count the API publishes, and compares nothing itself", () => {
    const model = modelOf([["lab", window(1000000)], ["p", input(850000)]]);
    const html = (more: Partial<typeof model>): string => text(tiles(modelHtml({ ...model, ...more }, { lab: "Lab" }, "2026-11-15", { date: new Date("2026-11-16T00:00:00Z"), stale_after_days: 90 }))[0]!);
    expect(html({})).toBe("Context window 850K to 1M tokens Smallest to largest among its entries At Lab: 1M");
    // Whatever the fields say is what the tile says, whatever the entries under it hold.
    expect(html({ input_window_min: { entry_ref: "x/m", tokens: 128000, bound: "limit", basis: "documented", scope: "input" }, input_window_unknown_count: 5 })).toBe("Context window 128K to 1M tokens Smallest to largest among its entries; unknown at 5 of 2 At Lab: 1M");
    expect(html({ input_window_min: null, input_window_max: null })).toBe("Context window Unknown No source states one at any of its 2 entries At Lab: 1M");
    // The lab's line is input_window_reference, not the lab's entry looked up in entries.
    expect(html({ input_window_reference: { entry_ref: "lab/m", tokens: 922000, bound: "limit", basis: "documented", scope: "input" } })).toBe("Context window 850K to 1M tokens Smallest to largest among its entries At Lab: 922K");
    expect(html({ input_window_reference: null })).toBe("Context window 850K to 1M tokens Smallest to largest among its entries At Lab: unknown");
    expect(html({ reference_ref: null })).toBe("Context window 850K to 1M tokens Smallest to largest among its entries");
  });
});

// pi's block on an entry's page and in a row (design/pi-source.md, section h; design/pi-merged.md, sections 6, 7 and 9).
// The page prints the block and /api/v1/meta.pi as they are: every number of pi's it shows is one of theirs, each row
// says the standing of its item and nothing else, and what pi does not state says so.
describe("pi's catalog on an entry's page and in a row", () => {
  const piModel = (id: string, more: Partial<PiModel> = {}): PiModel => ({
    id, name: `Pi ${id}`, api: "openai-completions", provider: "lab", baseUrl: "https://api.lab.example/v1", reasoning: true, input: ["text", "image"],
    cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 }, contextWindow: 190000, maxTokens: 8000, type: "chat", ...more,
  }) as PiModel;
  const pi: PiCatalog = {
    lab: {
      // Differs in its context window and in its tiers; every optional field stated, the cache lifetimes the entry does not document.
      full: piModel("full", {
        cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25, tiers: [{ inputTokensAbove: 199999, input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 }] },
        compat: { supportsStore: false, thinkingFormat: "openai", chatTemplateArgs: { enable_thinking: { $var: "thinking.enabled" } } },
        thinkingLevelMap: { off: "none", minimal: null, high: "high" },
        promptCache: { short: 300, long: 3600 },
        inputLimits: { maxRequestBytes: 20971520, images: { maxPerRequest: 3600 } },
      }),
      // Nothing optional stated, and every price 0.
      bare: piModel("bare", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4000 }),
      // The same values as the entry, everywhere both state one; flags of the three groups, one pi has no words for.
      agree: piModel("agree", { api: "anthropic-messages", compat: { supportsStrictTools: true, requiresReasoningContentOnAssistantMessages: true, maxTokensField: "max_tokens", sendSessionAffinityHeaders: true, supportsSomethingNew: 3 } }),
      // Another input price than the entry's.
      pricey: piModel("pricey", { api: "an-api-without-words" }),
      // The entry states no limit and no price: pi alone does.
      nolimit: piModel("nolimit", { contextWindow: 272000, maxTokens: 128000 }),
      // The entry's limits are 0, none stated (Vercel's Grok Voice): pi alone states them.
      zero: piModel("zero", { contextWindow: 4096, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      // providers.dev publishes the context window as unknown and removes the input price (the review's override fixture).
      fixed: piModel("fixed"),
    },
    plan: {
      // A subscription entry: pi's prices and tiers are not compared; its limits are.
      sub: piModel("sub", { provider: "plan", cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25, tiers: [{ inputTokensAbove: 272000, input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 }] } }),
    },
  };
  const listed = { input: { price: 1, cache: { read: 0.1, write: 1.25 } }, output: { price: 4 } };
  const input: Parameters<typeof resolveWithPi>[0] = {
    upstream: {
      lab: {
        id: "lab", name: "Lab",
        models: {
          full: UpstreamModel.parse({ id: "full", name: "Full", limit: { context: 200000, output: 8000 }, cost: { text: { input: { price: 1, cache: { read: 0.1, write: 1.25 }, overrides: [{ when: { context: { gt: 200000 } }, price: 2, cache: { read: 0.2 } }] }, output: { price: 4, overrides: [{ when: { context: { gt: 200000 } }, price: 8 }] } } } }),
          bare: UpstreamModel.parse({ id: "bare", name: "Bare", limit: { context: 100000, output: 4000 } }),
          unlisted: UpstreamModel.parse({ id: "unlisted", name: "Unlisted" }),
          agree: UpstreamModel.parse({ id: "agree", name: "Agree", limit: { context: 190000, output: 8000 }, cost: { text: listed } }),
          pricey: UpstreamModel.parse({ id: "pricey", name: "Pricey", limit: { context: 190000, output: 8000 }, cost: { text: { ...listed, input: { ...listed.input, price: 2 } } } }),
          nolimit: UpstreamModel.parse({ id: "nolimit", name: "No limit" }),
          zero: UpstreamModel.parse({ id: "zero", name: "Zero", limit: { context: 0, output: 0 } }),
          fixed: UpstreamModel.parse({ id: "fixed", name: "Fixed", limit: { context: 190000, output: 8000 }, cost: { text: listed } }),
        },
      },
      plan: { id: "plan", name: "Plan", models: { sub: UpstreamModel.parse({ id: "sub", name: "Sub", limit: { context: 190000, output: 8000 }, cost: { text: { input: { price: 0 }, output: { price: 0 } } } }) } },
    },
    additions: [],
    overrides: [{ provider: "lab", rules: [{ models: ["fixed"], set: { limit: { context: null }, cost: { text: { input: { price: "$delete" } } } }, reason: "Not documented for this access", evidence: [{ kind: "documented", url: "https://example.com/limits", date: "2026-11-01" }] }] }],
    routes: {}, access: { default: "api", default_basis: "fixture", patterns: [], providers: { plan: { access: "subscription", basis: "A plan" } } }, upstreamDate: "2026-11-13",
  };
  // pi's statements laid over the safe values after the fence, dated by the fetch of pi's catalog, as the build does.
  const catalog = layPiOver(resolveWithPi(input, { catalog: pi }).catalog, "2026-11-12");
  const index = buildIndex(catalog, "fixture", "2026-11-14T00:00:00Z", "2026-11-14T00:00:00Z");
  /** The same data built without pi's catalog. */
  const without = buildIndex(resolveWithPi(input).catalog, "fixture", "2026-11-14T00:00:00Z", "2026-11-14T00:00:00Z");
  const modelOf = (ref: string): JsonObject => catalog[ref.split("/")[0]!]!.models[ref.split("/").slice(1).join("/")]!;
  // The build writes each summary's pi from the checked block (scripts/lib/pi-fence.ts).
  for (const summary of index.entries) summary.pi = piShort((modelOf(summary.ref)[NS] as unknown as ModelExtension).pi);
  const meta = (more: Partial<MetaPi["sync"]> = {}): MetaPi => ({
    source: "https://pi.dev/api/models",
    snapshot: { fetched_at: "2026-11-12T14:19:45.000Z", checked_at: "2026-11-14T04:17:12.000Z", etag: '"p1"', last_modified: null, revision: null, sha256: "ab".repeat(32), providers: 2, models: 6 },
    sync: { last_attempt_at: "2026-11-14T04:17:12.000Z", last_attempt_ok: true, last_error: null, ...more },
    counts: { entries_with_block: 6, left_out_models: 0, unmatched_models: 0 },
  });
  const today = { date: new Date("2026-11-14T00:00:00Z"), stale_after_days: 90 };
  const refOf = (model: string): string => (model.includes("/") ? model : `lab/${model}`);
  /** The entry's page as the API answers would draw it; `noPi`, as the build without pi's data answers. */
  const page = (model: string, piMeta: MetaPi = meta(), noPi = false): string => {
    const ref = refOf(model);
    const summary = (noPi ? without : index).entries.find((entry) => entry.ref === ref)!;
    const entry = structuredClone(modelOf(ref));
    const own = entry[NS] as unknown as ModelExtension;
    if (noPi) own.pi = null;
    const provider = index.providers.find((item) => item.id === summary.provider)!;
    return entryHtml({ summary, provider, model: entry, today, cache_ages_s: CACHE_AGES_S, imported: "2026-11-13", pi: piMeta });
  };
  const section = (html: string): string => html.split('<section aria-labelledby="pi">')[1]!.split("</section>")[0]!;
  const blockOf = (model: string): PiBlock => (modelOf(refOf(model))[NS] as unknown as ModelExtension).pi!;
  const standingsOf = (model: string) => Object.fromEntries(blockOf(model).values.map((item) => [item.field, item.standing]));
  /** What a reader sees: the text of the HTML, without its tags and the hover texts. */
  const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  const numbersOf = (value: unknown): number[] => (typeof value === "number" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(numbersOf) : []);
  const LISTED = ["full", "bare", "agree", "pricey", "nolimit", "zero", "fixed", "plan/sub"];
  const strip = (html: string): string => html.replace(/<div class="warn-tip"[\s\S]*?<\/div>/g, "");
  /** The values of a page as a reader sees them, without the lists the warnings open: the tiles and the limits' table. */
  const values = (html: string): string => text(strip(html.slice(html.indexOf('<div class="tiles'), html.indexOf("<h3>Limit evaluations"))));
  /** The list one warning opens. */
  const listOf = (html: string, id: string): string => { const at = html.indexOf(`<div class="warn-tip" id="${id}"`); return at < 0 ? "" : text(html.slice(at, html.indexOf("</div>", at) + 6)).trim(); };
  const lists = (html: string): string[] => [...html.matchAll(/<div class="warn-tip"[\s\S]*?<\/div>/g)].map((match) => match[0]);

  it("the blocks are as the cases need them: each standing, on a limit, a price, the tiers and a lifetime", () => {
    expect(blockOf("full").differences.map((item) => item.field)).toEqual(["context_window", "cost.tiers"]);
    expect(blockOf("bare")).toMatchObject({ compat: null, thinking_level_map: null, prompt_cache: null, differences: [] });
    expect(blockOf("bare").input_limits).toEqual({ max_request_bytes: null, max_images_per_request: null, max_images_per_message: null });
    expect(index.entries.find((entry) => entry.ref === "lab/unlisted")!.pi).toBeNull();
    const all = (standing: string, fields: string[], rest: Record<string, string> = {}) => ({ ...Object.fromEntries(fields.map((field) => [field, standing])), ...rest });
    const prices = ["cost.input", "cost.output", "cost.cache_read", "cost.cache_write"];
    const lifetimes = ["prompt_cache.short", "prompt_cache.long"];
    expect(standingsOf("full")).toEqual(all("agrees", ["max_tokens", ...prices], { context_window: "differs", "cost.tiers": "differs", "prompt_cache.short": "only", "prompt_cache.long": "only" }));
    expect(standingsOf("bare")).toEqual(all("silent", [...prices, "cost.tiers", ...lifetimes], { context_window: "agrees", max_tokens: "agrees" }));
    expect(standingsOf("agree")).toEqual(all("agrees", ["context_window", "max_tokens", ...prices], all("silent", ["cost.tiers", ...lifetimes])));
    expect(standingsOf("pricey")).toEqual(all("agrees", ["context_window", "max_tokens", ...prices], { "cost.input": "differs", ...all("silent", ["cost.tiers", ...lifetimes]) }));
    expect(standingsOf("nolimit")).toEqual(all("only", ["context_window", "max_tokens", ...prices], all("silent", ["cost.tiers", ...lifetimes])));
    expect(standingsOf("zero")).toEqual(all("only", ["context_window", "max_tokens"], all("silent", [...prices, "cost.tiers", ...lifetimes])));
    expect(standingsOf("fixed")).toEqual(all("agrees", ["max_tokens", "cost.output", "cost.cache_read", "cost.cache_write"], { context_window: "not_compared", "cost.input": "not_compared", ...all("silent", ["cost.tiers", ...lifetimes]) }));
    expect(standingsOf("plan/sub")).toEqual(all("not_compared", [...prices, "cost.tiers"], { context_window: "agrees", max_tokens: "agrees", ...all("silent", lifetimes) }));
  });

  it("pi's figure is the value where pi alone states one, shown unmarked like any other value", () => {
    // nolimit: models.dev states no limit and no price; zero: its limits are 0, which states none (Vercel's Grok Voice).
    expect(values(page("nolimit"))).toContain("Context window 272,000 tokens Maximum output 128,000 tokens Price $1 / $4 Input / output, per 1M tokens");
    expect(values(page("zero"))).toContain("Context window 4,096 tokens Maximum output 4,096 tokens");
    // full: models.dev documents no lifetime; pi's two are the values.
    expect(values(page("full"))).toContain("Cache lifetime, short 5 min Cache lifetime, long 1 h");
    for (const model of ["nolimit", "zero", "full"]) expect(values(page(model)), model).not.toMatch(/pi\.dev|pi's|\bpi\b/);
    // Without pi's data they are unknown, and nothing else of the page moves but the warnings pi's figures made.
    expect(values(page("nolimit", meta(), true))).toContain("Context window Unknown Maximum output Unknown Price Unknown");
    expect(values(page("zero", meta(), true))).toContain("Context window Unknown Maximum output Unknown");
  });

  it("where pi states a value otherwise than another source, the value warns, and its list prints pi's figure and date", () => {
    const full = page("full");
    expect((listOf(full, "warn-row-input_window"))).toBe("Not all sources agree Context window models.dev 200,000 tokens (the value on this page) 2026-11-13 pi.dev 190,000 tokens 2026-11-12 How a value is chosen");
    // The tiers, on the conditional rates: each source's list, never rounded.
    expect((listOf(full, "warn-price-rates"))).toBe("Not all sources agree Conditional rates models.dev Above 200,000: input $2, output $8, cache read $0.20 (the value on this page) 2026-11-13 pi.dev Above 199,999: input $2, output $8, cache read $0.20 2026-11-12 How a value is chosen");
    // pricey: pi's input price, on the Input row and on the price as a whole, and on no other row.
    const pricey = page("pricey");
    expect((listOf(pricey, "warn-price-input"))).toBe("Not all sources agree Input models.dev $2 / 1M (the value on this page) 2026-11-13 pi.dev $1 / 1M 2026-11-12 How a value is chosen");
    expect((listOf(pricey, "warn-tile-price"))).toBe(text(listOf(pricey, "warn-price-input")).replace("Agree Input", "Agree Price").replace("agree Input", "agree Price"));
    expect([...pricey.matchAll(/popovertarget="([^"]+)"/g)].map((match) => match[1])).toEqual(["warn-tile-price", "warn-price-input"]);
    // Without pi's data, no warning on either.
    for (const model of ["full", "pricey"]) expect(page(model, meta(), true), model).not.toContain("warn-sign");
  });

  it("pi's price of 0, and pi's price of a subscription entry, state nothing: no warning, and never free", () => {
    for (const model of ["bare", "plan/sub"]) {
      const html = page(model);
      expect(html, model).not.toContain("warn-sign");
      expect(text(strip(html)), model).not.toMatch(/\bfree\b|pi (?:says|lists) \$0/i);
    }
    expect(index.entries.find((entry) => entry.ref === "plan/sub")!.safe.price.sources.map((item) => item.source)).not.toContain("pi.dev");
  });

  it("a value providers.dev publishes as unknown stays Unknown, pi does not fill it, and its warning says what each source states", () => {
    const fixed = page("fixed");
    expect(values(fixed)).toContain("Context window Unknown");
    expect((listOf(fixed, "warn-row-input_window"))).toBe("Not all sources agree Context window providers.dev Unknown (the value on this page) 2026-11-01 Evidence models.dev 190,000 tokens 2026-11-13 pi.dev 190,000 tokens 2026-11-12 How a value is chosen");
    expect(fixed).toContain('<span class="warn-sub"><a href="https://example.com/limits" rel="noopener">Evidence</a></span>');
  });

  it("prints no standing of pi's anywhere: no line under a value, no count beside pi's mark", () => {
    for (const model of LISTED) {
      const html = page(model);
      expect(html, model).not.toMatch(/pi-note|pi-line|pi-from|pi-differ|pi-tiers|\bpi (?:agrees|says|lists)\b|pi states [$\d]|not compared|\d+ differs?\b/);
    }
  });

  it("every figure a warning prints is one of the API's, from the entry's safe values", () => {
    for (const model of LISTED) {
      const summary = index.entries.find((entry) => entry.ref === refOf(model))!;
      const allowed = new Set<string>();
      for (const value of numbersOf(summary.safe)) for (const written of [exact(value), usdUnrounded(value).slice(1), span(value)]) allowed.add(written);
      for (const list of lists(page(model))) {
        const figures = text(list.replace(/\d{4}-\d\d-\d\d/g, "")).match(/\$?\d(?:[\d,.]*\d)?(?: (?:min|h|s)\b)?/g) ?? [];
        for (const figure of figures) expect(allowed.has(figure.replace(/^\$/, "")), `${model}: ${figure}`).toBe(true);
      }
    }
  });

  it("pi's section holds only what pi alone returns: no table of limits and prices, no cache lifetimes; the request format in words and in pi's word; each stated flag once, in its group", () => {
    for (const model of LISTED) {
      const own = section(page(model));
      expect(own, model).not.toMatch(/id="pi-prices"|Limits and prices|>Cache lifetimes<|No difference/);
      expect(own, model).toContain('<h2 id="pi">How pi calls the model</h2>'.slice(0, 0));
      const block = blockOf(model);
      for (const name of Object.keys(block.compat ?? {})) expect(own.split(`<code>${name}`).length - 1, `${model} ${name}`).toBe(1);
    }
    expect(page("agree")).toContain('<h2 id="pi">How pi calls the model</h2>');
    // The format in plain words and pi's word under them; a format with no words, pi's word alone.
    expect(section(page("agree"))).toContain("Anthropic Messages<div class=\"id\"><code>anthropic-messages</code></div>");
    expect(text(section(page("pricey")))).toMatch(/in words and in pi's word an-api-without-words Address/);
    // The three groups: the provider's, in words with pi's name and value; pi's own; any other name, as stated.
    const group = (html: string, title: string): string => `${title} ${text(html.split(`<th scope="row">${title}`)[1]!.split("</tr>")[0]!).trim()}`;
    const agree = section(page("agree"));
    expect(group(agree, "What the provider accepts")).toBe("What the provider accepts compat : what the provider or the model accepts in this request format, as pi states it. A flag not named follows pi's own default: it is not false Strict tool schemas supportsStrictTools: true Accepted reasoning_content on earlier assistant messages in a request requiresReasoningContentOnAssistantMessages: true Required The request field for the output limit maxTokensField: \"max_tokens\" max_tokens");
    expect(group(agree, "What pi does")).toBe("What pi does pi's own switches, as pi states them: how pi builds its requests. Not a statement about the provider sendSessionAffinityHeaders true");
    expect(group(agree, "Other flags")).toBe("Other flags Flags this page has no words for yet, as pi states them supportsSomethingNew 3");
    // A group pi states nothing of says so; it is not false.
    const bare = section(page("bare"));
    for (const title of ["What the provider accepts", "What pi does", "Other flags"]) expect(group(bare, title)).toMatch(/None stated$/);
    const full = section(page("full"));
    expect(group(full, "What the provider accepts")).toContain("The store request field supportsStore: false Not accepted");
    expect(group(full, "What pi does")).toContain('chatTemplateArgs {"enable_thinking":{"$var":"thinking.enabled"}}');
  });

  it("a flag absent from compat is not shown as false, and nothing pi does not state is shown as no", () => {
    // The values pi states, without the hints under the row names (one of which says that an absent flag is not false).
    const values = (html: string): string => text([...section(html).matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => match[1]).join(" | "));
    const bare = section(page("bare"));
    expect(values(page("bare"))).not.toMatch(/\bfalse\b|Not accepted/);
    expect(bare).toContain("None stated");
    expect(text(bare)).not.toContain("supportsStore");
    // Thinking levels, every flag group and the request limits: not stated, never "no"; pi's prices of 0, never free.
    expect(text(bare).match(/Not stated|None stated/g)!.length).toBeGreaterThanOrEqual(5);
    expect(text(page("bare"))).not.toMatch(/\bfree\b|\$0\b|pi (?:says|lists) \$0/i);
    // On the other block, false is shown only where pi states it, by its flag's name.
    const full = section(page("full"));
    expect(values(page("full")).match(/\bfalse\b/g)).toEqual(["false"]);
    expect(full).toContain("<code>supportsStore: false</code>");
    expect(full).toContain("<dt>minimal</dt><dd><span class=\"muted\" title=\"pi marks this level as not supported.\">not supported</span></dd>");
  });

  it("has the same tables and rows on every entry pi lists, and one line on an entry it does not", () => {
    const skeleton = (html: string): string[] => [...section(html).matchAll(/<h3[^>]*>(.*?)<\/h3>|<th scope="(?:col|row)"[^>]*>(.*?)(?:<div|<\/th>)/gs)].map((match) => (match[1] ?? match[2]!).replace(/<[^>]+>/g, "").trim());
    for (const model of LISTED) expect(skeleton(page(model)), model).toEqual(skeleton(page("full")));
    expect(skeleton(page("full"))).toEqual(["In pi's catalog", "As pi states it", "Model", "Request format", "Address", "Input", "Reasoning", "Thinking levels", "What the provider accepts", "What pi does", "Other flags", "Request limits"]);
    const unlisted = section(page("unlisted"));
    expect(text(unlisted).trim()).toBe("How pi calls the model pi's model catalog does not list this entry. Fetched 2026-11-12 from pi.dev/api/models Last checked 2026-11-14 , unchanged");
  });

  it("says when pi's catalog was fetched and last checked, and that the last import failed when /meta says so", () => {
    const fine = page("full");
    expect(text(section(fine))).toContain("Fetched 2026-11-12 from pi.dev/api/models Last checked 2026-11-14 , unchanged");
    expect(fine).toMatch(/>pi\.dev<\/span><span class="muted date" title="Fetched from pi&#39;s catalog 2026-11-12 14:19 UTC\. Last checked 2026-11-14 04:17 UTC: unchanged since the fetch\.">2026-11-12<\/span>/);
    expect(fine).toContain("It is the last source of each value.");
    expect(fine).not.toContain("failed");
    const failed = page("full", meta({ last_attempt_at: "2026-11-15T04:17:00.000Z", last_attempt_ok: false, last_error: "pi.dev answered HTTP 503" }));
    expect(text(section(failed))).toContain("The last import, 2026-11-15, failed: this is the last good one");
    expect(failed).toContain(">2026-11-12 · last import failed</span>");
    expect(text(section(page("unlisted", meta({ last_attempt_ok: false }))))).toContain("failed: this is the last good one");
  });

  it("6. a price in a warning is never rounded, a part and a tier alike", () => {
    // The second review: 0.0156275 and 0.0156276 both read $0.015628.
    const summary = structuredClone(index.entries.find((entry) => entry.ref === "lab/full")!);
    const tier = { input_tokens_above: 100, input: 0.123451, output: 3, cache_read: 0.2, cache_write: null };
    summary.safe.price = {
      source: "models.dev", date: "2026-11-13", agreement: "differ", differs: ["output", "tiers"],
      sources: [
        { source: "models.dev", withheld: false, input: 1, output: 0.0156276, cache_read: null, cache_write: null, tiers: [{ ...tier, input: 0.123452 }], date: "2026-11-13", evidence_url: null },
        { source: "pi.dev", withheld: false, input: 1, output: 0.0156275, cache_read: null, cache_write: null, tiers: [tier], date: "2026-11-12", evidence_url: null },
      ],
    };
    const html = entryHtml({ summary, provider: index.providers[0]!, model: modelOf("lab/full"), today, cache_ages_s: CACHE_AGES_S, imported: "2026-11-13", pi: meta() });
    expect((listOf(html, "warn-price-output"))).toContain("models.dev $0.0156276 / 1M (the value on this page) 2026-11-13 pi.dev $0.0156275 / 1M 2026-11-12");
    expect((listOf(html, "warn-price-rates"))).toContain("models.dev Above 100: input $0.123452, output $3, cache read $0.20 (the value on this page) 2026-11-13 pi.dev Above 100: input $0.123451, output $3, cache read $0.20 2026-11-12");
    // As the site writes prices where that is the same number; the full number, in plain decimals, where it is not.
    expect(usdUnrounded(12.5)).toBe("$12.50");
    expect(usdUnrounded(0.075)).toBe("$0.075");
    expect(usdUnrounded(0.123451)).toBe("$0.123451");
    expect(usdUnrounded(1e-7)).toBe("$0.0000001");
    expect(usdUnrounded(1.5e-9)).toBe("$0.0000000015");
    expect(usdUnrounded(1234.56789)).toBe("$1,234.56789");
  });

  it("7. says \"last checked, unchanged\" only after a check later than the fetch, and calls nothing the last good one without a snapshot", () => {
    const fetchedOnly: MetaPi = { ...meta(), snapshot: { ...meta().snapshot!, checked_at: "2026-11-12T14:19:45.000Z" } };
    for (const model of ["full", "unlisted"]) {
      const html = page(model, fetchedOnly);
      expect(text(section(html))).toContain("Fetched 2026-11-12 from pi.dev/api/models");
      expect(html).not.toMatch(/Last checked|unchanged|checked again/);
    }
    // A first import that failed: no snapshot, so nothing is the last good one.
    const failedFirst: MetaPi = { source: "https://pi.dev/api/models", snapshot: null, sync: { last_attempt_at: "2026-11-15T04:17:00.000Z", last_attempt_ok: false, last_error: "pi.dev answered HTTP 503" }, counts: { entries_with_block: 0, left_out_models: 0, unmatched_models: 0 } };
    const unlisted = page("unlisted", failedFirst);
    expect(text(section(unlisted))).toContain("This dataset is built without pi's catalog ( pi.dev/api/models ). The last import, 2026-11-15, failed");
    expect(unlisted).not.toMatch(/last good/);
    expect(unlisted).toContain("This dataset has no pi data. The last import, 2026-11-15 04:17 UTC, failed.");
  });

  it("7, second review: a check is later by time, not by spelling", () => {
    const at = (fetched: string, checked: string): MetaPi => ({ ...meta(), snapshot: { ...meta().snapshot!, fetched_at: fetched, checked_at: checked } });
    // The same instant, and an earlier one, spelled so that they sort after the fetch as text.
    for (const said of [at("2026-11-21T05:00:00.000Z", "2026-11-21T05:00:00Z"), at("2026-11-21T05:00:00.418Z", "2026-11-21T05:00:00Z")]) {
      expect(piRechecked(said)).toBe(false);
      expect(page("full", said)).not.toMatch(/Last checked|unchanged since the fetch/);
    }
    // A later instant (05:00:01 UTC) that sorts before the fetch as text.
    const later = at("2026-11-21T05:00:00.000Z", "2026-11-21T03:00:01-02:00");
    expect(piRechecked(later)).toBe(true);
    expect(text(section(page("full", later)))).toContain("Last checked 2026-11-21 , unchanged");
  });

  it("a row prints the safe values pi gives and the warnings it causes, and no standing", () => {
    const rowOf = (ref: string): string => rowHtml(index.entries.find((entry) => entry.ref === ref)!, { today, imported: "2026-11-13", pi: meta() });
    for (const summary of index.entries) {
      const html = rowOf(summary.ref);
      expect(html, summary.ref).not.toMatch(/pi-note|pi-line|\bpi (?:agrees|says|lists|states)\b|not compared/);
      // A warning exactly where the summary's safe.differing says so.
      const warned = [...html.matchAll(/popovertarget="warn-[^"]*-(input_window|max_output|price|cache_short|cache_long)"/g)].map((match) => match[1]);
      expect(warned.sort(), summary.ref).toEqual([...summary.safe.differing].sort());
    }
    // The entries whose limits only pi states show pi's, unmarked.
    expect(rowOf("lab/nolimit")).toContain('title="272,000 tokens.">272K</a>');
    expect(rowOf("lab/full")).toContain('popovertarget="warn-lab/full-input_window"');
  });

  it("a row with a block has the pi.dev badge and nothing about differences; a row without one has none", () => {
    const listed = row({ ref: "lab/full", provider: "lab", model: "full", pi: { ref: "lab/full", api: "openai-completions", match: "id", difference_count: 2 } });
    expect(listed).toContain('<span class="origin pi" title="pi&#39;s model catalog (pi.dev) also lists this entry. Imported, not verified by providers.dev. It is the last source of each value.">pi.dev</span>');
    expect(listed).not.toContain("<a class=\"origin");
    expect(listed).not.toMatch(/differ|otherwise|agree/i);
    const paired = row({ ref: "lab/full", provider: "lab", model: "full", pi: { ref: "lab-pi/Full", api: "openai-completions", match: "alias", difference_count: 0 } });
    expect(paired).toContain("also lists this entry, as lab-pi/Full.");
    expect(row({})).not.toContain("pi.dev");
  });

  it("a row's sources: a mark and its date each, pi.dev dated by the import of pi's catalog as models.dev is by its own", () => {
    const today = { date: new Date("2026-11-14T00:00:00Z"), stale_after_days: 90 };
    const listed = { ref: "lab/full", provider: "lab", model: "full", pi: { ref: "lab/full", api: "openai-completions", match: "id", difference_count: 2 } } as const;
    /** The source cell of a row, and what a reader sees in it. */
    const cell = (more: Partial<Summary>, pi?: MetaPi): string => rowHtml(summaryOf(more), { today, imported: "2026-11-13", pi }).split('data-label="Source">')[1]!.split("</td>")[0]!;
    const seen = (html: string): string[] => html.replace(/<[^>]+>/g, " ").trim().split(/\s+/);
    const said = "Fetched from pi&#39;s catalog 2026-11-12 14:19 UTC. Last checked 2026-11-14 04:17 UTC: unchanged since the fetch.";

    // models.dev and pi: the date of pi's data is fetched_at (2026-11-12), not the last check (2026-11-14).
    const two = cell(listed, meta());
    expect(seen(two)).toEqual(["models.dev", "2026-11-13", "pi.dev", "2026-11-12"]);
    expect(two).toContain(`>pi.dev</span><span class="muted date" title="${said}">2026-11-12</span></span>`);
    expect(two).not.toMatch(/differ|otherwise|agree/i);
    expect(two).not.toMatch(/<a /);
    // All three sources, in their order; the providers.dev date as before.
    const three = cell({ ...listed, origin: "modified", verified: "2026-11-01", overridden_fields: ["limit.context"] }, meta());
    expect(seen(three)).toEqual(["models.dev", "2026-11-13", "providers.dev", "2026-11-01", "pi.dev", "2026-11-12"]);
    expect(three).not.toMatch(/differ|otherwise|agree/i);
    // An entry providers.dev added, which pi lists.
    expect(seen(cell({ ...listed, origin: "added", verified: "2026-11-01" }, meta()))).toEqual(["providers.dev", "2026-11-01", "pi.dev", "2026-11-12"]);
    // No pi block: no mark and no date of pi's, with or without pi's data.
    for (const pi of [meta(), undefined]) {
      expect(seen(cell({ ref: "lab/full", provider: "lab", model: "full" }, pi))).toEqual(["models.dev", "2026-11-13"]);
      expect(cell({ ref: "lab/full", provider: "lab", model: "full" }, pi)).not.toContain("pi&#39;s catalog");
    }
    // No pi data in the answer: the mark, no date; nothing is made up.
    expect(seen(cell(listed))).toEqual(["models.dev", "2026-11-13", "pi.dev"]);
    expect(seen(cell(listed, { ...meta(), snapshot: null }))).toEqual(["models.dev", "2026-11-13", "pi.dev"]);
    // No check after the fetch: the title says the fetch only.
    const once = { ...meta(), snapshot: { ...meta().snapshot!, checked_at: meta().snapshot!.fetched_at } };
    expect(cell(listed, once)).toContain('title="Fetched from pi&#39;s catalog 2026-11-12 14:19 UTC.">2026-11-12</span>');
    // The last import failed: in a row the date stays as plain as the models.dev one, and its title says so; the
    // entry's page says it in words beside the date.
    const failed = meta({ last_attempt_at: "2026-11-15T04:17:00.000Z", last_attempt_ok: false, last_error: "pi.dev answered HTTP 503" });
    const after = cell(listed, failed);
    expect(seen(after)).toEqual(["models.dev", "2026-11-13", "pi.dev", "2026-11-12"]);
    expect(after).toContain(`<span class="muted date" title="${said} The last import, 2026-11-15 04:17 UTC, failed: this is the last good one.">2026-11-12</span>`);
    expect(page("full", failed).split('<p class="id">')[1]!.split("</p>")[0]).toContain(">2026-11-12 · last import failed</span>");
  });
});

// A provider's models (since API 1.6.0): one table, its entries first, then, folded under them, the models its lists
// name that have no entry, as /api/v1/providers/{provider} and /api/v1/listings/{provider} give them, printed and not
// worked out.
describe("the models of a provider", () => {
  const today = { date: new Date("2026-11-22T00:00:00Z"), stale_after_days: 30 };
  const provider = (access: "api" | "subscription" = "subscription"): ProviderSummary => ({
    id: "devin", name: "Devin", origin: "added", doc: null, env: [], entry_count: 1, evidence_entry_count: 1,
    providers_dev: { access, access_basis: "Signed in with a plan.", access_source: null, note: null, evidence: [] },
  }) as unknown as ProviderSummary;
  const sources = (source: ListingSource | null): ListingSources => ({
    name: source, owner: source, released: source, context_window: source, max_input: null, max_output: source, input_modalities: source, output_modalities: source,
    reasoning: { supported: source, levels: source, budget_min: null, budget_max: null, can_disable: null, dynamic: null, disable_with: null },
    web_search: null, aliases: null, variants: null, plans: null, hidden: null,
  });
  const reasoning = (more: Partial<ListingReasoning>): ListingReasoning => ({ supported: null, levels: null, budget_min: null, budget_max: null, can_disable: null, dynamic: null, disable_with: null, ...more });
  const model = (more: Partial<ListingModel>): ListingModel => ({
    id: "gemini-4-neon", name: "Gemini 4 Neon", owner: "google", entry: null, canonical: null, released: "2026-11-01", context_window: 1048576, max_input: null, max_output: 65536,
    input_modalities: ["text", "image"], output_modalities: ["text"], reasoning: reasoning({ supported: true, levels: ["low", "medium", "high"] }), web_search: null,
    aliases: [], variants: [], plans: [], hidden: null, listed_by: ["listed"], sources: sources("listed"), ...more,
  });
  // One source's list, as basis says, unless the test gives lists.
  const listing = (models: ListingModel[], more: Partial<Listing> = {}): Listing => {
    const basis = more.basis ?? "listed";
    const listedAt = more.listed_at ?? "2026-11-22";
    const lists: ListingLists = { listed: null, "providers.dev": null, "models.dev": null, "pi.dev": null, [basis]: { listed_at: listedAt, model_count: models.length } };
    return {
      provider: "devin", basis, listed_at: listedAt, lists, client: "provimux", client_label: "Provimux, a proxy built on CLIProxyAPI",
      evidence: [{ kind: "listed", url: "https://github.com/ngvoicu/groundtruth/blob/main/listed.json", date: "2026-11-22", note: null }], model_count: models.length, models, ...more,
    };
  };
  const entry = (model: string, name: string): Summary => summaryOf({ ref: `devin/${model}`, provider: "devin", model, name });
  const table = (entries: Summary[], value: Listing | null, access: "api" | "subscription" = "subscription", day = today): string => modelsTableHtml(provider(access), entries, value, "2026-11-21", day);
  const rowOf = (html: string, id: string): string => html.split("<tr").find((part) => part.includes(`<code>${id}</code>`)) ?? "";

  it("prints one table: the entries first, then the models a list names without an entry, folded behind one line that counts them", () => {
    const html = table([entry("swe-2", "SWE-2")], listing([model({ id: "swe-2", name: "SWE-2", entry: { provider: "devin", model: "swe-2" } }), model({})]));
    expect(count(html, "<table")).toBe(1);
    expect(html).toContain('<h2 id="models" class="!m-0">Models</h2>');
    expect(html).not.toContain("Model list</h2>");
    expect(html).toContain('<a href="/api/v1/providers/devin"><code>GET /api/v1/providers/devin</code></a> · <a href="/api/v1/listings/devin"><code>GET /api/v1/listings/devin</code></a>');
    // The entry is printed once, as an entry, before the fold; the model without one comes after it, quieter, with no link.
    expect(count(html, "<code>swe-2</code>")).toBe(1);
    expect(html.indexOf("<code>swe-2</code>")).toBeLessThan(html.indexOf('<tbody class="more-models"'));
    expect(html).toContain('<tbody class="more-models" id="model-list"><tr class="fold"><td colspan="8"><details class="more-models"><summary><span class="count">1 more model</span> <span class="said">known from model lists only: no entry, so no price or cache data</span></summary></details></td></tr><tr class="listed-only">');
    const without = rowOf(html, "gemini-4-neon");
    expect(without).toContain('<span class="listed-name">Gemini 4 Neon</span>');
    expect(without).not.toContain("<a ");
    expect(without).toContain(">Not evaluated</span>");
    expect(without).toContain('data-label="Price in / out"><span class="muted" title="providers.dev has no entry for this model at this provider, so no price.">–</span>');
  });

  it("opens the fold and does not say more where the provider has no entries; with nothing at all, says so", () => {
    const html = table([], listing([model({}), model({ id: "other" })]));
    expect(html).toContain('<details class="more-models" open><summary><span class="count">2 models</span>');
    expect(html).not.toContain("<tbody></tbody>");
    // Every model of the list has its entry: no fold.
    expect(table([entry("swe-2", "SWE-2")], listing([model({ id: "swe-2", entry: { provider: "devin", model: "swe-2" } })]))).not.toContain("more-models");
    const none = table([], null);
    expect(none).toContain("No models are listed for this provider.");
    expect(none).not.toContain("<table");
    expect(none).not.toContain("/api/v1/listings");
  });

  it("prints what the lists state of a model without an entry, its source in the hover text, and Unknown where none states it", () => {
    const html = table([], listing([model({ sources: { ...sources("listed"), max_output: "models.dev" } }), model({ id: "bare", name: null, released: null, context_window: null, max_output: null, sources: sources(null) }), model({ id: "same-as-id", name: "same-as-id" })]));
    const full = rowOf(html, "gemini-4-neon");
    expect(full).toContain('<span title="1,048,576 tokens. From the vendor&#39;s own list.">1.05M</span>');
    expect(full).toContain('<span title="65,536 tokens. From models.dev.">65.54K</span>');
    expect(full).toContain('<span class="muted date" title="Release date. From the vendor&#39;s own list.">2026-11-01</span>');
    // A model no source names is printed by its id, once, at the size of a name.
    for (const id of ["bare", "same-as-id"]) {
      const bare = rowOf(html, id);
      expect(bare).toContain(`<th scope="row"><div class="id alone"><code>${id}</code>`);
      expect(bare).not.toContain("listed-name");
      expect(count(bare, `<code>${id}</code>`)).toBe(1);
    }
    expect(count(rowOf(html, "bare"), ">Unknown</span>")).toBe(3);
  });

  it("marks each list that names a model with the list's date: subscription where the vendor's list was read through a login, vendor list otherwise", () => {
    const lists: ListingLists = { listed: { listed_at: "2026-11-22", model_count: 1 }, "providers.dev": null, "models.dev": { listed_at: "2026-11-21", model_count: 1 }, "pi.dev": { listed_at: "2026-11-20", model_count: 1 } };
    const all = listing([model({ listed_by: ["listed", "models.dev", "pi.dev"] })], { lists });
    expect(rowOf(table([], all), "gemini-4-neon")).toContain('<span class="sources"><span class="badge listed" title="On the vendor&#39;s own model list, read on a subscription login through Provimux, a proxy built on CLIProxyAPI.">subscription</span><span class="muted date" title="The day the vendor&#39;s list was read.">2026-11-22</span><span class="origin upstream" title="On models.dev&#39;s list of this provider.">models.dev</span><span class="muted date" title="Imported from models.dev on this date.">2026-11-21</span><span class="origin pi" title="On pi&#39;s catalog of this provider.">pi.dev</span><span class="muted date" title="Fetched from pi&#39;s catalog on this date.">2026-11-20</span></span>');
    expect(rowOf(table([], all, "api"), "gemini-4-neon")).toContain('title="On the vendor&#39;s own model list, read through Provimux, a proxy built on CLIProxyAPI.">vendor list</span>');
    // Only the lists that name it.
    const pi = rowOf(table([], listing([model({ listed_by: ["pi.dev"] })], { lists })), "gemini-4-neon");
    expect(pi).toContain(">pi.dev</span>");
    expect(pi).not.toContain("models.dev</span>");
    expect(pi).not.toContain("subscription</span>");
  });

  it("marks a list read by the discovery or stated by providers.dev stale by the threshold it is given, and an import never", () => {
    const old = listing([model({})], { listed_at: "2026-10-01" });
    expect(table([], old)).toContain('<span class="stale" title="The day the vendor&#39;s list was read. More than 30 days ago.">2026-10-01 · stale</span>');
    expect(table([], old, "subscription", { ...today, stale_after_days: 90 })).not.toContain("· stale");
    expect(table([], listing([model({ listed_by: ["models.dev"] })], { basis: "models.dev", listed_at: "2026-10-01" }))).not.toContain("· stale");
  });

  it("adds to an entry's row the plan names and the vendor's own list where it names the entry, and nothing where it does not", () => {
    const lists: ListingLists = { listed: { listed_at: "2026-11-22", model_count: 1 }, "providers.dev": null, "models.dev": { listed_at: "2026-11-21", model_count: 1 }, "pi.dev": null };
    const html = table([entry("swe-2", "SWE-2"), entry("swe-1", "SWE-1")], listing([
      model({ id: "swe-2", entry: { provider: "devin", model: "swe-2" }, plans: ["pro"] }),
      model({ id: "swe-1", entry: { provider: "devin", model: "swe-1" }, listed_by: ["models.dev"] }),
    ], { lists }));
    const listed = rowOf(html, "swe-2");
    expect(listed).toContain('<div class="hint" title="Plan names the vendor&#39;s list attaches to the model, as it writes them.">Plans: pro</div></th>');
    expect(listed).toContain('<td class="nowrap source-col" data-label="Source"><span class="sources"><span class="badge listed" title="On the vendor&#39;s own model list, read on a subscription login through Provimux, a proxy built on CLIProxyAPI.">subscription</span><span class="muted date" title="The day the vendor&#39;s list was read.">2026-11-22</span><span class="origin upstream"');
    const imported = rowOf(html, "swe-1");
    expect(imported).not.toContain("badge listed");
    expect(imported).not.toContain("Plans:");
    expect(html).not.toContain("more-models");
  });

  it("shows the plan names the vendor's list attaches, as it writes them, and a model hidden in its picker", () => {
    const html = table([], listing([model({ plans: ["plus", "pro"], hidden: true }), model({ id: "other", hidden: false })]));
    expect(rowOf(html, "gemini-4-neon")).toContain(">Plans: plus, pro</div>");
    expect(rowOf(html, "gemini-4-neon")).toContain(">Hidden in the vendor's picker</div>");
    expect(rowOf(html, "other")).not.toContain("Plans:");
    expect(rowOf(html, "other")).not.toContain("Hidden");
  });

  it("gives each list in the page's facts, with its date and, in the hover text, how many models it names; and says when there is none", () => {
    const lists: ListingLists = { listed: { listed_at: "2026-11-22", model_count: 6 }, "providers.dev": null, "models.dev": { listed_at: "2026-11-21", model_count: 2 }, "pi.dev": null };
    const html = providerHtml(provider(), [], listing([model({})], { lists }), "2026-11-21", today);
    expect(html).toContain('<dt class="muted">Model lists</dt><dd><span class="sources side"><span class="badge listed" title="The vendor&#39;s own model list, read on a subscription login through Provimux, a proxy built on CLIProxyAPI: 6 models.">subscription</span><span class="muted date" title="The day the vendor&#39;s list was read.">2026-11-22</span><span class="origin upstream" title="models.dev&#39;s list of this provider: 2 models.">models.dev</span><span class="muted date" title="Imported from models.dev on this date.">2026-11-21</span></span><div class="hint mt-1"><a href="/docs/methodology/#listings">How the lists are joined</a> · <a href="https://github.com/ngvoicu/groundtruth/blob/main/listed.json">Source</a></div></dd>');
    const none = providerHtml(provider(), [], null, "2026-11-21", today);
    expect(none).toContain("<dt class=\"muted\">Model lists</dt><dd><span class=\"muted\">None yet: no source gives a list of this provider's models.</span></dd>");
  });

  it("puts in the fold, linked to its entry, a model of the list whose entry the page has no row for", () => {
    const html = table([], listing([model({ id: "swe-3", name: "SWE-3", entry: { provider: "devin", model: "swe-3" } })]));
    expect(rowOf(html, "swe-3")).toContain('<a href="/entries/devin/swe-3">SWE-3</a>');
  });
});
