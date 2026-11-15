// The cache lifetime record (design/safe-cache-lifetime.md, sections 2 to 5 and the worked examples of section 10).
// Every evaluation is written out here, as the published dataset of 2026-11-15 has it; nothing is read from data/.
import { describe, expect, it, vi } from "vitest";
import {
  cacheLifetime,
  cacheResult,
  contradicts,
  documentedCache,
  documentedItems,
  emptyCacheLifetime,
  evaluationLifetime,
  lifetimeSeconds,
  type CacheEvaluation,
  type CacheLifetimeItem,
  type CacheMode,
  type CacheResult,
  type LifetimeSource,
  type RetentionProfile,
  type SafeLifetime,
} from "../src/core/cache.ts";
import type { JsonObject } from "../src/core/merge.ts";
import { lifetimeRuleBreaks } from "./helpers.ts";

const LABELS: Record<string, string> = {
  cliproxyapi: "Requests sent through CLIProxyAPI",
  "codex-cli": "OpenAI's Codex CLI",
  "agent+cliproxyapi": "A coding agent, through CLIProxyAPI",
  "muse-code": "Meta's Muse Code CLI",
  direct: "Requests sent straight to the provider",
  "devin-cli": "The Devin CLI",
};

/** "c 1/1 · 300: 3/3 · 900: 2/3", the notation of the design, as results. */
function results(text: string): CacheResult[] {
  if (!text.trim()) return [];
  return text.split("·").map((part) => {
    const match = /^\s*(c|\d+):?\s*(\d+)\/(\d+)\s*$/.exec(part);
    if (!match) throw new Error(`not a result: ${part}`);
    return match[1] === "c" ? cacheResult("control", 0, Number(match[2]), Number(match[3])) : cacheResult("timed", Number(match[1]), Number(match[2]), Number(match[3]));
  });
}

function evaluation(id: string, client: string, date: string, text: string, more: Partial<CacheEvaluation> = {}): CacheEvaluation {
  return {
    id,
    route: "route",
    route_label: "Route",
    client,
    client_label: LABELS[client] ?? client,
    date,
    request_settings: {},
    retention_profile: "short",
    parameter: null,
    value: null,
    results: results(text),
    late_excluded: null,
    note: null,
    source: `https://example.com/${id}`,
    ...more,
  };
}

const long1h = { retention_profile: "long" as const, parameter: "cache_control.ttl", value: "1h" };
const long24h = { retention_profile: "long" as const, parameter: "prompt_cache_retention", value: "24h" };

// The evaluations of section 10, in full.
const X1 = evaluation("cpa-codex-long-2026-11-06/X1", "cliproxyapi", "2026-11-06", "c 1/1 · 300: 3/3 · 900: 2/3 · 1800: 2/3 · 3600: 3/3 · 7200: 3/3 · 10800: 3/3 · 14400: 2/3 · 21600: 2/3 · 28800: 1/3 · 36000: 1/3 · 43200: 0/3");
const H1 = evaluation("harness-2026-11-07/H1", "codex-cli", "2026-11-07", "c 1/1 · 300: 3/3 · 900: 2/3 · 1800: 3/3 · 3600: 2/3 · 7200: 3/3 · 14400: 1/3 · 21600: 1/3 · 28800: 2/3 · 36000: 1/3 · 43200: 0/3");
const H2 = evaluation("harness-2026-11-07/H2", "agent+cliproxyapi", "2026-11-07", "c 1/1 · 300: 3/3 · 900: 3/3 · 1800: 3/3 · 3600: 2/3 · 7200: 2/3 · 14400: 3/3 · 21600: 2/3 · 28800: 1/3 · 36000: 1/3 · 43200: 0/3");
const L4 = evaluation("cpa-latest-2026-11-06/L4", "cliproxyapi", "2026-11-06", "c 1/1 · 150: 3/3 · 300: 3/3 · 600: 3/3 · 900: 2/3 · 1800: 1/3 · 3600: 0/3 · 7200: 2/3");
const H5 = evaluation("harness-2026-11-07/H5", "muse-code", "2026-11-07", "c 0/1 · 150: 0/3 · 300: 0/3 · 600: 0/3 · 900: 0/3 · 1800: 0/3 · 3600: 0/3 · 7200: 0/3");
const H6 = evaluation("harness-2026-11-07/H6", "agent+cliproxyapi", "2026-11-07", "c 1/1 · 150: 3/3 · 300: 3/3 · 600: 3/3 · 900: 3/3 · 1800: 3/3 · 3600: 3/3 · 7200: 3/3");
const M2 = evaluation("meta-24h-2026-11-10/M2", "agent+cliproxyapi", "2026-11-10", "c 1/1 · 14400: 3/3 · 43200: 0/3 · 86400: 0/3", long24h);
const G5 = evaluation("gpt6-2026-11-11/G5", "cliproxyapi", "2026-11-11", "c 1/1 · 300: 3/3 · 900: 3/3 · 1800: 3/3 · 2400: 0/3 · 3600: 0/3");
const K1beta = evaluation("cpa-8.0.53/K1-beta", "cliproxyapi", "2026-11-04", "c 1/1 · 600: 3/3 · 1800: 2/3 · 3900: 0/3", long1h);
const K1nobeta = evaluation("cpa-8.0.53/K1-nobeta", "cliproxyapi", "2026-11-04", "c 1/1 · 600: 3/3 · 1800: 3/3 · 3900: 0/3", long1h);
const R5 = evaluation("openrouter-direct/R5", "direct", "2026-11-04", "c 1/1 · 150: 0/3 · 300: 0/3");
const L1b = evaluation("cpa-latest-2026-11-06/L1b", "cliproxyapi", "2026-11-06", "c 1/1 · 150: 2/2 · 300: 1/2 · 600: 0/2 · 900: 0/2");
const R4 = evaluation("openrouter-direct/R4", "direct", "2026-11-04", "c 1/1 · 150: 3/3 · 300: 3/3 · 450: 0/3 · 600: 0/3");
const D6 = evaluation("cpa-8.0.53/D6", "cliproxyapi", "2026-11-04", "c 0/1");
const D9 = evaluation("cpa-8.0.53/D9", "cliproxyapi", "2026-11-04", "c 1/1 · 150: 0/3 · 300: 3/3 · 450: 1/3 · 600: 0/3 · 900: 0/3");
const D11c = evaluation("devin-harness-2026-11-08/D11c", "devin-cli", "2026-11-08", "c 1/1 · 300: 2/2 · 900: 2/2 · 1800: 2/2 · 3600: 2/2 · 7200: 2/2");
const N1c = evaluation("devin-cache-investigation-2026-11-09/N1c", "devin-cli", "2026-11-09", "c 0/1 · 120: 0/2");
const D11p = evaluation("devin-harness-2026-11-08/D11p", "agent+cliproxyapi", "2026-11-08", "c 0/1 · 300: 0/2 · 900: 0/2 · 1800: 0/2 · 3600: 0/2 · 7200: 0/2");
const N1p = evaluation("devin-cache-investigation-2026-11-09/N1p", "agent+cliproxyapi", "2026-11-09", "c 1/1 · 120: 2/2");

