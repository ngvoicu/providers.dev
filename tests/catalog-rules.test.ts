import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { familyRuleVerdict, resolve, versionNextTo, type ResolveInput } from "../src/core/resolve.ts";
import { CatalogRules, type AccessRules, type Evidence, type ObservedFile, type UpstreamCatalog } from "../src/core/schema.ts";
import { ROOT } from "../scripts/lib/files.ts";

const evidence: Evidence[] = [{ kind: "documented", url: "https://example.com/docs", date: "2026-11-01" }];
const access: AccessRules = { default: "api", default_basis: "default", patterns: [], providers: {} };

/** The rules as written in data/authored/catalog-rules.yaml. */
const rules = CatalogRules.parse(parseYaml(readFileSync(join(ROOT, "data", "authored", "catalog-rules.yaml"), "utf8")));
const ruleOf = (family: string) => rules.exclude.find((rule) => rule.family === family)!;

/** Each family: spellings seen in the catalog that must go, and spellings that must stay. Model id, then canonical id, then name. */
type Spelling = [id: string, canonical: string | null, name?: string];
const cases: Record<string, { out: Spelling[]; kept: Spelling[] }> = {
  "claude-opus": {
    out: [
      ["claude-opus-4-20250514", "anthropic/claude-opus-4-20250514"],
      ["anthropic/claude-opus-4.1", "anthropic/claude-opus-4-1"],
      ["claude-opus-4-1-20250805-thinking", "anthropic/claude-opus-4-1-20250805"],
      ["claude-opus4-7", "anthropic/claude-opus-4-7"],
      ["claude-4-opus", "anthropic/claude-opus-4-0"],
      ["anthropic/claude-opus-4.6:thinking:8192", "anthropic/claude-opus-4-6"],
      ["claude-opus-4-8@default", "anthropic/claude-opus-4-8"],
      ["claude-opus-5", "anthropic/claude-opus-5"],
      ["claude-opus-4-5-20251101", null, "Claude Opus 4.5"],
      ["claude-opus-4-5", "anthropic/claude-opus-4-5", "Claude Opus 4.5 (latest)"],
    ],
    kept: [
      ["claude-opus-5-5", "anthropic/claude-opus-5-5"],
      ["claude-opus-5-5-fast", "anthropic/claude-opus-5-5"],
      ["anthropic/claude-opus-5.5:thinking", "anthropic/claude-opus-5-5"],
      ["~anthropic/claude-opus-latest", null, "Anthropic: Claude Opus Latest"],
      ["anthropic/claude-opus-latest", "anthropic/claude-opus-5-5", "Claude Opus Latest (Claude Opus 5.5)"],
      ["claude-opus-6", "anthropic/claude-opus-6"],
      ["claude-6-opus", null],
    ],
  },
  "claude-sonnet": {
    out: [
      ["claude-3-7-sonnet-20250219", "anthropic/claude-3-7-sonnet-20250219"],
      ["claude-3.5-sonnet-v2", "anthropic/claude-3-5-sonnet-20241022"],
      ["anthropic/claude-sonnet-3.5-june", null, "Claude-Sonnet-3.5-June"],
      ["claude-4.5-sonnet", "anthropic/claude-sonnet-4-5"],
      ["claude-5-sonnet", "anthropic/claude-sonnet-5"],
      ["duo-chat-sonnet-5", "anthropic/claude-sonnet-5"],
      ["claude-sonnet-4@eu", "anthropic/claude-sonnet-4-0"],
      ["claude-sonnet-4-5-think", "anthropic/claude-sonnet-4-5"],
      ["claude-sonnet-4-6:low-cost", "anthropic/claude-sonnet-4-6"],
    ],
    kept: [
      ["claude-sonnet-5-5", "anthropic/claude-sonnet-5-5"],
      ["claude-sonnet-5.5:low-cost", "anthropic/claude-sonnet-5-5"],
      ["claude-5.5-sonnet", null],
      ["~anthropic/claude-sonnet-latest", null],
      ["claude-sonnet-7", null],
    ],
  },
  "claude-haiku": {
    out: [
      ["claude-3-haiku", "anthropic/claude-3-haiku-20240307"],
      ["claude-3-5-haiku-20241022", "anthropic/claude-3-5-haiku-20241022"],
      ["claude-haiku-4-5@eu", "anthropic/claude-haiku-4-5"],
      ["claude-haiku-4-5-20251001", null, "Claude Haiku 4.5"],
    ],
    kept: [
      ["anthropic-claude-5.5-haiku", "anthropic/claude-haiku-5-5"],
      ["Claude Haiku 5.5", null, "Claude Haiku 5.5"],
      ["claude-haiku-5-5:thinking", "anthropic/claude-haiku-5-5"],
      ["anthropic/claude-haiku-latest", null],
      ["claude-haiku-6", null],
    ],
  },
  "claude-fable": {
    out: [
      ["claude-fable-5", null, "Claude Fable 5"],
      ["anthropic/claude-fable-5.1", "anthropic/claude-fable-5-1"],
      ["claude-fable-5-1:thinking", "anthropic/claude-fable-5-1"],
    ],
    kept: [
      ["claude-fable-5-2", "anthropic/claude-fable-5-2"],
      ["claude-fable-5.2-fast", "anthropic/claude-fable-5-2"],
      ["claude-fable-5-2:low-cost", "anthropic/claude-fable-5-2"],
      ["~anthropic/claude-fable-latest", null],
      ["claude-fable-6", null],
    ],
  },
};

