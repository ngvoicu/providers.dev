import { describe, expect, it } from "vitest";
import { clone } from "../src/core/merge.ts";
import { summarize } from "../src/core/entries.ts";
import { resolve, type ResolveInput } from "../src/core/resolve.ts";
import { OverrideFile as OverrideFileSchema, ext, providerExt, type AccessRules, type AuthoredProvider, type Evidence, type ObservedFile, type OverrideFile, type UpstreamCatalog } from "../src/core/schema.ts";

const evidence: Evidence[] = [{ kind: "documented", url: "https://example.com/docs", date: "2026-11-01" }];

const access: AccessRules = {
  default: "api",
  default_basis: "default",
  patterns: [{ match: "-coding-plan$", access: "subscription", basis: "by name" }],
  providers: {},
};

function upstream(): UpstreamCatalog {
  return {
    lab: {
      id: "lab",
      name: "Lab",
      models: {
        "model-a": {
          id: "model-a",
          name: "Model A",
          family: "a",
          limit: { context: 200000, output: 64000 },
          capabilities: { temperature: true },
        },
        "model-b": { id: "model-b", name: "Model B", limit: { context: 100000, output: 8000 } },
      },
    },
    "lab-coding-plan": { id: "lab-coding-plan", name: "Lab plan", models: { "model-a": { id: "model-a", name: "Model A" } } },
  };
}

function input(overrides: OverrideFile[] = [], more: Partial<ResolveInput> = {}): ResolveInput {
  return { upstream: upstream(), additions: [], overrides, access, routes: {}, ...more };
}

const contextOverride: OverrideFile = {
  provider: "lab",
  rules: [{ models: ["model-a"], set: { limit: { context: 1000000 } }, reason: "documented higher", evidence }],
};

