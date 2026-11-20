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
