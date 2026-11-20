// pi's model catalog (https://pi.dev/api/models, MIT), the second imported source. design/pi-source.md.
// This file holds the structure the import accepts. Loose on purpose where pi may add keys, strict on every field
// the build reads: when pi changes the type of a field named here, the pi import fails on purpose, the last good pi
// snapshot stays, and someone adapts `PiModel`.
import { z } from "zod";
import type { Json } from "./merge.ts";
import type { CatalogBefore } from "./resolve.ts";
import type { Issue, PiAliases } from "./schema.ts";

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

export const PI_VALUE_FIELDS = [...PI_DIFFERENCE_FIELDS, "prompt_cache.short", "prompt_cache.long"] as const;
export type PiValueField = (typeof PI_VALUE_FIELDS)[number];

/** Where pi's catalog stands beside one value of the entry (design/pi-merged.md, section 2). */
export interface PiValue {
  field: PiValueField;
  entry_field: string;
  unit: "tokens" | "usd_per_million_tokens" | "seconds";
  standing: "agrees" | "differs" | "only" | "not_compared" | "silent";
  pi: number | null;
  pi_tiers: PiCostTier[] | null;
}

/** The plain facts of a published entry that pi's code is handed, all copies (design/pi-merged.md, section 8). */
export interface PiEntryFacts {
  limit: unknown;
  cost: unknown;
  /** providers_dev.access of the entry. */
  access: "api" | "subscription" | "unknown";
  /** `path` and `op` of every item of providers_dev.provenance. */
  corrections: { path: string; op: "set" | "unknown" | "delete" }[];
  /** providers_dev.cache.lifetime.short.documented_s and .long.documented_s. */
  documented_s: { short: number | null; long: number | null };
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
  values: PiValue[];
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
/**
 * Whether a price of the entry is in US dollars per million tokens: its `unit` is absent, or is models.dev's unit of a
 * price per token, `token` ("Prices are USD per 1M for `token` and `character`, and per 1 unit otherwise"). Asked of
 * a side's own unit, of a tier's own unit and of the plain prices alike. A price in any other unit is not compared.
 */
const perMillionTokens = (unit: unknown): boolean => unit === undefined || unit === "token";

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
 * US dollars per million tokens. Null where they cannot be compared: a side or a tier priced in another unit than per
 * million tokens (`perMillionTokens`), an override on the context that is not a tier of whole tokens, or a negative price.
 */
export function entryTiers(cost: unknown): PiCostTier[] | null {
  const text = isRecord(cost) && isRecord(cost.text) ? cost.text : {};
  let comparable = true;
  const side = (name: "input" | "output"): Map<number, Record<string, unknown>> => {
    const found = new Map<number, Record<string, unknown>>();
    const own = isRecord(text[name]) ? text[name] : {};
    if (!perMillionTokens(own.unit)) comparable = false;
    for (const override of Array.isArray(own.overrides) ? own.overrides : []) {
      const threshold = tierThreshold(override);
      if (threshold === "unreadable") comparable = false;
      if (typeof threshold !== "number") continue;
      if (!perMillionTokens((override as Record<string, unknown>).unit)) comparable = false;
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
      return a === b;
    });
  });
}

/** One value of pi's catalog read beside the entry's: what `values` and `differences` are both made of. */
interface PiReading {
  field: PiValueField;
  entry_field: string;
  unit: PiValue["unit"];
  standing: PiValue["standing"];
  pi: number | null;
  /** The entry's value, where the standing is agrees or differs. Null for cost.tiers. */
  published: number | null;
  pi_tiers: PiCostTier[] | null;
  published_tiers: PiCostTier[] | null;
}

/**
 * Whether providers.dev published the field at `fieldPath` as unknown or removed it: a correction with `op` unknown
 * or delete whose path is the field's, a path above it or a path below it.
 */
const unknownByUs = (corrections: PiEntryFacts["corrections"], fieldPath: string): boolean =>
  corrections.some(({ path, op }) => op !== "set" && (path === fieldPath || fieldPath.startsWith(`${path}.`) || path.startsWith(`${fieldPath}.`)));

/**
 * The one reading of the nine values pi's catalog can state of an entry (design/pi-merged.md, section 2): for each,
 * pi's value, the entry's, and the standing, the first line that holds deciding. `piValues` and `piDifferences` are
 * both made from it, so a value is `differs` exactly where `differences` lists it. `facts` are of the entry as
 * published, after every override: its `limit` and `cost`, never `providers_dev.pricing`.
 */
