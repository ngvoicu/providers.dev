import { describe, expect, it } from "vitest";
import { emptyCacheLifetime } from "../src/core/cache.ts";
import { CacheLifetimeRecordSchema } from "../src/core/contract.ts";
import { clone, type Json, type JsonObject } from "../src/core/merge.ts";
import { summarize } from "../src/core/entries.ts";
import { emptyInputWindow } from "../src/core/limits.ts";
import { resolve, type ResolveInput } from "../src/core/resolve.ts";
import { inputWindowRuleBreaks } from "./helpers.ts";
import { MeasurementLabels, OverrideFile as OverrideFileSchema, ext, providerExt, type AccessRules, type AuthoredProvider, type Evidence, type ObservedFile, type OverrideFile, type UpstreamCatalog } from "../src/core/schema.ts";

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

    // A selection can be narrowed to the models the provider's page names. It is still not evidence about the entry,
    // and a named model it does not reach is reported.
    const wider = upstream();
    for (const id of ["model-a", "model-b"]) wider.lab!.models[id]!.capabilities = { cache: { explicit: { ttl: ["5m", "1h"] } } };
    const narrowed = resolve(input([OverrideFileSchema.parse({ provider: "lab", rules: [{ ...rule, select: { ...rule.select, models: ["model-a", "model-gone"] } }] })], { upstream: wider }));
    expect(ext(narrowed.catalog.lab!.models["model-a"]!).cache.retention.support).toBe("supported");
    expect(summarize("lab", narrowed.catalog.lab!.models["model-a"]!, 0)).toMatchObject({ origin: "upstream", verified: null });
    expect(ext(narrowed.catalog.lab!.models["model-b"]!).cache.retention.support).toBe("unknown");
    expect(narrowed.issues).toEqual([expect.objectContaining({ level: "warning", code: "orphan-override", target: "lab/model-gone" })]);

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
    expect(exclusions.map((item) => [item.kind, item.leaves_out, item.date, item.evidence.length, item.entries])).toEqual([["entry", null, null, 1, 1], ["provider", null, null, 1, 1]]);
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
    // No API entry of the same model: no price per token, whatever is listed (design/sources-side-by-side.md, 2.4); the
    // listed figures stay in the entry's own cost, and a listed zero is the plan.
    expect(ext(plan.listed!).pricing).toMatchObject({ billing: "not_applicable", coverage: "not_applicable", reference_ref: null, rules: null });
    expect(plan.listed!.cost).toEqual({ text: { input: { price: 0.2 }, output: { price: 1.2 } } });
    expect(summarize("lab-coding-plan", plan.listed!, 0)).toMatchObject({ price_in: null, price_out: null, price_from: null });
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

/**
 * What resolve published for the entries of the input window fixture before the input window existed (commit 355b308,
 * the same fixture): limit, limits.measured, limits.from_measurement, verified and origin. The record adds a key and
 * changes none of these.
 */