const IMPORT = { source: "models.dev" as const, date: "2026-11-15" };
const fromImport = (): { source: LifetimeSource; date: string | null } => IMPORT;
const docs = (cache: unknown) => documentedCache({ capabilities: { cache } } as JsonObject);

/** A documented item, every key written. */
const documentedOf = (profile: RetentionProfile, lifetime: number, mode: CacheMode | null, text: string | null, from: { source: LifetimeSource; date: string | null } = IMPORT): CacheLifetimeItem => ({
  retention_profile: profile, basis: "documented", source: from.source, date: from.date, lifetime_s: lifetime, mode, documented_as: text,
  client: null, client_label: null, parameter: null, value: null, evaluations: 0, evaluation_ids: [], checks: 0, hits: 0, tested_from_s: null, first_miss_s: null, results: null,
});
/** A measured item, every key written. */
const measuredOf = (more: Pick<CacheLifetimeItem, "date" | "lifetime_s" | "client" | "evaluation_ids" | "checks" | "hits" | "tested_from_s" | "first_miss_s" | "results"> & Partial<CacheLifetimeItem>): CacheLifetimeItem => ({
  retention_profile: "short", basis: "measured", source: "providers.dev", mode: null, documented_as: null, client_label: LABELS[more.client!]!, parameter: null, value: null, evaluations: more.evaluation_ids.length, ...more,
});
const NOTHING: SafeLifetime = { safe_s: null, basis: "none", source: null, date: null, documented_s: null, measured_s: null, clients: 0, evaluations: 0, checks: 0, hits: 0, checks_inside: null, hits_inside: null, tested_from_s: null, first_miss_s: null };
const profileOf = (more: Partial<SafeLifetime>): SafeLifetime => ({ ...NOTHING, ...more });

describe("evaluationLifetime (3.2)", () => {
  it("gives every row of the tables of section 10", () => {
    const rows: [CacheEvaluation, number, number | null, number | null][] = [
      [X1, 300, 900, 300],
      [H1, 300, 900, 300],
      [H2, 1800, 3600, 300],
      [L4, 600, 900, 150],
      [H5, 0, 0, 150],
      [H6, 7200, null, 150],
      [M2, 14400, 43200, 14400],
      [G5, 1800, 2400, 300],
      [K1beta, 600, 1800, 600],
      [K1nobeta, 1800, 3900, 600],
      [R5, 0, 150, 150],
      [L1b, 150, 300, 150],
      [R4, 300, 450, 150],
      [D6, 0, 0, null],
      [D9, 0, 150, 150],
      [D11c, 7200, null, 300],
      [N1c, 0, 0, 120],
      [D11p, 0, 0, 300],
      [N1p, 120, null, 120],
    ];
    for (const [run, safe, miss, from] of rows) expect(evaluationLifetime(run), run.id).toEqual({ safe_s: safe, first_miss_s: miss, tested_from_s: from });
  });

  it("does not count an evaluation with no result, or with only a control that hit", () => {
    expect(evaluationLifetime(evaluation("none", "direct", "2026-11-01", ""))).toBeNull();
    expect(evaluationLifetime(evaluation("control", "direct", "2026-11-01", "c 1/1"))).toBeNull();
    expect(evaluationLifetime(evaluation("control-2", "direct", "2026-11-01", "c 3/3"))).toBeNull();
    // A control that missed counts on its own.
    expect(evaluationLifetime(evaluation("missed", "direct", "2026-11-01", "c 0/1"))).toEqual({ safe_s: 0, first_miss_s: 0, tested_from_s: null });
  });

  it("walks the timed results where there is no control", () => {
    expect(evaluationLifetime(evaluation("no-control", "direct", "2026-11-01", "300: 3/3 · 900: 1/3"))).toEqual({ safe_s: 300, first_miss_s: 900, tested_from_s: 300 });
    expect(evaluationLifetime(evaluation("no-control-miss", "direct", "2026-11-01", "300: 0/3"))).toEqual({ safe_s: 0, first_miss_s: 300, tested_from_s: 300 });
  });

  it("takes 2 of 3 as a miss, and a full hit after a miss does not raise the value", () => {
    expect(evaluationLifetime(evaluation("two-of-three", "direct", "2026-11-01", "c 1/1 · 150: 2/3"))).toEqual({ safe_s: 0, first_miss_s: 150, tested_from_s: 150 });
    expect(evaluationLifetime(evaluation("again", "direct", "2026-11-01", "c 1/1 · 150: 3/3 · 300: 2/3 · 600: 3/3 · 900: 3/3"))).toEqual({ safe_s: 150, first_miss_s: 300, tested_from_s: 150 });
    // A missed control ends it, whatever came after.
    expect(evaluationLifetime(evaluation("cold-start", "direct", "2026-11-01", "c 0/1 · 150: 3/3 · 300: 3/3"))).toEqual({ safe_s: 0, first_miss_s: 0, tested_from_s: 150 });
  });

  it("orders the results itself: the control first, then by age", () => {
    const shuffled = { ...L4, results: [...L4.results].reverse() };
    expect(evaluationLifetime(shuffled)).toEqual({ safe_s: 600, first_miss_s: 900, tested_from_s: 150 });
    const late = evaluation("late", "direct", "2026-11-01", "600: 0/3 · c 1/1 · 300: 3/3 · 150: 3/3");
    expect(evaluationLifetime(late)).toEqual({ safe_s: 300, first_miss_s: 600, tested_from_s: 150 });
  });
});

