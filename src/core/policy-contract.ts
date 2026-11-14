// Shared conditions, pricing and request controls. No provider-specific branches in the public contract.
import { z } from "zod";
import type { Json } from "./merge.ts";

export type Condition =
  | { kind: "predicate"; field: string; op: "eq" | "in" | "gt" | "gte" | "lt" | "lte" | "min_items"; value: Json }
  | { kind: "all" | "any"; conditions: Condition[] }
  | { kind: "not"; condition: Condition }
  | { kind: "unknown"; raw: Json };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() => z.union([
  z.strictObject({ kind: z.literal("predicate"), field: z.string().min(1), op: z.enum(["eq", "in", "gt", "gte", "lt", "lte", "min_items"]), value: z.json() }),
  z.strictObject({ kind: z.enum(["all", "any"]), conditions: z.array(ConditionSchema).min(1) }),
  z.strictObject({ kind: z.literal("not"), condition: ConditionSchema }),
  z.strictObject({ kind: z.literal("unknown"), raw: z.json() }),
])).describe("Shared condition tree. all = AND, any = OR, not = negation. Unknown conditions cannot be assumed true or false. min_items = the field is a list with at least that many items. request.context_tokens preserves the source's context threshold; it does not mean the model's maximum window or necessarily input-only tokens. Authored rules may use request.input_tokens explicitly.");

export const PolicyEvidenceSchema = z.strictObject({
  kind: z.enum(["documented", "measured"]), url: z.url(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), note: z.string(),
});
export const CoverageSchema = z.enum(["unknown", "partial", "complete", "not_applicable"])
  .describe("unknown = no usable record; partial = known fields without a completeness claim; complete = explicitly confirmed for the stated scope; not_applicable = no per-use billing on this access. Empty lists alone never prove absence.");

export const BillingUnitSchema = z.strictObject({
  name: z.string().min(1).describe("For example token, character, request, second or token_hour."),
  quantity: z.number().positive().nullable().describe("Amount is charged per this many units. Null = the source does not establish the scale."),
});

/** A rule as an author writes it and as the import reads it. The published rule adds what follows from it. */
export const PricingRuleInputSchema = z.strictObject({
  id: z.string().min(1),
  when: ConditionSchema.nullable().describe("Null = unconditional base rule. A condition with kind=unknown remains unresolved."),
  meter: z.string().min(1).describe("The charge affected. For text: text.input, text.output, text.reasoning_output, text.cache_read, text.cache_write, text.cache_storage. The same charges exist for audio, image and video (audio.input, image.output, video.output and so on), each priced in its own unit. web_search is the charge for web searches. A multiply rule names one charge or a scope: text.* is every text charge, audio.* every audio charge, * every charge."),
  operation: z.enum(["set", "multiply"]),
  amount: z.number().nonnegative().describe("A price for set, or a factor for multiply. Zero is a known zero, never missing."),
  currency: z.string().nullable().describe("ISO currency for a price; null for multipliers or an unknown currency."),
  unit: BillingUnitSchema.nullable().describe("Billing unit and scale. Null for multipliers or an unknown unit."),
  applies_to: z.enum(["all_usage", "above_threshold"]).nullable().describe("all_usage = the rate holds for the whole request that matches the condition. above_threshold = only for the part above a size threshold. Imported rules are all_usage: models.dev evaluates a condition per request, and a matching rule prices that request. Null = not established; never infer marginal billing."),
  source_path: z.string().nullable().describe("Field in the original cost record. Null for a separately authored rule."),
});
export const ResultingRateSchema = z.strictObject({
  meter: z.string().min(1),
  amount: z.number().nonnegative(),
  currency: z.string().nullable(),
  unit: BillingUnitSchema.nullable(),
}).describe("A base rate after a multiplier.");
export const PricingRuleSchema = PricingRuleInputSchema.extend({
  period: z.enum(["peak", "off_peak"]).nullable().describe("Set on a rule whose condition reads the time of day or the day of the week (request.utc_hours, request.utc_days): peak = the rule raises the base rate in its window, off_peak = it lowers it. The base rate is the price outside the window. Null = not a time rule, or one that leaves the base rate as it is."),
  resulting_rates: z.array(ResultingRateSchema).nullable().describe("On a multiply rule: each unconditional base rate in its scope times the factor, which is the price when this rule applies and no other conditional rule does. Null on a set rule, whose amount is the rate itself, and on a multiply rule with no base rate in its scope."),
});
const pricingShape = {
  coverage: CoverageSchema,
  billing: z.enum(["per_use", "reference", "not_applicable", "unknown"]).describe("per_use = the entry is billed at these rates. reference = a subscription entry: the rates are the API list prices of reference_ref, not the subscription's bill. not_applicable = a subscription entry with no API entry of the same model to refer to. unknown = rates are listed for the entry and what they bill is not established."),
  reference_ref: z.string().nullable().describe("With billing = reference: the API entry the rates are taken from. That is the entry a providers.dev entry inherits from, or the entry of the lab's own provider for the same canonical model. Otherwise null."),
  rule_order: z.literal("listed").nullable().describe("listed = process matching rules in array order per meter: set replaces the rate and multiply scales it. Imported rules are listed: base rates first, then models.dev's overrides in their order, then its multipliers, which is how models.dev defines a price. Null = combination precedence is unconfirmed; this record cannot produce an authoritative combined quote."),
  unparsed: z.array(z.strictObject({ path: z.string(), value: z.json() })).describe("Source fields not normalized, retained without loss. Nonempty means coverage is partial."),
  evidence: z.array(PolicyEvidenceSchema),
};
const rulesText = "Base prices, conditional replacements and multipliers. Null = unknown. [] proves no rules only with complete coverage.";
/** Pricing before `period` and `resulting_rates` are worked out: what the import produces and what an author declares. */
export const PricingInputSchema = z.strictObject({ ...pricingShape, rules: z.array(PricingRuleInputSchema).nullable().describe(rulesText) });
export const PricingSchema = z.strictObject({
  coverage: pricingShape.coverage,
  billing: pricingShape.billing,
  reference_ref: pricingShape.reference_ref,
  rules: z.array(PricingRuleSchema).nullable().describe(rulesText),
  rule_order: pricingShape.rule_order,
  unparsed: pricingShape.unparsed,
  evidence: pricingShape.evidence,
}).describe("Normalized pricing present on every entry and summary. Source imports are partial unless completeness is explicitly confirmed. Unknown applicability, units or rule interactions must not silently resolve to a base price.");
export type Pricing = z.infer<typeof PricingSchema>;
export type PricingInput = z.infer<typeof PricingInputSchema>;
export type PricingRule = z.infer<typeof PricingRuleSchema>;
export type PricingRuleInput = z.infer<typeof PricingRuleInputSchema>;
export type ResultingRate = z.infer<typeof ResultingRateSchema>;
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

/** An authored pricing record. The author writes the rules; `period` and `resulting_rates` are worked out from them. */
export const PricingDeclarationSchema = PricingInputSchema.superRefine((value, ctx) => {
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