const BEFORE_INPUT_WINDOW = {
  "added/x": {"limit":{"context":64000},"measured":[],"from_measurement":[],"verified":"2026-11-07","origin":"added"},
  "lab/model-a": {"limit":{"context":200000,"output":64000},"measured":[{"route":"lab-api","route_label":"Lab API key","client":"direct","client_label":"Straight to the provider","context":null,"output":null,"input_accepted":930000,"input_refused":null,"input_read":null,"output_accepted":null,"note":null,"date":"2026-11-09","source":"https://github.com/example/probe/blob/main/results/limits-2026-11-09/l.jsonl"}],"from_measurement":[],"verified":"2026-11-09","origin":"upstream"},
  "lab/model-b": {"limit":{"context":120000,"output":8000},"measured":[],"from_measurement":[],"verified":"2026-11-04","origin":"upstream"},
  "lab/model-c": {"limit":{"context":300000,"input":260000,"output":8000},"measured":[],"from_measurement":[],"verified":"2026-11-03","origin":"upstream"},
  "lab/model-d": {"limit":{"context":0,"output":0},"measured":[],"from_measurement":[],"verified":null,"origin":"upstream"},
  "lab/model-e": {"limit":{"context":600000,"input":400000},"measured":[],"from_measurement":[],"verified":"2026-11-05","origin":"upstream"},
  "lab-coding-plan/model-a": {"limit":null,"measured":[],"from_measurement":[],"verified":null,"origin":"upstream"},
  "lab-login/m1": {"limit":null,"measured":[{"route":"lab-login","route_label":"Lab login","client":"direct","client_label":"Straight to the provider","context":null,"output":null,"input_accepted":190000,"input_refused":195000,"input_read":null,"output_accepted":null,"note":null,"date":"2026-11-08","source":"https://github.com/example/probe/blob/main/results/limits-2026-11-08/l.jsonl"}],"from_measurement":[],"verified":"2026-11-08","origin":"added"},
  "lab-login/m2": {"limit":{"context":1000000,"output":32000},"measured":[{"route":"lab-login","route_label":"Lab login","client":"direct","client_label":"Straight to the provider","context":1000000,"output":32000,"input_accepted":null,"input_refused":null,"input_read":null,"output_accepted":null,"note":null,"date":"2026-11-08","source":"https://github.com/example/probe/blob/main/results/limits-2026-11-08/l.jsonl"}],"from_measurement":["context","output"],"verified":"2026-11-08","origin":"added"},
};

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
  const directLabel = { clients: { direct: { id: "direct", label: "Straight to the provider", kind: "direct" as const } }, omit_note_parts_mentioning: [] };

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
    // The results by age are made here, once: a short measured item with the result, and nothing measured for long.
    expect(ext(model).cache.lifetime.lifetimes).toEqual([
      expect.objectContaining({ retention_profile: "short", basis: "measured", evaluations: 1, evaluation_ids: ["run-1"], results: [{ kind: "timed", age_s: 300, hits: 3, checks: 3, hit_rate_pct: 100 }] }),
    ]);
    expect(ext(model).cache.lifetime.long.evaluations).toBe(0);
    // Every entry has the same cache record, also one nobody evaluated.
    expect(ext(catalog.lab!.models["model-b"] ?? Object.values(catalog.lab!.models).find((item) => item.id !== "model-a")!).cache).toMatchObject({ lifetime: { lifetimes: [] }, evaluations: [] });
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

  it("publishes the date of a limits row, else the date of its folder, and input_read, null where absent", () => {
    const rows: ObservedFile = {
      ...observed,
      limits: [
        // Today's shape: no date, no input_read.
        { route: "lab-api", client: "direct", model: "model-a", models_dev: "lab/model-a", input_accepted: 150000, input_refused: 160000, source: "results/limits-2026-11-08/l.jsonl" },
        // The new shape: its own date, and an input read to the end.
        { route: "lab-api", client: "tool-x", model: "model-a", models_dev: "lab/model-a", input_accepted: 120000, input_read: 110000, date: "2026-11-12", source: "results/limits-2026-11-08/l.jsonl" },
        // A date of its own on a row whose folder has none; null is the same as absent.
        { route: "lab-api", client: "other-tool", model: "model-b", models_dev: "lab/model-b", context: 100000, input_read: null, date: "2026-11-14", source: "results/limits/l.jsonl" },
        { route: "lab-api", client: "direct", model: "model-b", models_dev: "lab/model-b", context: 100000, date: null, source: "results/limits/l.jsonl" },
        // On a route upstream does not list: the entry is created with the row's own date as its evidence date.
        { route: "lab-login", client: "direct", model: "c", base_model: "lab/model-a", input_accepted: 900000, input_refused: 910000, date: "2026-11-12", source: "results/limits-2026-11-08/l.jsonl" },
      ],
    };
    const labels = { clients: { direct: { id: "direct", label: "Direct", kind: "direct" as const }, "tool-x": { id: "tool-x", label: "Tool X", kind: "direct" as const }, "other-tool": { id: "other-tool", label: "Other tool", kind: "direct" as const } }, omit_note_parts_mentioning: [] };
    const { catalog } = resolve(input([], { observed: rows, routes, labels, additions: [login] }));
    const measured = (ref: [string, string]) => ext(catalog[ref[0]]!.models[ref[1]]!).limits.measured.map((item) => [item.client, item.date, item.input_accepted, item.input_read]);
    expect(measured(["lab", "model-a"])).toEqual([["direct", "2026-11-08", 150000, null], ["tool-x", "2026-11-12", 120000, 110000]]);
    expect(measured(["lab", "model-b"])).toEqual([["other-tool", "2026-11-14", null, null], ["direct", null, null, null]]);
    expect(measured(["lab-login", "c"])).toEqual([["direct", "2026-11-12", 900000, null]]);
    expect(ext(catalog["lab-login"]!.models.c!).evidence.map((item) => item.date)).toEqual(["2026-11-12"]);
    // Every limit evaluation has the same keys, input_read among them.
    const keys = new Set(Object.values(catalog).flatMap((provider) => Object.values(provider.models).flatMap((model) => ext(model).limits.measured.map((item) => Object.keys(item).join(",")))));
    expect([...keys]).toEqual(["route,route_label,client,client_label,context,output,input_accepted,input_refused,input_read,output_accepted,note,date,source,client_kind"]);
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
    const labels = { clients: { "tool-x": { id: "gateway", label: "Through a gateway", kind: "direct" as const } }, omit_note_parts_mentioning: ["toolx"] };
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
    expect(cache.lifetime.lifetimes.filter((item) => item.basis === "measured").map((item) => [item.retention_profile, item.value, item.evaluations])).toEqual([["short", null, 1], ["long", "1h", 1]]);
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

  describe("the input window", () => {
    const listed: Evidence = { kind: "listed", url: "https://example.com/models", date: "2026-11-07" };
    const windowUpstream = (): UpstreamCatalog => {
      const catalog = upstream();
      catalog.lab!.models["model-c"] = { id: "model-c", name: "Model C", limit: { context: 300000, input: 250000, output: 8000 } };
      catalog.lab!.models["model-d"] = { id: "model-d", name: "Model D", type: "image", limit: { context: 0, output: 0 } };
      catalog.lab!.models["model-e"] = { id: "model-e", name: "Model E", limit: { context: 500000, input: 400000 } };
      return catalog;
    };
    const dated = (date: string): Evidence[] => [{ kind: "documented", url: "https://example.com/limits", date }];
    const corrections: OverrideFile = {
      provider: "lab",
      rules: [
        { models: ["model-b"], set: { limit: { context: 120000 } }, reason: "documented higher", evidence: dated("2026-11-04") },
        { models: ["model-c"], set: { limit: { input: 260000 } }, reason: "documented higher", evidence: dated("2026-11-03") },
        { models: ["model-e"], set: { limit: { context: 600000 } }, reason: "documented higher", evidence: dated("2026-11-05") },
      ],
    };
    const added: AuthoredProvider = { id: "added", name: "Added", access: "api", access_basis: "b", evidence, models: [{ id: "x", fields: { limit: { context: 64000 } }, evidence: [...evidence, listed] }] };
    const limits: ObservedFile = {
      ...observed,
      cache: [],
      limits: [
        // Created by the measurement, inheriting from lab/model-a (200,000 documented there): a bracket, nothing documented here.
        { route: "lab-login", client: "direct", model: "m1", base_model: "lab/model-a", input_accepted: 190000, input_refused: 195000, source: "results/limits-2026-11-08/l.jsonl" },
        // A window the route names, on an entry providers.dev added: measured, not documented.
        { route: "lab-login", client: "direct", model: "m2", base_model: "lab/model-a", context: 1000000, output: 32000, source: "results/limits-2026-11-08/l.jsonl" },
        // An accepted size with no refusal, no named window and no read check: it does not count.
        { route: "lab-api", client: "direct", model: "model-a", models_dev: "lab/model-a", input_accepted: 930000, source: "results/limits-2026-11-09/l.jsonl" },
      ],
    };
    const resolved = () => resolve(input([corrections], { upstream: windowUpstream(), observed: limits, routes, labels: directLabel, additions: [login, added], upstreamDate: "2026-11-15" }));
    const windowOf = (catalog: ReturnType<typeof resolve>["catalog"], provider: string, model: string) => ext(catalog[provider]!.models[model]!).limits.input_window;

    it("takes source and date from the import, a correction of the field read, or the entry providers.dev added", () => {
      const { catalog } = resolved();
      const brief = (provider: string, model: string) => {
        const w = windowOf(catalog, provider, model);
        return [w.tokens, w.basis, w.scope, w.documented_field, w.source, w.date];
      };
      // Imported, nothing corrected: models.dev and the import date.
      expect(brief("lab", "model-a")).toEqual([200000, "documented", "window", "limit.context", "models.dev", "2026-11-15"]);
      // A correction of the field read: providers.dev and the date of its evidence.
      expect(brief("lab", "model-b")).toEqual([120000, "documented", "window", "limit.context", "providers.dev", "2026-11-04"]);
      expect(brief("lab", "model-c")).toEqual([260000, "documented", "input", "limit.input", "providers.dev", "2026-11-03"]);
      // A correction of limit.context where limit.input is the field read: still the import's.
      expect(brief("lab", "model-e")).toEqual([400000, "documented", "input", "limit.input", "models.dev", "2026-11-15"]);
      // An entry providers.dev added whose file states a limit: the newest of its evidence, of any kind.
      expect(brief("added", "x")).toEqual([64000, "documented", "window", "limit.context", "providers.dev", "2026-11-07"]);
      // A window of 0 on an image model, and an entry with no limit: nothing known.
      expect(windowOf(catalog, "lab", "model-d")).toEqual(emptyInputWindow());
      expect(windowOf(catalog, "lab-coding-plan", "model-a")).toEqual(emptyInputWindow());
      // Without an import date, none is published.
      const undated = resolve(input([], { upstream: windowUpstream() }));
      expect(windowOf(undated.catalog, "lab", "model-a")).toMatchObject({ source: "models.dev", date: null, documented_date: null });
    });

    it("takes nothing from the entry an added entry inherits from, and reads a measured window as a measurement", () => {
      const { catalog } = resolved();
      const m1 = catalog["lab-login"]!.models.m1!;
      expect(ext(m1).inherited?.from).toBe("lab/model-a");
      expect(m1.limit).toBeUndefined();
      expect(windowOf(catalog, "lab-login", "m1")).toMatchObject({ tokens: 190000, basis: "measured", bound: "at_least", scope: "input", source: "providers.dev", date: "2026-11-08", documented_tokens: null, measured_refused: 195000, evaluations: 1 });
      const m2 = catalog["lab-login"]!.models.m2!;
      expect([m2.limit, ext(m2).limits.from_measurement]).toEqual([{ context: 1000000, output: 32000 }, ["context", "output"]]);
      expect(windowOf(catalog, "lab-login", "m2")).toMatchObject({ tokens: 1000000, basis: "measured", bound: "limit", scope: "window", documented_tokens: null, documented_status: null, measured_kind: "window" });
    });

    it("keeps a row that does not count in limits.measured, in no item, and reports it once", () => {
      const { catalog, issues } = resolved();
      const model = catalog.lab!.models["model-a"]!;
      expect(ext(model).limits.measured).toEqual([expect.objectContaining({ input_accepted: 930000, input_refused: null, context: null, input_read: null })]);
      expect(ext(model).limits.input_window).toMatchObject({ basis: "documented", tokens: 200000, documented_status: null, evaluations: 0, measurements: [] });
      expect(issues.filter((issue) => issue.code === "limit-not-counted")).toEqual([
        { level: "notice", code: "limit-not-counted", target: "lab/model-a#limits", message: expect.stringMatching(/^The limit evaluation of lab\/model-a by direct on lab-api \(2026-11-09\) states input_accepted 930000, and gives no input window/) },
      ]);
      // An evaluation of the output alone is not reported.
      const output: ObservedFile = { ...limits, limits: [{ route: "lab-api", client: "direct", model: "model-b", models_dev: "lab/model-b", output: 8000, source: "results/limits-2026-11-09/l.jsonl" }] };
      expect(resolve(input([], { observed: output, routes, labels: directLabel })).issues.filter((issue) => issue.code === "limit-not-counted")).toEqual([]);
    });

    it("keeps the rules of 2.6 on every entry", () => {
      const { catalog } = resolved();
      for (const provider of Object.values(catalog)) {
        for (const model of Object.values(provider.models)) {
          const limits = ext(model).limits;
          expect(inputWindowRuleBreaks(limits.input_window, model.limit, limits.from_measurement, limits.measured), `${provider.id}/${model.id}`).toEqual([]);
        }
      }
    });

    it("leaves limit, limits.measured, limits.from_measurement, verified and origin as they were", () => {
      const { catalog } = resolved();
      const now = Object.fromEntries(Object.values(catalog).flatMap((provider) => Object.values(provider.models).map((model) => {
        const extension = ext(model);
        // Since 1.4.0 a limit evaluation also names its client's kind; every other key is as it was.
        expect(extension.limits.measured.every((item) => item.client_kind === "direct")).toBe(true);
        const measured = extension.limits.measured.map(({ client_kind: _kind, ...item }) => item);
        return [`${provider.id}/${model.id}`, { limit: model.limit ?? null, measured, from_measurement: extension.limits.from_measurement, verified: extension.verified, origin: extension.origin }];
      })));
      expect(now).toEqual(BEFORE_INPUT_WINDOW);
    });
  });

  describe("the cache lifetime record", () => {
    const documentedUpstream = (): UpstreamCatalog => {
      const catalog = upstream();
      catalog.lab!.models["model-a"]!.capabilities = { cache: { explicit: { ttl: ["5m", "1h"] } } };
      catalog.lab!.models["model-b"]!.capabilities = { cache: false };
      catalog.lab!.models["model-c"] = { id: "model-c", name: "Model C", capabilities: { cache: { implicit: { ttl: ["30m"] } } } };
      return catalog;
    };
    const run = (id: string, checks: { age_s: number; warm: number; total: number }[], more: Partial<ObservedFile["cache"][number]> = {}) => ({
      id, route: "lab-api", client: "direct", model: "model-a", models_dev: "lab/model-a", date: "2026-11-07", source: `results/${id}.json`, control: { warm: 1, total: 1 }, checks, latest: true, ...more,
    });

    it("gives the measured entry a measured item and its two profiles, and the others the empty record", () => {
      const { catalog, issues } = resolve(input([], { observed, routes, labels: directLabel, additions: [login], upstreamDate: "2026-11-15" }));
      const lifetime = ext(catalog.lab!.models["model-a"]!).cache.lifetime;
      expect(lifetime.lifetimes).toEqual([
        {
          retention_profile: "short", basis: "measured", source: "providers.dev", date: "2026-11-05", lifetime_s: 300, mode: null, documented_as: null,
          client: "direct", client_label: "Straight to the provider", parameter: null, value: null, evaluations: 1, evaluation_ids: ["run-1"], checks: 3, hits: 3,
          tested_from_s: 300, first_miss_s: null, results: [{ kind: "timed", age_s: 300, hits: 3, checks: 3, hit_rate_pct: 100 }],
          client_kind: "direct", chosen: true,
        },
      ]);
      expect(lifetime.short).toEqual({ safe_s: 300, basis: "measured", source: "providers.dev", date: "2026-11-05", documented_s: null, measured_s: 300, documented_status: null, clients: 1, evaluations: 1, checks: 3, hits: 3, checks_inside: null, hits_inside: null, tested_from_s: 300, first_miss_s: null });
      expect(lifetime.long).toEqual(emptyCacheLifetime().long);
      // Nobody evaluated it and nothing is documented: the record of an entry nothing is known about.
      expect(ext(catalog.lab!.models["model-b"]!).cache.lifetime).toEqual(emptyCacheLifetime());
      // The run on the login route has no result: it stays in the evaluations of the added entry and counts for no lifetime.
      expect(ext(catalog["lab-login"]!.models.a!).cache.evaluations.map((item) => item.id)).toEqual(["run-2"]);
      expect(ext(catalog["lab-login"]!.models.a!).cache.lifetime).toEqual(emptyCacheLifetime());
      // The cache record has four keys; verified and origin are as they were.
      const model = catalog.lab!.models["model-a"]!;
      expect(Object.keys(ext(model).cache)).toEqual(["documented", "retention", "lifetime", "evaluations"]);
      expect(ext(model).verified).toBe("2026-11-05");
      expect(summarize("lab", model, 0).origin).toBe("modified");
      expect(issues.filter((issue) => ["lifetime-differs", "unparsed-lifetime", "retention-lifetime-differs"].includes(issue.code))).toEqual([]);
    });

    it("names models.dev and the import date on a documented lifetime, and makes two items of 0 for an entry that does not cache", () => {
      const { catalog, issues } = resolve(input([], { upstream: documentedUpstream(), upstreamDate: "2026-11-15" }));
      const a = catalog.lab!.models["model-a"]!;
      const lifetime = ext(a).cache.lifetime;
      expect(lifetime.lifetimes.map((item) => [item.retention_profile, item.basis, item.source, item.date, item.lifetime_s, item.mode, item.documented_as])).toEqual([
        ["short", "documented", "models.dev", "2026-11-15", 300, "explicit", "5m"],
        ["long", "documented", "models.dev", "2026-11-15", 3600, "explicit", "1h"],
      ]);
      expect(lifetime.short).toMatchObject({ safe_s: 300, basis: "documented", source: "models.dev", date: "2026-11-15" });
      expect(lifetime.long).toMatchObject({ safe_s: 3600, basis: "documented", source: "models.dev", date: "2026-11-15" });
      // A documented lifetime is not providers.dev's evidence: the entry stays as imported.
      expect(summarize("lab", a, 0)).toMatchObject({ origin: "upstream", verified: null });
      const b = ext(catalog.lab!.models["model-b"]!).cache.lifetime;
      expect(b.lifetimes.map((item) => [item.retention_profile, item.lifetime_s, item.mode, item.documented_as, item.source])).toEqual([["short", 0, null, null, "models.dev"], ["long", 0, null, null, "models.dev"]]);
      expect([b.short.safe_s, b.short.basis, b.long.safe_s, b.long.basis]).toEqual([0, "documented", 0, "documented"]);
      expect(issues).toEqual([]);
    });

    it("names providers.dev and the evidence date where a correction sets the lifetime or the cache", () => {
      const corrections: OverrideFile = {
        provider: "lab",
        rules: [
          { models: ["model-a"], set: { capabilities: { cache: { explicit: { ttl: ["5m", "2h"] } } } }, reason: "documented lifetimes", evidence: [{ kind: "documented", url: "https://example.com/cache", date: "2026-11-09" }] },
          { models: ["model-c"], set: { capabilities: { cache: false } }, reason: "does not cache", evidence: [{ kind: "documented", url: "https://example.com/none", date: "2026-11-10" }] },
        ],
      };
      const { catalog } = resolve(input([corrections], { upstream: documentedUpstream(), upstreamDate: "2026-11-15" }));
      expect(ext(catalog.lab!.models["model-a"]!).provenance.map((change) => change.path)).toEqual(["capabilities.cache.explicit.ttl"]);
      expect(ext(catalog.lab!.models["model-a"]!).cache.lifetime.lifetimes.map((item) => [item.lifetime_s, item.source, item.date])).toEqual([[300, "providers.dev", "2026-11-09"], [7200, "providers.dev", "2026-11-09"]]);
      expect(ext(catalog.lab!.models["model-a"]!).cache.lifetime.long).toMatchObject({ safe_s: 7200, basis: "documented", source: "providers.dev", date: "2026-11-09" });
      const c = ext(catalog.lab!.models["model-c"]!).cache.lifetime;
      expect(c.lifetimes.map((item) => [item.retention_profile, item.lifetime_s, item.source, item.date])).toEqual([["short", 0, "providers.dev", "2026-11-10"], ["long", 0, "providers.dev", "2026-11-10"]]);
      // A correction of another field of the cache does not move the source of the lifetimes.
      const minTokens: OverrideFile = { provider: "lab", rules: [{ models: ["model-a"], set: { capabilities: { cache: { explicit: { min_tokens: 2048 } } } }, reason: "minimum", evidence }] };
      const other = resolve(input([minTokens], { upstream: documentedUpstream(), upstreamDate: "2026-11-15" }));
      expect(ext(other.catalog.lab!.models["model-a"]!).cache.lifetime.lifetimes.map((item) => item.source)).toEqual(["models.dev", "models.dev"]);
    });

    it("names providers.dev on an added entry that documents a lifetime, and gives none to one that names an upstream entry", () => {
      const added: AuthoredProvider = {
        id: "lab-login", name: "Lab login", access: "subscription", access_basis: "a login", evidence,
        models: [
          { id: "own", fields: { capabilities: { cache: { implicit: { ttl: ["1h"] } } } }, evidence: [{ kind: "documented", url: "https://example.com/login", date: "2026-11-12" }, { kind: "listed", url: "https://example.com/list", date: "2026-11-14" }] },
          { id: "named", inherits: "lab/model-a", evidence },
        ],
      };
      const { catalog } = resolve(input([], { upstream: documentedUpstream(), additions: [added], upstreamDate: "2026-11-15" }));
      const own = ext(catalog["lab-login"]!.models.own!).cache.lifetime;
      expect(own.lifetimes.map((item) => [item.retention_profile, item.lifetime_s, item.mode, item.source, item.date])).toEqual([["short", 3600, "implicit", "providers.dev", "2026-11-12"]]);
      expect(own.short).toMatchObject({ safe_s: 3600, basis: "documented", source: "providers.dev", date: "2026-11-12" });
      // lab/model-a documents 5m and 1h; the added entry takes its identity only, never its cache behaviour.
      expect(ext(catalog["lab-login"]!.models.named!).cache.lifetime).toEqual(emptyCacheLifetime());
    });

    it("leaves a run marked as lacking, or one that is not the latest, out of every item", () => {
      const runs: ObservedFile = {
        ...observed,
        cache: [run("kept", [{ age_s: 300, warm: 3, total: 3 }]), run("lacking", [{ age_s: 150, warm: 0, total: 3 }], { lacks: "patch" }), run("older", [{ age_s: 150, warm: 0, total: 3 }], { latest: false })],
      };
      const { catalog } = resolve(input([], { observed: runs, routes, labels: directLabel, additions: [login] }));
      const lifetime = ext(catalog.lab!.models["model-a"]!).cache.lifetime;
      expect(lifetime.lifetimes.flatMap((item) => item.evaluation_ids)).toEqual(["kept"]);
      expect(lifetime.short).toMatchObject({ safe_s: 300, evaluations: 1 });
    });

    it("reports a lifetime that differs from groundtruth's reading of the same run", () => {
      const runs: ObservedFile = {
        ...observed,
        cache: [
          run("agrees", [{ age_s: 300, warm: 3, total: 3 }, { age_s: 600, warm: 1, total: 3 }], { all_warm_through_s: 300 }),
          run("differs", [{ age_s: 300, warm: 3, total: 3 }, { age_s: 600, warm: 3, total: 3 }], { all_warm_through_s: 300 }),
          run("null-is-0", [{ age_s: 300, warm: 2, total: 3 }], { all_warm_through_s: null }),
          run("null-differs", [{ age_s: 300, warm: 3, total: 3 }], { all_warm_through_s: null }),
          // groundtruth's reading ignores the control: a run whose control missed is not compared.
          run("cold-control", [{ age_s: 300, warm: 3, total: 3 }], { all_warm_through_s: 300, control: { warm: 0, total: 1 } }),
          run("no-reading", [{ age_s: 300, warm: 3, total: 3 }]),
        ],
      };
      const { catalog, issues } = resolve(input([], { observed: runs, routes, labels: directLabel, additions: [login] }));
      expect(issues.filter((issue) => issue.code === "lifetime-differs")).toEqual([
        expect.objectContaining({ level: "warning", target: "differs" }),
        expect.objectContaining({ level: "warning", target: "null-differs" }),
      ]);
      // The value derived from the checks is published all the same.
      expect(ext(catalog.lab!.models["model-a"]!).cache.lifetime.lifetimes[0]!.evaluation_ids).toContain("differs");
    });

    it("reports a lifetime that is not a whole number of seconds, makes no item of it, and keeps the record valid", () => {
      const catalog = documentedUpstream();
      catalog.lab!.models["model-c"]!.capabilities = { cache: { explicit: { ttl: ["500ms"] } } };
      const result = resolve(input([], { upstream: catalog }));
      expect(result.issues).toEqual([expect.objectContaining({ level: "notice", code: "unparsed-lifetime", target: "lab/model-c#capabilities.cache.explicit.ttl" })]);
      const lifetime = ext(result.catalog.lab!.models["model-c"]!).cache.lifetime;
      expect(lifetime).toEqual(emptyCacheLifetime());
      expect(CacheLifetimeRecordSchema.safeParse(lifetime).success).toBe(true);
      // The text stays readable where models.dev wrote it.
      expect(result.catalog.lab!.models["model-c"]!.capabilities).toEqual({ cache: { explicit: { ttl: ["500ms"] } } });
    });

    it("dates a documented lifetime of an added entry by its newest evidence, a declaration made for it included", () => {
      const dated = (date: string) => ({ kind: "documented" as const, url: `https://example.com/docs/${date}`, date });
      const declaration = {
        support: "supported" as const, parameter: { name: "cache_control.ttl", location: "Cache marker" }, accepted_values: ["5m", "1h"], default: "5m",
        profiles: [{ profile: "short" as const, value: "5m" }, { profile: "long" as const, value: "1h" }], conditions: [], evidence: [{ ...dated("2026-11-14"), note: "The documented request field." }],
      };
      const added: AuthoredProvider = {
        id: "added", name: "Added", access: "api", access_basis: "fixture", evidence: [dated("2026-11-01")],
        models: [{ id: "m", fields: { capabilities: { cache: { explicit: { ttl: ["5m", "1h"] } } } }, evidence: [dated("2026-11-01")], cache_retention: declaration }],
      };
      const { catalog } = resolve(input([], { additions: [added] }));
      const extension = ext(catalog.added!.models.m!);
      expect(extension.evidence.map((source) => source.date)).toEqual(["2026-11-01", "2026-11-14"]);
      expect(extension.cache.lifetime.lifetimes.map((item) => [item.lifetime_s, item.source, item.date])).toEqual([[300, "providers.dev", "2026-11-14"], [3600, "providers.dev", "2026-11-14"]]);
      expect([extension.cache.lifetime.short.date, extension.cache.lifetime.long.date]).toEqual(["2026-11-14", "2026-11-14"]);
    });

    it("reports groundtruth's lifetime for a run whose checks give none", () => {
      const runs: ObservedFile = {
        ...observed,
        cache: [
          run("warm-only", [], { all_warm_through_s: 300 }),
          run("warm-only-null", [], { all_warm_through_s: null }),
          run("warm-only-zero", [], { all_warm_through_s: 0 }),
          // Only a reading above 0 claims a lifetime the checks do not give.
          run("warm-only-negative", [], { all_warm_through_s: -1 }),
        ],
      };
      const { catalog, issues } = resolve(input([], { observed: runs, routes, labels: directLabel, additions: [login] }));
      expect(issues.filter((issue) => issue.code === "lifetime-differs")).toEqual([expect.objectContaining({ level: "warning", target: "warm-only" })]);
      // It stays an evaluation that counts for no lifetime.
      const cache = ext(catalog.lab!.models["model-a"]!).cache;
      expect(cache.evaluations.map((item) => item.id).sort()).toEqual(["warm-only", "warm-only-negative", "warm-only-null", "warm-only-zero"]);
      expect(cache.lifetime).toEqual(emptyCacheLifetime());
    });

    it("reports a documented lifetime that is not a duration, and does not make an item of it", () => {
      const catalog = documentedUpstream();
      catalog.lab!.models["model-c"]!.capabilities = { cache: { implicit: { ttl: ["5m-10m", "1h"] }, explicit: { ttl: ["about an hour"] } } };
      const result = resolve(input([], { upstream: catalog }));
      expect(result.issues).toEqual([
        expect.objectContaining({ level: "notice", code: "unparsed-lifetime", target: "lab/model-c#capabilities.cache.implicit.ttl" }),
        expect.objectContaining({ level: "notice", code: "unparsed-lifetime", target: "lab/model-c#capabilities.cache.explicit.ttl" }),
      ]);
      expect(ext(result.catalog.lab!.models["model-c"]!).cache.lifetime.lifetimes.map((item) => item.documented_as)).toEqual(["1h"]);
    });

    it("reports a retention option whose lifetime is not the documented lifetime of its profile", () => {
      const source = { kind: "documented" as const, url: "https://example.com/api-reference", date: "2026-11-14", note: "The reference names the field and its values." };
      const control = (longSeconds: number) => ({
        id: "cache.retention", support: "supported", when: null,
        bindings: [{ location: "body", path: "/cache_control/ttl", scope: "content_block" }],
        options: [
          { value: null, attributes: { retention_s: 300, profile: "short" }, settings: null, when: null },
          { value: "1h", attributes: { retention_s: longSeconds, profile: "long" }, settings: null, when: null },
        ],
        default: { value: "5m" }, conditions: [], evidence: [source],
      });
      const file = (longSeconds: number) => OverrideFileSchema.parse({ provider: "lab", rules: [{ models: ["model-a"], request_controls: [control(longSeconds)], reason: "The provider documents the field", evidence }] });
      expect(resolve(input([file(3600)], { upstream: documentedUpstream() })).issues).toEqual([]);
      expect(resolve(input([file(7200)], { upstream: documentedUpstream() })).issues).toEqual([
        expect.objectContaining({ level: "notice", code: "retention-lifetime-differs", target: "lab/model-a#request_controls.cache.retention" }),
      ]);
    });

    const documenting = (ttl: string[]): UpstreamCatalog => {
      const catalog = upstream();
      catalog.lab!.models["model-a"]!.capabilities = { cache: { explicit: { ttl } } };
      return catalog;
    };

    it("puts an evaluation in short by the seconds of the shortest documented lifetime the record counts, not by its first text", () => {
      // 500ms is no documented lifetime (whole seconds only): the shortest is 5m, and an evaluation that asked for 5m is short.
      const runs: ObservedFile = {
        ...observed,
        cache: [
          run("asks-5m", [{ age_s: 150, warm: 0, total: 1 }], { options: { ttl: "5m" } }),
          run("asks-500ms", [{ age_s: 150, warm: 3, total: 3 }], { options: { ttl: "500ms" } }),
        ],
      };
      const { catalog, issues } = resolve(input([], { upstream: documenting(["500ms", "5m"]), observed: runs, routes, labels: directLabel, additions: [login] }));
      const cache = ext(catalog.lab!.models["model-a"]!).cache;
      // A lifetime asked for that does not come to whole seconds is long.
      expect(cache.evaluations.map((item) => [item.id, item.retention_profile])).toEqual([["asks-500ms", "long"], ["asks-5m", "short"]]);
      // Its miss at 150 s, inside 300 s, contradicts the documented lifetime.
      expect(cache.lifetime.short).toEqual({
        safe_s: 0, basis: "measured", source: "providers.dev", date: "2026-11-07", documented_s: 300, measured_s: 0, documented_status: "contradicted",
        clients: 1, evaluations: 1, checks: 2, hits: 1, checks_inside: 2, hits_inside: 1, tested_from_s: 150, first_miss_s: 150,
      });
      expect(cache.lifetime.long).toMatchObject({ safe_s: 150, basis: "measured", documented_s: null, measured_s: 150, evaluations: 1 });
      expect(issues.map((issue) => issue.code)).toEqual(["unparsed-lifetime"]);
    });

    it("puts an evaluation in short when its lifetime is the shortest one in seconds, however either is written and in whatever order", () => {
      const runs: ObservedFile = { ...observed, cache: [run("asks-1m", [{ age_s: 30, warm: 0, total: 1 }], { options: { ttl: "1m" } })] };
      const record = (ttl: string[], overrides: OverrideFile[] = []) => ext(resolve(input(overrides, { upstream: documenting(ttl), observed: runs, routes, labels: directLabel, additions: [login] })).catalog.lab!.models["model-a"]!).cache;
      const first = record(["60s", "1m"]);
      const reversed = record(["1m", "60s"]);
      expect(first.evaluations[0]!.retention_profile).toBe("short");
      expect(reversed.evaluations[0]!.retention_profile).toBe("short");
      expect(first.lifetime.short).toMatchObject({ safe_s: 0, basis: "measured", documented_s: 60, measured_s: 0, checks_inside: 2, hits_inside: 1 });
      expect(first.lifetime.lifetimes.map((item) => [item.retention_profile, item.basis, item.documented_as ?? item.value])).toEqual([["short", "documented", "1m"], ["short", "documented", "60s"], ["short", "measured", "1m"]]);
      expect(reversed.lifetime).toEqual(first.lifetime);
      // A profile declared on the entry's retention option still decides first.
      const declaration = {
        support: "supported", parameter: { name: "cache_control.ttl", location: "Cache marker" }, accepted_values: ["1m"], default: null,
        profiles: [{ profile: "long", value: "1m" }], conditions: [], evidence: [{ kind: "documented", url: "https://example.com/retention", date: "2026-11-14", note: "The fixture documentation." }],
      };
      const declared = OverrideFileSchema.parse({ provider: "lab", rules: [{ models: ["model-a"], cache_retention: declaration, reason: "Declared", evidence }] });
      expect(record(["60s", "1m"], [declared]).evaluations[0]!.retention_profile).toBe("long");
    });

    // OpenAI's minimum cache lifetime for a request, sent as {"prompt_cache_options": {"ttl": "12h"}}: the run of
    // groundtruth 8dec117 on openai/gpt-6.1-sol, warm through 12 hours and cold at 24, on an entry documenting 30m and 12h.
    const twelveHours = [{ age_s: 1800, warm: 3, total: 3 }, { age_s: 21600, warm: 3, total: 3 }, { age_s: 43200, warm: 3, total: 3 }, { age_s: 86400, warm: 0, total: 3 }];
    const openai = (options: JsonObject, overrides: OverrideFile[] = []) => {
      const runs: ObservedFile = { ...observed, cache: [run("sol-12h", twelveHours, { options })] };
      return ext(resolve(input(overrides, { upstream: documenting(["30m", "12h"]), observed: runs, routes, labels: directLabel, additions: [login] })).catalog.lab!.models["model-a"]!).cache;
    };
    const asked = (cache: ReturnType<typeof openai>) => cache.evaluations.map((item) => [item.retention_profile, item.parameter, item.value]);

    it("puts an evaluation that sent prompt_cache_options.ttl=12h in long, beside the documented 12 hours, with the field it sent", () => {
      const cache = openai({ prompt_cache_options: { ttl: "12h" } });
      expect(asked(cache)).toEqual([["long", "prompt_cache_options.ttl", "12h"]]);
      expect(cache.evaluations[0]!.request_settings).toEqual({ prompt_cache_options: { ttl: "12h" } });
      expect(cache.lifetime.long).toMatchObject({ safe_s: 43200, basis: "measured", documented_s: 43200, measured_s: 43200, documented_status: "not_contradicted", evaluations: 1 });
      expect(cache.lifetime.short).toMatchObject({ safe_s: 1800, basis: "documented", documented_s: 1800, measured_s: null, evaluations: 0 });
      expect(cache.lifetime.lifetimes.filter((item) => item.basis === "measured").map((item) => [item.retention_profile, item.parameter, item.value, item.lifetime_s, item.first_miss_s]))
        .toEqual([["long", "prompt_cache_options.ttl", "12h", 43200, 86400]]);
      // The shortest documented lifetime asked for by the same field is short, as with the other two fields.
      expect(asked(openai({ prompt_cache_options: { ttl: "30m" } }))).toEqual([["short", "prompt_cache_options.ttl", "30m"]]);
      expect(asked(openai({ ttl: "12h" }))).toEqual([["long", "cache_control.ttl", "12h"]]);
      expect(asked(openai({ prompt_cache_retention: "12h" }))).toEqual([["long", "prompt_cache_retention", "12h"]]);
    });

    it("puts the same run with empty options in short, beside the documented 30 minutes: the measurement, which contradicts it", () => {
      const cache = openai({});
      expect(asked(cache)).toEqual([["short", null, null]]);
      expect(cache.lifetime.short).toMatchObject({ safe_s: 43200, basis: "measured", documented_s: 1800, measured_s: 43200, documented_status: "contradicted", evaluations: 1 });
      expect(cache.lifetime.long).toMatchObject({ safe_s: 43200, basis: "documented", measured_s: null, evaluations: 0 });
      // prompt_cache_options without a ttl asks for nothing either.
      expect(asked(openai({ prompt_cache_options: {} }))).toEqual([["short", null, null]]);
    });

    it("reads a malformed prompt_cache_options.ttl as it reads a malformed ttl", () => {
      // Not a string (or an empty one, or no object to hold it): no lifetime asked, short, as for ttl.
      for (const [value, ttl] of [[43200, 43200], [true, true], [null, null], ["", ""], [["12h"], ["12h"]], [{ seconds: 43200 }, { seconds: 43200 }]] as [Json, Json][]) {
        expect(asked(openai({ prompt_cache_options: { ttl: value } }))).toEqual([["short", null, null]]);
        expect(asked(openai({ ttl }))).toEqual([["short", null, null]]);
      }
      expect(asked(openai({ prompt_cache_options: "12h" }))).toEqual([["short", null, null]]);
      expect(asked(openai({ prompt_cache_options: ["12h"] }))).toEqual([["short", null, null]]);
      // A string that is not a duration: asked, and long, as for ttl.
      for (const value of ["twelve hours", "500ms", "12h-24h"]) {
        expect(asked(openai({ prompt_cache_options: { ttl: value } }))).toEqual([["long", "prompt_cache_options.ttl", value]]);
        expect(asked(openai({ ttl: value }))).toEqual([["long", "cache_control.ttl", value]]);
      }
    });

    it("lets a retention declaration on prompt_cache_options.ttl decide the profile of the evaluations that sent it", () => {
      const source = { kind: "documented" as const, url: "https://example.com/prompt-caching", date: "2026-11-14", note: "The guide names the field and its values." };
      const declared = (profile12h: "short" | "long") => OverrideFileSchema.parse({
        provider: "lab",
        rules: [{
          models: ["model-a"], reason: "The provider documents the field", evidence,
          request_controls: [{
            id: "cache.retention", support: "supported", when: null,
            bindings: [{ location: "body", path: "/prompt_cache_options/ttl", scope: "request" }],
            options: [
              { value: "30m", attributes: { retention_s: 1800, profile: "short" }, settings: null, when: null },
              { value: "12h", attributes: { retention_s: 43200, profile: profile12h }, settings: null, when: null },
            ],
            default: { value: "30m" }, conditions: [], evidence: [source],
          }],
        }],
      });
      expect(asked(openai({ prompt_cache_options: { ttl: "12h" } }, [declared("long")]))).toEqual([["long", "prompt_cache_options.ttl", "12h"]]);
      // The declaration is read for the field it names: a profile declared there decides first.
      expect(asked(openai({ prompt_cache_options: { ttl: "12h" } }, [declared("short")]))).toEqual([["short", "prompt_cache_options.ttl", "12h"]]);
      // The same value sent by another field is not what the declaration speaks of: decided in seconds.
      expect(asked(openai({ ttl: "12h" }, [declared("short")]))).toEqual([["long", "cache_control.ttl", "12h"]]);
    });

    it("makes the same lifetime record of every entry from inputs in reverse order, and whatever the locale's order of text", () => {
      const catalog = upstream();
      catalog.lab!.models["model-a"]!.capabilities = { cache: { implicit: { ttl: ["1h", "5m"] }, explicit: { ttl: ["300s", "1h", "60m", "500ms"] } } };
      catalog.lab!.models["model-b"]!.capabilities = { cache: false };
      catalog.lab!.models["model-c"] = { id: "model-c", name: "Model C", capabilities: { cache: { explicit: { ttl: ["60s", "1m", "2h"] } } } };
      // Two raw clients share a public id, with its one label.
      const labels = MeasurementLabels.parse({
        clients: { direct: { id: "direct", label: "Straight to the provider", kind: "direct" as const }, "direct-2": { id: "direct", label: "Straight to the provider", kind: "direct" as const }, "tool-x": { id: "gateway", label: "Through a gateway", kind: "direct" as const } },
      });
      const at = (model: string) => ({ model, models_dev: `lab/${model}` });
      const runs: ObservedFile = {
        ...observed,
        cache: [
          run("z", [{ age_s: 300, warm: 3, total: 3 }, { age_s: 150, warm: 3, total: 3 }, { age_s: 600, warm: 1, total: 3 }]),
          run("ä", [{ age_s: 150, warm: 3, total: 3 }, { age_s: 300, warm: 2, total: 3 }], { client: "direct-2" }),
          run("Z2", [{ age_s: 1800, warm: 3, total: 3 }, { age_s: 600, warm: 3, total: 3 }], { client: "tool-x", date: "2026-11-06", options: { ttl: "1h" } }),
          run("b", [{ age_s: 600, warm: 2, total: 3 }], { client: "tool-x", date: "2026-11-08", options: { ttl: "60m" } }),
          run("f", [{ age_s: 900, warm: 3, total: 3 }], { client: "tool-x", options: { prompt_cache_retention: "1h" } }),
          run("c", [{ age_s: 150, warm: 1, total: 3 }], { options: { ttl: "5m" } }),
          run("d", [{ age_s: 300, warm: 3, total: 3 }], { date: "2026-11-05", options: { ttl: "300s" } }),
          run("e", [{ age_s: 150, warm: 3, total: 3 }], { options: { ttl: "500ms" } }),
          run("g", [{ age_s: 30, warm: 0, total: 3 }], { ...at("model-c"), options: { ttl: "1m" } }),
          run("h", [{ age_s: 60, warm: 3, total: 3 }], { ...at("model-c"), client: "tool-x", options: { ttl: "60s" } }),
          run("i", [{ age_s: 600, warm: 3, total: 3 }, { age_s: 7200, warm: 0, total: 3 }], { ...at("model-c"), client: "direct-2", options: { ttl: "2h" } }),
          run("j", [{ age_s: 300, warm: 3, total: 3 }], { ...at("model-b") }),
          run("k", [{ age_s: 300, warm: 3, total: 3 }], { client: "tool-x", date: "2026-11-04" }),
        ],
      };
      const given = input([], { upstream: catalog, observed: runs, routes, labels, additions: [login], upstreamDate: "2026-11-15" });
      /** Every list of the input in reverse order, and every object with its keys in reverse order. */
      const reversed = <T>(value: T): T =>
        (Array.isArray(value) ? value.map(reversed).reverse() : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversed(item)])) : value) as T;
      const records = (result: ReturnType<typeof resolve>) =>
        Object.fromEntries(Object.values(result.catalog).flatMap((provider) => Object.values(provider.models).map((model) => [`${provider.id}/${model.id}`, ext(model).cache.lifetime])));
      const forward = resolve(given);
      const backward = resolve(reversed(given));
      const original = String.prototype.localeCompare;
      let otherLocale: ReturnType<typeof resolve>;
      try {
        // Another collation: every comparison by the locale the other way round.
        String.prototype.localeCompare = function (this: string, that: string) { return -original.call(this, that); } as typeof original;
        otherLocale = resolve(given);
      } finally {
        String.prototype.localeCompare = original;
      }
      // The evaluations as published are newest first, then by id in plain character order ("z" before "ä"), whatever the locale.
      const published = (result: ReturnType<typeof resolve>) => ext(result.catalog.lab!.models["model-a"]!).cache.evaluations;
      const order = published(forward).map((item) => [item.date, item.id] as const);
      expect(order).toEqual([...order].sort((x, y) => (x[0] === y[0] ? (x[1] < y[1] ? -1 : 1) : x[0] > y[0] ? -1 : 1)));
      expect(order.map(([, id]) => id).filter((id) => id === "z" || id === "ä")).toEqual(["z", "ä"]);
      expect(published(otherLocale).map((item) => item.id)).toEqual(published(forward).map((item) => item.id));
      expect(published(backward).map((item) => item.id)).toEqual(published(forward).map((item) => item.id));
      const a = records(forward)["lab/model-a"]!;
      expect(a.lifetimes.map((item) => [item.retention_profile, item.basis, item.documented_as ?? item.value, item.client, item.parameter])).toEqual([
        ["short", "documented", "5m", null, null],
        ["short", "documented", "300s", null, null],
        ["short", "measured", null, "direct", null],
        ["short", "measured", null, "gateway", null],
        ["short", "measured", "300s", "direct", "cache_control.ttl"],
        ["short", "measured", "5m", "direct", "cache_control.ttl"],
        ["long", "documented", "1h", null, null],
        ["long", "documented", "1h", null, null],
        ["long", "documented", "60m", null, null],
        ["long", "measured", "500ms", "direct", "cache_control.ttl"],
        ["long", "measured", "1h", "gateway", "cache_control.ttl"],
        ["long", "measured", "1h", "gateway", "prompt_cache_retention"],
        ["long", "measured", "60m", "gateway", "cache_control.ttl"],
      ]);
      expect(a.lifetimes[2]).toMatchObject({ client_label: "Straight to the provider", evaluation_ids: ["z", "ä"], lifetime_s: 150 });
      expect(records(forward)["lab/model-c"]!.short).toMatchObject({ documented_s: 60, measured_s: 0, safe_s: 0, clients: 2 });
      expect(records(backward)).toEqual(records(forward));
      expect(records(otherLocale)).toEqual(records(forward));
    });
  });
});
