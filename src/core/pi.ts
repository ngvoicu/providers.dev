// pi's model catalog (https://pi.dev/api/models, MIT), the second imported source. design/pi-source.md.
// This file holds the structure the import accepts. Loose on purpose where pi may add keys, strict on every field
// the build reads: when pi changes the type of a field named here, the pi import fails on purpose, the last good pi
// snapshot stays, and someone adapts `PiModel`.
import { z } from "zod";

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
