import { describe, expect, it } from "vitest";
import { importDate, runVerdict, shortAge, warmRange } from "../src/core/format.ts";

const ages = (...seconds: number[]) => seconds.map((age_s) => ({ age_s }));

describe("cache evaluations in words", () => {
  it("says what held for every re-send and what was seen beyond it", () => {
    expect(runVerdict({ all_warm_through_s: 150, last_warm_s: 7200, first_all_cold_s: null, checks: ages(150, 300, 7200) })).toEqual({
      head: "Always cached up to 2.5 min",
      detail: "Still cached at 2 h, the oldest age checked",
    });
  });

  it("does not repeat an age that is both", () => {
    expect(runVerdict({ all_warm_through_s: 7200, last_warm_s: 7200, first_all_cold_s: null, checks: ages(300, 7200) })).toEqual({
      head: "Always cached up to 2 h",
      detail: "That was the oldest age checked",
    });
  });

  it("names the age at which nothing was cached", () => {
    expect(runVerdict({ all_warm_through_s: 600, last_warm_s: 1800, first_all_cold_s: 3900, checks: ages(600, 1800, 3900) })).toEqual({
      head: "Always cached up to 10 min",
      detail: "Last cached at 30 min; nothing cached at 1 h 5 min",
    });
    expect(runVerdict({ all_warm_through_s: 300, last_warm_s: 300, first_all_cold_s: 1800, checks: ages(300, 1800) }).detail).toBe("Nothing cached at 30 min");
  });

  it("does not hide a cache that came back after an age with no hits", () => {
    expect(runVerdict({ all_warm_through_s: null, last_warm_s: 450, first_all_cold_s: 240, checks: ages(60, 240, 450) })).toEqual({
      head: "Cached only part of the time",
      detail: "Nothing cached at 4 min, but cached again as late as 7.5 min",
    });
  });

  it("separates no hits from no result", () => {
    expect(runVerdict({ all_warm_through_s: null, last_warm_s: null, first_all_cold_s: 150, control: { warm: 1, total: 1 }, checks: ages(150, 300) })).toEqual({
      head: "Not cached at any age checked",
      detail: "Cached when sent again at once",
    });
    expect(runVerdict({ all_warm_through_s: null, last_warm_s: null, first_all_cold_s: null }).head).toBe("No result by age");
  });

  it("words the catalog summary as a floor", () => {
    expect(warmRange({ measured_warm_min_s: 1800, measured_warm_max_s: 1800 })).toBe("At least 30 min");
    expect(warmRange({ measured_warm_min_s: 600, measured_warm_max_s: 14400 })).toBe("At least 10 min to 4 h");
    expect(warmRange({})).toBe("");
  });

  it("keeps age headings short", () => {
    expect([150, 3600, 4500, 86400].map(shortAge)).toEqual(["2.5 min", "1 h", "1 h 15", "24 h"]);
  });
});

describe("the date of the models.dev import", () => {
  it("is the day of the import, and is absent for an index from before the field existed", () => {
    expect(importDate({ upstream_fetched_at: "2026-11-13T09:41:00.000Z" })).toBe("2026-11-13");
    expect(importDate({})).toBeUndefined();
  });
});

describe("prices", () => {
  it("writes a price in dollars without noise", async () => {
    const { usd } = await import("../src/core/format.ts");
    expect([usd(10), usd(12.5), usd(0.075), usd(0), usd(1250), usd(0.132)]).toEqual(["$10", "$12.50", "$0.075", "$0", "$1,250", "$0.132"]);
  });

  it("takes the base price per token and nothing in another unit", async () => {
    const { summarize } = await import("../src/core/entries.ts");
    const model = (cost: unknown) => ({ id: "m", name: "M", cost, providers_dev: { origin: "upstream", access: "api" } }) as never;
    const priced = summarize("p", model({ text: { input: { price: 10, overrides: [{ when: { context: { gt: 1 } }, price: 20 }] }, output: { price: 50 } } }), 0);
    expect([priced.price_in, priced.price_out]).toEqual([10, 50]);
    const perCharacter = summarize("p", model({ text: { input: { price: 15, unit: "character" } } }), 0);
    expect([perCharacter.price_in, perCharacter.price_out]).toEqual([undefined, undefined]);
    expect(summarize("p", model(undefined), 0).price_in).toBeUndefined();
    // A listed 0 is kept as 0: the page says "Free" or "In plan" by the access method, never "Unknown".
    expect(summarize("p", model({ text: { input: { price: 0 }, output: { price: 0 } } }), 0).price_in).toBe(0);
  });
});
