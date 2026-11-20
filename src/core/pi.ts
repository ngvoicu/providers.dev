// pi's model catalog (https://pi.dev/api/models, MIT), the second imported source. design/pi-source.md.
// This file holds the structure the import accepts. Loose on purpose where pi may add keys, strict on every field
// the build reads: when pi changes the type of a field named here, the pi import fails on purpose, the last good pi
// snapshot stays, and someone adapts `PiModel`.
import { z } from "zod";
import type { Json } from "./merge.ts";

export const PiModel = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  api: z.string().min(1),
  provider: z.string().min(1),
  baseUrl: z.string(), // "" on 48 azure models
  reasoning: z.boolean(),
  input: z.array(z.string()),
  type: z.string().min(1),
  contextWindow: z.number().int().nonnegative(),
  maxTokens: z.number().int().nonnegative(),
  cost: z.looseObject({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    tiers: z
      .array(
        z.looseObject({
          inputTokensAbove: z.number().int().nonnegative(),
          input: z.number().nonnegative(),
          output: z.number().nonnegative(),
          cacheRead: z.number().nonnegative(),
          cacheWrite: z.number().nonnegative(),
        }),
      )
      .optional(),
  }),
  compat: z.record(z.string(), z.json()).optional(),
  thinkingLevelMap: z.record(z.string(), z.string().nullable()).optional(),
  promptCache: z.looseObject({ short: z.number().int().nonnegative().optional(), long: z.number().int().nonnegative().optional() }).optional(),
  inputLimits: z
    .looseObject({
      maxRequestBytes: z.number().int().nonnegative().optional(),
      images: z.looseObject({ maxPerRequest: z.number().int().nonnegative().optional(), maxPerMessage: z.number().int().nonnegative().optional() }).optional(),
    })
    .optional(),
});
export type PiModel = z.infer<typeof PiModel>;
export const PiFeed = z.record(z.string(), z.record(z.string(), PiModel));
/** The snapshot as the build reads it: provider key -> model id -> model. */
export type PiCatalog = z.infer<typeof PiFeed>;

// ---- what is published of pi's catalog (design/pi-source.md, section d). The contract is in contract.ts.

/** One price tier by size of request. Null only on a tier read from the entry's own cost, where the entry states none. */
export interface PiCostTier {
  input_tokens_above: number;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
}

/** pi's prices, in US dollars per million tokens. 0 stands for "no charge" and for "no price recorded" alike. */
export interface PiCost {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  tiers: PiCostTier[];
}

export const PI_DIFFERENCE_FIELDS = ["context_window", "max_tokens", "cost.input", "cost.output", "cost.cache_read", "cost.cache_write", "cost.tiers"] as const;
export type PiDifferenceField = (typeof PI_DIFFERENCE_FIELDS)[number];

/** One value that pi's catalog states otherwise than the entry publishes it. */
export interface PiDifference {
  field: PiDifferenceField;
  entry_field: string;
  unit: "tokens" | "usd_per_million_tokens";
  pi: number | null;
  published: number | null;
  pi_tiers: PiCostTier[] | null;
  published_tiers: PiCostTier[] | null;
}

/** What pi's catalog states for an entry: `providers_dev.pi`. */
export interface PiBlock {
  ref: string;
  provider: string;
  model: string;
  match: "id" | "alias";
  name: string;
  type: string;
  api: string;
  base_url: string | null;
  reasoning: boolean;
  input: string[];
  context_window: number;
  max_tokens: number;
  cost: PiCost;
  thinking_level_map: Record<string, string | null> | null;
  compat: Record<string, Json> | null;
  prompt_cache: { short_s: number | null; long_s: number | null } | null;
  input_limits: { max_request_bytes: number | null; max_images_per_request: number | null; max_images_per_message: number | null };
  differences: PiDifference[];
}

/** The pi block of an entry in short: `pi` of a summary. */
export interface PiSummary {
  ref: string;
  api: string;
  match: "id" | "alias";
  difference_count: number;
}

