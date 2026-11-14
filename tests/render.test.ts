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
const cells = (html: string): number => ["skip", "all", "most", "few", "none"].reduce((sum, name) => sum + count(html, `class="${name}"`) + count(html, `class="${name} control"`), 0);

describe("the cache summary in a table row", () => {
  it("draws the lines the API gives, each with the control and every age of the ladder", () => {
    const html = row({
      evaluation_count: 2,
      cache_results: [line("short", [[0, 1, 1], [150, 3, 3], [450, 2, 3], [600, 0, 3]]), line("long", [[0, 1, 1], [3600, 1, 3]], { parameter: "cache_control.ttl", value: "1h" })],
    });
    expect(count(html, 'class="strip"')).toBe(2);
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
    expect(count(shortOnly, 'class="strip"')).toBe(1);
    expect(count(shortOnly, ">Not evaluated</span>")).toBe(1);
    const never = row({});
    expect(never).toContain("Not evaluated");
    expect(never).not.toContain('class="strip"');
    // An entry that does not cache cannot be asked for a longer lifetime: the long line says so.
    expect(row({ evaluation_count: 1, cache_retention: "unsupported", cache_results: [line("short", [[300, 0, 3]]), line("long", null)] })).toContain(">Unsupported</span>");
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