describe("resolve: overrides", () => {
  it("keeps authored and override sources for unsupported caching", () => {
    const added: AuthoredProvider = {
      id: "added", name: "Added", access: "api", access_basis: "Fixture", evidence,
      models: [{ id: "model-a", fields: { capabilities: { cache: false } }, evidence }],
    };
    const override: OverrideFile = { provider: "lab", rules: [{ models: ["model-a"], set: { capabilities: { cache: { implicit: false, explicit: false } } }, reason: "Explicitly unsupported", evidence }] };
    const { catalog } = resolve(input([override], { additions: [added], upstreamDate: "2026-11-13" }));
    const authored = ext(catalog.added!.models["model-a"]!).cache.retention;
    expect(authored).toMatchObject({ support: "unsupported", evidence: [{ url: evidence[0]!.url, date: evidence[0]!.date }] });
    expect(authored.evidence.some((source) => source.url === "https://models.dev")).toBe(false);
    const corrected = ext(catalog.lab!.models["model-a"]!).cache.retention;
    expect(corrected.support).toBe("unsupported");
    expect(corrected.evidence.some((source) => source.url === evidence[0]!.url)).toBe(true);
    expect(corrected.evidence.some((source) => source.note.includes("capabilities.cache is false"))).toBe(false);
  });

  it("publishes sourced retention declarations only on the named entry", () => {
    const declaration = {
      support: "supported", parameter: { name: "cache_control.ttl", location: "Cache marker" },
      accepted_values: ["5m", "1h"], default: "5m", profiles: [{ profile: "short", value: "5m" }, { profile: "long", value: "1h" }],
      conditions: ["Fixture protocol only"], evidence: [{ kind: "documented", url: "https://example.com/retention", date: "2026-11-14", note: "The fixture documentation confirms this parameter and these values." }],
    };
    const override = OverrideFileSchema.parse({ provider: "lab", rules: [{ models: ["model-a"], cache_retention: declaration, reason: "Confirmed parameter", evidence }] });
    const { catalog } = resolve(input([override]));
    const model = catalog.lab!.models["model-a"]!;
    expect(ext(model).cache.retention).toEqual(declaration);
    expect(summarize("lab", model, 0)).toMatchObject({ cache_retention: "supported", origin: "modified", verified: "2026-11-14" });
    expect(ext(catalog.lab!.models["model-b"]!).cache.retention.support).toBe("unknown");
    expect(ext(catalog["lab-coding-plan"]!.models["model-a"]!).cache.retention.support).toBe("unknown");
    const withoutEvidence = { ...declaration, evidence: [] };
    expect(OverrideFileSchema.safeParse({ provider: "lab", rules: [{ models: ["model-a"], cache_retention: withoutEvidence, reason: "No source", evidence }] }).success).toBe(false);
  });

  it("applies a provider-wide control to every entry that documents the lifetimes, without marking them", () => {
    const source = { kind: "documented" as const, url: "https://example.com/api-reference", date: "2026-11-14", note: "The reference names the field and its values." };
    const control = {
      id: "cache.retention", support: "supported", when: null,
      bindings: [{ location: "body", path: "/cache_control/ttl", scope: "content_block" }],
      options: [
        // Leaving the field out is the short profile here: the source documents no value for it.
        { value: null, attributes: { retention_s: 300, profile: "short" }, settings: [{ location: "body", path: "/cache_control/type", scope: "content_block", value: "ephemeral" }], when: null },
        { value: "1h", attributes: { retention_s: 3600, profile: "long" }, settings: null, when: null },
      ],
      default: { value: "5m" }, conditions: [], evidence: [source],
    };
    const documented = upstream();
    documented.lab!.models["model-a"]!.capabilities = { cache: { explicit: { ttl: ["5m", "1h"] } } };
    documented.lab!.models["model-b"]!.capabilities = { cache: { explicit: { ttl: ["5m"] } } };
    documented.lab!.models["model-c"] = { id: "model-c", name: "Model C", capabilities: { cache: { implicit: { ttl: ["5m", "1h"] } } } };
    const rule = { select: { cache_mode: "explicit", cache_ttl: ["5m", "1h"] }, request_controls: [control], reason: "The provider documents the field", evidence };
    const { catalog, issues } = resolve(input([OverrideFileSchema.parse({ provider: "lab", rules: [rule] })], { upstream: documented }));
    const a = catalog.lab!.models["model-a"]!;
    // The entry that documents both lifetimes for that mode gets the control, and the flat cache record says the same.
    expect(ext(a).request_controls.items.find((item) => item.id === "cache.retention")).toMatchObject({ support: "supported", bindings: control.bindings, evidence: [source] });
    expect(ext(a).cache.retention).toEqual({
      support: "supported", parameter: { name: "cache_control.ttl", location: "Request body, on a content block" }, accepted_values: ["1h"], default: "5m",
      profiles: [{ profile: "short", value: null }, { profile: "long", value: "1h" }], conditions: [], evidence: [source],
    });
    // It is a statement about the provider's API, not evidence about the entry: the entry stays as imported.
    expect(summarize("lab", a, 0)).toMatchObject({ cache_retention: "supported", origin: "upstream", verified: null });
    expect(ext(a).evidence).toEqual([]);
    // One lifetime only, the lifetimes under the other mode, or another provider: not selected.
    for (const model of [catalog.lab!.models["model-b"]!, catalog.lab!.models["model-c"]!, catalog["lab-coding-plan"]!.models["model-a"]!]) expect(ext(model).cache.retention.support).toBe("unknown");
    expect(issues).toEqual([]);

    // A rule that names the entry wins over the selection, and that one is evidence about the entry.
    const own = { ...control, options: [{ value: "5m", attributes: { profile: "short" }, settings: null, when: null }], default: { value: "5m" } };
    const both = resolve(input([OverrideFileSchema.parse({ provider: "lab", rules: [rule, { models: ["model-a"], request_controls: [own], reason: "Checked for this model", evidence }] })], { upstream: documented }));
    expect(ext(both.catalog.lab!.models["model-a"]!).cache.retention.accepted_values).toEqual(["5m"]);
    expect(summarize("lab", both.catalog.lab!.models["model-a"]!, 0)).toMatchObject({ origin: "modified", verified: "2026-11-14" });
    // The same source is listed once.
    expect(ext(both.catalog.lab!.models["model-a"]!).evidence).toEqual([source]);

    // A selection that finds nothing is reported, so that a stale rule is seen.
    const none = resolve(input([OverrideFileSchema.parse({ provider: "lab", rules: [{ ...rule, select: { cache_mode: "explicit", cache_ttl: ["30m", "12h"] } }] })], { upstream: documented }));
    expect(none.issues).toEqual([expect.objectContaining({ level: "warning", code: "orphan-override", target: "lab#select" })]);

    // A selection declares controls and nothing else, and a rule has `models` or `select`, never both or neither.
    const invalid = (more: object) => OverrideFileSchema.safeParse({ provider: "lab", rules: [{ reason: "r", evidence, ...more }] }).success;
    expect(invalid({ select: rule.select, request_controls: [control] })).toBe(true);
    expect(invalid({ select: rule.select, request_controls: [control], set: { limit: { context: 1 } } })).toBe(false);
    expect(invalid({ select: rule.select })).toBe(false);
    expect(invalid({ select: rule.select, models: ["model-a"], request_controls: [control] })).toBe(false);
    expect(invalid({ request_controls: [control] })).toBe(false);
  });

  it("publishes our value for an overridden field and upstream for the rest", () => {
    const { catalog } = resolve(input([contextOverride]));
    const model = catalog.lab?.models["model-a"];
    expect(model?.limit).toEqual({ context: 1000000, output: 64000 });
    // A published correction has every key, and so has its evidence: the note is null where none was written.
    expect(ext(model!).provenance).toEqual([
      { path: "limit.context", op: "set", had_upstream: true, upstream: 200000, value: 1000000, reason: "documented higher", evidence: evidence.map((source) => ({ ...source, note: null })) },
    ]);
    expect(catalog.lab?.models["model-b"]?.limit).toEqual({ context: 100000, output: 8000 });
    expect(ext(catalog.lab!.models["model-b"]!).provenance).toEqual([]);
  });

  it("keeps our value when upstream changes that field, and follows upstream on the others", () => {
    const changed = upstream();
    changed.lab!.models["model-a"]!.limit = { context: 400000, output: 128000 };
    const { catalog } = resolve({ ...input([contextOverride]), upstream: changed });
    expect(catalog.lab?.models["model-a"]?.limit).toEqual({ context: 1000000, output: 128000 });
    expect(ext(catalog.lab!.models["model-a"]!).provenance?.[0]?.upstream).toBe(400000);
  });

  it("shows upstream again when the override is removed", () => {
    const { catalog } = resolve(input([]));
    expect(catalog.lab?.models["model-a"]?.limit).toEqual({ context: 200000, output: 64000 });
    expect(ext(catalog.lab!.models["model-a"]!).provenance).toEqual([]);
  });

  it("publishes false and zero, hides an unknown, and removes a deletion", () => {
    const { catalog } = resolve(
      input([
        {
          provider: "lab",
          rules: [
            { models: ["model-a"], set: { capabilities: { temperature: false }, limit: { output: 0, context: null } }, reason: "r", evidence },
            { models: ["model-b"], set: { limit: { output: "$delete" } }, reason: "r", evidence },
          ],
        },
      ]),
    );
    const a = catalog.lab!.models["model-a"]!;
    expect(a.capabilities).toEqual({ temperature: false });
    expect(a.limit).toEqual({ output: 0 });
    expect(ext(a).provenance?.map((change) => [change.path, change.op])).toEqual([
      ["capabilities.temperature", "set"],
      ["limit.output", "set"],
      ["limit.context", "unknown"],
    ]);
    const b = catalog.lab!.models["model-b"]!;
    expect(b.limit).toEqual({ context: 100000 });
    expect(ext(b).provenance?.[0]).toMatchObject({ path: "limit.output", op: "delete", upstream: 8000 });
  });

  it("flags an override whose entry disappeared upstream and does not recreate the entry", () => {
    const gone = upstream();
    delete gone.lab!.models["model-a"];
    const { catalog, issues } = resolve({ ...input([contextOverride]), upstream: gone });
    expect(catalog.lab?.models["model-a"]).toBeUndefined();
    expect(issues).toEqual([expect.objectContaining({ level: "warning", code: "orphan-override", target: "lab/model-a" })]);

    const noProvider = resolve({ ...input([{ provider: "vanished", rules: [] }]) });
    expect(noProvider.catalog.vanished).toBeUndefined();
    expect(noProvider.issues[0]).toMatchObject({ code: "orphan-override", target: "vanished" });
  });

  it("reports an override that upstream has caught up with", () => {
    const { catalog, issues } = resolve(
      input([{ provider: "lab", rules: [{ models: ["model-a"], set: { limit: { context: 200000 } }, reason: "r", evidence }] }]),
    );
    expect(issues).toEqual([expect.objectContaining({ level: "notice", code: "redundant-override", target: "lab/model-a#limit.context" })]);
    expect(ext(catalog.lab!.models["model-a"]!).provenance).toEqual([]);
  });

  it("removes excluded models and providers and lists them", () => {
    const { catalog, exclusions } = resolve(
      input([
        { provider: "lab", rules: [{ models: ["model-b"], exclude: true, reason: "retired", evidence }] },
        { provider: "lab-coding-plan", exclude: { reason: "closed", evidence }, rules: [] },
      ]),
    );
    expect(Object.keys(catalog)).toEqual(["lab"]);
    expect(Object.keys(catalog.lab!.models)).toEqual(["model-a"]);
    expect(exclusions.map((item) => item.target)).toEqual(["lab/model-b", "lab-coding-plan"]);
  });

  it("refuses to override reserved fields", () => {
    const { issues } = resolve(input([{ provider: "lab", rules: [{ models: ["model-a"], set: { id: "other" }, reason: "r", evidence }] }]));
    expect(issues[0]).toMatchObject({ level: "error", code: "reserved-field" });
  });

  it("is deterministic and leaves its input untouched", () => {
    const first = input([contextOverride]);
    const snapshot = JSON.stringify(first);
    expect(JSON.stringify(resolve(first))).toBe(JSON.stringify(resolve(clone(first))));
    expect(JSON.stringify(first)).toBe(snapshot);
  });
});

