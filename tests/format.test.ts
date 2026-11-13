import { describe, expect, it } from "vitest";
import { addResults, cacheResult, profileOf, retentionOf, summarizeCache, type CacheEvaluation } from "../src/core/cache.ts";
import { importDate, shortAge } from "../src/core/format.ts";

const NO_CACHE = { retention: { support: "unknown", parameter: null, accepted_values: null, default: null, profiles: [], conditions: [], evidence: [] }, results: null, evaluations: [] };

describe("ages", () => {
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
    const model = (cost: unknown) => ({ id: "m", name: "M", cost, providers_dev: { origin: "upstream", access: "api", cache: NO_CACHE } }) as never;
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
    const model = (measured: unknown[]) => ({ id: "m", name: "M", providers_dev: { origin: "added", access: "subscription", limits: { measured }, cache: NO_CACHE } }) as never;
    const two = summarize("p", model([{ input_accepted: 915011, input_refused: 922500 }, { input_accepted: 920870, input_refused: 921875 }]), 0);
    // The widest accepted and the narrowest refused: the real limit is between them.
    expect([two.measured_input_accepted, two.measured_input_refused, two.context]).toEqual([920870, 921875, undefined]);
    const none = summarize("p", model([{ context: 1000000, output: 128000 }]), 0);
    expect([none.measured_input_accepted, none.measured_input_refused]).toEqual([undefined, undefined]);
  });
});

describe("cache evaluations as the API publishes them", () => {
  const evaluation = (id: string, results: [number, number, number][], sent: Partial<CacheEvaluation> = {}): CacheEvaluation => ({
    id,
    route: "r",
    route_label: "R",
    client: "direct",
    client_label: "Direct",
    date: "2026-11-10",
    request_settings: {},
    retention_profile: "short",
    parameter: null,
    value: null,
    results: results.map(([age, hits, checks]) => cacheResult(age === 0 ? "control" : "timed", age, hits, checks)),
    source: `https://example.com/${id}`,
    ...sent,
  });

  it("gives every result its counts and its percentage, to two decimals", () => {
    expect(cacheResult("timed", 300, 2, 3)).toEqual({ kind: "timed", age_s: 300, hits: 2, checks: 3, hit_rate_pct: 66.67 });
    expect(cacheResult("control", 0, 3, 3).hit_rate_pct).toBe(100);
    expect(cacheResult("timed", 450, 0, 3).hit_rate_pct).toBe(0);
  });

  it("adds evaluations up by exact age and never folds one age into another", () => {
    const sum = addResults([
      [cacheResult("control", 0, 1, 1), cacheResult("timed", 450, 3, 3), cacheResult("timed", 600, 1, 3)],
      [cacheResult("control", 0, 0, 1), cacheResult("timed", 600, 3, 3), cacheResult("timed", 150, 3, 3)],
    ]);
    expect(sum.map((item) => [item.kind, item.age_s, item.hits, item.checks, item.hit_rate_pct])).toEqual([
      ["control", 0, 1, 2, 50],
      ["timed", 150, 3, 3, 100],
      // 7.5 minutes stays 7.5 minutes; only the two checks at 10 minutes are added together.
      ["timed", 450, 3, 3, 100],
      ["timed", 600, 4, 6, 66.67],
    ]);
  });

  it("makes one line per retention setting, short first, and null where a setting was not evaluated", () => {
    expect(summarizeCache([])).toBeNull();
    const onlyShort = summarizeCache([evaluation("a", [[0, 1, 1], [300, 3, 3]]), evaluation("b", [[0, 1, 1], [300, 0, 3]])])!;
    expect(onlyShort.map((row) => [row.retention_profile, row.parameter, row.value, row.evaluations])).toEqual([
      ["short", null, null, 2],
      ["long", null, null, 0],
    ]);
    expect(onlyShort[0]!.results).toEqual([cacheResult("control", 0, 2, 2), cacheResult("timed", 300, 3, 6)]);
    expect(onlyShort[0]!.evaluation_ids).toEqual(["a", "b"]);
    // Not evaluated is null, not a row of zeros.
    expect(onlyShort[1]).toMatchObject({ results: null, last_date: null, evaluation_ids: [] });

    const long = { retention_profile: "long" as const, parameter: "cache_control.ttl" };
    const both = summarizeCache([evaluation("d", [[3600, 0, 3]], { ...long, value: "24h" }), evaluation("c", [[3600, 3, 3]], { ...long, value: "1h", date: "2026-11-12" })])!;
    expect(both.map((row) => [row.retention_profile, row.value, row.results === null ? null : row.results.length, row.last_date])).toEqual([
      ["short", null, null, null],
      ["long", "1h", 1, "2026-11-12"],
      ["long", "24h", 1, "2026-11-10"],
    ]);
  });

  it("calls a lifetime short only when none was asked for, or the shortest documented one", () => {
    const documented = { capabilities: { cache: { explicit: { ttl: ["1h", "5m"] } } } };
    expect([profileOf(null, documented), profileOf("5m", documented), profileOf("1h", documented), profileOf("24h", {})]).toEqual(["short", "short", "long", "long"]);
  });

  it("says what a request can ask for only from what is documented or was accepted", () => {
    expect(retentionOf({}, [], null)).toEqual({ support: "unknown", parameter: null, accepted_values: null, default: null, profiles: [], conditions: [], evidence: [] });
    expect(retentionOf({ capabilities: { cache: false } }, [], "2026-11-13")).toMatchObject({ support: "unsupported", profiles: [], evidence: [{ kind: "documented", date: "2026-11-13" }] });
    // One documented lifetime is no choice: nothing is claimed.
    expect(retentionOf({ capabilities: { cache: { explicit: { ttl: ["5m"] } } } }, [], null).support).toBe("unknown");

    const documented = retentionOf({ capabilities: { cache: { explicit: { ttl: ["5m", "1h"] } } } }, [], "2026-11-13");
    expect(documented).toMatchObject({ support: "supported", parameter: null, accepted_values: ["5m", "1h"], default: null });
    expect(documented.profiles).toEqual([{ profile: "short", value: null }, { profile: "short", value: "5m" }, { profile: "long", value: "1h" }]);

    // An evaluation that sent a lifetime names the request field, when its control shows the request was accepted and cached.
    const sent = { request_settings: { prompt_cache_retention: "24h" }, retention_profile: "long" as const, parameter: "prompt_cache_retention", value: "24h" };
    const accepted = retentionOf({ capabilities: { cache: { implicit: true } } }, [evaluation("m", [[0, 1, 1], [14400, 3, 3]], sent)], null);
    expect(accepted).toMatchObject({ support: "supported", parameter: { name: "prompt_cache_retention", location: "Request body, top level" }, accepted_values: ["24h"] });
    expect(accepted.evidence).toEqual([expect.objectContaining({ kind: "measured", url: "https://example.com/m", date: "2026-11-10" })]);
    const refused = retentionOf({}, [evaluation("n", [[0, 0, 1]], sent)], null);
    expect(refused.support).toBe("unknown");
  });
});