function piReadings(model: PiModel, facts: PiEntryFacts): PiReading[] {
  const limit = isRecord(facts.limit) ? facts.limit : {};
  const text = isRecord(facts.cost) && isRecord(facts.cost.text) ? facts.cost.text : {};
  const input = isRecord(text.input) ? text.input : {};
  const output = isRecord(text.output) ? text.output : {};
  const cache = isRecord(input.cache) ? input.cache : {};
  const corrections = facts.corrections;
  // A subscription entry is not paid per token: its own cost is not what a request costs, so no price is compared.
  const subscription = facts.access === "subscription";

  /** The rule for one value: `pi` null = pi states none; `entry` null = the entry states none. */
  const reading = (field: PiValueField, entryField: string, unit: PiValue["unit"], pi: number | null, entry: number | null, compared: boolean): PiReading => {
    const standing: PiValue["standing"] = pi === null ? "silent" : !compared ? "not_compared" : entry === null ? "only" : pi === entry ? "agrees" : "differs";
    const published = standing === "agrees" || standing === "differs" ? entry : null;
    return { field, entry_field: entryField, unit, standing, pi, published, pi_tiers: null, published_tiers: null };
  };

  // Limits: 0 is "none stated" on both sides.
  const above0 = (value: unknown): number | null => {
    const number = numberOr(value);
    return number !== null && number > 0 ? number : null;
  };
  const limitReading = (field: PiValueField, entryField: string, pi: number, entry: unknown): PiReading =>
    reading(field, entryField, "tokens", pi > 0 ? pi : null, above0(entry), !unknownByUs(corrections, entryField));

  // Prices: the entry's listed 0 is a price; pi's 0 is also its "no price recorded". A side priced in another unit
  // than per million tokens (a price per character) is not compared.
  const priceReading = (field: PiValueField, entryField: string, pi: number, entry: unknown, sideUnit: unknown, keyedByLifetime = false): PiReading => {
    const compared = !subscription && perMillionTokens(sideUnit) && !keyedByLifetime && !unknownByUs(corrections, entryField);
    return reading(field, entryField, "usd_per_million_tokens", pi > 0 ? pi : null, numberOr(entry), compared);
  };

  // Tiers (section e, rule 5): both lists are statements, an empty one included, so they are never `only`.
  const piList = piTiers(model);
  const entryList = entryTiers(facts.cost);
  let tiers: PiReading;
  if (piList.length === 0 && entryList !== null && entryList.length === 0) {
    tiers = { field: "cost.tiers", entry_field: "cost.text", unit: "usd_per_million_tokens", standing: "silent", pi: null, published: null, pi_tiers: null, published_tiers: null };
  } else {
    const compared = !subscription && entryList !== null && !unknownByUs(corrections, "cost.text");
    const standing: PiValue["standing"] = !compared ? "not_compared" : tiersAgree(piList, entryList) ? "agrees" : "differs";
    tiers = { field: "cost.tiers", entry_field: "cost.text", unit: "usd_per_million_tokens", standing, pi: null, published: null, pi_tiers: piList, published_tiers: standing === "not_compared" ? null : entryList };
  }

  // Lifetimes: pi's against the documented lifetime of the profile, never the safe value. 0 is a value on both sides.
  const lifetimeCompared = !unknownByUs(corrections, "capabilities.cache");
  const lifetimeReading = (field: PiValueField, profile: "short" | "long", pi: number | undefined): PiReading =>
    reading(field, `providers_dev.cache.lifetime.${profile}.documented_s`, "seconds", pi ?? null, facts.documented_s[profile], lifetimeCompared);

  return [
    limitReading("context_window", "limit.context", model.contextWindow, limit.context),
    limitReading("max_tokens", "limit.output", model.maxTokens, limit.output),
    priceReading("cost.input", "cost.text.input.price", model.cost.input, input.price, input.unit),
    priceReading("cost.output", "cost.text.output.price", model.cost.output, output.price, output.unit),
    priceReading("cost.cache_read", "cost.text.input.cache.read", model.cost.cacheRead, cache.read, input.unit),
    // A cache-write price keyed by lifetime is not compared: pi states one price and does not say for which lifetime.
    priceReading("cost.cache_write", "cost.text.input.cache.write", model.cost.cacheWrite, cache.write, input.unit, isRecord(cache.write)),
    tiers,
    lifetimeReading("prompt_cache.short", "short", model.promptCache?.short),
    lifetimeReading("prompt_cache.long", "long", model.promptCache?.long),
  ];
}

const isDifferenceField = (field: PiValueField): field is PiDifferenceField => (PI_DIFFERENCE_FIELDS as readonly string[]).includes(field);

