import { describe, expect, it } from "vitest";
import { clone } from "../src/core/merge.ts";
import { resolve, type ResolveInput } from "../src/core/resolve.ts";
import { ext, providerExt, type AccessRules, type Evidence, type ObservedFile, type OverrideFile, type UpstreamCatalog } from "../src/core/schema.ts";

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
  it("publishes our value for an overridden field and upstream for the rest", () => {
    const { catalog } = resolve(input([contextOverride]));
    const model = catalog.lab?.models["model-a"];
    expect(model?.limit).toEqual({ context: 1000000, output: 64000 });
    expect(ext(model!).provenance).toEqual([
      { path: "limit.context", op: "set", had_upstream: true, upstream: 200000, value: 1000000, reason: "documented higher", evidence },
    ]);
    expect(catalog.lab?.models["model-b"]?.limit).toEqual({ context: 100000, output: 8000 });
    expect(ext(catalog.lab!.models["model-b"]!).provenance).toBeUndefined();
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
    expect(ext(catalog.lab!.models["model-a"]!).provenance).toBeUndefined();
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
    expect(ext(catalog.lab!.models["model-a"]!).provenance).toBeUndefined();
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
    expect(ext(model).cache?.observed).toEqual([
      expect.objectContaining({ run: "run-1", client: "direct", route_label: "Lab API key", all_warm_through_s: 300, source: "https://github.com/example/probe/blob/main/results/run-1.json" }),
    ]);
    expect(ext(model).verified).toBe("2026-11-05");
    expect(ext(model).provenance).toBeUndefined();
  });

  it("creates an entry for a route upstream does not list, and reports routes it cannot place", () => {
    const { catalog, issues } = resolve(input([], { observed, routes, labels: directLabel, additions: [login] }));
    const added = catalog["lab-login"]!.models.a!;
    expect(added).toMatchObject({ name: "Model A", canonical_id: "lab/model-a" });
    expect(added.limit).toBeUndefined();
    expect(ext(added)).toMatchObject({ origin: "added", access: "subscription" });
    expect(ext(added).cache?.observed).toHaveLength(1);
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
    expect(ext(imported).limits?.from_measurement).toBeUndefined();
    expect(ext(imported).limits?.measured?.[0]?.context).toBe(150000);
  });

  it("names clients by their public label, drops note parts on the omit list and skips runs marked as lacking", () => {
    const labelled: ObservedFile = {
      ...observed,
      cache: [
        { ...observed.cache[0]!, id: "tool-x-1.0/R7", client: "tool-x", note: "ToolX 1.0 with patch 12; 5 samples per age" },
        { ...observed.cache[0]!, id: "tool-x-1.0/R8", lacks: "patch 12" },
        { ...observed.cache[0]!, id: "other/R9", client: "mystery" },
      ],
    };
    const labels = { clients: { "tool-x": { id: "gateway", label: "Through a gateway" } }, omit_note_parts_mentioning: ["toolx"] };
    const { catalog, issues } = resolve(input([], { observed: labelled, routes, labels, additions: [login] }));
    const runs = ext(catalog.lab!.models["model-a"]!).cache!.observed!;
    expect(runs.map((run) => [run.run, run.client, run.client_label, run.note])).toEqual([
      ["R7", "gateway", "Through a gateway", "5 samples per age"],
      ["R9", "other", "Another client", undefined],
    ]);
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
