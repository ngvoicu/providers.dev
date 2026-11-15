import { describe, expect, it } from "vitest";
import { CACHE_AGES_S, cacheResult, type CacheSummaryRow } from "../src/core/cache.ts";
import { buildIndex, type Summary } from "../src/core/entries.ts";
import type { Json } from "../src/core/merge.ts";
import { entryHtml, rowHtml } from "../src/core/render.ts";
import { resolve } from "../src/core/resolve.ts";
import { UpstreamModel } from "../src/core/schema.ts";
import { pricingOf } from "../src/core/policies.ts";
import { summaryOf } from "./helpers.ts";

const row = (more: Partial<Summary>): string => rowHtml(summaryOf(more), { now: new Date("2026-11-13T00:00:00Z") });
const count = (html: string, part: string): number => html.split(part).length - 1;
const line = (profile: "short" | "long", results: [number, number, number][] | null, sent: Partial<CacheSummaryRow> = {}): CacheSummaryRow => ({
  retention_profile: profile,
  parameter: null,
  value: null,
  evaluations: results ? 1 : 0,
  evaluation_ids: results ? ["e"] : [],
  last_date: results ? "2026-11-10" : null,
  results: results ? results.map(([age, hits, checks]) => cacheResult(age === 0 ? "control" : "timed", age, hits, checks)) : null,
  ...sent,
});

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
    expect(bare.filter((item) => item.startsWith("h"))).toEqual(["h2 Limits", "h3 Documented", "h3 Measured tokens", "h2 Price", "h3 Conditional rates", "h3 Request controls", "h2 Prompt caching", "h3 Documented", "h3 Retention", "h3 Measured", "h2 Provenance", "h2 Data"]);
    expect(bare.filter((item) => item.startsWith("row"))).toEqual([
      "row Context window", "row Largest input", "row Maximum output",
      "row Input", "row Output", "row Reasoning output", "row Cache read", "row Cache write",
      "row Service tier", "row Automatic implicit", "row Manual explicit", "row Cache retention", "row Short", "row Long",
      "row Source", "row Inherited from", "row Corrections", "row Evidence",
    ]);
    // An entry everything is known about has the same skeleton: no section, table or row more, and none less.
    expect(skeleton(pages.full)).toEqual(bare);
    expect(skeleton(pages.login)).toEqual(bare);
    // Where there is nothing, the row says so.
    expect(count(pages.bare, ">Unknown</span>")).toBeGreaterThan(15);
    // Inherited from, Corrections, Evidence, and the prices of other kinds in the source.
    expect(count(pages.bare, '<span class="muted">None</span>')).toBe(4);
    for (const html of Object.values(pages)) expect(count(html, "<details")).toBe(3);
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

/** The lines of a row's cache cell: the strips inside the link, not the ages written over them. */
const lines = (html: string): number => count(html.slice(html.indexOf('<a class="plain heat-strip"')), 'class="strip"');
const cells = (html: string): number => ["skip", "all", "most", "few", "none"].reduce((sum, name) => sum + count(html, `class="${name}"`) + count(html, `class="${name} control"`), 0);

describe("the cache summary in a table row", () => {
  it("draws the lines the API gives, each with the control and every age of the ladder", () => {
    const html = row({
      evaluation_count: 2,
      cache_results: [line("short", [[0, 1, 1], [150, 3, 3], [450, 2, 3], [600, 0, 3]]), line("long", [[0, 1, 1], [3600, 1, 3]], { parameter: "cache_control.ttl", value: "1h" })],
    });
    expect(lines(html)).toBe(2);
    expect(cells(html)).toBe(2 * (CACHE_AGES_S.length + 1));
    expect(html).toContain(">Short</span>");
    expect(html).toContain("Long <b>1h</b>");
    expect(html).toContain("cache_control.ttl=1h");
    // 7.5 and 10 minutes are cells of their own, with the percentage as published and the counts in the tooltip.
    expect(html).toContain('title="After 7.5 min: 2 of 3 re-sends served from the cache (66.67%)">67</span>');
    expect(html).toContain('title="After 10 min: 0 of 3 re-sends served from the cache (0%)">0</span>');
    expect(html).toContain('title="At once: 1 of 1 re-sends served from the cache (100%)">100</span>');
  });

  it("says Not evaluated where there is no measurement, never 0", () => {
    const shortOnly = row({ evaluation_count: 1, cache_results: [line("short", [[300, 3, 3]]), line("long", null)] });
    expect(lines(shortOnly)).toBe(1);
    expect(count(shortOnly, ">Not evaluated</span>")).toBe(1);
    const never = row({});
    expect(never).toContain("Not evaluated");
    expect(never).not.toContain('class="strip"');
    // An entry that does not cache cannot be asked for a longer lifetime: the long line says so.
    expect(row({ evaluation_count: 1, cache_retention: "unsupported", cache_results: [line("short", [[300, 0, 3]]), line("long", null)] })).toContain(">Unsupported</span>");
  });

  it("carries the ages over its cells, for where the table is stacked and its head is out of sight", () => {
    const html = row({ evaluation_count: 1, cache_results: [line("short", [[300, 3, 3]]), line("long", null)] });
    expect(count(html, 'class="heat-strip strip-head in-row" aria-hidden="true"')).toBe(1);
    expect(html.indexOf("strip-head in-row")).toBeLessThan(html.indexOf('<a class="plain heat-strip"'));
    expect(row({})).not.toContain("strip-head");
  });

  it("names the column of every cell, for where the table is stacked", () => {
    const html = row({ evaluation_count: 1, cache_results: [line("short", [[300, 3, 3]]), line("long", null)] });
    for (const label of ["Provider", "Context", "Max output", "Price in / out", "Released", "Cache, documented", "Cache, measured · % by age", "Source"]) expect(html).toContain(`data-label="${label}"`);
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
