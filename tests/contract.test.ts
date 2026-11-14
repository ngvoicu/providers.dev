import { describe, expect, it } from "vitest";
import { CacheRetentionDeclarationSchema } from "../src/core/cache-contract.ts";
import { CapabilitiesSchema, CostSchema } from "../src/core/metadata-contract.ts";
import { openapi } from "../src/core/openapi.ts";

describe("known metadata fields with upstream extensions", () => {
  const cost = {
    text: {
      input: { price: 2, cache: { read: 0, write: { "5m": 2.5, "1h": 4 } }, future_field: { kept: true }, overrides: [{ when: { context: { gt: 100000 } }, price: 3 }] },
      output: { price: 10, reasoning: 12 },
    },
    multipliers: [{ when: { service_tier: { equals: "priority" } }, factor: { text: 2 } }],
    future_modality: { price: 1 },
  };

  it("validates nested prices while preserving additional upstream fields", () => {
    expect(CostSchema.parse(cost)).toEqual(cost);
    expect(CostSchema.safeParse({ text: { input: { price: "unknown" } } }).success).toBe(false);
    expect(CostSchema.safeParse({ text: { input: { cache: { write: { "1h": "unknown" } } } } }).success).toBe(false);
    expect(CapabilitiesSchema.safeParse({ cache: { implicit: { ttl: 300 } } }).success).toBe(false);
    expect(CapabilitiesSchema.parse({ cache: false, future_capability: true })).toEqual({ cache: false, future_capability: true });
  });

  it("describes the nested fields consumed by the website in OpenAPI", () => {
    const spec = openapi() as { components: { schemas: Record<string, { properties: Record<string, unknown> }> } };
    expect(spec.components.schemas.Entry!.properties.cost).toMatchObject({ properties: { text: { properties: { input: { properties: { price: { type: "number" }, cache: { properties: { read: { type: "number" } } } } } } } } });
    expect(spec.components.schemas.Entry!.properties.capabilities).toHaveProperty("properties.cache");
    expect(spec.components.schemas.CacheModeDocumentation!.properties).toHaveProperty("support");
  });
});

describe("retention declarations", () => {
  const claim = { support: "supported", parameter: null, accepted_values: null, default: null, profiles: [], conditions: [], evidence: [{ kind: "documented", url: "https://example.com", date: "2026-11-14", note: "Confirmation" }] };
  it("rejects a support claim with no confirmed parameter", () => {
    expect(CacheRetentionDeclarationSchema.safeParse(claim).success).toBe(false);
  });
  it("rejects a profile value outside the confirmed values", () => {
    expect(CacheRetentionDeclarationSchema.safeParse({ ...claim, parameter: { name: "retention", location: "body" }, accepted_values: ["5m"], profiles: [{ profile: "long", value: "1h" }] }).success).toBe(false);
  });
});
