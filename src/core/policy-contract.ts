// Shared conditions, pricing and request controls. No provider-specific branches in the public contract.
import { z } from "zod";
import type { Json } from "./merge.ts";

export type Condition =
  | { kind: "predicate"; field: string; op: "eq" | "in" | "gt" | "gte" | "lt" | "lte"; value: Json }
  | { kind: "all" | "any"; conditions: Condition[] }
  | { kind: "not"; condition: Condition }
  | { kind: "unknown"; raw: Json };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() => z.union([
  z.strictObject({ kind: z.literal("predicate"), field: z.string().min(1), op: z.enum(["eq", "in", "gt", "gte", "lt", "lte"]), value: z.json() }),
  z.strictObject({ kind: z.enum(["all", "any"]), conditions: z.array(ConditionSchema).min(1) }),
  z.strictObject({ kind: z.literal("not"), condition: ConditionSchema }),
  z.strictObject({ kind: z.literal("unknown"), raw: z.json() }),
])).describe("Shared condition tree. all = AND, any = OR, not = negation. Unknown conditions cannot be assumed true or false. request.context_tokens preserves the source's context threshold; it does not mean the model's maximum window or necessarily input-only tokens. Authored rules may use request.input_tokens explicitly.");

export const PolicyEvidenceSchema = z.strictObject({
  kind: z.enum(["documented", "measured"]), url: z.url(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), note: z.string(),
});
export const CoverageSchema = z.enum(["unknown", "partial", "complete", "not_applicable"])
  .describe("unknown = no usable record; partial = known fields without a completeness claim; complete = explicitly confirmed for the stated scope; not_applicable = no per-use billing on this access. Empty lists alone never prove absence.");

export const BillingUnitSchema = z.strictObject({
  name: z.string().min(1).describe("For example token, character, request, second or token_hour."),
  quantity: z.number().positive().nullable().describe("Amount is charged per this many units. Null = the source does not establish the scale."),
});

export const PricingRuleSchema = z.strictObject({
  id: z.string().min(1),
  when: ConditionSchema.nullable().describe("Null = unconditional base rule. A condition with kind=unknown remains unresolved."),
  meter: z.string().min(1).describe("The charge affected, e.g. text.input, text.output, text.cache_read, text.cache_write or text.cache_storage. text.* and * are multiplier scopes."),
  operation: z.enum(["set", "multiply"]),
  amount: z.number().nonnegative().describe("A price for set, or a factor for multiply. Zero is a known zero, never missing."),
  currency: z.string().nullable().describe("ISO currency for a price; null for multipliers or an unknown currency."),
  unit: BillingUnitSchema.nullable().describe("Billing unit and scale. Null for multipliers or an unknown unit."),
  applies_to: z.enum(["all_usage", "above_threshold"]).nullable().describe("Whether the rate applies to all matching usage or only the portion above the threshold. Null = not established; never infer marginal billing."),
  source_path: z.string().nullable().describe("Field in the original cost record. Null for a separately authored rule."),
});
export const PricingSchema = z.strictObject({
  coverage: CoverageSchema,
  billing: z.enum(["per_use", "reference", "not_applicable", "unknown"]).describe("reference = prices inherited from another entry, not the subscription's bill."),
  reference_ref: z.string().nullable(),
  rules: z.array(PricingRuleSchema).nullable().describe("Base prices, conditional replacements and multipliers. Null = unknown. [] proves no rules only with complete coverage."),
  rule_order: z.literal("listed").nullable().describe("listed = process matching rules in array order per meter: set replaces the rate and multiply scales it. Null = combination precedence is unconfirmed; this record cannot produce an authoritative combined quote."),
  unparsed: z.array(z.strictObject({ path: z.string(), value: z.json() })).describe("Source fields not normalized, retained without loss. Nonempty means coverage is partial."),
  evidence: z.array(PolicyEvidenceSchema),
}).describe("Normalized pricing present on every entry and summary. Source imports are partial unless completeness is explicitly confirmed. Unknown applicability, units or rule interactions must not silently resolve to a base price.");
export type Pricing = z.infer<typeof PricingSchema>;
export type PricingRule = z.infer<typeof PricingRuleSchema>;
export type PolicyEvidence = z.infer<typeof PolicyEvidenceSchema>;

