// One safe value per quantity (design/sources-side-by-side.md, section 11, cases 1 to 9): the rule, without pi.
// Every fixture is written out here; nothing is read from data/.
import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/core/entries.ts";
import { windowMeasurement, type InputWindowMeasurement } from "../src/core/limits.ts";
import { priceParts, pricingOf } from "../src/core/policies.ts";
import { resolve, type ResolveInput } from "../src/core/resolve.ts";
import { countingKind, safeNumber, type SafeValues, type SourceValue } from "../src/core/safe.ts";
import { ext, MeasurementLabels, ObservedFile, type AccessRules, type AuthoredProvider, type Catalog, type Evidence, type OverrideFile, type UpstreamCatalog } from "../src/core/schema.ts";
import { limitOf, safeBreaks } from "./helpers.ts";

const REPO = "https://github.com/example/probe";
const IMPORT_DATE = "2026-11-20";
const doc = (date: string, url = `https://example.com/docs/${date}`): Evidence => ({ kind: "documented", url, date });

/** lab/m: an API-key entry documenting everything. login/m: the same model on a login, with nothing of its own. */
function upstream(): UpstreamCatalog {
  return {
    lab: {
      id: "lab",
      name: "Lab",
      models: {
        m: {
          id: "m", name: "M", canonical_id: "lab/m",
          limit: { context: 1000000, input: 900000, output: 64000 },
          capabilities: { cache: { explicit: { ttl: ["5m", "1h"] } } },
          cost: { text: { input: { price: 3, cache: { read: 0.3 } }, output: { price: 15 } } },
        },
        bare: { id: "bare", name: "Bare" },
        zero: { id: "zero", name: "Zero", limit: { context: 0, output: 0 }, capabilities: { cache: false }, cost: { text: { input: { price: 0 }, output: { price: 0 } } } },
        nulls: { id: "nulls", name: "Nulls", limit: { context: 200000, output: null as unknown as number } },
      },
    },
    login: { id: "login", name: "Login", models: { m: { id: "m", name: "M", canonical_id: "lab/m", capabilities: { cache: { explicit: { ttl: ["5m"] } } } } } },
    unk: { id: "unk", name: "Unclassified", models: { m: { id: "m", name: "M", capabilities: { cache: { explicit: { ttl: ["5m"] } } } } } },
  };
}

const access: AccessRules = {
  default: "api",
  default_basis: "fixture",
  patterns: [],
  providers: { login: { access: "subscription", basis: "a login" }, unk: { access: "unknown", basis: "not classified" } },
};
const routes = { "lab-api": { provider: "lab" }, "lab-login": { provider: "login" }, "unk-api": { provider: "unk" } };
const LABELS = MeasurementLabels.parse({
  clients: {
    direct: { id: "direct", label: "Requests sent straight to the provider", kind: "direct" },
    "direct-b": { id: "direct-b", label: "Another direct probe", kind: "direct" },
    cliproxyapi: { id: "cliproxyapi", label: "Requests sent through CLIProxyAPI", kind: "proxy" },
    "vendor-cli": { id: "vendor-cli", label: "The vendor's CLI", kind: "own-client" },
  },
});

type Run = ObservedFile["cache"][number];
type Limit = ObservedFile["limits"][number];
const ROUTE_OF: Record<string, string> = { lab: "lab-api", login: "lab-login", unk: "unk-api" };
/** A cache run on `ref`, its checks as [age, warm, total]; the control hit. */
const run = (id: string, ref: string, client: string, checks: [number, number, number][], more: Partial<Run> = {}): Run => {
  const [provider, model] = ref.split("/") as [string, string];
  return { id, route: ROUTE_OF[provider]!, client, model, models_dev: ref, date: "2026-11-10", source: `results/${id}.json`, control: { warm: 1, total: 1 }, checks: checks.map(([age_s, warm, total]) => ({ age_s, warm, total })), latest: true, ...more };
};
const limit = (ref: string, client: string, more: Partial<Limit>): Limit => {
  const [provider, model] = ref.split("/") as [string, string];
  return { route: ROUTE_OF[provider]!, client, model, models_dev: ref, date: "2026-11-12", source: `results/limits-${client}.jsonl`, ...more };
};

/** Every catalog built here: case 9 checks the sentences of 5.1 on each. */
const built: Catalog[] = [];

