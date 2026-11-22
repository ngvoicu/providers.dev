import { describe, expect, it } from "vitest";
import { CACHE_AGES_S } from "../src/core/cache.ts";
import { buildIndex } from "../src/core/entries.ts";
import { emptyInputWindow } from "../src/core/limits.ts";
import { openapi } from "../src/core/openapi.ts";
import { conditionOf, controlsOf, pricingOf } from "../src/core/policies.ts";
import { PricingDeclarationSchema, PricingSchema, RequestControlDeclarationSchema, RequestControlsSchema } from "../src/core/policy-contract.ts";
import { CONTROL_EXAMPLE, PRICING_DECLARATION_EXAMPLE, PRICING_EXAMPLE } from "../src/core/policy-examples.ts";
import { entryHtml, rowHtml } from "../src/core/render.ts";
import { resolve } from "../src/core/resolve.ts";
import { ext, OverrideFile, UpstreamModel } from "../src/core/schema.ts";
import { limitOf } from "./helpers.ts";

const evidence = [{ kind: "documented" as const, url: "https://example.com/docs", date: "2026-11-14", note: "Fixture source" }];
const noRetention = { support: "unknown" as const, parameter: null, accepted_values: null, default: null, profiles: [], conditions: [], evidence: [] };
const cost = { text: { input: { price: 2, cache: { read: 0, write: { "5m": 2.5, "1h": 4 } }, overrides: [{ when: { context: { gt: 200000 } }, price: 4, cache: { read: 0.2, write: { "1h": 8 } } }] }, output: { price: 10 } }, multipliers: [{ when: { service_tier: { equals: "priority" } }, factor: { text: 2 } }] };
function fixture(authored = false) {
  const model = UpstreamModel.parse({ id: "m", name: "M", canonical_id: "p/m", cost });
  return resolve({
    upstream: { p: { id: "p", name: "P", models: { m: model, other: { ...model, id: "other" } } } },
    additions: [{ id: "plan", name: "Plan", access: "subscription", access_basis: "Fixture", evidence, models: [{ id: "m", inherits: "p/m", evidence: [{ ...evidence[0]!, url: "https://example.com/unrelated-measurement", kind: "measured" }] }] }], routes: {},
    overrides: authored ? [OverrideFile.parse({ provider: "p", rules: [{ models: ["m"], pricing: PRICING_DECLARATION_EXAMPLE, request_controls: [CONTROL_EXAMPLE], reason: "Fixture", evidence }] })] : [],
    access: { default: "api", default_basis: "Fixture", patterns: [], providers: {} }, upstreamDate: "2026-11-14",
  }).catalog;
}