/**
 * Where pi's price, context window or output limit is not the entry's published value (section e): the items of
 * `piReadings` that differ, so never a price or the tiers on a subscription entry.
 */
export function piDifferences(model: PiModel, facts: PiEntryFacts): PiDifference[] {
  return piReadings(model, facts).flatMap(({ field, entry_field, unit, standing, pi, published, pi_tiers, published_tiers }) =>
    standing === "differs" && isDifferenceField(field) && unit !== "seconds" ? [{ field, entry_field, unit, pi, published, pi_tiers, published_tiers }] : [],
  );
}

/** Where pi's catalog stands beside each of the nine values of the entry, in the order of `PI_VALUE_FIELDS`. */
export function piValues(model: PiModel, facts: PiEntryFacts): PiValue[] {
  return piReadings(model, facts).map(({ field, entry_field, unit, standing, pi, pi_tiers }) => ({ field, entry_field, unit, standing, pi, pi_tiers }));
}

/** The pi block of an entry: what the feed states, in the block's words, with the differences (section f) and the values. */
export function piBlock(provider: string, model: PiModel, match: PiBlock["match"], facts: PiEntryFacts): PiBlock {
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
    differences: piDifferences(model, facts),
    values: piValues(model, facts),
  };
}

// ---- matching: which entry each pi model speaks of (section c)

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

/**
 * The value of `record` under `key`, only where it is the record's own: no id from the feed, the alias file or the
 * catalog reaches `Object.prototype` (`constructor`, `toString`, `__proto__` and the rest).
 */
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

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
 * The rule of section c. `before` is the catalog before any exclusion: the models.dev snapshot, our additions and the
 * entries that exist because we measured them, as plain rows. Equal ids always come first; then the alias file.
 * Nothing is matched by similarity: `alike` and `same_host` are hints for the person who writes the alias file, read
 * by nothing else.
 */