function build(more: { cache?: Run[]; limits?: Limit[]; overrides?: OverrideFile[]; additions?: AuthoredProvider[]; observed?: Partial<ObservedFile>; upstream?: UpstreamCatalog } = {}): ReturnType<typeof resolve> & { safe: (ref: string) => SafeValues } {
  const observed: ObservedFile = {
    schema: 1, repository: REPO, routes: { "lab-api": "Lab API key", "lab-login": "Lab login", "unk-api": "Unclassified" },
    clients: {}, cache: more.cache ?? [], limits: more.limits ?? [], known: [], ...more.observed,
  };
  const input: ResolveInput = { upstream: more.upstream ?? upstream(), additions: more.additions ?? [], overrides: more.overrides ?? [], access, routes, labels: LABELS, observed, upstreamDate: IMPORT_DATE };
  const result = resolve(input);
  built.push(result.catalog);
  const safe = (ref: string): SafeValues => {
    const at = ref.indexOf("/");
    return ext(result.catalog[ref.slice(0, at)]!.models[ref.slice(at + 1)]!).safe;
  };
  return { ...result, safe };
}
const override = (models: string[], set: Record<string, unknown>, evidence: Evidence[] = [doc("2026-11-09")]): OverrideFile => ({ provider: "lab", rules: [{ models, set: set as never, reason: "a correction", evidence }] });
const brief = (items: SourceValue[]) => items.map((item) => [item.source, item.withheld ? "withheld" : item.value]);

describe("1. the first source that states a value gives it", () => {
  it("models.dev, where nothing else states one", () => {
    const { safe } = build();
    expect(safe("lab/m").input_window).toMatchObject({ value: 900000, unit: "tokens", scope: "input", source: "models.dev", date: IMPORT_DATE, agreement: "single", window_tokens: 1000000 });
    expect(safe("lab/m").max_output).toMatchObject({ value: 64000, source: "models.dev", scope: null, window_tokens: null });
    expect(safe("lab/m").cache_short).toMatchObject({ value: 300, unit: "seconds", source: "models.dev" });
    expect(safe("lab/m").cache_long).toMatchObject({ value: 3600, source: "models.dev" });
    expect(safe("lab/m").price).toMatchObject({ source: "models.dev", date: IMPORT_DATE, agreement: "single", differs: [], sources: [{ source: "models.dev", withheld: false, input: 3, output: 15, cache_read: 0.3, cache_write: null, tiers: [] }] });
  });

  it("providers.dev, before models.dev", () => {
    const { safe } = build({ overrides: [override(["m"], { limit: { input: 800000, output: 32000 }, cost: { text: { input: { price: 2 } } } })] });
    expect(safe("lab/m").input_window).toMatchObject({ value: 800000, source: "providers.dev", date: "2026-11-09", agreement: "differ" });
    expect(brief(safe("lab/m").input_window.sources)).toEqual([["providers.dev", 800000], ["models.dev", 900000]]);
    expect(safe("lab/m").max_output).toMatchObject({ value: 32000, source: "providers.dev", agreement: "differ" });
    expect(safe("lab/m").price).toMatchObject({ source: "providers.dev", agreement: "differ", differs: ["input"] });
  });

  it("measured, before every other", () => {
    const { safe } = build({ cache: [run("d1", "lab/m", "direct", [[300, 3, 3], [450, 0, 3]])], limits: [limit("lab/m", "direct", { input_accepted: 895000, input_refused: 905000, output: 60000 })] });
    expect(safe("lab/m").input_window).toMatchObject({ value: 895000, at_least: true, source: "measured", scope: "input", agreement: "agree" });
    expect(safe("lab/m").max_output).toMatchObject({ value: 60000, source: "measured", agreement: "differ" });
    expect(safe("lab/m").cache_short).toMatchObject({ value: 300, source: "measured", date: "2026-11-10", agreement: "agree" });
  });

  it("nothing: null, no source, none", () => {
    const { safe, catalog } = build();
    for (const quantity of ["input_window", "max_output", "cache_short", "cache_long"] as const) {
      expect(safe("lab/bare")[quantity]).toMatchObject({ value: null, source: null, date: null, agreement: "none", sources: [], at_least: false, scope: null, window_tokens: null });
    }
    expect(safe("lab/bare").price).toEqual({ source: null, date: null, agreement: "none", differs: [], sources: [] });
    expect(ext(catalog.lab!.models.bare!).pricing.rules).toBeNull();
    expect(safe("lab/bare").differing).toEqual([]);
  });
});