describe("catalog rules: reading a version", () => {
  it("reads the version on either side of the word and never takes a date for one", () => {
    expect(versionNextTo("claude-opus-4-20250514", "opus")).toEqual([4, 0]);
    expect(versionNextTo("claude-opus-4-1-20250805", "opus")).toEqual([4, 1]);
    expect(versionNextTo("claude-3-opus-20240229", "opus")).toEqual([3, 0]);
    expect(versionNextTo("claude-3-7-sonnet-20250219", "sonnet")).toEqual([3, 7]);
    expect(versionNextTo("Claude Opus 4.1 (Thinking)", "opus")).toEqual([4, 1]);
    expect(versionNextTo("claude-opus-latest", "opus")).toBeNull();
  });

  for (const [family, { out, kept }] of Object.entries(cases)) {
    it(`${family}: leaves out the earlier versions in every spelling and keeps the rest`, () => {
      const rule = ruleOf(family);
      const verdict = ([id, canonical, name]: Spelling) => familyRuleVerdict({ id, family, name: name ?? id, ...(canonical ? { canonical_id: canonical } : {}) }, rule);
      expect(out.map((spelling) => [spelling[0], verdict(spelling)])).toEqual(out.map((spelling) => [spelling[0], "out"]));
      expect(kept.map((spelling) => [spelling[0], verdict(spelling)])).toEqual(kept.map((spelling) => [spelling[0], "kept"]));
    });
  }

  it("does not touch another maker's model that has the word in its name", () => {
    const opus = ruleOf("claude-opus");
    const fable = ruleOf("claude-fable");
    expect(familyRuleVerdict({ id: "Gemma-4-31B-Claude-4.6-Opus-Reasoning-Distilled", family: "claude", name: "Gemma 4 31B Claude 4.6 Opus Reasoning Distilled" }, opus)).toBeNull();
    expect(familyRuleVerdict({ id: "Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-Derestricted", family: "qwen3.5" }, opus)).toBeNull();
    expect(familyRuleVerdict({ id: "gemma-4-26b-a4b-it-opusdistill", family: "gemma", name: "Opus Distill" }, opus)).toBeNull();
    expect(familyRuleVerdict({ id: "Gemma-4-31B-Fabled", family: "gemma" }, fable)).toBeNull();
    expect(familyRuleVerdict({ id: "qwen/qwen3.8-27b-fable", family: "qwen" }, fable)).toBeNull();
  });
});