export function matchPi(pi: PiCatalog, aliases: PiAliases | undefined, before: CatalogBefore): PiMatching {
  const issues: Issue[] = [];
  const lines = aliases?.providers ?? {};
  const where = (piProvider: string, piModel?: string): string => `pi/${piProvider}${piModel === undefined ? "" : `/${piModel}`}`;

  // Lines that name a pi provider or a pi model the snapshot does not have.
  for (const [piProvider, line] of Object.entries(lines)) {
    const piModels = own(pi, piProvider);
    if (!piModels) {
      issues.push({ level: "warning", code: "pi-alias-orphan", target: where(piProvider), message: `data/authored/pi-aliases.yaml has a line for the pi provider ${piProvider}, which pi's catalog no longer has. Delete the line.` });
      continue;
    }
    for (const piModel of Object.keys(line.models)) {
      if (own(piModels, piModel)) continue;
      issues.push({ level: "warning", code: "pi-alias-orphan", target: where(piProvider, piModel), message: `data/authored/pi-aliases.yaml has a line for the pi model ${piProvider}/${piModel}, which pi's catalog no longer has. Delete the line.` });
    }
  }

  // The catalog's providers, and the ids of each one's entries, in the catalog's order.
  const entriesOf = new Map<string, string[]>(before.providers.map((id) => [id, []]));
  // The hosts each catalog provider's entries are reached at, for same_host.
  const hostsOf = new Map<string, Set<string>>(before.providers.map((id) => [id, new Set<string>()]));
  for (const row of before.entries) {
    entriesOf.get(row.provider)?.push(row.model);
    const hosts = hostsOf.get(row.provider);
    for (const url of row.base_urls) {
      const host = hostOf(url);
      if (host && hosts) hosts.add(host);
    }
  }

  const providers: PiMatching["providers"] = [];
  const unmatched: PiReport["unmatched"] = [];
  const candidates: PiAssignment[] = [];
  for (const piProvider of Object.keys(pi).sort(byText)) {
    const models = own(pi, piProvider)!;
    const line = own(lines, piProvider);
    let target: string | null = null;
    let state: PiReport["providers"][number]["state"] = "absent";
    let orphaned = false;
    if (entriesOf.has(piProvider)) {
      target = piProvider;
      state = "shared";
      if (line?.same_as !== undefined) {
        issues.push({ level: "warning", code: "pi-provider-collides", target: where(piProvider), message: `data/authored/pi-aliases.yaml pairs the pi provider ${piProvider} with ${line.same_as}, but the catalog has a provider ${piProvider} itself. The catalog's own provider is used and the same_as is ignored.` });
      }
    } else if (line?.same_as !== undefined) {
      if (entriesOf.has(line.same_as)) {
        target = line.same_as;
        state = "paired";
      } else {
        orphaned = true;
        issues.push({ level: "warning", code: "pi-alias-orphan", target: where(piProvider), message: `data/authored/pi-aliases.yaml pairs the pi provider ${piProvider} with ${line.same_as}, which the catalog does not have. Its models belong to no entry.` });
      }
    } else if (line && Object.keys(line.models).length > 0) {
      for (const piModel of Object.keys(line.models)) {
        if (!own(models, piModel)) continue;
        issues.push({ level: "warning", code: "pi-alias-orphan", target: where(piProvider, piModel), message: `data/authored/pi-aliases.yaml pairs the pi model ${piProvider}/${piModel}, but the catalog has no provider ${piProvider} and the file pairs it with none.` });
      }
    }
    const piHosts = new Set(Object.values(models).map((model) => hostOf(model.baseUrl)).filter((host): host is string => host !== null));
    const sameHost = [...hostsOf].filter(([, hosts]) => [...hosts].some((host) => piHosts.has(host))).map(([id]) => id).sort(byText);
    providers.push({ pi_provider: piProvider, state, catalog_provider: target, same_host: sameHost });

    const entryIds = target ? entriesOf.get(target)! : [];
    const entries = new Set(entryIds);
    const alike = (piModel: string): string[] => entryIds.filter((id) => squeezed(id) === squeezed(piModel)).sort(byText);
    for (const piModel of Object.keys(models).sort(byText)) {
      const model = own(models, piModel)!;
      const modelLine = line ? own(line.models, piModel) : undefined;
      if (!target) {
        unmatched.push({ pi_provider: piProvider, pi_model: piModel, name: model.name, why: orphaned || modelLine ? "alias-orphan" : "provider-absent", alike: [] });
        continue;
      }
      if (entries.has(piModel)) {
        if (modelLine) {
          issues.push({ level: "notice", code: "pi-alias-redundant", target: where(piProvider, piModel), message: `The model line for ${piProvider}/${piModel} in data/authored/pi-aliases.yaml is no longer needed: ${target} now has an entry with the pi model's own id. Delete the line.` });
        }
        candidates.push({ piProvider, piModel, model, provider: target, entry: piModel, match: state === "shared" ? "id" : "alias" });
        continue;
      }
      if (modelLine) {
        if (entries.has(modelLine.same_as)) {
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
      models: Object.keys(own(pi, provider.pi_provider) ?? {}).length,
      matched: perProvider.get(provider.pi_provider)?.matched ?? 0,
      left_out: perProvider.get(provider.pi_provider)?.left_out ?? 0,
      unmatched: unmatchedOf.get(provider.pi_provider) ?? 0,
      same_host: provider.same_host,
    })),
    unmatched: matching.unmatched,
    left_out: leftOut,
  };
}

// ---- the one entry point of pi's part of the build (design/pi-source.md, section k)

export interface PiPartInput {
  pi: PiCatalog;
  aliases: PiAliases | undefined;
  before: CatalogBefore;
  ruledOut: { ref: string; rule: string }[];
  /** Copies of plain facts of the entry as published; undefined where the ref is not published. */
  entryOf: (ref: string) => PiEntryFacts | undefined;
}

export interface PiPart {
  /** One per pi model whose entry is published. `ref` is the entry's, provider/model of the catalog. */
  blocks: { ref: string; block: PiBlock }[];
  report: PiReport;
  /** The alias issues of section c. */
  issues: Issue[];
}

/**
 * Everything pi's catalog adds to a dataset that is complete without it: the match against the catalog before any
 * exclusion, a block for each pi model whose entry is published, worked out against that entry as published, and the
 * report. A pi model is matched where `entryOf` knows its entry, left out where it does not, by the catalog rule that
 * left the entry out or else by an override.
 */
export function piPart(input: PiPartInput): PiPart {
  const matching = matchPi(input.pi, input.aliases, input.before);
  const ruledOut = new Map(input.ruledOut.map((item) => [item.ref, item.rule]));
  const published = new Set<PiAssignment>();
  const blocks: PiPart["blocks"] = [];
  for (const assignment of matching.assignments) {
    const ref = `${assignment.provider}/${assignment.entry}`;
    const entry = input.entryOf(ref);
    if (!entry) continue;
    published.add(assignment);
    blocks.push({ ref, block: piBlock(assignment.piProvider, assignment.model, assignment.match, entry) });
  }
  const report = piReport(input.pi, matching, (assignment) => published.has(assignment), (ref) => ruledOut.get(ref) ?? "override");
  return { blocks, report, issues: matching.issues };
}