describe("2. what states nothing", () => {
  it("a limit of 0 and an absent or null field state nothing; a lifetime of 0 and a listed price of 0 are statements", () => {
    const { safe, catalog } = build();
    expect(safe("lab/zero").input_window).toMatchObject({ value: null, agreement: "none" });
    expect(safe("lab/zero").max_output).toMatchObject({ value: null, agreement: "none" });
    expect(safe("lab/nulls").max_output).toMatchObject({ value: null, agreement: "none" });
    expect(safe("lab/nulls").input_window).toMatchObject({ value: 200000, scope: "window" });
    expect([safe("lab/zero").cache_short.value, safe("lab/zero").cache_long.value, safe("lab/zero").cache_short.source]).toEqual([0, 0, "models.dev"]);
    expect(safe("lab/zero").price).toMatchObject({ source: "models.dev", sources: [{ input: 0, output: 0 }] });
    // The summary's max_output is the safe value: 0 states nothing.
    const index = buildIndex(catalog, "v", "2026-11-20T00:00:00Z", "2026-11-20T00:00:00Z");
    expect(index.entries.find((entry) => entry.ref === "lab/zero")!.max_output).toBeNull();
    expect(index.entries.find((entry) => entry.ref === "lab/m")!.max_output).toBe(64000);
  });
});