describe("resolve: access and additions", () => {
  it("classifies access by name, pattern, then default, and never calls a default reviewed", () => {
    const { catalog } = resolve(input());
    expect(providerExt(catalog.lab!)).toMatchObject({ origin: "upstream", access: "api", access_reviewed: false });
    expect(providerExt(catalog["lab-coding-plan"]!)).toMatchObject({ access: "subscription", access_reviewed: false });
    expect(ext(catalog["lab-coding-plan"]!.models["model-a"]!).access).toBe("subscription");
  });

  it("adds a provider and inherits identity only", () => {
    const { catalog } = resolve(
      input([], {
        additions: [
          {
            id: "lab-login",
            name: "Lab login",
            access: "subscription",
            access_basis: "a login",
            evidence,
            models: [{ id: "a", inherits: "lab/model-a", evidence }],
          },
        ],
      }),
    );
    const model = catalog["lab-login"]!.models.a!;
    expect(model).toMatchObject({ id: "a", name: "Model A", family: "a", canonical_id: "lab/model-a" });
    expect(model.limit).toBeUndefined();
    expect(model.capabilities).toBeUndefined();
    expect(ext(model)).toMatchObject({ origin: "added", access: "subscription", inherited: { from: "lab/model-a" }, verified: "2026-11-01" });
  });

  it("gives an added subscription entry the API list price, marked as inherited", () => {
    const cost = { text: { input: { price: 4, cache: { read: 0.4 } }, output: { price: 20 } } };
    const priced = upstream();
    priced.lab!.models["model-a"]!.cost = cost;
    priced["lab-coding-plan"]!.models["model-a"]!.cost = { text: { input: { price: 0 }, output: { price: 0 } } };
    const login = (accessMethod: "subscription" | "api", models: AuthoredProvider["models"]): AuthoredProvider => ({
      id: `lab-${accessMethod}`,
      name: "Lab other",
      access: accessMethod,
      access_basis: "stated",
      evidence,
      models,
    });
    const { catalog } = resolve(
      input(
        // A correction to the API price is carried too: the price is taken after the overrides.
        [{ provider: "lab", rules: [{ models: ["model-a"], set: { cost: { text: { output: { price: 25 } } } }, reason: "price list", evidence }] }],
        {
          upstream: priced,
          additions: [
            login("subscription", [
              { id: "a", inherits: "lab/model-a", evidence },
              { id: "own", inherits: "lab/model-a", fields: { cost: { text: { input: { price: 1 }, output: { price: 2 } } } }, evidence },
              { id: "from-plan", inherits: "lab-coding-plan/model-a", evidence },
              { id: "unpriced", inherits: "lab/model-b", evidence },
              { id: "alone", evidence },
            ]),
            login("api", [{ id: "a", inherits: "lab/model-a", evidence }]),
          ],
        },
      ),
    );
    const models = catalog["lab-subscription"]!.models;
    expect(models.a!.cost).toEqual({ text: { input: { price: 4, cache: { read: 0.4 } }, output: { price: 25 } } });
    expect(ext(models.a!).inherited?.fields).toContain("cost");
    expect(summarize("lab-subscription", models.a!, 0)).toMatchObject({ price_in: 4, price_out: 25, price_from: "lab/model-a", access: "subscription" });
    // A price of its own is kept and is not marked.
    expect(models.own!.cost).toEqual({ text: { input: { price: 1 }, output: { price: 2 } } });
    expect(summarize("lab-subscription", models.own!, 0).price_from).toBeNull();
    // Nothing is taken from another plan, from an entry without a price, or without a named entry.
    for (const id of ["from-plan", "unpriced", "alone"]) {
      expect(models[id]!.cost).toBeUndefined();
      expect(ext(models[id]!).inherited?.fields ?? []).not.toContain("cost");
    }
    // An API entry we add has a price of its own to find: it does not take the lab's.
    expect(catalog["lab-api"]!.models.a!.cost).toBeUndefined();
    // The entries it was taken from are untouched.
    expect(ext(catalog.lab!.models["model-a"]!).inherited).toBeNull();
    expect(catalog["lab-coding-plan"]!.models["model-a"]!.cost).toEqual({ text: { input: { price: 0 }, output: { price: 0 } } });
  });

  it("shows the API list price on every subscription entry by one rule, and leaves an imported cost as it is", () => {
    const priced = upstream();
    priced.lab!.models["model-a"] = { ...priced.lab!.models["model-a"]!, canonical_id: "lab/model-a", cost: { text: { input: { price: 4, overrides: [{ when: { context: { gt: 200000 } }, price: 8 }] }, output: { price: 20 } } } };
    // A dated copy of the same model comes first by id; the entry with the canonical id itself is the reference.
    priced.lab!.models["model-a-0101"] = { id: "model-a-0101", name: "Model A 0101", canonical_id: "lab/model-a", cost: { text: { input: { price: 9 }, output: { price: 9 } } } };
    const zero = { text: { input: { price: 0 }, output: { price: 0 } } };
    priced["lab-coding-plan"]!.models = {
      "model-a": { id: "model-a", name: "Model A", canonical_id: "lab/model-a", cost: zero },
      listed: { id: "listed", name: "Listed", canonical_id: "elsewhere/model-x", cost: { text: { input: { price: 0.2 }, output: { price: 1.2 } } } },
      free: { id: "free", name: "Free", cost: zero },
    };
    const { catalog } = resolve(input([], { upstream: priced }));
    const plan = catalog["lab-coding-plan"]!.models;
    // The plan lists 0 for the model. The entry shows the lab's API price instead and says whose it is; its own
    // `cost` stays as models.dev has it, and nothing is marked as inherited.
    expect(plan["model-a"]!.cost).toEqual(zero);
    expect(ext(plan["model-a"]!).inherited).toBeNull();
    expect(ext(plan["model-a"]!).pricing).toMatchObject({ billing: "reference", reference_ref: "lab/model-a", rule_order: "listed" });
    expect(summarize("lab-coding-plan", plan["model-a"]!, 0)).toMatchObject({ price_in: 4, price_out: 20, price_from: "lab/model-a", origin: "upstream" });
    // The conditional rates come with it: base prices first, then the override.
    expect(ext(plan["model-a"]!).pricing.rules!.map((rule) => rule.amount)).toEqual([4, 20, 8]);
    // No API entry of the same model: a listed price stays and is not called an API price, and a listed zero is the plan.
    expect(ext(plan.listed!).pricing).toMatchObject({ billing: "unknown", reference_ref: null });
    expect(summarize("lab-coding-plan", plan.listed!, 0)).toMatchObject({ price_in: 0.2, price_out: 1.2, price_from: null });
    expect(ext(plan.free!).pricing).toMatchObject({ billing: "not_applicable", coverage: "not_applicable", rules: null });
    expect(summarize("lab-coding-plan", plan.free!, 0)).toMatchObject({ price_in: null, price_out: null, price_from: null });
    // The API entries are billed by their own rates and refer to nothing.
    expect(ext(catalog.lab!.models["model-a"]!).pricing).toMatchObject({ billing: "per_use", reference_ref: null });
    expect(summarize("lab", catalog.lab!.models["model-a-0101"]!, 0)).toMatchObject({ price_in: 9, price_from: null });
  });

  it("flags an addition that upstream now has too", () => {
    const { issues } = resolve(
      input([], { additions: [{ id: "lab", name: "Lab", access: "api", access_basis: "b", evidence, models: [] }] }),
    );
    expect(issues[0]).toMatchObject({ level: "warning", code: "addition-collides", target: "lab" });
  });
});

