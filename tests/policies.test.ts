import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/core/entries.ts";
import { openapi } from "../src/core/openapi.ts";
import { conditionOf, controlsOf, pricingOf } from "../src/core/policies.ts";
import { PricingDeclarationSchema, PricingSchema, RequestControlDeclarationSchema, RequestControlsSchema } from "../src/core/policy-contract.ts";
import { CONTROL_EXAMPLE, PRICING_EXAMPLE } from "../src/core/policy-examples.ts";
import { entryHtml, rowHtml } from "../src/core/render.ts";
import { resolve } from "../src/core/resolve.ts";
import { ext, OverrideFile, UpstreamModel } from "../src/core/schema.ts";

const evidence = [{ kind: "documented" as const, url: "https://example.com/docs", date: "2026-11-14", note: "Fixture source" }];
const noRetention = { support: "unknown" as const, parameter: null, accepted_values: null, default: null, profiles: [], conditions: [], evidence: [] };
const cost = { text: { input: { price: 2, cache: { read: 0, write: { "5m": 2.5, "1h": 4 } }, overrides: [{ when: { context: { gt: 200000 } }, price: 4, cache: { read: 0.2, write: { "1h": 8 } } }] }, output: { price: 10 } }, multipliers: [{ when: { service_tier: { equals: "priority" } }, factor: { text: 2 } }] };
function fixture(authored = false) {
  const model = UpstreamModel.parse({ id: "m", name: "M", canonical_id: "p/m", cost });
  return resolve({
    upstream: { p: { id: "p", name: "P", models: { m: model, other: { ...model, id: "other" } } } },
    additions: [{ id: "plan", name: "Plan", access: "subscription", access_basis: "Fixture", evidence, models: [{ id: "m", inherits: "p/m", evidence: [{ ...evidence[0]!, url: "https://example.com/unrelated-measurement", kind: "measured" }] }] }], routes: {},
    overrides: authored ? [OverrideFile.parse({ provider: "p", rules: [{ models: ["m"], pricing: PRICING_EXAMPLE, request_controls: [CONTROL_EXAMPLE], reason: "Fixture", evidence }] })] : [],
    access: { default: "api", default_basis: "Fixture", patterns: [], providers: {} }, upstreamDate: "2026-11-14",
  }).catalog;
}