// ---- the block and its differences (sections e and f). Worked out once, when the data is built.

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const numberOr = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
/** Two prices are equal when they are equal after rounding each to 6 decimals. */
const samePrice = (a: number, b: number): boolean => Math.round(a * 1e6) === Math.round(b * 1e6);

/** pi's tiers, sorted by `inputTokensAbove`, in the block's words. */
function piTiers(model: PiModel): PiCostTier[] {
  return [...(model.cost.tiers ?? [])]
    .sort((a, b) => a.inputTokensAbove - b.inputTokensAbove)
    .map((tier) => ({ input_tokens_above: tier.inputTokensAbove, input: tier.input, output: tier.output, cache_read: tier.cacheRead, cache_write: tier.cacheWrite }));
}

/**
 * The threshold of an override that is a tier by size of request: its `when` has the one key `context`, with the one
 * comparison `gt` (the number) or `gte` (the number less 1) on a number. Null for every other override.
 */
function tierThreshold(override: unknown): number | null {
  if (!isRecord(override) || !isRecord(override.when)) return null;
  const keys = Object.keys(override.when);
  if (keys.length !== 1 || keys[0] !== "context" || !isRecord(override.when.context)) return null;
  const comparison = Object.entries(override.when.context);
  if (comparison.length !== 1) return null;
  const [operator, value] = comparison[0]!;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (operator === "gt") return value;
  if (operator === "gte") return value - 1;
  return null;
}

/** The entry's tiers by size of request, read from `cost.text.input.overrides` and `cost.text.output.overrides`. */
export function entryTiers(cost: unknown): PiCostTier[] {
  const text = isRecord(cost) && isRecord(cost.text) ? cost.text : {};
  const side = (name: "input" | "output"): Map<number, Record<string, unknown>> => {
    const found = new Map<number, Record<string, unknown>>();
    const own = isRecord(text[name]) ? text[name] : {};
    for (const override of Array.isArray(own.overrides) ? own.overrides : []) {
      const threshold = tierThreshold(override);
      // Where two overrides of one side have the same threshold, the one listed last counts.
      if (threshold !== null) found.set(threshold, override as Record<string, unknown>);
    }
    return found;
  };
  const input = side("input");
  const output = side("output");
  const thresholds = [...new Set([...input.keys(), ...output.keys()])].sort((a, b) => a - b);
  return thresholds.map((threshold) => {
    const inputOverride = input.get(threshold);
    const cache = isRecord(inputOverride?.cache) ? inputOverride.cache : {};
    return {
      input_tokens_above: threshold,
      input: numberOr(inputOverride?.price),
      output: numberOr(output.get(threshold)?.price),
      cache_read: numberOr(cache.read),
      cache_write: numberOr(cache.write),
    };
  });
}

/** pi's tiers and the entry's agree: the same thresholds, and every price that both state equal. */
function tiersAgree(pi: PiCostTier[], published: PiCostTier[], compare: { input: boolean; output: boolean }): boolean {
  if (pi.length !== published.length) return false;
  return pi.every((tier, index) => {
    const other = published[index]!;
    if (tier.input_tokens_above !== other.input_tokens_above) return false;
    const fields: [keyof PiCostTier, boolean][] = [["input", compare.input], ["output", compare.output], ["cache_read", compare.input], ["cache_write", compare.input]];
    return fields.every(([field, compared]) => {
      const a = tier[field];
      const b = other[field];
      // Both must state a value; pi's price of 0 is also its "no price recorded".
      if (!compared || a === null || b === null || a === 0) return true;
      return samePrice(a, b);
    });
  });
}

/**
 * Where pi's price, context window or output limit is not the entry's published value (section e). `entry` is the
 * entry as published, after every override: its `limit` and `cost`, never `providers_dev.pricing`.
 */
