// pi's model catalog (https://pi.dev/api/models, MIT), the second imported source. design/pi-source.md.
// This file holds the structure the import accepts. Loose on purpose where pi may add keys, strict on every field
// the build reads: when pi changes the type of a field named here, the pi import fails on purpose, the last good pi
// snapshot stays, and someone adapts `PiModel`.
import { z } from "zod";
import type { Json } from "./merge.ts";
import { Evidence, PROVIDER_ID, type Catalog, type Issue } from "./schema.ts";

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
 * What an override is for the tiers. A tier by size of request: its `when` has the one key `context`, with the one
 * comparison `gt: N` (N a whole number, 0 or more; the threshold is N) or `gte: N` (N a whole number, 1 or more; the
 * threshold is N less 1), so that the threshold is a whole number of tokens, 0 or more. Any other override on the
 * context alone cannot be read as a tier: "unreadable". Every other override (service tier, time of day, a composite)
 * is not a tier: null.
 */
function tierThreshold(override: unknown): number | "unreadable" | null {
  if (!isRecord(override) || !isRecord(override.when)) return null;
  const keys = Object.keys(override.when);
  if (keys.length !== 1 || keys[0] !== "context") return null;
  if (!isRecord(override.when.context)) return "unreadable";
  const comparison = Object.entries(override.when.context);
  if (comparison.length !== 1) return "unreadable";
  const [operator, value] = comparison[0]!;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return "unreadable";
  if (operator === "gt" && value >= 0) return value;
  if (operator === "gte" && value >= 1) return value - 1;
  return "unreadable";
}

/**
 * The entry's tiers by size of request, read from `cost.text.input.overrides` and `cost.text.output.overrides`, all in
 * US dollars per million tokens. Null where they cannot be compared: a side priced in another unit (`unit`), a tier
 * with a unit of its own, an override on the context that is not a tier of whole tokens, or a negative price.
 */