describe("uniform pricing and controls", () => {
  it("preserves context thresholds, TTL write prices, zero and combined conditions", () => {
    const pricing = PricingSchema.parse(pricingOf({ cost }, "api", null, evidence));
    expect(pricing.coverage).toBe("partial");
    expect(pricing.rule_order).toBeNull();
    expect(pricing.unparsed).toEqual([]);
    expect(pricing.rules?.find((rule) => rule.id === "cost.text.input.cache.read")?.amount).toBe(0);
    expect(pricing.rules?.find((rule) => rule.id === "cost.text.input.overrides[0].price")).toMatchObject({ when: { kind: "predicate", field: "request.context_tokens", op: "gt", value: 200000 }, applies_to: null, amount: 4 });
    expect(pricing.rules?.find((rule) => rule.id === "cost.text.input.overrides[0].cache.write.1h")).toMatchObject({ meter: "text.cache_write", amount: 8, when: { kind: "all", conditions: [{ field: "request.context_tokens", value: 200000 }, { field: "cache.retention_s", value: 3600 }] } });
    expect(pricing.rules?.at(-1)).toMatchObject({ operation: "multiply", meter: "text.*", amount: 2, when: { field: "request.service_tier", value: "priority" } });
  });

  it("keeps nested and unfamiliar conditions instead of treating them as unconditional", () => {
    expect(conditionOf({ all: [{ context: { gte: 200000, lt: 500000 } }, { any: [{ region: { in: ["eu", "us"] } }, { not: { thinking: { equals: false } } }] }] })).toMatchObject({ kind: "all", conditions: [{ kind: "all", conditions: [{ op: "gte" }, { op: "lt" }] }, { kind: "any" }] });
    expect(conditionOf({ future: { foo: 1 } })).toEqual({ kind: "unknown", raw: { future: { foo: 1 } } });
    expect(conditionOf({ context: { future_operator: 42 } })).toEqual({ kind: "unknown", raw: { context: { future_operator: 42 } } });
    expect(conditionOf({})).toEqual({ kind: "unknown", raw: {} });
  });

  it("distinguishes unknown, subscription reference, incomplete and inapplicable pricing", () => {
    expect(pricingOf({}, "api", null, [])).toMatchObject({ coverage: "unknown", billing: "unknown", rules: null });
    expect(pricingOf({}, "subscription", null, [])).toMatchObject({ coverage: "not_applicable", billing: "not_applicable", rules: null });
    expect(pricingOf({ cost }, "subscription", "p/m", [])).toMatchObject({ billing: "reference", reference_ref: "p/m" });
    expect(pricingOf({ cost: { future_modality: { price: 5 }, text: { input: { unit: "character", price: 1 } } } }, "api", null, [])).toMatchObject({ coverage: "partial", unparsed: [{ path: "cost.future_modality", value: { price: 5 } }], rules: [{ unit: { name: "character", quantity: null } }] });
  });

  it("keeps controls present without inventing request headers or accepting measured settings", () => {
    const controls = RequestControlsSchema.parse(controlsOf({}, noRetention, []));
    expect(controls.items.map((item) => [item.id, item.support, item.bindings, item.options])).toEqual([["cache.retention", "unknown", null, null], ["service_tier", "unknown", null, null]]);
    const known = controlsOf({}, { ...noRetention, support: "supported", parameter: { name: "ttl", location: "Some client setting" }, accepted_values: ["1h"] }, evidence);
    expect(known.items[0]).toMatchObject({ support: "supported", bindings: null, options: [{ value: "1h", attributes: { retention_s: 3600 }, settings: null }] });
  });

  it("validates documentation examples, body paths, evidence and unsupported states", () => {
    expect(PricingDeclarationSchema.parse(PRICING_EXAMPLE)).toEqual(PRICING_EXAMPLE);
    expect(RequestControlDeclarationSchema.parse(CONTROL_EXAMPLE)).toEqual(CONTROL_EXAMPLE);
    expect(RequestControlDeclarationSchema.safeParse({ ...CONTROL_EXAMPLE, support: "unsupported" }).success).toBe(false);
    expect(RequestControlDeclarationSchema.safeParse({ ...CONTROL_EXAMPLE, bindings: [{ location: "body", path: "cache.ttl", scope: "request" }] }).success).toBe(false);
    expect(RequestControlDeclarationSchema.safeParse({ ...CONTROL_EXAMPLE, evidence: [] }).success).toBe(false);
    expect(PricingDeclarationSchema.safeParse({ ...PRICING_EXAMPLE, unparsed: [{ path: "future", value: 1 }] }).success).toBe(false);
  });

  it("publishes one object in summaries and full records, scoped to the declared entry", () => {
    const catalog = fixture(true);
    const index = buildIndex(catalog, "fixture", "2026-11-14T00:00:00Z", "2026-11-14T00:00:00Z");
    const summary = index.entries.find((entry) => entry.ref === "p/m")!;
    const full = ext(catalog.p!.models.m!);
    expect(summary.pricing).toEqual(PRICING_EXAMPLE);
    expect(summary.pricing).toEqual(full.pricing);
    expect(summary.request_controls).toEqual(full.request_controls);
    expect(full.cache.retention).toMatchObject({ support: "supported", accepted_values: ["5m", "1h"], profiles: [{ profile: "short", value: "5m" }, { profile: "long", value: "1h" }] });
    expect(ext(catalog.p!.models.other!).cache.retention.support).toBe("unknown");
    expect(ext(catalog.p!.models.other!).pricing.coverage).toBe("partial");
    expect(summary.origin).toBe("modified");
    const reference = ext(catalog.plan!.models.m!);
    expect(reference.pricing).toMatchObject({ billing: "reference", reference_ref: "p/m", rules: PRICING_EXAMPLE.rules, evidence: PRICING_EXAMPLE.evidence });
    expect(reference.request_controls.items.find((control) => control.id === "cache.retention")?.support).toBe("unknown");
    expect(ext(fixture().plan!.models.m!).pricing.evidence.some((source) => source.url.includes("unrelated-measurement"))).toBe(false);
  });

  it("renders the normalized rates and numeric limits without narrative notes", () => {
    const catalog = fixture(true);
    const model = catalog.p!.models.m!;
    ext(model).limits = { measured: [{ route: "p", route_label: "P", client: "direct", client_label: "Direct", source: "https://example.com/result", input_accepted: 915011, input_refused: 922500, note: "A free-text claim that should stay in raw evidence" }] };
    const index = buildIndex(catalog, "fixture", "2026-11-14T00:00:00Z", "2026-11-14T00:00:00Z");
    const summary = index.entries.find((entry) => entry.ref === "p/m")!;
    const html = entryHtml({ summary, provider: index.providers[0]!, model, now: new Date("2026-11-14T00:00:00Z"), imported: "2026-11-14" });
    const visibleLimits = html.split('<section aria-labelledby="limits">')[1]!.split('</section>')[0]!;
    expect(visibleLimits).toContain("Input accepted");
    expect(visibleLimits).toContain("915,011");
    expect(visibleLimits).not.toContain("accepted an input");
    expect(visibleLimits).not.toContain("A free-text claim");
    expect(html).toContain("Input tokens &gt;");
    expect(html).toContain("x-example-cache");
    expect(html).not.toContain("the prices above do not change");
    expect(rowHtml(summary, { now: new Date("2026-11-14T00:00:00Z") })).toContain("Conditional rates");
  });

  it("keeps every recursive OpenAPI reference resolvable and every new entry field required", () => {
    const spec = openapi() as Record<string, unknown>;
    let references = 0;
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      for (const [key, item] of Object.entries(value)) {
        if (key === "$ref" && typeof item === "string" && item.startsWith("#/")) {
          const target = item.slice(2).split("/").reduce<unknown>((node, segment) => (node as Record<string, unknown> | undefined)?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")], spec);
          expect(target, item).toBeDefined(); references += 1;
        } else visit(item);
      }
    };
    visit(spec);
    expect(references).toBeGreaterThan(10);
    const schemas = (spec.components as { schemas: Record<string, { required?: string[] }> }).schemas;
    expect(schemas.EntrySummary!.required).toEqual(expect.arrayContaining(["pricing", "request_controls"]));
    expect(schemas.EntryExtension!.required).toEqual(expect.arrayContaining(["pricing", "request_controls"]));
  });
});