export function piDifferences(model: PiModel, entry: { limit?: unknown; cost?: unknown }): PiDifference[] {
  const out: PiDifference[] = [];
  const limit = isRecord(entry.limit) ? entry.limit : {};
  const text = isRecord(entry.cost) && isRecord(entry.cost.text) ? entry.cost.text : {};
  const input = isRecord(text.input) ? text.input : {};
  const output = isRecord(text.output) ? text.output : {};
  const cache = isRecord(input.cache) ? input.cache : {};
  // An entry price whose side has a unit (a price per character) is not a price per million tokens.
  const inputCompared = input.unit === undefined;
  const outputCompared = output.unit === undefined;
  const item = (field: PiDifferenceField, entryField: string, unit: PiDifference["unit"], pi: number | null, published: number | null): PiDifference => ({ field, entry_field: entryField, unit, pi, published, pi_tiers: null, published_tiers: null });

  const limitItem = (field: PiDifferenceField, entryField: string, pi: number, published: unknown): void => {
    const value = numberOr(published);
    // In limit, 0 is "none stated"; pi's 0 is no value either.
    if (value === null || value === 0 || pi === 0 || value === pi) return;
    out.push(item(field, entryField, "tokens", pi, value));
  };
  limitItem("context_window", "limit.context", model.contextWindow, limit.context);
  limitItem("max_tokens", "limit.output", model.maxTokens, limit.output);

  const priceItem = (field: PiDifferenceField, entryField: string, pi: number, published: unknown, compared: boolean): void => {
    const value = numberOr(published);
    if (!compared || value === null || pi === 0 || samePrice(pi, value)) return;
    out.push(item(field, entryField, "usd_per_million_tokens", pi, value));
  };
  priceItem("cost.input", "cost.text.input.price", model.cost.input, input.price, inputCompared);
  priceItem("cost.output", "cost.text.output.price", model.cost.output, output.price, outputCompared);
  priceItem("cost.cache_read", "cost.text.input.cache.read", model.cost.cacheRead, cache.read, inputCompared);
  // A cache-write price keyed by lifetime is not compared: pi states one price and does not say for which lifetime.
  priceItem("cost.cache_write", "cost.text.input.cache.write", model.cost.cacheWrite, cache.write, inputCompared);

  const pi = piTiers(model);
  const published = entryTiers(entry.cost);
  if (!tiersAgree(pi, published, { input: inputCompared, output: outputCompared })) {
    out.push({ field: "cost.tiers", entry_field: "cost.text", unit: "usd_per_million_tokens", pi: null, published: null, pi_tiers: pi, published_tiers: published });
  }
  return out;
}

/** The pi block of an entry: what the feed states, in the block's words, with the differences (section f). */
export function piBlock(provider: string, model: PiModel, match: PiBlock["match"], entry: { limit?: unknown; cost?: unknown }): PiBlock {
  const limits = model.inputLimits;
  return {
    ref: `${provider}/${model.id}`,
    provider,
    model: model.id,
    match,
    name: model.name,
    type: model.type,
    api: model.api,
    base_url: model.baseUrl === "" ? null : model.baseUrl,
    reasoning: model.reasoning,
    input: [...model.input],
    context_window: model.contextWindow,
    max_tokens: model.maxTokens,
    cost: { input: model.cost.input, output: model.cost.output, cache_read: model.cost.cacheRead, cache_write: model.cost.cacheWrite, tiers: piTiers(model) },
    thinking_level_map: model.thinkingLevelMap ? { ...model.thinkingLevelMap } : null,
    compat: model.compat ? (structuredClone(model.compat) as Record<string, Json>) : null,
    prompt_cache: model.promptCache ? { short_s: model.promptCache.short ?? null, long_s: model.promptCache.long ?? null } : null,
    input_limits: {
      max_request_bytes: limits?.maxRequestBytes ?? null,
      max_images_per_request: limits?.images?.maxPerRequest ?? null,
      max_images_per_message: limits?.images?.maxPerMessage ?? null,
    },
    differences: piDifferences(model, entry),
  };
}

/** The block in short, for a summary. */
export function piSummary(block: PiBlock | null): PiSummary | null {
  return block ? { ref: block.ref, api: block.api, match: block.match, difference_count: block.differences.length } : null;
}
