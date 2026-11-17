// Known models.dev fields. Objects stay open so new upstream fields survive publication.
import { z } from "zod";

export const LimitSchema = z.looseObject({
  context: z.number().nonnegative().optional().describe("Context window in tokens."),
  input: z.number().nonnegative().optional().describe("Maximum input in tokens."),
  output: z.number().nonnegative().optional().describe("Maximum output in tokens."),
});

const cacheMode = z.union([z.boolean(), z.looseObject({
  ttl: z.array(z.string()).optional().describe("Documented lifetimes, such as 5m or 1h."),
  min_tokens: z.number().nonnegative().optional(),
  max_breakpoints: z.number().nonnegative().optional(),
  targets: z.array(z.string()).optional(),
})]);
export const DocumentedCacheSchema = z.union([z.literal(false), z.looseObject({
  implicit: cacheMode.optional(),
  explicit: cacheMode.optional(),
})]).describe("False explicitly disables caching. Missing modes are unknown.");

const tools = z.looseObject({
  supported: z.boolean().optional(),
  choice: z.array(z.string()).optional(),
  freeform: z.array(z.string()).optional(),
  strict: z.boolean().optional(),
  // models.dev e337b7d (2026-11-17): a list of tool changes, no longer a boolean. Open, so a value models.dev adds later is kept.
  updates: z.array(z.string()).optional().describe("The tool changes the API accepts in the middle of a conversation, as models.dev lists them. Known values: add, remove, replace. [] = none. Other values may be added."),
});
export const CapabilitiesSchema = z.looseObject({
  cache: DocumentedCacheSchema.optional(),
  temperature: z.boolean().optional(),
  top_k: z.boolean().optional(),
  top_p: z.boolean().optional(),
  structured_output: z.boolean().optional(),
  prompt_cache_key: z.boolean().optional(),
  store: z.boolean().optional(),
  stream_usage: z.boolean().optional(),
  system_updates: z.boolean().optional(),
  effort_updates: z.boolean().optional(),
  service_tier: z.array(z.string()).optional(),
  tools: tools.optional(),
  reasoning: z.looseObject({
    supported: z.boolean().optional(),
    toggle: z.boolean().optional(),
    effort: z.array(z.string()).optional(),
    budget: z.looseObject({ min: z.number().optional(), max: z.number().optional() }).optional(),
    default: z.looseObject({ type: z.string().optional(), value: z.union([z.boolean(), z.string(), z.number()]).optional() }).optional(),
  }).optional(),
}).describe("Documented capabilities. Missing fields remain unknown.");

const numberComparison = z.looseObject({ gt: z.number().optional(), gte: z.number().optional(), lt: z.number().optional(), lte: z.number().optional(), equals: z.number().optional() });
const stringComparison = z.looseObject({ equals: z.string().optional(), in: z.array(z.string()).optional(), gt: z.string().optional(), gte: z.string().optional(), lt: z.string().optional(), lte: z.string().optional() });
const otherCondition = z.record(z.string(), z.json());
export const PriceConditionSchema = z.looseObject({
  context: numberComparison.optional(),
  service_tier: stringComparison.optional(),
  region: stringComparison.optional(),
  date: stringComparison.optional(),
  utc_hours: stringComparison.optional(),
  utc_days: stringComparison.optional(),
  holiday: stringComparison.optional(),
  thinking: z.looseObject({ equals: z.boolean().optional() }).optional(),
  all: z.array(otherCondition).optional(),
  any: z.array(otherCondition).optional(),
  not: otherCondition.optional(),
}).describe("Conditions for a price override or multiplier. Composite and future conditions are preserved as JSON.");

const cacheWrite = z.union([z.number(), z.record(z.string(), z.number())]).describe("Cache write price, or prices keyed by lifetime.");
const cachePriceFields = { read: z.number().optional(), write: cacheWrite.optional(), storage: z.number().optional() };
export const CachePriceSchema = z.looseObject({
  ...cachePriceFields,
  explicit: z.looseObject(cachePriceFields).optional(),
});
const inputPriceFields = { price: z.number().optional(), cache: CachePriceSchema.optional() };
const outputPriceFields = { price: z.number().optional(), reasoning: z.number().optional() };
export const TextPriceSchema = z.looseObject({
  input: z.looseObject({
    ...inputPriceFields,
    unit: z.string().optional().describe("Alternative source unit. Absent means per million tokens."),
    overrides: z.array(z.looseObject({ when: PriceConditionSchema, ...inputPriceFields })).optional(),
  }).optional(),
  output: z.looseObject({
    ...outputPriceFields,
    unit: z.string().optional(),
    overrides: z.array(z.looseObject({ when: PriceConditionSchema, ...outputPriceFields })).optional(),
  }).optional(),
}).describe("Text prices in USD per million tokens unless a unit is specified. Missing is unknown; zero is a listed zero price.");

const textFactor = z.union([z.number(), z.looseObject({
  input: z.union([z.number(), z.looseObject(inputPriceFields)]).optional(),
  output: z.union([z.number(), z.looseObject(outputPriceFields)]).optional(),
})]);
export const CostSchema = z.looseObject({
  text: TextPriceSchema.optional(),
  multipliers: z.array(z.looseObject({
    when: PriceConditionSchema,
    factor: z.union([z.number(), z.looseObject({ text: textFactor.optional() })]),
  })).optional(),
}).describe("List prices and conditional changes. Other modalities and future price fields are passed through unchanged.");

export const ApiEndpointSchema = z.looseObject({
  base_url: z.string().optional(),
  path: z.string().optional(),
  sdk: z.record(z.string(), z.string()).optional(),
  capabilities: CapabilitiesSchema.optional(),
  compatibility: z.looseObject({ max_tokens_field: z.string().optional(), reasoning_field: z.string().optional() }).optional(),
});

export const ModelMetadataShape = {
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.string().optional(),
  family: z.string().optional(),
  canonical_id: z.string().optional(),
  status: z.string().optional(),
  release_date: z.string().optional(),
  limit: LimitSchema.optional(),
  capabilities: CapabilitiesSchema.optional(),
  cost: CostSchema.optional(),
  modalities: z.looseObject({ input: z.array(z.string()).optional(), output: z.array(z.string()).optional() }).optional(),
  api: z.record(z.string(), ApiEndpointSchema).optional(),
};
