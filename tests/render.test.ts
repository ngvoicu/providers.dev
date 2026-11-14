import { describe, expect, it } from "vitest";
import { CACHE_AGES_S, cacheResult, type CacheSummaryRow } from "../src/core/cache.ts";
import { buildIndex, type Summary } from "../src/core/entries.ts";
import type { Json } from "../src/core/merge.ts";
import { entryHtml, rowHtml } from "../src/core/render.ts";
import { resolve } from "../src/core/resolve.ts";
import { UpstreamModel } from "../src/core/schema.ts";
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

  it("shows no measured limit in the table: those are on the entry's page", () => {
    expect(row({ measured_limit_count: 2 })).not.toContain("Limits measured");
  });
});