describe("3. which measurement counts", () => {
  const held = (minutes: number): [number, number, number][] => [[minutes * 60, 3, 3], [minutes * 60 + 150, 0, 3]];

  it("on an API-key entry, direct; a proxy beside it changes nothing; a proxy or an own client alone gives no measured value", () => {
    const both = build({ cache: [run("d", "lab/m", "direct", held(5)), run("p", "lab/m", "cliproxyapi", [[150, 0, 3]])], limits: [limit("lab/m", "direct", { input_accepted: 895000, input_refused: 905000 }), limit("lab/m", "cliproxyapi", { input_accepted: 500000, input_refused: 510000, output: 1000 })] });
    expect(both.safe("lab/m").cache_short).toMatchObject({ value: 300, source: "measured", sources: [{ client: "direct", client_kind: "direct" }, { source: "models.dev" }] });
    expect(both.safe("lab/m").input_window).toMatchObject({ value: 895000, source: "measured" });
    // An output only the proxy measured: not counted.
    expect(both.safe("lab/m").max_output).toMatchObject({ value: 64000, source: "models.dev" });
    for (const client of ["cliproxyapi", "vendor-cli"]) {
      const alone = build({ cache: [run("x", "lab/m", client, [[150, 0, 3]])], limits: [limit("lab/m", client, { input_accepted: 500000, input_refused: 510000 })] });
      expect(alone.safe("lab/m").cache_short).toMatchObject({ value: 300, source: "models.dev", agreement: "single" });
      expect(alone.safe("lab/m").input_window).toMatchObject({ value: 900000, source: "models.dev", agreement: "single" });
      const lifetime = ext(alone.catalog.lab!.models.m!).cache.lifetime;
      expect([lifetime.short.measured_s, lifetime.short.documented_status, lifetime.lifetimes.find((item) => item.basis === "measured")!.chosen]).toEqual([null, null, false]);
    }
  });

  it("reads access unknown as an API key", () => {
    const { safe } = build({ cache: [run("p", "unk/m", "cliproxyapi", [[150, 0, 3]])] });
    expect(safe("unk/m").cache_short).toMatchObject({ value: 300, source: "models.dev" });
  });

  it("on a login, the vendor's own client wins whichever is lower; else direct; else a proxy; per quantity and per profile", () => {
    const own = build({ cache: [run("v", "login/m", "vendor-cli", [[1800, 3, 3]]), run("p", "login/m", "cliproxyapi", [[150, 0, 3]]), run("pl", "login/m", "cliproxyapi", [[3600, 3, 3]], { options: { ttl: "1h" } })] });
    expect(own.safe("login/m").cache_short).toMatchObject({ value: 1800, source: "measured", sources: [{ client: "vendor-cli", client_kind: "own_client", client_label: "The vendor's CLI" }, { source: "models.dev", value: 300 }] });
    // The long profile: only the proxy measured it, so the proxy counts there.
    expect(own.safe("login/m").cache_long).toMatchObject({ value: 3600, source: "measured", sources: [{ client: "cliproxyapi", client_kind: "proxy" }] });
    const direct = build({ cache: [run("d", "login/m", "direct", held(10)), run("p", "login/m", "cliproxyapi", [[150, 0, 3]])] });
    expect(direct.safe("login/m").cache_short).toMatchObject({ value: 600, sources: [{ client_kind: "direct" }, { source: "models.dev" }] });
    const proxy = build({ cache: [run("p", "login/m", "cliproxyapi", [[150, 0, 3]])], limits: [limit("login/m", "cliproxyapi", { context: 1000000, output: 32000 })] });
    expect(proxy.safe("login/m").cache_short).toMatchObject({ value: 0, sources: [{ client_kind: "proxy", below: 150 }, { source: "models.dev" }], agreement: "differ" });
    expect(proxy.safe("login/m").input_window).toMatchObject({ value: 1000000, scope: "window", source: "measured", sources: [{ client_kind: "proxy", evaluation_id: null }] });
    expect(proxy.safe("login/m").max_output).toMatchObject({ value: 32000, source: "measured", sources: [{ client_kind: "proxy" }] });
  });

  it("within the kind, the lowest, of several evaluations and clients; the statement names the evaluation", () => {
    const { safe } = build({ cache: [run("a", "lab/m", "direct", held(10)), run("b", "lab/m", "direct-b", held(5), { date: "2026-11-08" }), run("c", "lab/m", "direct", held(20))] });
    expect(safe("lab/m").cache_short.sources[0]).toEqual({
      source: "measured", value: 300, withheld: false, at_least: false, below: 450, scope: null, date: "2026-11-08",
      evidence_url: `${REPO}/blob/main/results/b.json`, client: "direct-b", client_label: "Another direct probe", client_kind: "direct", evaluation_id: "b",
    });
  });

  it("names the newest among equal values, then the first by id", () => {
    const { safe } = build({ cache: [run("z", "lab/m", "direct", held(5), { date: "2026-11-01" }), run("y", "lab/m", "direct", held(5), { date: "2026-11-05" }), run("x", "lab/m", "direct", held(5), { date: "2026-11-05" })] });
    expect(safe("lab/m").cache_short.sources[0]).toMatchObject({ evaluation_id: "x", date: "2026-11-05" });
  });

  it("feeds nothing with a client that has no kind", () => {
    const { safe, issues, catalog } = build({ cache: [run("m", "lab/m", "mystery", [[150, 0, 3]])] });
    expect(safe("lab/m").cache_short).toMatchObject({ value: 300, source: "models.dev" });
    expect(ext(catalog.lab!.models.m!).cache.evaluations[0]).toMatchObject({ client: "other", client_kind: null });
    expect(issues).toContainEqual(expect.objectContaining({ code: "unmapped-client", target: "mystery" }));
  });

  it("a bracket gives at_least and below; a lower bound under a larger stated value is the safe value, and agrees", () => {
    const { safe } = build({ limits: [limit("lab/m", "direct", { input_accepted: 600000, input_refused: 1000000 })] });
    expect(safe("lab/m").input_window).toMatchObject({ value: 600000, at_least: true, scope: "input", source: "measured", agreement: "agree", window_tokens: 1000000 });
    expect(safe("lab/m").input_window.sources[0]).toMatchObject({ at_least: true, below: 1000000 });
  });

  it("countingKind: the first kind of the entry's order among those that gave a value", () => {
    expect(countingKind("api", ["proxy", "own_client"])).toBeNull();
    expect(countingKind("unknown", ["proxy", "direct"])).toBe("direct");
    expect(countingKind("subscription", ["proxy", "direct", "own_client"])).toBe("own_client");
    expect(countingKind("subscription", ["proxy", "direct", null])).toBe("direct");
    expect(countingKind("subscription", ["proxy", null])).toBe("proxy");
    expect(countingKind("subscription", [null])).toBeNull();
  });
});

describe("4. the refinement of the input window", () => {
  it("a named window above a stated cap gives the cap, models.dev, agree", () => {
    const { safe } = build({ limits: [limit("lab/m", "direct", { context: 1000000 })] });
    expect(safe("lab/m").input_window).toMatchObject({ value: 900000, scope: "input", source: "models.dev", agreement: "agree", window_tokens: 1000000 });
    expect(brief(safe("lab/m").input_window.sources)).toEqual([["measured", 1000000], ["models.dev", 900000]]);
  });

  it("a named window below a stated cap gives the window, differ", () => {
    const { safe } = build({ limits: [limit("lab/m", "direct", { context: 850000 })] });
    expect(safe("lab/m").input_window).toMatchObject({ value: 850000, scope: "window", source: "measured", agreement: "differ", window_tokens: 1000000 });
  });
});