describe("contradicts (4.1)", () => {
  it("takes the cases of section 4", () => {
    expect(contradicts(K1beta, 3600)).toBe(false); // 2 of 3 at 1800 is not below half; 3900 is outside
    expect(contradicts(R5, 300)).toBe(true); // 0 of 3 at 150
    expect(contradicts(L1b, 300)).toBe(false); // 1 of 2 at 300 is exactly half
    expect(contradicts(L1b, 600)).toBe(true); // 0 of 2 at 600, inside 600
  });

  it("contradicts at fewer than half inside, the documented age included, and nowhere above it", () => {
    expect(contradicts(evaluation("a", "direct", "2026-11-01", "c 1/1 · 150: 1/3"), 300)).toBe(true);
    expect(contradicts(evaluation("b", "direct", "2026-11-01", "c 1/1 · 300: 1/3"), 300)).toBe(true);
    expect(contradicts(evaluation("c", "direct", "2026-11-01", "c 1/1 · 300: 3/3 · 301: 0/2"), 300)).toBe(false);
    expect(contradicts(evaluation("d", "direct", "2026-11-01", "c 1/1 · 300: 3/6"), 300)).toBe(false);
    expect(contradicts(evaluation("e", "direct", "2026-11-01", "c 1/1 · 300: 2/4"), 300)).toBe(false);
  });

  it("tests the control as any other result", () => {
    expect(contradicts(evaluation("cold", "direct", "2026-11-01", "c 0/1"), 300)).toBe(true);
    expect(contradicts(evaluation("warm", "direct", "2026-11-01", "c 1/1 · 600: 0/3"), 300)).toBe(false);
  });

  it("never contradicts a documented 0", () => {
    for (const run of [R5, D6, H5, D11p]) expect(contradicts(run, 0)).toBe(false);
  });
});

describe("documentedItems (5)", () => {
  it("makes an item of each documented lifetime, short for the shortest and long for every other", () => {
    expect(documentedItems(docs({ explicit: { ttl: ["5m", "1h"] } }), fromImport)).toEqual([documentedOf("short", 300, "explicit", "5m"), documentedOf("long", 3600, "explicit", "1h")]);
    expect(documentedItems(docs({ explicit: { ttl: ["5m"] } }), fromImport)).toEqual([documentedOf("short", 300, "explicit", "5m")]);
    expect(documentedItems(docs({ explicit: { ttl: ["30m"] } }), fromImport)).toEqual([documentedOf("short", 1800, "explicit", "30m")]);
    expect(documentedItems(docs({ implicit: { ttl: ["24h"] } }), fromImport)).toEqual([documentedOf("short", 86400, "implicit", "24h")]);
    expect(documentedItems(docs({ implicit: true, explicit: { ttl: ["12h", "30m"] } }), fromImport)).toEqual([documentedOf("short", 1800, "explicit", "30m"), documentedOf("long", 43200, "explicit", "12h")]);
    expect(documentedItems(docs({ explicit: { ttl: ["2h"] } }), fromImport)).toEqual([documentedOf("short", 7200, "explicit", "2h")]);
    // The profile is decided over both ways of caching.
    expect(documentedItems(docs({ implicit: { ttl: ["1h"] }, explicit: { ttl: ["5m"] } }), fromImport)).toEqual([documentedOf("short", 300, "explicit", "5m"), documentedOf("long", 3600, "implicit", "1h")]);
  });

  it("makes four items where both ways of caching document the same two lifetimes", () => {
    const cyber = docs({ implicit: { ttl: ["30m", "12h"], min_tokens: 1024 }, explicit: { ttl: ["30m", "12h"], min_tokens: 1024, max_breakpoints: 4 } });
    expect(documentedItems(cyber, fromImport)).toEqual([
      documentedOf("short", 1800, "implicit", "30m"),
      documentedOf("short", 1800, "explicit", "30m"),
      documentedOf("long", 43200, "implicit", "12h"),
      documentedOf("long", 43200, "explicit", "12h"),
    ]);
  });

  it("makes no item where a way of caching is supported without a lifetime, or nothing is said", () => {
    expect(documentedItems(docs({ implicit: true }), fromImport)).toEqual([]);
    expect(documentedItems(docs({ implicit: { min_tokens: 4096 } }), fromImport)).toEqual([]);
    expect(documentedItems(documentedCache({}), fromImport)).toEqual([]);
    // One way unsupported and the other not stated is unknown, not \"does not cache\".
    expect(docs({ explicit: false }).support).toBe("unknown");
    expect(documentedItems(docs({ explicit: false }), fromImport)).toEqual([]);
    // A lifetime of a way that is not supported is no item either.
    expect(documentedItems(docs({ implicit: false, explicit: { ttl: ["5m"] } }), fromImport)).toEqual([documentedOf("short", 300, "explicit", "5m")]);
  });

  it("makes two items of 0 seconds where the entry is documented as not caching", () => {
    const none = [documentedOf("short", 0, null, null), documentedOf("long", 0, null, null)];
    expect(documentedItems(docs(false), fromImport)).toEqual(none);
    expect(documentedItems(docs({ implicit: false, explicit: false }), fromImport)).toEqual(none);
  });

  it("makes no item of a lifetime that is not a whole number of seconds above 0, and rounds nothing", () => {
    expect(lifetimeSeconds("500ms")).toBeUndefined();
    expect(lifetimeSeconds("1500ms")).toBeUndefined();
    expect(lifetimeSeconds("0s")).toBeUndefined();
    expect(lifetimeSeconds("2000ms")).toBe(2);
    expect(lifetimeSeconds("5m")).toBe(300);
    expect(documentedItems(docs({ explicit: { ttl: ["500ms"] } }), fromImport)).toEqual([]);
    expect(documentedItems(docs({ explicit: { ttl: ["500ms", "0m", "5m"] } }), fromImport)).toEqual([documentedOf("short", 300, "explicit", "5m")]);
    expect(cacheLifetime(docs({ explicit: { ttl: ["500ms"] } }), [], fromImport)).toEqual(emptyCacheLifetime());
  });

  it("makes no item of a text that is not a duration", () => {
    expect(documentedItems(docs({ explicit: { ttl: ["5m-10m", "a while", "1h"] } }), fromImport)).toEqual([documentedOf("short", 3600, "explicit", "1h")]);
    expect(documentedItems(docs({ explicit: { ttl: ["5m-10m"] } }), fromImport)).toEqual([]);
  });

  it("asks sourceOf per way of caching, and with null for the \"does not cache\" item", () => {
    const asked: (CacheMode | null)[] = [];
    const sourceOf = (mode: CacheMode | null) => {
      asked.push(mode);
      return mode === "implicit" ? { source: "providers.dev" as const, date: "2026-11-02" } : mode === "explicit" ? IMPORT : { source: "providers.dev" as const, date: "2026-11-03" };
    };
    const corrected = { source: "providers.dev" as const, date: "2026-11-02" };
    expect(documentedItems(docs({ implicit: { ttl: ["1h"] }, explicit: { ttl: ["5m", "1h"] } }), sourceOf)).toEqual([
      documentedOf("short", 300, "explicit", "5m"),
      documentedOf("long", 3600, "implicit", "1h", corrected),
      documentedOf("long", 3600, "explicit", "1h"),
    ]);
    expect(asked.sort()).toEqual(["explicit", "implicit"]);
    asked.length = 0;
    expect(documentedItems(docs(false), sourceOf).map((item) => [item.source, item.date])).toEqual([["providers.dev", "2026-11-03"], ["providers.dev", "2026-11-03"]]);
    expect(asked).toEqual([null]);
  });
});

