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

describe("measured input", () => {
  it("puts the bounds of an evaluated input limit in the summary", async () => {
    const { summarize } = await import("../src/core/entries.ts");
    const model = (measured: unknown[]) => ({ id: "m", name: "M", providers_dev: { origin: "added", access: "subscription", limits: { measured } } }) as never;
    const two = summarize("p", model([{ input_accepted: 915011, input_refused: 922500 }, { input_accepted: 920870, input_refused: 921875 }]), 0);
    // The widest accepted and the narrowest refused: the real limit is between them.
    expect([two.measured_input_accepted, two.measured_input_refused, two.context]).toEqual([920870, 921875, undefined]);
    const none = summarize("p", model([{ context: 1000000, output: 128000 }]), 0);
    expect([none.measured_input_accepted, none.measured_input_refused]).toEqual([undefined, undefined]);
  });
});

describe("cache evaluations taken together", () => {
  it("pools the checks by age band and keeps asked lifetimes apart", async () => {
    const { poolCache } = await import("../src/core/entries.ts");
    const run = (checks: [number, number, number][], options?: Record<string, string>) =>
      ({ checks: checks.map(([age_s, warm, total]) => ({ age_s, warm, total })), ...(options ? { options } : {}) }) as never;
    const pooled = poolCache([
      run([[150, 3, 3], [300, 2, 3], [900, 3, 3], [43200, 0, 3]], { reasoning: "low" }),
      run([[300, 3, 3], [600, 1, 3], [172800, 0, 3], [900, 0, 0]]),
      run([[3600, 3, 3]], { ttl: "1h" }),
      run([[3600, 2, 3]], { prompt_cache_retention: "24h" }),
    ]);
    expect(pooled).toEqual([
      // 2.5 minutes has its own band; 10 and 15 minutes share one; two days falls in the last one. A check that was not made counts nowhere.
      { evaluations: 2, bands: [{ up_to_s: 150, warm: 3, total: 3 }, { up_to_s: 300, warm: 5, total: 6 }, { up_to_s: 900, warm: 4, total: 6 }, { up_to_s: 43200, warm: 0, total: 3 }, { up_to_s: 86400, warm: 0, total: 3 }] },
      { asked: "1h", evaluations: 1, bands: [{ up_to_s: 3600, warm: 3, total: 3 }] },
      { asked: "24h", evaluations: 1, bands: [{ up_to_s: 3600, warm: 2, total: 3 }] },
    ]);
    expect(poolCache([])).toEqual([]);
  });
});