describe("5. agreement, one case per row of 2.5, both ways", () => {
  const value = (source: SourceValue["source"], v: number | null, more: Partial<SourceValue> = {}): SourceValue => ({
    source, value: v, withheld: false, at_least: false, below: null, scope: null, date: null, evidence_url: null, client: null, client_label: null, client_kind: null, evaluation_id: null, ...more,
  });
  const agreement = (quantity: Parameters<typeof safeNumber>[0], items: SourceValue[], chosen: InputWindowMeasurement[] = []) => {
    const forward = safeNumber(quantity, items, chosen).agreement;
    expect(safeNumber(quantity, [...items].reverse(), chosen).agreement).toBe(forward);
    return forward;
  };
  const item = (more: Parameters<typeof limitOf>[0]): InputWindowMeasurement => ({ ...windowMeasurement(limitOf(more))!, chosen: true });

  it("two stated numbers: equal or not", () => {
    expect(agreement("max_output", [value("models.dev", 64000), value("providers.dev", 64000)])).toBe("agree");
    expect(agreement("max_output", [value("models.dev", 64000), value("providers.dev", 32000)])).toBe("differ");
    expect(agreement("max_output", [value("models.dev", 64000)])).toBe("single");
    expect(agreement("max_output", [])).toBe("none");
  });

  it("two windows of one scope; a cap and a window", () => {
    expect(agreement("input_window", [value("models.dev", 1000000, { scope: "window" }), value("providers.dev", 1048576, { scope: "window" })])).toBe("differ");
    expect(agreement("input_window", [value("models.dev", 922000, { scope: "input" }), value("providers.dev", 1050000, { scope: "window" })])).toBe("agree");
    expect(agreement("input_window", [value("models.dev", 1100000, { scope: "input" }), value("providers.dev", 1050000, { scope: "window" })])).toBe("differ");
  });

  it("a measured input window and a stated one: the test of 4.2, over the chosen evaluations", () => {
    const stated = value("models.dev", 922000, { scope: "input" });
    const measured = (chosen: InputWindowMeasurement) => value("measured", chosen.tokens, { scope: chosen.kind === "window" ? "window" : "input", at_least: chosen.bound === "at_least" });
    const below = item({ input_accepted: 600000, input_refused: 1000000 });
    expect(agreement("input_window", [measured(below), stated], [below])).toBe("agree");
    const refused = item({ input_accepted: 900000, input_refused: 912780 });
    expect(agreement("input_window", [measured(refused), stated], [refused])).toBe("differ");
    const accepted = item({ input_accepted: 931220, input_read: 931220 });
    expect(agreement("input_window", [measured(accepted), stated], [accepted])).toBe("differ");
    const named = item({ context: 900000 });
    expect(agreement("input_window", [measured(named), stated], [named])).toBe("differ");
    const other = item({ context: 1048576 });
    expect(agreement("input_window", [measured(other), value("models.dev", 1000000, { scope: "window" })], [other])).toBe("differ");
  });

  it("a measured lifetime m with first miss f and a stated S: S < m, S ≥ f contradict; m ≤ S < f and no miss above m do not", () => {
    const m = (v: number, f: number | null) => value("measured", v, { below: f });
    expect(agreement("cache_short", [m(600, 900), value("models.dev", 300)])).toBe("differ");
    expect(agreement("cache_short", [m(300, 450), value("models.dev", 1800)])).toBe("differ");
    expect(agreement("cache_short", [m(1800, 3900), value("models.dev", 3600)])).toBe("agree");
    expect(agreement("cache_short", [m(300, null), value("models.dev", 3600)])).toBe("agree");
    expect(agreement("cache_short", [m(300, null), value("models.dev", 300)])).toBe("agree");
    expect(agreement("cache_long", [m(0, 0), value("models.dev", 0)])).toBe("differ");
  });

  it("withholding contradicts every later stated value; a measurement contradicts no withheld one", () => {
    const withheld = value("providers.dev", null, { withheld: true });
    expect(agreement("cache_short", [withheld, value("models.dev", 300)])).toBe("differ");
    expect(agreement("cache_short", [value("measured", 300), withheld])).toBe("agree");
    expect(agreement("cache_short", [value("measured", 300), withheld, value("models.dev", 300)])).toBe("differ");
  });
});