export const RequestBindingSchema = z.strictObject({
  location: z.enum(["header", "body", "query"]),
  path: z.string().min(1).describe("Header/query name, or JSON Pointer relative to the body scope. A body path uses /cache_control/ttl, not a header name."),
  scope: z.enum(["request", "content_block"]).nullable().describe("Where the binding is applied. Null = scope unknown."),
});
export const RequestSettingSchema = RequestBindingSchema.extend({ value: z.json() });
export const RequestOptionSchema = z.strictObject({
  value: z.json().describe("The provider's actual accepted value, not a display alias."),
  attributes: z.record(z.string(), z.json()).nullable().describe("Normalized meaning when known, e.g. retention_s: 3600 and profile: long. Short/long alone never specifies a duration."),
  settings: z.array(RequestSettingSchema).nullable().describe("Exact fields and any companion headers for this option. Null = transport unknown."),
  when: ConditionSchema.nullable(),
});
export const RequestControlSchema = z.strictObject({
  id: z.string().min(1).describe("Semantic id, e.g. cache.retention or service_tier; independent of the provider's wire field."),
  support: z.enum(["supported", "unsupported", "unknown"]),
  when: ConditionSchema.nullable().describe("Scope of the support claim: endpoint, protocol, region or another request condition."),
  bindings: z.array(RequestBindingSchema).nullable().describe("Known places this control is sent. Null means transport is unconfirmed, even when support is documented."),
  options: z.array(RequestOptionSchema).nullable(),
  default: z.strictObject({ value: z.json() }).nullable().describe("Known default wrapped in value so an explicit JSON null differs from an unknown default."),
  conditions: z.array(z.string()).describe("Source restrictions not yet represented as condition trees. Nonempty means a caller must not treat the control as unconditional."),
  evidence: z.array(PolicyEvidenceSchema),
});
export const RequestControlsSchema = z.strictObject({
  coverage: CoverageSchema,
  items: z.array(RequestControlSchema).describe("Always includes cache.retention and service_tier. Additional controls use the same schema. No control is inherited across access routes."),
});
export type RequestControls = z.infer<typeof RequestControlsSchema>;
export type RequestControl = z.infer<typeof RequestControlSchema>;

export const PricingDeclarationSchema = PricingSchema.superRefine((value, ctx) => {
  if (value.coverage !== "unknown" && value.evidence.length === 0) ctx.addIssue({ code: "custom", path: ["evidence"], message: "Pricing declarations need source evidence." });
  if (value.coverage === "complete" && (value.rules === null || value.unparsed.length > 0)) ctx.addIssue({ code: "custom", path: ["coverage"], message: "Complete pricing needs rules and no unparsed fields." });
  if (value.evidence.some((source) => source.date === null || source.note.trim() === "")) ctx.addIssue({ code: "custom", path: ["evidence"], message: "Authored evidence needs a date and confirmation note." });
  const unresolved = (condition: Condition | null): boolean => condition !== null && (condition.kind === "unknown" || (condition.kind === "not" ? unresolved(condition.condition) : (condition.kind === "all" || condition.kind === "any") && condition.conditions.some(unresolved)));
  if (value.coverage === "complete" && value.rules?.some((rule) => unresolved(rule.when))) ctx.addIssue({ code: "custom", path: ["coverage"], message: "Complete pricing cannot contain unresolved conditions." });
});
export const RequestControlDeclarationSchema = RequestControlSchema.superRefine((value, ctx) => {
  if (value.evidence.length === 0) ctx.addIssue({ code: "custom", path: ["evidence"], message: "Request controls need source evidence." });
  if (value.evidence.some((source) => source.date === null || source.note.trim() === "")) ctx.addIssue({ code: "custom", path: ["evidence"], message: "Authored evidence needs a date and confirmation note." });
  if (value.id === "cache.retention" && value.support === "supported" && !value.bindings?.length) ctx.addIssue({ code: "custom", path: ["bindings"], message: "Supported cache retention needs a confirmed request binding." });
  if (value.support !== "supported" && (value.bindings !== null || value.options !== null || value.default !== null)) ctx.addIssue({ code: "custom", path: ["support"], message: "Unknown or unsupported controls cannot declare accepted settings." });
  for (const binding of [...(value.bindings ?? []), ...(value.options ?? []).flatMap((option) => option.settings ?? [])]) {
    if (binding.location === "body" && !binding.path.startsWith("/")) ctx.addIssue({ code: "custom", path: ["bindings"], message: "Body fields must use a JSON Pointer beginning with /." });
  }
});
export const RequestControlDeclarationsSchema = z.array(RequestControlDeclarationSchema).superRefine((items, ctx) => {
  if (new Set(items.map((item) => item.id)).size !== items.length) ctx.addIssue({ code: "custom", message: "A control id can be declared only once per entry." });
});