describe("resolve: measurements", () => {
  const observed: ObservedFile = {
    schema: 1,
    repository: "https://github.com/example/probe",
    routes: { "lab-api": "Lab API key", "lab-login": "Lab login" },
    clients: { direct: "plain requests", "tool-x": "internal tool" },
    cache: [
      {
        id: "run-1",
        route: "lab-api",
        client: "direct",
        model: "model-a",
        models_dev: "lab/model-a",
        date: "2026-11-05",
        source: "results/run-1.json",
        checks: [{ age_s: 300, warm: 3, total: 3 }],
        all_warm_through_s: 300,
        last_warm_s: 300,
        first_all_cold_s: null,
        latest: true,
      },
      { id: "old", route: "lab-api", client: "direct", model: "model-a", models_dev: "lab/model-a", date: "2026-10-01", source: "results/old.json" },
      { id: "run-2", route: "lab-login", client: "direct", model: "a", base_model: "lab/model-a", date: "2026-11-06", source: "results/run-2.json", latest: true },
      { id: "run-3", route: "nowhere", client: "direct", model: "x", date: "2026-11-06", source: "results/run-3.json", latest: true },
    ],
    limits: [],
    known: [],
  };
  const login = { id: "lab-login", name: "Lab login", access: "subscription" as const, access_basis: "a login", evidence, models: [] };
  const routes = { "lab-api": { provider: "lab" }, "lab-login": { provider: "lab-login" } };
  const directLabel = { clients: { direct: { id: "direct", label: "Straight to the provider" } }, omit_note_parts_mentioning: [] };

  it("puts a measurement next to the documented value without replacing it", () => {
    const { catalog } = resolve(input([], { observed, routes, labels: directLabel, additions: [login] }));
    const model = catalog.lab!.models["model-a"]!;
    expect(model.limit).toEqual({ context: 200000, output: 64000 });
    expect(ext(model).cache.evaluations).toEqual([
      expect.objectContaining({
        id: "run-1",
        client: "direct",
        route_label: "Lab API key",
        retention_profile: "short",
        parameter: null,
        value: null,
        results: [{ kind: "timed", age_s: 300, hits: 3, checks: 3, hit_rate_pct: 100 }],
        source: "https://github.com/example/probe/blob/main/results/run-1.json",
      }),
    ]);
    // The summary table is made here, once: a short line with the result, and a long line that was not evaluated.
    expect(ext(model).cache.results).toEqual([
      expect.objectContaining({ retention_profile: "short", evaluations: 1, evaluation_ids: ["run-1"], results: [{ kind: "timed", age_s: 300, hits: 3, checks: 3, hit_rate_pct: 100 }] }),
      expect.objectContaining({ retention_profile: "long", evaluations: 0, results: null }),
    ]);
    // Every entry has the same cache record, also one nobody evaluated.
    expect(ext(catalog.lab!.models["model-b"] ?? Object.values(catalog.lab!.models).find((item) => item.id !== "model-a")!).cache).toMatchObject({ results: null, evaluations: [] });
    expect(ext(model).verified).toBe("2026-11-05");
    expect(ext(model).provenance).toEqual([]);
  });

  it("creates an entry for a route upstream does not list, and reports routes it cannot place", () => {
    const { catalog, issues } = resolve(input([], { observed, routes, labels: directLabel, additions: [login] }));
    const added = catalog["lab-login"]!.models.a!;
    expect(added).toMatchObject({ name: "Model A", canonical_id: "lab/model-a" });
    expect(added.limit).toBeUndefined();
    expect(ext(added)).toMatchObject({ origin: "added", access: "subscription" });
    expect(ext(added).cache.evaluations).toHaveLength(1);
    expect(issues).toEqual([expect.objectContaining({ code: "unmapped-route", target: "nowhere" })]);
  });

  it("publishes a measured limit as the limit only on an entry we add", () => {
    const withLimits: ObservedFile = {
      ...observed,
      limits: [
        { route: "lab-login", client: "direct", model: "a", base_model: "lab/model-a", context: 900000, output: 32000, source: "results/limits-2026-11-08/l.jsonl" },
        { route: "lab-api", client: "direct", model: "model-a", models_dev: "lab/model-a", context: 150000, source: "results/limits-2026-11-08/l.jsonl" },
      ],
    };
    const { catalog } = resolve(input([], { observed: withLimits, routes, labels: directLabel, additions: [login] }));
    const added = catalog["lab-login"]!.models.a!;
    expect(added.limit).toEqual({ context: 900000, output: 32000 });
    expect(ext(added).limits).toMatchObject({ from_measurement: ["context", "output"], measured: [expect.objectContaining({ context: 900000, date: "2026-11-08" })] });
    // The upstream entry keeps its documented window; the measurement sits next to it.
    const imported = catalog.lab!.models["model-a"]!;
    expect(imported.limit).toEqual({ context: 200000, output: 64000 });
    expect(ext(imported).limits.from_measurement).toEqual([]);
    // A limit evaluation has every field: what it did not measure is null, never left out.
    expect(ext(imported).limits.measured[0]).toMatchObject({ context: 150000, output: null, input_accepted: null, input_refused: null, output_accepted: null, note: null });
  });

  it("names clients by their public label, drops note parts on the omit list and skips runs marked as lacking", () => {
    const labelled: ObservedFile = {
      ...observed,
      cache: [
        { ...observed.cache[0]!, id: "runs-1.0/R7", client: "tool-x", note: "ToolX 1.0 with patch 12; 5 samples per age", control: { warm: 1, total: 1 }, options: { ttl: "1h" } },
        { ...observed.cache[0]!, id: "runs-1.0/R8", lacks: "patch 12" },
        { ...observed.cache[0]!, id: "other/R9", client: "mystery" },
      ],
    };
    const labels = { clients: { "tool-x": { id: "gateway", label: "Through a gateway" } }, omit_note_parts_mentioning: ["toolx"] };
    const { catalog, issues } = resolve(input([], { observed: labelled, routes, labels, additions: [login] }));
    const cache = ext(catalog.lab!.models["model-a"]!).cache;
    const runs = cache.evaluations;
    expect(runs.map((run) => [run.id, run.client, run.client_label, run.note])).toEqual([
      ["other/R9", "other", "Another client", null],
      ["runs-1.0/R7", "gateway", "Through a gateway", "5 samples per age"],
    ]);
    // The run that sent a lifetime is the long line, with the request field it stands for; the control comes first.
    expect(runs[1]).toMatchObject({ retention_profile: "long", parameter: "cache_control.ttl", value: "1h", request_settings: { ttl: "1h" } });
    expect(runs[1]!.results.map((item) => [item.kind, item.age_s])).toEqual([["control", 0], ["timed", 300]]);
    expect(cache.results!.map((row) => [row.retention_profile, row.value, row.evaluations])).toEqual([["short", null, 1], ["long", "1h", 1]]);
    // Sending the value and getting a cache hit cannot prove the parameter was recognized.
    expect(cache.retention).toMatchObject({ support: "unknown", parameter: null, accepted_values: null });
    expect(JSON.stringify(runs)).not.toMatch(/tool-x|ToolX/);
    expect(issues).toContainEqual(expect.objectContaining({ code: "unmapped-client", target: "mystery" }));
  });

  it("flags measurements whose entry disappeared upstream", () => {
    const gone = upstream();
    delete gone.lab!.models["model-a"];
    const { issues } = resolve({ ...input([], { observed, routes, labels: directLabel, additions: [login] }), upstream: gone });
    expect(issues).toContainEqual(expect.objectContaining({ code: "orphan-observation", target: "lab/model-a" }));
  });
});