describe("6. withheld", () => {
  for (const [name, ttl] of [["null", null], ['"$delete"', "$delete"]] as const) {
    it(`an override of ${name}: unknown on purpose, providers.dev, differ beside models.dev's value`, () => {
      const { safe } = build({ overrides: [override(["m"], { capabilities: { cache: { explicit: { ttl } } } }, [doc("2026-11-17", "https://example.com/retention")])] });
      for (const quantity of ["cache_short", "cache_long"] as const) {
        expect(safe("lab/m")[quantity]).toMatchObject({ value: null, source: "providers.dev", date: "2026-11-17", agreement: "differ" });
        expect(safe("lab/m")[quantity].sources[0]).toMatchObject({ source: "providers.dev", withheld: true, value: null, evidence_url: "https://example.com/retention" });
      }
      expect(safe("lab/m").differing).toEqual(["cache_short", "cache_long"]);
    });
  }

  it("with a measurement, the measurement is the safe value, and does not contradict the withheld one", () => {
    const { safe, catalog } = build({ cache: [run("d", "lab/m", "direct", [[300, 3, 3]])], overrides: [override(["m"], { capabilities: { cache: { explicit: { ttl: null } } } })] });
    expect(safe("lab/m").cache_short).toMatchObject({ value: 300, source: "measured", agreement: "differ" });
    expect(brief(safe("lab/m").cache_short.sources)).toEqual([["measured", 300], ["providers.dev", "withheld"], ["models.dev", 300]]);
    expect(ext(catalog.lab!.models.m!).cache.lifetime.short).toMatchObject({ safe_s: 300, basis: "measured", source: "providers.dev" });
    expect(ext(catalog.lab!.models.m!).cache.lifetime.long).toMatchObject({ safe_s: null, basis: "none", source: null });
  });

  it("a withheld price leaves pricing unknown", () => {
    const { safe, catalog } = build({ overrides: [override(["m"], { cost: null })] });
    expect(safe("lab/m").price).toMatchObject({ source: "providers.dev", agreement: "differ", sources: [{ source: "providers.dev", withheld: true, input: null }, { source: "models.dev", input: 3 }] });
    expect(ext(catalog.lab!.models.m!).pricing.rules).toBeNull();
  });
});

describe("7. what providers.dev states", () => {
  it("a correction that changes the reading states; one of another field or a redundant one states nothing", () => {
    const other = build({ overrides: [override(["m"], { limit: { output: 32000 } })] });
    expect(brief(other.safe("lab/m").input_window.sources)).toEqual([["models.dev", 900000]]);
    expect(brief(other.safe("lab/m").max_output.sources)).toEqual([["providers.dev", 32000], ["models.dev", 64000]]);
    const redundant = build({ overrides: [override(["m"], { limit: { input: 900000 } })] });
    expect(brief(redundant.safe("lab/m").input_window.sources)).toEqual([["models.dev", 900000]]);
    expect(redundant.issues).toContainEqual(expect.objectContaining({ code: "redundant-override" }));
    const ownCache = build({ overrides: [override(["m"], { capabilities: { cache: { explicit: { min_tokens: 1024 } } } })] });
    expect(brief(ownCache.safe("lab/m").cache_short.sources)).toEqual([["models.dev", 300]]);
  });

  it("dates a statement by the newest evidence of the corrections that touch the fields read, with its address", () => {
    const { safe } = build({ overrides: [
      override(["m"], { limit: { input: 800000 } }, [doc("2026-11-03", "https://example.com/a"), doc("2026-11-09", "https://example.com/b")]),
      override(["m"], { capabilities: { cache: { explicit: { ttl: ["10m", "1h"] } } } }, [doc("2026-11-11", "https://example.com/c")]),
    ] });
    expect(safe("lab/m").input_window.sources[0]).toMatchObject({ source: "providers.dev", value: 800000, date: "2026-11-09", evidence_url: "https://example.com/b" });
    expect(safe("lab/m").cache_short.sources[0]).toMatchObject({ source: "providers.dev", value: 600, date: "2026-11-11", evidence_url: "https://example.com/c" });
    expect(brief(safe("lab/m").cache_long.sources)).toEqual([["models.dev", 3600]]);
  });

  it("an entry providers.dev adds states its own values, dated by its evidence; models.dev states nothing of it", () => {
    const added: AuthoredProvider = {
      id: "added", name: "Added", access: "api", access_basis: "fixture", evidence: [doc("2026-11-01")],
      models: [{ id: "x", fields: { limit: { context: 64000, output: 8000 }, cost: { text: { input: { price: 1 }, output: { price: 2 } } } }, evidence: [doc("2026-11-05", "https://example.com/x"), { kind: "listed", url: "https://example.com/list", date: "2026-11-07" }] }],
    };
    const { safe } = build({ additions: [added] });
    expect(safe("added/x").input_window).toMatchObject({ value: 64000, scope: "window", source: "providers.dev", agreement: "single", date: "2026-11-07", sources: [{ evidence_url: "https://example.com/list" }] });
    expect(safe("added/x").max_output).toMatchObject({ value: 8000, source: "providers.dev" });
    // The price's evidence is what it rests on, never a model list.
    expect(safe("added/x").price).toMatchObject({ source: "providers.dev", date: "2026-11-05", sources: [{ input: 1, output: 2, evidence_url: "https://example.com/x" }] });
  });
});

