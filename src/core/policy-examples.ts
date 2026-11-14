// Documentation fixtures only. Never published as provider data.
import type { Pricing, PricingRule, RequestControl } from "./policy-contract.ts";

const evidence = [{ kind: "documented" as const, url: "https://example.com/pricing", date: "2026-11-14", note: "Illustrative contract example; not actual provider pricing or settings." }];
const base = { operation: "set", currency: "USD", unit: { name: "token", quantity: 1000000 }, applies_to: "all_usage", source_path: null } as const;
const rule = (id: string, meter: string, amount: number, when: PricingRule["when"] = null): PricingRule => ({ ...base, id, meter, amount, when });
export const PRICING_EXAMPLE: Pricing = {
  coverage: "complete", billing: "per_use", reference_ref: null, rule_order: "listed", unparsed: [], evidence,
  rules: [
    rule("input", "text.input", 2), rule("output", "text.output", 10), rule("cache-read", "text.cache_read", 0.2),
    rule("short-write", "text.cache_write", 2.5, { kind: "predicate", field: "cache.retention_s", op: "eq", value: 300 }),
    rule("long-write", "text.cache_write", 4, { kind: "predicate", field: "cache.retention_s", op: "eq", value: 3600 }),
    { id: "long-context", meter: "text.*", operation: "multiply", amount: 2, currency: null, unit: null, applies_to: "all_usage", source_path: null, when: { kind: "predicate", field: "request.input_tokens", op: "gt", value: 200000 } },
  ],
};

export const CONTROL_EXAMPLE: RequestControl = {
  id: "cache.retention", support: "supported", when: { kind: "predicate", field: "request.endpoint", op: "eq", value: "/v1/example" },
  bindings: [{ location: "body", path: "/cache_control/ttl", scope: "content_block" }],
  options: [
    { value: "5m", attributes: { retention_s: 300, profile: "short" }, when: null, settings: [
      { location: "body", path: "/cache_control/type", scope: "content_block", value: "ephemeral" },
      { location: "body", path: "/cache_control/ttl", scope: "content_block", value: "5m" },
    ] },
    { value: "1h", attributes: { retention_s: 3600, profile: "long" }, when: null, settings: [
      { location: "body", path: "/cache_control/type", scope: "content_block", value: "ephemeral" },
      { location: "body", path: "/cache_control/ttl", scope: "content_block", value: "1h" },
      { location: "header", path: "x-example-cache", scope: "request", value: "extended" },
    ] },
  ],
  default: { value: "5m" }, conditions: [], evidence,
};