describe("catalog rules: in the build", () => {
  const model = (id: string, family: string, canonical?: string) => ({ id, name: id, family, ...(canonical ? { canonical_id: canonical } : {}), limit: { context: 200000, output: 32000 } });
  const upstream = (): UpstreamCatalog => ({
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      models: {
        "claude-opus-4-8": model("claude-opus-4-8", "claude-opus"),
        "claude-opus-5-5": model("claude-opus-5-5", "claude-opus"),
        "claude-sonnet-5": model("claude-sonnet-5", "claude-sonnet"),
      },
    },
    gateway: {
      id: "gateway",
      name: "Gateway",
      models: {
        "anthropic/claude-opus-5": model("anthropic/claude-opus-5", "claude-opus", "anthropic/claude-opus-5"),
        "anthropic/claude-opus-5.5": model("anthropic/claude-opus-5.5", "claude-opus", "anthropic/claude-opus-5-5"),
        "~anthropic/claude-opus-latest": model("~anthropic/claude-opus-latest", "claude-opus"),
        "anthropic/claude-opus-next": model("anthropic/claude-opus-next", "claude-opus"),
        "Gemma-4-31B-Claude-4.6-Opus-Reasoning-Distilled": model("Gemma-4-31B-Claude-4.6-Opus-Reasoning-Distilled", "claude"),
      },
    },
  });
  const input = (more: Partial<ResolveInput> = {}): ResolveInput => ({ upstream: upstream(), additions: [], overrides: [], access, routes: {}, catalogRules: rules, ...more });

  it("removes the earlier versions at every provider and publishes one item per rule with its count", () => {
    const { catalog, exclusions, issues } = resolve(input());
    expect(Object.keys(catalog.anthropic!.models)).toEqual(["claude-opus-5-5"]);
    expect(Object.keys(catalog.gateway!.models)).toEqual(["Gemma-4-31B-Claude-4.6-Opus-Reasoning-Distilled", "anthropic/claude-opus-5.5", "anthropic/claude-opus-next", "~anthropic/claude-opus-latest"]);
    expect(exclusions).toEqual([
      { kind: "rule", target: "claude-opus-before-5.5", leaves_out: "Claude Opus versions before 5.5, at every provider", reason: "Editorial choice of providers.dev: Claude Opus versions before 5.5 are not listed.", date: "2026-11-16", evidence: [], entries: 2 },
      expect.objectContaining({ kind: "rule", target: "claude-sonnet-before-5.5", entries: 1 }),
      expect.objectContaining({ kind: "rule", target: "claude-haiku-before-5.5", entries: 0 }),
      expect.objectContaining({ kind: "rule", target: "claude-fable-before-5.2", entries: 0 }),
    ]);
    // An entry of the family with no version anywhere is published and reported, not guessed.
    expect(issues).toEqual([expect.objectContaining({ level: "warning", code: "rule-version-unread", target: "gateway/anthropic/claude-opus-next" })]);
  });

  it("raises no issue for an override that names an entry a rule leaves out", () => {
    const redundant = { models: ["anthropic/claude-opus-5"], set: { limit: { context: 200000 } }, reason: "r", evidence };
    const { catalog, issues } = resolve(
      input({
        overrides: [
          {
            provider: "gateway",
            rules: [
              // A correction that would be redundant, and a selection naming the removed entry beside a kept one, as aimlapi's does.
              redundant,
              {
                select: { cache_mode: "explicit", models: ["anthropic/claude-opus-5", "anthropic/claude-opus-5.5"] },
                request_controls: [{ id: "cache.retention", support: "supported", when: null, bindings: [{ location: "body", path: "/cache_control/ttl", scope: "content_block" }], options: [], default: null, conditions: [], evidence: [{ kind: "documented", url: "https://example.com/docs", date: "2026-11-01", note: "The request field." }] }],
                reason: "r",
                evidence,
              },
            ],
          },
        ],
      }),
    );
    expect(catalog.gateway!.models["anthropic/claude-opus-5"]).toBeUndefined();
    expect(issues.filter((issue) => issue.target.startsWith("gateway/anthropic/claude-opus-5#") || issue.target === "gateway/anthropic/claude-opus-5")).toEqual([]);
    // Without the rule the same override is reported, as before.
    const { issues: without } = resolve(input({ catalogRules: { exclude: [] }, overrides: [{ provider: "gateway", rules: [redundant] }] }));
    expect(without).toContainEqual(expect.objectContaining({ code: "redundant-override", target: "gateway/anthropic/claude-opus-5#limit.context" }));
  });

  it("reports a measurement of an entry a rule leaves out and publishes it nowhere", () => {
    const observed: ObservedFile = {
      schema: 1,
      repository: "https://github.com/example/probe",
      routes: { "gateway-api": "Gateway API key" },
      clients: { direct: "plain requests" },
      cache: [
        { id: "run-1", route: "gateway-api", client: "direct", model: "anthropic/claude-opus-5", models_dev: "gateway/anthropic/claude-opus-5", date: "2026-11-05", source: "results/run-1.json", checks: [{ age_s: 300, warm: 3, total: 3 }], latest: true },
      ],
      limits: [],
      known: [],
    };
    const labels = { clients: { direct: { id: "direct", label: "Straight to the provider" } }, omit_note_parts_mentioning: [] };
    const { catalog, issues } = resolve(input({ observed, routes: { "gateway-api": { provider: "gateway" } }, labels }));
    expect(catalog.gateway!.models["anthropic/claude-opus-5"]).toBeUndefined();
    expect(issues.filter((issue) => issue.code === "excluded-observation")).toEqual([
      { level: "warning", code: "excluded-observation", target: "gateway/anthropic/claude-opus-5", message: "Measurements for gateway/anthropic/claude-opus-5 were not published: the catalog rule claude-opus-before-5.5 leaves the entry out." },
    ]);
    expect(JSON.stringify(catalog)).not.toContain("run-1");
  });
});