describe("cacheLifetime: the worked examples of section 10", () => {
  const check = (documented: ReturnType<typeof docs>, runs: CacheEvaluation[]) => {
    const record = cacheLifetime(documented, runs, fromImport);
    expect(lifetimeRuleBreaks(record, runs, documented)).toEqual([]);
    return record;
  };

  it("1. openai-codex/gpt-6.1-sol: three clients, nothing documented, 300 measured", () => {
    const record = check(docs({ implicit: true }), [H1, H2, X1]);
    expect(record).toEqual({
      short: profileOf({ safe_s: 300, basis: "measured", source: "providers.dev", date: "2026-11-07", measured_s: 300, clients: 3, evaluations: 3, checks: 96, hits: 63, tested_from_s: 300, first_miss_s: 900 }),
      long: NOTHING,
      lifetimes: [
        measuredOf({ client: "agent+cliproxyapi", date: "2026-11-07", lifetime_s: 1800, evaluation_ids: [H2.id], checks: 31, hits: 21, tested_from_s: 300, first_miss_s: 3600, results: H2.results }),
        measuredOf({ client: "cliproxyapi", date: "2026-11-06", lifetime_s: 300, evaluation_ids: [X1.id], checks: 34, hits: 23, tested_from_s: 300, first_miss_s: 900, results: X1.results }),
        measuredOf({ client: "codex-cli", date: "2026-11-07", lifetime_s: 300, evaluation_ids: [H1.id], checks: 31, hits: 19, tested_from_s: 300, first_miss_s: 900, results: H1.results }),
      ],
    });
  });

  it("2. meta-subscription/muse-wonder-1.0: one client never hit, 0 measured; long from one age", () => {
    const record = check(documentedCache({}), [M2, H5, H6, L4]);
    expect(record).toEqual({
      short: profileOf({ safe_s: 0, basis: "measured", source: "providers.dev", date: "2026-11-07", measured_s: 0, clients: 3, evaluations: 3, checks: 66, hits: 37, tested_from_s: 150, first_miss_s: 0 }),
      long: profileOf({ safe_s: 14400, basis: "measured", source: "providers.dev", date: "2026-11-10", measured_s: 14400, clients: 1, evaluations: 1, checks: 10, hits: 4, tested_from_s: 14400, first_miss_s: 43200 }),
      lifetimes: [
        measuredOf({ client: "agent+cliproxyapi", date: "2026-11-07", lifetime_s: 7200, evaluation_ids: [H6.id], checks: 22, hits: 22, tested_from_s: 150, first_miss_s: null, results: H6.results }),
        measuredOf({ client: "cliproxyapi", date: "2026-11-06", lifetime_s: 600, evaluation_ids: [L4.id], checks: 22, hits: 15, tested_from_s: 150, first_miss_s: 900, results: L4.results }),
        measuredOf({ client: "muse-code", date: "2026-11-07", lifetime_s: 0, evaluation_ids: [H5.id], checks: 22, hits: 0, tested_from_s: 150, first_miss_s: 0, results: H5.results }),
        measuredOf({ ...long24h, client: "agent+cliproxyapi", date: "2026-11-10", lifetime_s: 14400, evaluation_ids: [M2.id], checks: 10, hits: 4, tested_from_s: 14400, first_miss_s: 43200, results: M2.results }),
      ],
    });
  });

  it("3. openai/gpt-6.1-sol: documented and measured agree (the record of 2.5)", () => {
    const record = check(docs({ implicit: { min_tokens: 1024 }, explicit: { ttl: ["30m", "12h"], min_tokens: 1024, max_breakpoints: 4 } }), [G5]);
    expect(record).toEqual({
      short: { safe_s: 1800, basis: "documented", source: "models.dev", date: "2026-11-15", documented_s: 1800, measured_s: 1800, clients: 1, evaluations: 1, checks: 16, hits: 10, checks_inside: 10, hits_inside: 10, tested_from_s: 300, first_miss_s: 2400 },
      long: { safe_s: 43200, basis: "documented", source: "models.dev", date: "2026-11-15", documented_s: 43200, measured_s: null, clients: 0, evaluations: 0, checks: 0, hits: 0, checks_inside: null, hits_inside: null, tested_from_s: null, first_miss_s: null },
      lifetimes: [
        documentedOf("short", 1800, "explicit", "30m"),
        {
          retention_profile: "short", basis: "measured", source: "providers.dev", date: "2026-11-11", lifetime_s: 1800, mode: null, documented_as: null,
          client: "cliproxyapi", client_label: "Requests sent through CLIProxyAPI", parameter: null, value: null,
          evaluations: 1, evaluation_ids: ["gpt6-2026-11-11/G5"], checks: 16, hits: 10, tested_from_s: 300, first_miss_s: 2400,
          results: [
            { kind: "control", age_s: 0, hits: 1, checks: 1, hit_rate_pct: 100 },
            { kind: "timed", age_s: 300, hits: 3, checks: 3, hit_rate_pct: 100 },
            { kind: "timed", age_s: 900, hits: 3, checks: 3, hit_rate_pct: 100 },
            { kind: "timed", age_s: 1800, hits: 3, checks: 3, hit_rate_pct: 100 },
            { kind: "timed", age_s: 2400, hits: 0, checks: 3, hit_rate_pct: 0 },
            { kind: "timed", age_s: 3600, hits: 0, checks: 3, hit_rate_pct: 0 },
          ],
        },
        documentedOf("long", 43200, "explicit", "12h"),
      ],
    });
  });

  it("4. meta-subscription/muse-ember-1.0: the long profile from a run that continues another", () => {
    const E1 = evaluation("ember-2026-11-10/E1", "agent+cliproxyapi", "2026-11-10", "c 1/1 · 300: 2/2 · 1800: 1/2 · 3600: 0/2 · 7200: 1/2");
    const M1 = evaluation("meta-24h-2026-11-10/M1", "agent+cliproxyapi", "2026-11-10", "c 1/1 · 300: 3/3 · 1800: 3/3 · 3600: 3/3 · 7200: 3/3 · 14400: 3/3 · 28800: 0/3 · 43200: 0/3 · 86400: 0/3", long24h);
    const record = check(documentedCache({}), [E1, M1]);
    expect(record.short).toEqual(profileOf({ safe_s: 300, basis: "measured", source: "providers.dev", date: "2026-11-10", measured_s: 300, clients: 1, evaluations: 1, checks: 9, hits: 5, tested_from_s: 300, first_miss_s: 1800 }));
    expect(record.long).toEqual(profileOf({ safe_s: 14400, basis: "measured", source: "providers.dev", date: "2026-11-10", measured_s: 14400, clients: 1, evaluations: 1, checks: 25, hits: 16, tested_from_s: 300, first_miss_s: 28800 }));
  });

  it("5. anthropic/claude-opus-5-5: a miss that does not contradict; two runs of one client in one item", () => {
    const record = check(docs({ explicit: { ttl: ["5m", "1h"], min_tokens: 512, max_breakpoints: 4, targets: ["tools", "system", "messages"] } }), [K1beta, K1nobeta]);
    expect(record).toEqual({
      short: profileOf({ safe_s: 300, basis: "documented", source: "models.dev", date: "2026-11-15", documented_s: 300 }),
      long: { safe_s: 3600, basis: "documented", source: "models.dev", date: "2026-11-15", documented_s: 3600, measured_s: 600, clients: 1, evaluations: 2, checks: 20, hits: 13, checks_inside: 14, hits_inside: 13, tested_from_s: 600, first_miss_s: 1800 },
      lifetimes: [
        documentedOf("short", 300, "explicit", "5m"),
        documentedOf("long", 3600, "explicit", "1h"),
        measuredOf({
          ...long1h, client: "cliproxyapi", date: "2026-11-04", lifetime_s: 600, evaluation_ids: [K1beta.id, K1nobeta.id], checks: 20, hits: 13, tested_from_s: 600, first_miss_s: 1800,
          results: results("c 2/2 · 600: 6/6 · 1800: 5/6 · 3900: 0/6"),
        }),
      ],
    });
  });

  it("6. anthropic/claude-sonnet-5-5: documented only", () => {
    const record = check(docs({ explicit: { ttl: ["5m", "1h"], min_tokens: 512, max_breakpoints: 4, targets: ["tools", "system", "messages"] } }), []);
    expect(record).toEqual({
      short: profileOf({ safe_s: 300, basis: "documented", source: "models.dev", date: "2026-11-15", documented_s: 300 }),
      long: profileOf({ safe_s: 3600, basis: "documented", source: "models.dev", date: "2026-11-15", documented_s: 3600 }),
      lifetimes: [documentedOf("short", 300, "explicit", "5m"), documentedOf("long", 3600, "explicit", "1h")],
    });
  });

  it("7. neither: nothing documented, or caching without a lifetime, and no evaluation", () => {
    for (const documented of [documentedCache({}), docs({ implicit: { min_tokens: 4096 } }), docs({ implicit: true })]) {
      expect(check(documented, [])).toEqual({ short: NOTHING, long: NOTHING, lifetimes: [] });
      expect(cacheLifetime(documented, [], fromImport)).toEqual(emptyCacheLifetime());
    }
  });

  it("8. openrouter/google/gemini-3.8-flash: the documentation contradicted", () => {
    const record = check(docs({ implicit: true, explicit: { ttl: ["5m"], max_breakpoints: 1 } }), [R5]);
    expect(record).toEqual({
      short: { safe_s: 0, basis: "measured", source: "providers.dev", date: "2026-11-04", documented_s: 300, measured_s: 0, clients: 1, evaluations: 1, checks: 7, hits: 1, checks_inside: 7, hits_inside: 1, tested_from_s: 150, first_miss_s: 150 },
      long: NOTHING,
      lifetimes: [
        documentedOf("short", 300, "explicit", "5m"),
        measuredOf({ client: "direct", date: "2026-11-04", lifetime_s: 0, evaluation_ids: [R5.id], checks: 7, hits: 1, tested_from_s: 150, first_miss_s: 150, results: R5.results }),
      ],
    });
  });

  it("9. openrouter/google/gemini-4-argon: exactly half does not contradict", () => {
    const record = check(docs({ implicit: true, explicit: { ttl: ["5m"], max_breakpoints: 1 } }), [L1b, R4]);
    expect(record).toEqual({
      short: { safe_s: 300, basis: "documented", source: "models.dev", date: "2026-11-15", documented_s: 300, measured_s: 150, clients: 2, evaluations: 2, checks: 22, hits: 11, checks_inside: 12, hits_inside: 11, tested_from_s: 150, first_miss_s: 300 },
      long: NOTHING,
      lifetimes: [
        documentedOf("short", 300, "explicit", "5m"),
        measuredOf({ client: "cliproxyapi", date: "2026-11-06", lifetime_s: 150, evaluation_ids: [L1b.id], checks: 9, hits: 4, tested_from_s: 150, first_miss_s: 300, results: L1b.results }),
        measuredOf({ client: "direct", date: "2026-11-04", lifetime_s: 300, evaluation_ids: [R4.id], checks: 13, hits: 7, tested_from_s: 150, first_miss_s: 450, results: R4.results }),
      ],
    });
  });

  it("10 and 11. devin: only a control that missed; a miss at the youngest age with hits after it", () => {
    expect(check(documentedCache({}), [D6]).short).toEqual(profileOf({ safe_s: 0, basis: "measured", source: "providers.dev", date: "2026-11-04", measured_s: 0, clients: 1, evaluations: 1, checks: 1, hits: 0, first_miss_s: 0 }));
    expect(check(documentedCache({}), [D9]).short).toEqual(profileOf({ safe_s: 0, basis: "measured", source: "providers.dev", date: "2026-11-04", measured_s: 0, clients: 1, evaluations: 1, checks: 16, hits: 5, tested_from_s: 150, first_miss_s: 150 }));
  });

  it("12. devin/nemotron-3-5-super: two request shapes per client", () => {
    const record = check(documentedCache({}), [N1c, N1p, D11c, D11p]);
    expect(record).toEqual({
      short: profileOf({ safe_s: 0, basis: "measured", source: "providers.dev", date: "2026-11-09", measured_s: 0, clients: 2, evaluations: 4, checks: 28, hits: 14, tested_from_s: 120, first_miss_s: 0 }),
      long: NOTHING,
      lifetimes: [
        measuredOf({ client: "agent+cliproxyapi", date: "2026-11-09", lifetime_s: 0, evaluation_ids: [N1p.id, D11p.id].sort(), checks: 14, hits: 3, tested_from_s: 120, first_miss_s: 0, results: results("c 1/2 · 120: 2/2 · 300: 0/2 · 900: 0/2 · 1800: 0/2 · 3600: 0/2 · 7200: 0/2") }),
        measuredOf({ client: "devin-cli", date: "2026-11-09", lifetime_s: 0, evaluation_ids: [N1c.id, D11c.id].sort(), checks: 14, hits: 11, tested_from_s: 120, first_miss_s: 0, results: results("c 1/2 · 120: 0/2 · 300: 2/2 · 900: 2/2 · 1800: 2/2 · 3600: 2/2 · 7200: 2/2") }),
      ],
    });
  });

  it("13. alibaba/qwen-mt-plus: documented as not caching", () => {
    const record = check(docs(false), []);
    expect(record).toEqual({
      short: profileOf({ safe_s: 0, basis: "documented", source: "models.dev", date: "2026-11-15", documented_s: 0 }),
      long: profileOf({ safe_s: 0, basis: "documented", source: "models.dev", date: "2026-11-15", documented_s: 0 }),
      lifetimes: [documentedOf("short", 0, null, null), documentedOf("long", 0, null, null)],
    });
  });
});