describe("uniform pricing and controls", () => {
  it("preserves context thresholds, TTL write prices, zero and combined conditions", () => {
    const pricing = PricingSchema.parse(pricingOf({ cost }, "api", null, evidence));
    expect(pricing.coverage).toBe("partial");
    // models.dev defines how its rules combine, so an imported record says so: base prices, then the overrides in
    // their order, then every matching multiplier.
    expect(pricing.rule_order).toBe("listed");
    expect(pricing.rules!.map((rule) => (rule.operation === "multiply" ? "multiply" : rule.when === null ? "base" : "override")).join(" ")).toMatch(/^(base )+(override )+multiply$/);
    expect(pricing.unparsed).toEqual([]);
    expect(pricing.rules?.find((rule) => rule.id === "cost.text.input.cache.read")?.amount).toBe(0);
    expect(pricing.rules?.find((rule) => rule.id === "cost.text.input.overrides[0].price")).toMatchObject({ when: { kind: "predicate", field: "request.context_tokens", op: "gt", value: 200000 }, applies_to: "all_usage", amount: 4 });
    expect(pricing.rules?.find((rule) => rule.id === "cost.text.input.overrides[0].cache.write.1h")).toMatchObject({ meter: "text.cache_write", amount: 8, when: { kind: "all", conditions: [{ field: "request.context_tokens", value: 200000 }, { field: "cache.retention_s", value: 3600 }] } });
    expect(pricing.rules?.at(-1)).toMatchObject({ operation: "multiply", meter: "text.*", amount: 2, when: { field: "request.service_tier", value: "priority" } });
  });

  it("reads a factor the way models.dev defines it: a number scales every price under it, an object only what it names", () => {
    const priced = { text: { input: { price: 1, cache: { read: 0.1, write: { "5m": 1.25 } } }, output: { price: 4, reasoning: 5 } } };
    const rulesOf = (factor: unknown) => pricingOf({ cost: { ...priced, multipliers: [{ when: { service_tier: { equals: "flex" } }, factor }] } } as never, "api", null, evidence);
    const scaled = (factor: unknown) => rulesOf(factor).rules!.filter((rule) => rule.operation === "multiply").map((rule) => [rule.meter, rule.amount]);
    expect(scaled(0.5)).toEqual([["*", 0.5]]);
    expect(scaled({ text: 0.5 })).toEqual([["text.*", 0.5]]);
    // The shape Google's entries use: the input price and its cache read are named, the output side is one number.
    expect(scaled({ text: { input: { price: 0.5, cache: { read: 0.5 } }, output: 0.5 } })).toEqual([["text.input", 0.5], ["text.cache_read", 0.5], ["text.output", 0.5], ["text.reasoning_output", 0.5]]);
    // A number for the input side scales every input price that exists: here input, cache read and cache write.
    expect(scaled({ text: { input: 2, output: { price: 3 } } })).toEqual([["text.input", 2], ["text.cache_read", 2], ["text.cache_write", 2], ["text.output", 3]]);
    // Every kind of content is scaled the same way, and a web search is a charge of its own.
    expect(scaled({ text: 1.8, audio: 1.8, web_search: 2 })).toEqual([["text.*", 1.8], ["audio.*", 1.8], ["web_search", 2]]);
    // What is not a kind of content models.dev prices stays as the source has it.
    expect(rulesOf({ text: 1.8, hologram: 3 }).unparsed).toEqual([{ path: "cost.multipliers[0].factor.hologram", value: 3 }]);
    // Every rule of a fan-out has its own id.
    const ids = rulesOf({ text: { input: 2 } }).rules!.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names peak and off-peak hours and publishes the prices a multiplier makes", () => {
    const hours = { utc_days: { in: ["mon", "tue", "wed", "thu", "fri"] }, any: [{ all: [{ utc_hours: { gte: "01:00" } }, { utc_hours: { lt: "04:00" } }] }], not: { holiday: { equals: "CN" } } };
    const priced = { text: { input: { price: 0.15, cache: { read: 0.003 } }, output: { price: 0.6 } } };
    const peak = pricingOf({ cost: { ...priced, multipliers: [{ when: hours, factor: 2 }] } } as never, "api", null, evidence).rules!.at(-1)!;
    // The base price is the price outside the window, so a rule that raises it in a window marks the peak hours.
    expect(peak).toMatchObject({ operation: "multiply", meter: "*", amount: 2, period: "peak", applies_to: "all_usage" });
    expect(peak.resulting_rates).toEqual([
      { meter: "text.input", amount: 0.3, currency: "USD", unit: { name: "token", quantity: 1000000 } },
      { meter: "text.cache_read", amount: 0.006, currency: "USD", unit: { name: "token", quantity: 1000000 } },
      { meter: "text.output", amount: 1.2, currency: "USD", unit: { name: "token", quantity: 1000000 } },
    ]);
    const offPeak = pricingOf({ cost: { ...priced, multipliers: [{ when: { utc_hours: { gte: "14:00" } }, factor: { text: 0.5 } }] } } as never, "api", null, evidence).rules!.at(-1)!;
    expect(offPeak).toMatchObject({ period: "off_peak", meter: "text.*" });
    expect(offPeak.resulting_rates!.map((rate) => rate.amount)).toEqual([0.075, 0.0015, 0.3]);
    // A price set for a window is named by how it compares with the base price; one equal to it has no name.
    const windows = pricingOf({ cost: { text: { input: { price: 0.132, overrides: [{ when: { utc_hours: { lt: "16:00" } }, price: 0.132 }, { when: { utc_hours: { gte: "16:00" } }, price: 0.0825 }] } } } } as never, "api", null, evidence).rules!;
    expect(windows.map((rule) => [rule.amount, rule.period, rule.resulting_rates])).toEqual([[0.132, null, null], [0.132, null, null], [0.0825, "off_peak", null]]);
    // Not every conditional rule is a time rule: a tier or a date has no period, and still gets its prices.
    const tier = pricingOf({ cost: { ...priced, multipliers: [{ when: { service_tier: { equals: "priority" } }, factor: 1.1 }, { when: { date: { gte: "2026-12-01" } }, factor: { text: { input: { price: 2 } } } }] } } as never, "api", null, evidence).rules!;
    expect(tier.at(-2)).toMatchObject({ period: null, resulting_rates: [{ meter: "text.input", amount: 0.165 }, { meter: "text.cache_read", amount: 0.0033 }, { meter: "text.output", amount: 0.66 }] });
    expect(tier.at(-1)).toMatchObject({ period: null, meter: "text.input", resulting_rates: [{ meter: "text.input", amount: 0.3 }] });
    // A multiplier with no base price in its scope has nothing to multiply.
    expect(pricingOf({ cost: { text: { input: { overrides: [{ when: { context: { gt: 1 } }, price: 2 }] } }, multipliers: [{ when: { service_tier: { equals: "flex" } }, factor: 0.5 }] } } as never, "api", null, evidence).rules!.at(-1)!.resulting_rates).toBeNull();
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
    // A subscription entry with no API entry to refer to: a listed zero is the plan and not a price per token, so
    // nothing is published as a rate. Nor is any other listed price (design/sources-side-by-side.md, 2.4): it stays in
    // the entry's cost; only an entry providers.dev adds with a price of its own keeps it as rules.
    const free = { text: { input: { price: 0, cache: { read: 0, write: 0 } }, output: { price: 0 } } };
    expect(pricingOf({ cost: free }, "subscription", null, evidence)).toEqual({ coverage: "not_applicable", billing: "not_applicable", reference_ref: null, rules: null, rule_order: null, unparsed: [], evidence: [{ ...evidence[0], note: "The source lists a price of 0 for this entry, which is a subscription: no price per token is published." }] });
    expect(pricingOf({ cost: free }, "api", null, evidence)).toMatchObject({ billing: "per_use", rules: [{ amount: 0 }, { amount: 0 }, { amount: 0 }, { amount: 0 }] });
    expect(pricingOf({ cost }, "subscription", null, evidence)).toMatchObject({ coverage: "not_applicable", billing: "not_applicable", reference_ref: null, rules: null, evidence: [{ note: expect.stringMatching(/no API entry of the same model to refer to/) }] });
    expect(pricingOf({ cost }, "subscription", null, evidence, undefined, true)).toMatchObject({ billing: "unknown", reference_ref: null, coverage: "partial" });
    expect(pricingOf({ cost: { future_modality: { price: 5 }, text: { input: { unit: "character", price: 1 } } } }, "api", null, [])).toMatchObject({ coverage: "partial", unparsed: [{ path: "cost.future_modality", value: { price: 5 } }], rules: [{ unit: { name: "character", quantity: 1000000 } }] });
  });

  it("reads audio, image, video and web search prices as charges like the text ones, each with its unit", () => {
    const cost = {
      audio: { input: { price: 3, cache: { read: 0.3 }, overrides: [{ when: { context: { gt: 32000 } }, price: 6 }] }, output: { unit: "second", price: 0.01 } },
      image: { output: { unit: "image", price: 0.035, overrides: [{ when: { quality: { equals: "low" } }, price: 0.01 }] } },
      video: { output: { unit: "second", price: 0.24, overrides: [{ when: { resolution: { equals: "720P" }, generate_audio: { equals: false } }, price: 0.14 }] } },
      web_search: { price: 5, overrides: [{ when: { search_context_size: { equals: "high" } }, price: 12 }] },
      multipliers: [{ when: { service_tier: { equals: "flex" } }, factor: { audio: { input: { price: 0.5, cache: { read: 0.5 } } }, image: 0.5 } }],
    };
    const pricing = pricingOf({ cost } as never, "api", null, evidence);
    expect(pricing.unparsed).toEqual([]);
    const said = (rule: (typeof pricing.rules & object)[number]) => [rule.meter, rule.amount, rule.unit && `${rule.unit.quantity} ${rule.unit.name}`];
    // models.dev: per 1M for a token and a character, per 1 unit otherwise, and per 1,000 web searches.
    expect(pricing.rules!.filter((rule) => rule.when === null).map(said)).toEqual([
      ["audio.input", 3, "1000000 token"], ["audio.cache_read", 0.3, "1000000 token"], ["audio.output", 0.01, "1 second"],
      ["image.output", 0.035, "1 image"], ["video.output", 0.24, "1 second"], ["web_search", 5, "1000 search"],
    ]);
    const when = (id: string) => pricing.rules!.find((rule) => rule.id === id)!;
    expect(when("cost.image.output.overrides[0].price")).toMatchObject({ meter: "image.output", amount: 0.01, unit: { name: "image", quantity: 1 }, when: { field: "request.quality", op: "eq", value: "low" } });
    expect(when("cost.video.output.overrides[0].price")).toMatchObject({ when: { kind: "all", conditions: [{ field: "request.resolution", value: "720P" }, { field: "request.generate_audio", value: false }] } });
    expect(when("cost.web_search.overrides[0].price")).toMatchObject({ meter: "web_search", amount: 12, unit: { name: "search", quantity: 1000 }, when: { field: "request.search_context_size", value: "high" } });
    // A factor names the charges it scales, and the prices it makes are published with their units.
    expect(when("cost.multipliers[0].factor.audio.input.price")).toMatchObject({ meter: "audio.input", amount: 0.5, resulting_rates: [{ meter: "audio.input", amount: 1.5 }] });
    expect(when("cost.multipliers[0].factor.image")).toMatchObject({ meter: "image.*", resulting_rates: [{ meter: "image.output", amount: 0.0175, unit: { name: "image", quantity: 1 } }] });
    // models.dev's operator for a list ("at least this many items") is one of the grammar's. One it does not have is
    // kept as the source wrote it, and the rule is still published.
    const listed = (when: object) => pricingOf({ cost: { audio: { input: { unit: "minute", price: 1, overrides: [{ when, price: 2 }] } } } } as never, "api", null, evidence).rules!.at(-1);
    expect(listed({ keyterms_prompt: { min_items: 1 } })).toMatchObject({ amount: 2, unit: { name: "minute", quantity: 1 }, when: { kind: "predicate", field: "request.keyterms_prompt", op: "min_items", value: 1 } });
    expect(listed({ keyterms_prompt: { longest: 1 } })).toMatchObject({ amount: 2, when: { kind: "unknown", raw: { keyterms_prompt: { longest: 1 } } } });
  });

  it("keeps controls present without inventing request headers or accepting measured settings", () => {
    const controls = RequestControlsSchema.parse(controlsOf({}, noRetention, []));
    expect(controls.items.map((item) => [item.id, item.support, item.bindings, item.options])).toEqual([["cache.retention", "unknown", null, null], ["service_tier", "unknown", null, null]]);
    const known = controlsOf({}, { ...noRetention, support: "supported", parameter: { name: "ttl", location: "Some client setting" }, accepted_values: ["1h"] }, evidence);
    expect(known.items[0]).toMatchObject({ support: "supported", bindings: null, options: [{ value: "1h", attributes: { retention_s: 3600 }, settings: null }] });
  });

  it("validates documentation examples, body paths, evidence and unsupported states", () => {
    expect(PricingDeclarationSchema.parse(PRICING_DECLARATION_EXAMPLE)).toEqual(PRICING_DECLARATION_EXAMPLE);
    // The published form adds what follows from the rules; an author does not write it.
    expect(PricingSchema.parse(PRICING_EXAMPLE)).toEqual(PRICING_EXAMPLE);
    expect(PricingDeclarationSchema.safeParse(PRICING_EXAMPLE).success).toBe(false);
    expect(RequestControlDeclarationSchema.parse(CONTROL_EXAMPLE)).toEqual(CONTROL_EXAMPLE);
    expect(RequestControlDeclarationSchema.safeParse({ ...CONTROL_EXAMPLE, support: "unsupported" }).success).toBe(false);
    expect(RequestControlDeclarationSchema.safeParse({ ...CONTROL_EXAMPLE, bindings: [{ location: "body", path: "cache.ttl", scope: "request" }] }).success).toBe(false);
    expect(RequestControlDeclarationSchema.safeParse({ ...CONTROL_EXAMPLE, evidence: [] }).success).toBe(false);
    expect(PricingDeclarationSchema.safeParse({ ...PRICING_DECLARATION_EXAMPLE, unparsed: [{ path: "future", value: 1 }] }).success).toBe(false);
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
    ext(model).limits = { measured: [limitOf({ route: "p", route_label: "P", input_accepted: 915011, input_refused: 922500, note: "A free-text claim that should stay in raw evidence" })], from_measurement: [], input_window: emptyInputWindow() };
    const index = buildIndex(catalog, "fixture", "2026-11-14T00:00:00Z", "2026-11-14T00:00:00Z");
    const summary = index.entries.find((entry) => entry.ref === "p/m")!;
    const html = entryHtml({ summary, provider: index.providers[0]!, model, today: { date: new Date("2026-11-14T00:00:00Z"), stale_after_days: 90 }, cache_ages_s: CACHE_AGES_S, imported: "2026-11-14" });
    const visibleLimits = html.split('<section aria-labelledby="limits">')[1]!.split('</section>')[0]!;
    expect(visibleLimits).toContain("Input accepted");
    expect(visibleLimits).toContain("915,011");
    expect(visibleLimits).not.toContain("accepted an input");
    expect(visibleLimits).not.toContain("A free-text claim");
    // A condition is said in words, and a multiplier comes with the prices it makes of the base rates.
    expect(html).toContain("Input above 200,000 tokens");
    expect(html).toContain("<strong>Off-peak hours</strong>");
    expect(html).toContain("From 16:00 UTC");
    expect(html).toContain('$1 <span class="muted">/ 1M tokens</span> <span class="muted">· × 0.5</span>');
    expect(html).toContain("Whole request");
    expect(html).toContain("x-example-cache");
    expect(html).not.toContain("the prices above do not change");
    expect(rowHtml(summary, { today: { date: new Date("2026-11-14T00:00:00Z"), stale_after_days: 90 } })).toContain("Conditional rates");
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