describe("8. the price", () => {
  it("is taken whole from one source: a part it lacks is never filled from another", () => {
    const { safe, catalog } = build({ overrides: [override(["m"], { cost: { text: { input: { cache: "$delete" } } } })] });
    expect(safe("lab/m").price).toMatchObject({ source: "providers.dev", agreement: "agree", differs: [] });
    expect(safe("lab/m").price.sources.map((item) => [item.source, item.cache_read])).toEqual([["providers.dev", null], ["models.dev", 0.3]]);
    expect(ext(catalog.lab!.models.m!).pricing.rules!.some((rule) => rule.meter === "text.cache_read")).toBe(false);
  });

  it("a correction of one price: providers.dev's whole price, models.dev's uncorrected beside it, differs naming the part", () => {
    const { safe, catalog } = build({ overrides: [override(["m"], { cost: { text: { output: { price: 12 } } } })] });
    expect(safe("lab/m").price).toMatchObject({ source: "providers.dev", date: "2026-11-09", agreement: "differ", differs: ["output"] });
    expect(safe("lab/m").price.sources.map((item) => [item.source, item.input, item.output])).toEqual([["providers.dev", 3, 12], ["models.dev", 3, 15]]);
    expect(priceParts(ext(catalog.lab!.models.m!).pricing)).toMatchObject({ input: 3, output: 12 });
  });

  it("a subscription entry carries the statements of the API entry it refers to", () => {
    const plain = build();
    expect(ext(plain.catalog.login!.models.m!).pricing).toMatchObject({ billing: "reference", reference_ref: "lab/m" });
    expect(plain.safe("login/m").price).toEqual(plain.safe("lab/m").price);
    const corrected = build({ overrides: [override(["m"], { cost: { text: { output: { price: 12 } } } })] });
    expect(corrected.safe("login/m").price).toMatchObject({ source: "providers.dev", differs: ["output"] });
  });

  it("priceParts reads base prices, tiers and the rest", () => {
    const pricing = pricingOf({ cost: { text: {
      input: { price: 3, cache: { read: 0.3, write: { "5m": 3.75, "1h": 6 } }, overrides: [{ when: { context: { gt: 200000 } }, price: 6, cache: { read: 0.6 } }] },
      output: { price: 15, overrides: [{ when: { context: { gte: 200001 } }, price: 22.5 }, { when: { service_tier: { equals: "priority" } }, price: 30 }] },
    } } }, "api", null, []);
    const parts = priceParts(pricing)!;
    expect([parts.input, parts.output, parts.cache_read, parts.cache_write]).toEqual([3, 15, 0.3, null]);
    expect(parts.tiers).toEqual([{ input_tokens_above: 200000, input: 6, output: 22.5, cache_read: 0.6, cache_write: null }]);
    // The write prices keyed by lifetime and the priority rate are the rest of the price.
    expect((parts.other as { meter: string }[]).map((rule) => rule.meter)).toEqual(["text.cache_write", "text.cache_write", "text.output"]);
    expect(priceParts(pricingOf({}, "api", null, []))).toBeNull();
    // A tier whose threshold is not a whole number cannot be read as tiers.
    expect(priceParts(pricingOf({ cost: { text: { input: { price: 1, overrides: [{ when: { context: { gt: 1.5 } }, price: 2 }] } } } }, "api", null, []))!.tiers).toBeNull();
  });
});