describe("cacheLifetime: the rules", () => {
  const twoMinutes = (id: string, client: string, text: string, more: Partial<CacheEvaluation> = {}) => evaluation(id, client, "2026-11-01", text, more);

  it("orders the list: profile, documented before measured, no lifetime asked first, then by seconds, value and client", () => {
    const runs = [
      twoMinutes("l-24h-b", "direct", "c 1/1 · 600: 3/3", long24h),
      twoMinutes("l-1h-z", "zed", "c 1/1 · 600: 3/3", long1h),
      twoMinutes("l-1h-a", "alpha", "c 1/1 · 600: 3/3", long1h),
      twoMinutes("l-60m", "alpha", "c 1/1 · 600: 3/3", { retention_profile: "long", parameter: "cache_control.ttl", value: "60m" }),
      twoMinutes("s-5m", "direct", "c 1/1 · 300: 3/3", { parameter: "cache_control.ttl", value: "5m" }),
      twoMinutes("s-none-b", "direct", "c 1/1 · 300: 3/3"),
      twoMinutes("s-none-a", "alpha", "c 1/1 · 300: 3/3"),
    ];
    const documented = docs({ implicit: { ttl: ["1h"] }, explicit: { ttl: ["5m", "1h"] } });
    const record = cacheLifetime(documented, runs, fromImport);
    expect(record.lifetimes.map((item) => [item.retention_profile, item.basis, item.mode ?? item.value, item.client])).toEqual([
      ["short", "documented", "explicit", null],
      ["short", "measured", null, "alpha"],
      ["short", "measured", null, "direct"],
      ["short", "measured", "5m", "direct"],
      ["long", "documented", "implicit", null],
      ["long", "documented", "explicit", null],
      ["long", "measured", "1h", "alpha"],
      ["long", "measured", "1h", "zed"],
      ["long", "measured", "60m", "alpha"],
      ["long", "measured", "24h", "direct"],
    ]);
    expect(lifetimeRuleBreaks(record, runs, documented)).toEqual([]);
  });

  it("makes two items of two settings in one profile, and the lowest of them is the profile's", () => {
    const runs = [twoMinutes("a", "direct", "c 1/1 · 3600: 3/3 · 7200: 0/3", long1h), twoMinutes("b", "direct", "c 1/1 · 3600: 3/3 · 43200: 3/3", long24h)];
    const record = cacheLifetime(documentedCache({}), runs, fromImport);
    expect(record.lifetimes.map((item) => [item.value, item.lifetime_s])).toEqual([["1h", 3600], ["24h", 43200]]);
    expect(record.long).toMatchObject({ safe_s: 3600, basis: "measured", measured_s: 3600, clients: 1, evaluations: 2 });
    expect(record.short).toEqual(NOTHING);
  });

  it("leaves an evaluation that does not count out of every item; it says nothing about how long", () => {
    const runs = [twoMinutes("control-only", "direct", "c 1/1"), twoMinutes("empty", "direct", ""), twoMinutes("timed", "other", "c 1/1 · 300: 3/3")];
    const record = cacheLifetime(documentedCache({}), runs, fromImport);
    expect(record.lifetimes.flatMap((item) => item.evaluation_ids)).toEqual(["timed"]);
    expect(record.short).toMatchObject({ safe_s: 300, clients: 1, evaluations: 1 });
    expect(lifetimeRuleBreaks(record, runs, documentedCache({}))).toEqual([]);
    // With only such evaluations, the profile is not measured.
    expect(cacheLifetime(documentedCache({}), runs.slice(0, 2), fromImport)).toEqual(emptyCacheLifetime());
  });

  it("combines two evaluations of one client with different ages by the minimum, and adds their results up", () => {
    const early = twoMinutes("early", "direct", "c 1/1 · 120: 3/3");
    const late = twoMinutes("late", "direct", "c 1/1 · 300: 3/3 · 900: 3/3 · 1800: 1/3");
    const record = cacheLifetime(documentedCache({}), [early, late], fromImport);
    expect(record.lifetimes).toEqual([
      measuredOf({ client: "direct", date: "2026-11-01", lifetime_s: 120, evaluation_ids: ["early", "late"], checks: 14, hits: 12, tested_from_s: 120, first_miss_s: 1800, results: results("c 2/2 · 120: 3/3 · 300: 3/3 · 900: 3/3 · 1800: 1/3") }),
    ]);
    // Walked over the sums, the item would give 900; the value is the minimum of the evaluations, 120.
    expect(record.short).toMatchObject({ safe_s: 120, measured_s: 120, first_miss_s: 1800, tested_from_s: 120 });
    expect(lifetimeRuleBreaks(record, [early, late], documentedCache({}))).toEqual([]);
  });

  it("is contradicted by one evaluation of a client, though the item's sum is exactly half", () => {
    const hits = twoMinutes("hits", "direct", "c 1/1 · 150: 3/3 · 300: 3/3");
    const misses = twoMinutes("misses", "direct", "c 1/1 · 150: 0/3 · 300: 0/3");
    const documented = docs({ explicit: { ttl: ["5m"] } });
    const record = cacheLifetime(documented, [hits, misses], fromImport);
    expect(record.lifetimes[1]!.results).toEqual(results("c 2/2 · 150: 3/6 · 300: 3/6"));
    expect(record.short).toEqual({ safe_s: 0, basis: "measured", source: "providers.dev", date: "2026-11-01", documented_s: 300, measured_s: 0, clients: 1, evaluations: 2, checks: 14, hits: 8, checks_inside: 14, hits_inside: 8, tested_from_s: 150, first_miss_s: 150 });
    expect(lifetimeRuleBreaks(record, [hits, misses], documented)).toEqual([]);
  });

  it("is not raised by hits beyond the documented lifetime", () => {
    const run = twoMinutes("long-hit", "direct", "c 1/1 · 300: 3/3 · 3600: 3/3 · 7200: 3/3");
    const documented = docs({ explicit: { ttl: ["5m"] } });
    const record = cacheLifetime(documented, [run], fromImport);
    expect(record.short).toMatchObject({ safe_s: 300, basis: "documented", source: "models.dev", documented_s: 300, measured_s: 7200, checks_inside: 4, hits_inside: 4 });
    expect(lifetimeRuleBreaks(record, [run], documented)).toEqual([]);
  });

  it("keeps an entry documented as not caching at 0, documented, with what was measured beside it", () => {
    const run = twoMinutes("caches-after-all", "direct", "c 1/1 · 300: 3/3 · 600: 3/3");
    const documented = docs(false);
    const record = cacheLifetime(documented, [run], fromImport);
    expect(record.short).toEqual({ safe_s: 0, basis: "documented", source: "models.dev", date: "2026-11-15", documented_s: 0, measured_s: 600, clients: 1, evaluations: 1, checks: 7, hits: 7, checks_inside: 1, hits_inside: 1, tested_from_s: 300, first_miss_s: null });
    expect(record.long).toEqual(profileOf({ safe_s: 0, basis: "documented", source: "models.dev", date: "2026-11-15", documented_s: 0 }));
    expect(record.lifetimes.map((item) => [item.retention_profile, item.basis, item.lifetime_s])).toEqual([["short", "documented", 0], ["short", "measured", 600], ["long", "documented", 0]]);
    expect(lifetimeRuleBreaks(record, [run], documented)).toEqual([]);
  });

  it("takes the source and date of the documented item the safe value is", () => {
    const sourceOf = (mode: CacheMode | null) => (mode === "implicit" ? { source: "providers.dev" as const, date: "2026-11-02" } : IMPORT);
    const documented = docs({ implicit: { ttl: ["5m"] }, explicit: { ttl: ["5m"] } });
    const record = cacheLifetime(documented, [], sourceOf);
    expect(record.short).toMatchObject({ safe_s: 300, basis: "documented", source: "providers.dev", date: "2026-11-02" });
    expect(lifetimeRuleBreaks(record, [], documented)).toEqual([]);
  });

  it("counts a timed result with a single check like any other", () => {
    const single = twoMinutes("single", "direct", "c 1/1 · 150: 1/1 · 300: 1/1 · 600: 0/1");
    expect(evaluationLifetime(single)).toEqual({ safe_s: 300, first_miss_s: 600, tested_from_s: 150 });
    const record = cacheLifetime(documentedCache({}), [single], fromImport);
    expect(record.short).toMatchObject({ safe_s: 300, measured_s: 300, checks: 4, hits: 3, tested_from_s: 150, first_miss_s: 600 });
    expect(record.lifetimes[0]!.results).toEqual(results("c 1/1 · 150: 1/1 · 300: 1/1 · 600: 0/1"));
    // A single timed check that missed inside the documented lifetime contradicts it.
    const cold = twoMinutes("cold-single", "direct", "c 1/1 · 150: 0/1");
    expect(contradicts(cold, 300)).toBe(true);
    expect(cacheLifetime(docs({ explicit: { ttl: ["5m"] } }), [cold], fromImport).short).toMatchObject({ safe_s: 0, basis: "measured", checks_inside: 2, hits_inside: 1 });
  });

  it("makes one item per parameter: the same client and value sent in two request fields are two items", () => {
    const ttl = twoMinutes("by-ttl", "direct", "c 1/1 · 3600: 3/3", long1h);
    const retention = twoMinutes("by-retention", "direct", "c 1/1 · 1800: 3/3 · 3600: 0/3", { retention_profile: "long", parameter: "prompt_cache_retention", value: "1h" });
    const record = cacheLifetime(documentedCache({}), [ttl, retention], fromImport);
    expect(record.lifetimes.map((item) => [item.parameter, item.value, item.client, item.evaluation_ids, item.lifetime_s])).toEqual([
      ["cache_control.ttl", "1h", "direct", ["by-ttl"], 3600],
      ["prompt_cache_retention", "1h", "direct", ["by-retention"], 1800],
    ]);
    expect(record.long).toMatchObject({ safe_s: 1800, clients: 1, evaluations: 2 });
    expect(lifetimeRuleBreaks(record, [ttl, retention], documentedCache({}))).toEqual([]);
  });

  it("orders the list in plain character order, whatever the locale, and whatever the order of the input", () => {
    // Ordered by character code: B (66) < a (97) < z (122) < ä (228). A locale orders them a, B, ä, z (en-US) or
    // a, B, z, ä (sv-SE); neither is the order here, and localeCompare is made to fail if anything calls it.
    const runs = [
      twoMinutes("v-a", "direct", "c 1/1 · 600: 3/3", { retention_profile: "long", parameter: "p", value: "a" }),
      twoMinutes("v-ae", "direct", "c 1/1 · 600: 3/3", { retention_profile: "long", parameter: "p", value: "ä" }),
      twoMinutes("v-z", "direct", "c 1/1 · 600: 3/3", { retention_profile: "long", parameter: "p", value: "z" }),
      twoMinutes("v-B", "direct", "c 1/1 · 600: 3/3", { retention_profile: "long", parameter: "p", value: "B" }),
      // Clients in character order too: Zed before alpha.
      twoMinutes("c-alpha", "alpha", "c 1/1 · 300: 3/3"),
      twoMinutes("c-Zed", "Zed", "c 1/1 · 300: 3/3"),
      // One client, one value, two request fields: by parameter.
      twoMinutes("p-z", "direct", "c 1/1 · 600: 3/3", { retention_profile: "long", parameter: "z_field", value: "1h" }),
      twoMinutes("p-a", "direct", "c 1/1 · 600: 3/3", { retention_profile: "long", parameter: "a_field", value: "1h" }),
    ];
    // Two texts of one lifetime in one mode: by the text.
    const documented = docs({ explicit: { ttl: ["60s", "1m", "5m"] } });
    const spy = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("the order of the lifetime record must not depend on the locale");
    });
    try {
      const record = cacheLifetime(documented, runs, fromImport);
      expect(record.lifetimes.map((item) => item.documented_as ?? `${item.client}:${item.parameter}:${item.value}`)).toEqual([
        "1m", "60s", "Zed:null:null", "alpha:null:null",
        // Values that are not durations count as 0 seconds and come before 1h; among themselves, by character.
        "5m", "direct:p:B", "direct:p:a", "direct:p:z", "direct:p:ä", "direct:a_field:1h", "direct:z_field:1h",
      ]);
      for (const order of [[...runs].reverse(), [...runs.slice(3), ...runs.slice(0, 3)]]) {
        expect(cacheLifetime(docs({ explicit: { ttl: ["5m", "1m", "60s"] } }), order, fromImport)).toEqual(record);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("finds a broken rule", () => {
    const record = cacheLifetime(docs({ explicit: { ttl: ["5m"] } }), [R5], fromImport);
    const wrong = { ...record, short: { ...record.short, safe_s: 300, basis: "documented" as const, source: "models.dev" as const, date: "2026-11-15" } };
    expect(lifetimeRuleBreaks(wrong, [R5], docs({ explicit: { ttl: ["5m"] } }))).toContain("short 4.1 rule");
    expect(lifetimeRuleBreaks(record, [R5, D6], docs({ explicit: { ttl: ["5m"] } }))).toContain("11 cpa-8.0.53/D6");
  });
});
