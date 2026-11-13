import { describe, expect, it } from "vitest";
import type { Summary } from "../src/core/entries.ts";
import { rowHtml } from "../src/core/render.ts";

const base = {
  ref: "p/m",
  provider: "p",
  model: "m",
  name: "M",
  access: "api",
  origin: "upstream",
  cache: "unknown",
  cache_modes: [],
  cache_ttl_s: [],
  evaluations: 0,
  measured_limits: 0,
  overridden_fields: [],
  shard: 0,
} as unknown as Summary;
const row = (more: Partial<Summary>): string => rowHtml({ ...base, ...more }, { now: new Date("2026-11-13T00:00:00Z") });
const count = (html: string, part: string): number => html.split(part).length - 1;
const band = (up_to_s: number, warm: number, total: number) => ({ up_to_s, warm, total });

describe("the measured cell of the catalog", () => {
  it("has the same two lines of ten cells on every evaluated entry", () => {
    const rows = [
      // only the default lifetime was evaluated
      row({ evaluations: 2, measured_cache: [{ evaluations: 2, bands: [band(150, 3, 3), band(300, 1, 3)] }] }),
      // only a long lifetime was evaluated
      row({ evaluations: 1, measured_cache: [{ asked: "1h", parameter: "ttl", evaluations: 1, bands: [band(3600, 3, 3)] }] }),
      // both
      row({
        evaluations: 2,
        measured_cache: [
          { evaluations: 1, bands: [band(300, 3, 3)] },
          { asked: "24h", parameter: "prompt_cache_retention", evaluations: 1, bands: [band(86400, 0, 3)] },
        ],
      }),
      // evaluated, but no check was made
      row({ evaluations: 1, measured_cache: [{ evaluations: 1, bands: [] }] }),
    ];
    for (const html of rows) {
      expect(count(html, 'class="strip"')).toBe(2);
      expect(count(html, ">Default</span>")).toBe(1);
      expect(count(html, ">Long")).toBe(1);
      // twenty cells: ten per line, checked or not
      expect(count(html, 'class="skip"') + count(html, 'class="all"') + count(html, 'class="most"') + count(html, 'class="few"') + count(html, 'class="none"')).toBe(20);
    }
    expect(rows[1]).toContain("Long <b>1h</b>");
    expect(rows[1]).toContain("ttl=1h");
    expect(rows[2]).toContain("prompt_cache_retention=24h");
    expect(rows[0]).toContain(">33</span>"); // 1 of 3, in percent
  });

  it("shows nothing for an entry without evaluations, also where limits were measured", () => {
    for (const html of [row({}), row({ measured_limits: 2 })]) {
      expect(html).not.toContain("strip");
      expect(html).not.toContain("Limits measured");
    }
  });
});