describe("the kind of a client, from the measurements file or the labels file", () => {
  const cache = [run("c", "lab/m", "cliproxyapi", [[300, 3, 3], [450, 0, 3]])];

  it("takes the file's kind in client_kinds or in a client's object, and says where the labels file differs", () => {
    for (const observed of [{ client_kinds: { cliproxyapi: "direct" } }, { clients: { cliproxyapi: { kind: "direct", note: "plain requests" } } }] as Partial<ObservedFile>[]) {
      const { safe, issues, catalog } = build({ cache, observed });
      expect(ext(catalog.lab!.models.m!).cache.evaluations[0]!.client_kind).toBe("direct");
      expect(safe("lab/m").cache_short).toMatchObject({ value: 300, source: "measured", sources: [{ client: "cliproxyapi", client_kind: "direct" }, { source: "models.dev" }] });
      expect(issues.filter((issue) => issue.code === "client-kind-differs")).toEqual([expect.objectContaining({ level: "warning", target: "cliproxyapi" })]);
    }
  });

  it("is the labels file's where the measurements file states none, and no warning where both agree", () => {
    const agreeing = build({ cache, observed: { client_kinds: { cliproxyapi: "proxy" } } });
    expect(agreeing.issues.filter((issue) => issue.code === "client-kind-differs")).toEqual([]);
    expect(ext(agreeing.catalog.lab!.models.m!).cache.evaluations[0]!.client_kind).toBe("proxy");
    const silent = build({ cache, observed: { clients: { cliproxyapi: "plain requests through CLIProxyAPI" } } });
    expect(ext(silent.catalog.lab!.models.m!).cache.evaluations[0]!.client_kind).toBe("proxy");
  });

  it("reads both forms of the measurements file, own_client and own-client alike, and refuses another kind", () => {
    const base = { schema: 1, repository: REPO, routes: {}, cache: [] };
    expect(ObservedFile.safeParse({ ...base, clients: { a: "text" } }).success).toBe(true);
    const parsed = ObservedFile.parse({ ...base, clients: { a: { kind: "own-client" }, b: "text" }, client_kinds: { b: "own_client" }, route_kinds: { r: "login" } });
    expect([parsed.clients.a, parsed.client_kinds]).toEqual([{ kind: "own_client" }, { b: "own_client" }]);
    expect(ObservedFile.safeParse({ ...base, clients: {}, client_kinds: { a: "vendor" } }).success).toBe(false);
    expect(ObservedFile.safeParse({ ...base, clients: {}, route_kinds: { r: "token" } }).success).toBe(false);
  });

  it("is required in the labels file, one per public id", () => {
    expect(MeasurementLabels.safeParse({ clients: { a: { id: "a", label: "A" } } }).success).toBe(false);
    const two = MeasurementLabels.safeParse({ clients: { a: { id: "x", label: "X", kind: "direct" }, b: { id: "x", label: "X", kind: "proxy" } } });
    expect(two.success).toBe(false);
    expect(two.error!.issues[0]!.message).toMatch(/Public client id "x" has two kinds/);
    expect(MeasurementLabels.parse({ clients: { a: { id: "a", label: "A", kind: "own-client" } } }).clients.a!.kind).toBe("own_client");
  });
});

describe("9. what always holds, over every entry built here", () => {
  it("keeps the ten sentences of 5.1 and the copies of 5.2", () => {
    build({ cache: [run("d", "lab/m", "direct", [[300, 3, 3], [450, 0, 3]]), run("p", "login/m", "cliproxyapi", [[150, 0, 3]]), run("v", "login/m", "vendor-cli", [[1800, 3, 3]])], limits: [limit("lab/m", "direct", { context: 1000000, output: 60000 }), limit("login/m", "cliproxyapi", { input_accepted: 900000, input_refused: 910000 })] });
    expect(built.length).toBeGreaterThan(20);
    expect(built.flatMap((catalog) => safeBreaks(catalog))).toEqual([]);
  });

  it("finds a broken sentence", () => {
    const { catalog } = build({ cache: [run("d", "lab/m", "direct", [[300, 3, 3], [450, 0, 3]])] });
    const extension = ext(catalog.lab!.models.m!);
    extension.safe.cache_short.agreement = "differ";
    extension.cache.lifetime.short.safe_s = 301;
    extension.limits.input_window.measurements.forEach((item) => (item.chosen = true));
    expect(safeBreaks(catalog)).toEqual(expect.arrayContaining(["lab/m: cache_short 5 agreement", "lab/m: 5.2 short"]));
  });
});