export function entryTiers(cost: unknown): PiCostTier[] | null {
  const text = isRecord(cost) && isRecord(cost.text) ? cost.text : {};
  let comparable = true;
  const side = (name: "input" | "output"): Map<number, Record<string, unknown>> => {
    const found = new Map<number, Record<string, unknown>>();
    const own = isRecord(text[name]) ? text[name] : {};
    if (own.unit !== undefined) comparable = false;
    for (const override of Array.isArray(own.overrides) ? own.overrides : []) {
      const threshold = tierThreshold(override);
      if (threshold === "unreadable") comparable = false;
      if (typeof threshold !== "number") continue;
      if ((override as Record<string, unknown>).unit !== undefined) comparable = false;
      // Where two overrides of one side have the same threshold, the one listed last counts.
      found.set(threshold, override as Record<string, unknown>);
    }
    return found;
  };
  const input = side("input");
  const output = side("output");
  if (!comparable) return null;
  const thresholds = [...new Set([...input.keys(), ...output.keys()])].sort((a, b) => a - b);
  const tiers = thresholds.map((threshold) => {
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
  const negative = tiers.some((tier) => [tier.input, tier.output, tier.cache_read, tier.cache_write].some((price) => price !== null && price < 0));
  return negative ? null : tiers;
}

/** pi's tiers and the entry's agree: the same thresholds, and every price that both state equal. */
function tiersAgree(pi: PiCostTier[], published: PiCostTier[]): boolean {
  if (pi.length !== published.length) return false;
  return pi.every((tier, index) => {
    const other = published[index]!;
    if (tier.input_tokens_above !== other.input_tokens_above) return false;
    return (["input", "output", "cache_read", "cache_write"] as const).every((field) => {
      const a = tier[field];
      const b = other[field];
      // Both must state a value; pi's price of 0 is also its "no price recorded".
      if (a === null || b === null || a === 0) return true;
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

  // Tiers that cannot be compared (another unit, a threshold that is not whole tokens) give no item.
  const pi = piTiers(model);
  const published = entryTiers(entry.cost);
  if (published !== null && !tiersAgree(pi, published)) {
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

// ---- matching: which entry each pi model speaks of (section c)

const PiModelLine = z.strictObject({
  /** The model id of the entry, at the catalog's provider, that is this pi model under another spelling. */
  same_as: z.string().min(1),
  note: z.string().optional(),
});

const PiProviderLine = z
  .strictObject({
    /** The provider of the catalog that this pi provider id is. Left out where the catalog has the pi id itself. */
    same_as: z.string().regex(PROVIDER_ID).optional(),
    reason: z.string().min(1).optional(),
    evidence: z.array(Evidence).min(1).optional(),
    /** The day the model lines were checked against the report. Required when `models` has a line. */
    checked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    models: z.record(z.string().min(1), PiModelLine).default({}),
  })
  .superRefine((line, context) => {
    if (line.same_as !== undefined && line.reason === undefined) context.addIssue({ code: "custom", path: ["reason"], message: "A provider line with same_as needs a reason." });
    if (line.same_as !== undefined && line.evidence === undefined) context.addIssue({ code: "custom", path: ["evidence"], message: "A provider line with same_as needs evidence." });
    const lines = Object.keys(line.models).length;
    if (lines > 0 && line.checked === undefined) context.addIssue({ code: "custom", path: ["checked"], message: "A provider line with model lines needs checked, the day they were checked against the report." });
    if (line.same_as === undefined && lines === 0) context.addIssue({ code: "custom", path: [], message: "A provider line needs same_as or at least one model line." });
  });

/** data/authored/pi-aliases.yaml: the adapter between pi's spelling and the catalog's. Only `same_as`, nothing else. */
export const PiAliases = z
  .strictObject({ providers: z.record(z.string().regex(PROVIDER_ID), PiProviderLine).default({}) })
  .superRefine((file, context) => {
    const seen = new Map<string, string>();
    for (const [id, line] of Object.entries(file.providers)) {
      if (line.same_as === undefined) continue;
      const first = seen.get(line.same_as);
      if (first !== undefined) context.addIssue({ code: "custom", path: ["providers", id, "same_as"], message: `Two pi provider ids, ${first} and ${id}, have the same same_as ${line.same_as}. One provider of the catalog is one pi provider.` });
      else seen.set(line.same_as, id);
    }
  });
export type PiAliases = z.infer<typeof PiAliases>;

/** What became of the pi models of the snapshot: data/published/pi-report.json. Not part of the API. */
export interface PiReport {
  totals: { models: number; matched_id: number; matched_alias: number; left_out: number; unmatched: number };
  providers: {
    pi_provider: string;
    state: "shared" | "paired" | "absent";
    catalog_provider: string | null;
    models: number;
    matched: number;
    left_out: number;
    unmatched: number;
    /** A hint for a person: providers of the catalog with an entry whose api base_url has the host of this provider's baseUrl. */
    same_host: string[];
  }[];
  unmatched: {
    pi_provider: string;
    pi_model: string;
    name: string;
    why: "provider-absent" | "no-entry" | "alias-orphan" | "alias-conflict";
    /** A hint for a person: ids of the provider's entries equal to pi_model once both are lower-cased and every character that is not a letter or a digit is dropped. */
    alike: string[];
  }[];
  left_out: { pi_provider: string; pi_model: string; entry: string; by: string }[];
}

/** Plain character order, never the locale's. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const hostOf = (url: unknown): string | null => {
  if (typeof url !== "string" || !url) return null;
  try {
    return new URL(url.replace(/\{[^}]*\}/g, "x")).host.toLowerCase() || null;
  } catch {
    return null;
  }
};
const squeezed = (id: string): string => id.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A pi model and the entry it reached. */
export interface PiAssignment {
  piProvider: string;
  piModel: string;
  model: PiModel;
  /** The entry: the catalog's provider id and model id. */
  provider: string;
  entry: string;
  match: PiBlock["match"];
}

/** The match of every pi model, before any exclusion, and what the report needs of the catalog as it was then. */
export interface PiMatching {
  assignments: PiAssignment[];
  providers: Pick<PiReport["providers"][number], "pi_provider" | "state" | "catalog_provider" | "same_host">[];
  unmatched: PiReport["unmatched"];
  issues: Issue[];
}

/**
 * The rule of section c. `catalog` is the catalog before any exclusion: the models.dev snapshot, our additions and the
 * entries that exist because we measured them. Equal ids always come first; then the alias file. Nothing is matched by
 * similarity: `alike` and `same_host` are hints for the person who writes the alias file, read by nothing else.
 */
export function matchPi(pi: PiCatalog, aliases: PiAliases | undefined, catalog: Catalog): PiMatching {
  const issues: Issue[] = [];
  const lines = aliases?.providers ?? {};
  const where = (piProvider: string, piModel?: string): string => `pi/${piProvider}${piModel === undefined ? "" : `/${piModel}`}`;

  // Lines that name a pi provider or a pi model the snapshot does not have.
  for (const [piProvider, line] of Object.entries(lines)) {
    if (!pi[piProvider]) {
      issues.push({ level: "warning", code: "pi-alias-orphan", target: where(piProvider), message: `data/authored/pi-aliases.yaml has a line for the pi provider ${piProvider}, which pi's catalog no longer has. Delete the line.` });
      continue;
    }
    for (const piModel of Object.keys(line.models)) {
      if (pi[piProvider][piModel]) continue;
      issues.push({ level: "warning", code: "pi-alias-orphan", target: where(piProvider, piModel), message: `data/authored/pi-aliases.yaml has a line for the pi model ${piProvider}/${piModel}, which pi's catalog no longer has. Delete the line.` });
    }
  }

  // The hosts each catalog provider's entries are reached at, for same_host.
  const hostsOf = new Map<string, Set<string>>();
  for (const [id, provider] of Object.entries(catalog)) {
    const hosts = new Set<string>();
    for (const model of Object.values(provider.models)) {
      const api = model.api;
      if (typeof api !== "object" || api === null || Array.isArray(api)) continue;
      for (const endpoint of Object.values(api)) {
        if (typeof endpoint !== "object" || endpoint === null || Array.isArray(endpoint)) continue;
        const host = hostOf((endpoint as Record<string, unknown>).base_url);
        if (host) hosts.add(host);
      }
    }
    hostsOf.set(id, hosts);
  }

  const providers: PiMatching["providers"] = [];
  const unmatched: PiReport["unmatched"] = [];
  const candidates: PiAssignment[] = [];
  for (const piProvider of Object.keys(pi).sort(byText)) {
    const models = pi[piProvider]!;
    const line = lines[piProvider];
    let target: string | null = null;
    let state: PiReport["providers"][number]["state"] = "absent";
    let orphaned = false;
    if (catalog[piProvider]) {
      target = piProvider;
      state = "shared";
      if (line?.same_as !== undefined) {
        issues.push({ level: "warning", code: "pi-provider-collides", target: where(piProvider), message: `data/authored/pi-aliases.yaml pairs the pi provider ${piProvider} with ${line.same_as}, but the catalog has a provider ${piProvider} itself. The catalog's own provider is used and the same_as is ignored.` });
      }
    } else if (line?.same_as !== undefined) {
      if (catalog[line.same_as]) {
        target = line.same_as;
        state = "paired";
      } else {
        orphaned = true;
        issues.push({ level: "warning", code: "pi-alias-orphan", target: where(piProvider), message: `data/authored/pi-aliases.yaml pairs the pi provider ${piProvider} with ${line.same_as}, which the catalog does not have. Its models belong to no entry.` });
      }
    } else if (line && Object.keys(line.models).length > 0) {
      for (const piModel of Object.keys(line.models)) {
        if (!models[piModel]) continue;
        issues.push({ level: "warning", code: "pi-alias-orphan", target: where(piProvider, piModel), message: `data/authored/pi-aliases.yaml pairs the pi model ${piProvider}/${piModel}, but the catalog has no provider ${piProvider} and the file pairs it with none.` });
      }
    }
    const piHosts = new Set(Object.values(models).map((model) => hostOf(model.baseUrl)).filter((host): host is string => host !== null));
    const sameHost = [...hostsOf].filter(([, hosts]) => [...hosts].some((host) => piHosts.has(host))).map(([id]) => id).sort(byText);
    providers.push({ pi_provider: piProvider, state, catalog_provider: target, same_host: sameHost });

    const entries = target ? catalog[target]!.models : {};
    const entryIds = Object.keys(entries);
    const alike = (piModel: string): string[] => entryIds.filter((id) => squeezed(id) === squeezed(piModel)).sort(byText);
    for (const piModel of Object.keys(models).sort(byText)) {
      const model = models[piModel]!;
      const modelLine = line?.models[piModel];
      if (!target) {
        unmatched.push({ pi_provider: piProvider, pi_model: piModel, name: model.name, why: orphaned || modelLine ? "alias-orphan" : "provider-absent", alike: [] });
        continue;
      }
      if (entries[piModel]) {
        if (modelLine) {
          issues.push({ level: "notice", code: "pi-alias-redundant", target: where(piProvider, piModel), message: `The model line for ${piProvider}/${piModel} in data/authored/pi-aliases.yaml is no longer needed: ${target} now has an entry with the pi model's own id. Delete the line.` });
        }
        candidates.push({ piProvider, piModel, model, provider: target, entry: piModel, match: state === "shared" ? "id" : "alias" });
        continue;
      }
      if (modelLine) {
        if (entries[modelLine.same_as]) {
          candidates.push({ piProvider, piModel, model, provider: target, entry: modelLine.same_as, match: "alias" });
        } else {
          issues.push({ level: "warning", code: "pi-alias-orphan", target: where(piProvider, piModel), message: `data/authored/pi-aliases.yaml pairs the pi model ${piProvider}/${piModel} with ${target}/${modelLine.same_as}, which the catalog does not have.` });
          unmatched.push({ pi_provider: piProvider, pi_model: piModel, name: model.name, why: "alias-orphan", alike: alike(piModel) });
        }
        continue;
      }
      unmatched.push({ pi_provider: piProvider, pi_model: piModel, name: model.name, why: "no-entry", alike: alike(piModel) });
    }
  }

  // One pi model per entry: the one whose provider id and model id are both the entry's keeps it, else the first by
  // pi provider id and then pi model id. The candidates are in that order already.
  const byEntry = new Map<string, PiAssignment[]>();
  for (const candidate of candidates) {
    const ref = `${candidate.provider}/${candidate.entry}`;
    (byEntry.get(ref) ?? byEntry.set(ref, []).get(ref)!).push(candidate);
  }
  const assignments: PiAssignment[] = [];
  for (const [ref, group] of byEntry) {
    const winner = group.find((candidate) => candidate.match === "id") ?? group[0]!;
    assignments.push(winner);
    for (const loser of group) {
      if (loser === winner) continue;
      issues.push({ level: "warning", code: "pi-alias-conflict", target: where(loser.piProvider, loser.piModel), message: `The pi models ${winner.piProvider}/${winner.piModel} and ${loser.piProvider}/${loser.piModel} both reach the entry ${ref}. ${winner.piProvider}/${winner.piModel} keeps it; ${loser.piProvider}/${loser.piModel} belongs to no entry.` });
      unmatched.push({ pi_provider: loser.piProvider, pi_model: loser.piModel, name: loser.model.name, why: "alias-conflict", alike: [] });
    }
  }
  const order = (a: { pi_provider: string; pi_model: string }, b: { pi_provider: string; pi_model: string }): number => byText(a.pi_provider, b.pi_provider) || byText(a.pi_model, b.pi_model);
  unmatched.sort(order);
  assignments.sort((a, b) => byText(a.piProvider, b.piProvider) || byText(a.piModel, b.piModel));
  return { assignments, providers, unmatched, issues };
}

/** The report, once the build knows which entries are published and what left the others out. */
export function piReport(pi: PiCatalog, matching: PiMatching, published: (assignment: PiAssignment) => boolean, leftOutBy: (ref: string) => string): PiReport {
  const leftOut: PiReport["left_out"] = [];
  let matchedId = 0;
  let matchedAlias = 0;
  const perProvider = new Map<string, { matched: number; left_out: number }>();
  for (const assignment of matching.assignments) {
    const counts = perProvider.get(assignment.piProvider) ?? perProvider.set(assignment.piProvider, { matched: 0, left_out: 0 }).get(assignment.piProvider)!;
    if (published(assignment)) {
      counts.matched += 1;
      if (assignment.match === "id") matchedId += 1;
      else matchedAlias += 1;
    } else {
      counts.left_out += 1;
      const ref = `${assignment.provider}/${assignment.entry}`;
      leftOut.push({ pi_provider: assignment.piProvider, pi_model: assignment.piModel, entry: ref, by: leftOutBy(ref) });
    }
  }
  const unmatchedOf = new Map<string, number>();
  for (const item of matching.unmatched) unmatchedOf.set(item.pi_provider, (unmatchedOf.get(item.pi_provider) ?? 0) + 1);
  const models = Object.values(pi).reduce((sum, items) => sum + Object.keys(items).length, 0);
  return {
    totals: { models, matched_id: matchedId, matched_alias: matchedAlias, left_out: leftOut.length, unmatched: matching.unmatched.length },
    providers: matching.providers.map((provider) => ({
      pi_provider: provider.pi_provider,
      state: provider.state,
      catalog_provider: provider.catalog_provider,
      models: Object.keys(pi[provider.pi_provider] ?? {}).length,
      matched: perProvider.get(provider.pi_provider)?.matched ?? 0,
      left_out: perProvider.get(provider.pi_provider)?.left_out ?? 0,
      unmatched: unmatchedOf.get(provider.pi_provider) ?? 0,
      same_host: provider.same_host,
    })),
    unmatched: matching.unmatched,
    left_out: leftOut,
  };
}
