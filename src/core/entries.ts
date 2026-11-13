// The flat view of the catalog: one summary per provider-model entry.
// The website table, /api/v1/models and the compact index all use these summaries, built once by buildIndex().
import { isObject, type JsonObject } from "./merge.ts";
import { NS, type Access, type Catalog, type Measurement, type ModelExtension, type ProviderExtension } from "./schema.ts";

export type CacheSupport = "yes" | "no" | "unknown";
export type CacheMode = "implicit" | "explicit";
export type Origin = "upstream" | "modified" | "added";

/** The ages a pooled cache result is given at. A band holds the checks up to its age and above the band before it. */
export const CACHE_BANDS_S = [150, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400] as const;

/** Every evaluation of an entry that asked for the same cache lifetime, taken together. */
export interface PooledCache {
  /** The lifetime the requests asked for (`ttl` or `prompt_cache_retention`). Absent = they asked for none: the provider's default. */
  asked?: string;
  /** The request parameter that carried it: `ttl` or `prompt_cache_retention`. Present with `asked`. */
  parameter?: string;
  evaluations: number;
  /** Per band with at least one check: re-sends served from the cache, and re-sends made. */
  bands: { up_to_s: number; warm: number; total: number }[];
}

export interface Summary {
  /** `provider/model`. Provider ids never contain a slash, so the first slash ends the provider. */
  ref: string;
  provider: string;
  model: string;
  name: string;
  type?: string;
  family?: string;
  canonical_id?: string;
  status?: string;
  release_date?: string;
  access: Access;
  /** upstream = as imported; modified = an upstream entry with our overrides or measurements; added = an entry models.dev does not have. */
  origin: Origin;
  /** limit.context: the context window this provider exposes for the model, in tokens. */
  context?: number;
  /** limit.input: the largest input this provider accepts, where it is lower than the context window. */
  input?: number;
  /** limit.output: the most tokens one response can hold. A maximum, not a default. */
  max_output?: number;
  cache: CacheSupport;
  cache_modes: CacheMode[];
  /** Cache lifetimes the provider documents, in seconds, shortest first. */
  cache_ttl_s: number[];
  /** The documented lifetimes of each mode, in seconds. A mode with no documented lifetime has no key. */
  cache_ttl_by_mode_s?: Partial<Record<CacheMode, number[]>>;
  /** Our cache measurements on this entry. */
  evaluations: number;
  /** Across those runs: the shortest and longest age at which every check was still warm, in seconds. */
  /** cost.text.input.price: the list price of input, in US dollars per million tokens, before any change by context size or tier. */
  price_in?: number;
  /** cost.text.output.price: the same for output. */
  price_out?: number;
  /** Set where the price is inherited: the ref of the API entry whose list price this is. The entry itself is not paid per token. */
  price_from?: string;
  measured_warm_min_s?: number;
  measured_warm_max_s?: number;
  /** The cache evaluations of this entry taken together, by age. One item per lifetime the requests asked for; the default first. */
  measured_cache?: PooledCache[];
  /** The largest input an evaluation saw accepted on this entry, in tokens. The real limit is at least this. */
  measured_input_accepted?: number;
  /** The smallest input an evaluation saw refused. The real limit is below this. */
  measured_input_refused?: number;
  /** Our limit measurements on this entry. */
  measured_limits: number;
  overridden_fields: string[];
  /** Newest date of our own evidence for this entry. Imported data has none. */
  verified?: string;
  /** Which file under /data/entries/<provider>/ holds the full entry. */
  shard: number;
}

export interface ProviderSummary {
  id: string;
  name: string;
  doc?: string;
  access: Access;
  access_reviewed: boolean;
  origin: "upstream" | "added";
  models: number;
  with_evidence: number;
}

export interface Index {
  dataset_version: string;
  generated_at: string;
  /** When the models.dev part of this dataset was imported. */
  upstream_fetched_at: string;
  providers: ProviderSummary[];
  entries: Summary[];
}

export const SHARD_SIZE = 40;

const UNIT_SECONDS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 };

/** "5m" -> 300. Returns undefined for anything that is not a models.dev duration. */
export function durationSeconds(value: unknown): number | undefined {
  const match = typeof value === "string" ? /^(\d+)(ms|s|m|h|d)$/.exec(value) : null;
  if (!match) return undefined;
  return Number(match[1]) * (UNIT_SECONDS[match[2] as string] as number);
}

export function cacheFacts(model: JsonObject): Pick<Summary, "cache" | "cache_modes" | "cache_ttl_s" | "cache_ttl_by_mode_s"> {
  const capabilities = isObject(model.capabilities) ? model.capabilities : {};
  const cache = capabilities.cache;
  // models.dev: a missing `cache` says nothing; `false` says the entry does not cache.
  if (cache === false) return { cache: "no", cache_modes: [], cache_ttl_s: [] };
  if (!isObject(cache)) return { cache: "unknown", cache_modes: [], cache_ttl_s: [] };
  const modes: CacheMode[] = [];
  const ttl = new Set<number>();
  const byMode: Partial<Record<CacheMode, number[]>> = {};
  for (const mode of ["implicit", "explicit"] as const) {
    const value = cache[mode];
    if (value === undefined) continue;
    modes.push(mode);
    if (isObject(value) && Array.isArray(value.ttl)) {
      const own = new Set<number>();
      for (const item of value.ttl) {
        const seconds = durationSeconds(item);
        if (seconds !== undefined) own.add(seconds);
      }
      for (const seconds of own) ttl.add(seconds);
      if (own.size > 0) byMode[mode] = [...own].sort((a, b) => a - b);
    }
  }
  return {
    cache: modes.length > 0 ? "yes" : "unknown",
    cache_modes: modes,
    cache_ttl_s: [...ttl].sort((a, b) => a - b),
    ...(Object.keys(byMode).length > 0 ? { cache_ttl_by_mode_s: byMode } : {}),
  };
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** The base price of one side of `cost.text`. A price in another unit (per character) is not a price per token. */
function basePrice(model: JsonObject, side: "input" | "output"): number | undefined {
  const cost = model.cost;
  const words = isObject(cost) ? cost.text : undefined;
  const part = isObject(words) ? words[side] : undefined;
  return isObject(part) && part.unit === undefined ? count(part.price) : undefined;
}

/** The band an age falls in: the first one that reaches it. Ages past the last band count in the last. */
export function cacheBand(ageS: number): number {
  return CACHE_BANDS_S.find((limit) => ageS <= limit) ?? (CACHE_BANDS_S[CACHE_BANDS_S.length - 1] as number);
}

/** The cache lifetime an evaluation's requests asked for, and the parameter that carried it. Undefined = none: the provider's default. */
export function askedLifetime(run: Pick<Measurement, "options">): { parameter: string; value: string } | undefined {
  for (const parameter of ["ttl", "prompt_cache_retention"]) {
    const value = text(run.options?.[parameter]);
    if (value) return { parameter, value };
  }
  return undefined;
}

/**
 * Evaluations of one entry merged by age, across the clients they were sent through. Evaluations that asked for
 * different cache lifetimes are kept apart: they answer different questions.
 */
export function poolCache(runs: readonly Measurement[]): PooledCache[] {
  const groups = new Map<string, { asked?: string; parameter?: string; evaluations: number; counts: Map<number, [number, number]> }>();
  for (const run of runs) {
    const lifetime = askedLifetime(run);
    const key = lifetime?.value ?? "";
    const group = groups.get(key) ?? { ...(lifetime ? { asked: lifetime.value, parameter: lifetime.parameter } : {}), evaluations: 0, counts: new Map() };
    groups.set(key, group);
    group.evaluations += 1;
    for (const check of run.checks ?? []) {
      if (check.total === 0) continue;
      const band = cacheBand(check.age_s);
      const sum = group.counts.get(band) ?? [0, 0];
      group.counts.set(band, [sum[0] + check.warm, sum[1] + check.total]);
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, group]) => ({
      ...(group.asked ? { asked: group.asked, parameter: group.parameter } : {}),
      evaluations: group.evaluations,
      bands: CACHE_BANDS_S.flatMap((limit) => {
        const sum = group.counts.get(limit);
        return sum ? [{ up_to_s: limit, warm: sum[0], total: sum[1] }] : [];
      }),
    }));
}

export function summarize(providerId: string, model: JsonObject, shard: number): Summary {
  const extension = model[NS] as unknown as ModelExtension;
  const limit = isObject(model.limit) ? model.limit : {};
  const runs = extension.cache?.observed ?? [];
  const warm = runs.map((run) => run.all_warm_through_s).filter((value): value is number => typeof value === "number");
  const overridden = (extension.provenance ?? []).map((change) => change.path);
  const measuredLimits = extension.limits?.measured ?? [];
  const accepted = measuredLimits.map((item) => item.input_accepted).filter((value): value is number => typeof value === "number");
  const refused = measuredLimits.map((item) => item.input_refused).filter((value): value is number => typeof value === "number");
  const touched = overridden.length > 0 || runs.length > 0 || (extension.limits?.measured?.length ?? 0) > 0;
  const summary: Summary = {
    ref: `${providerId}/${String(model.id)}`,
    provider: providerId,
    model: String(model.id),
    name: String(model.name),
    access: extension.access,
    origin: extension.origin === "added" ? "added" : touched ? "modified" : "upstream",
    ...cacheFacts(model),
    evaluations: runs.length,
    measured_limits: extension.limits?.measured?.length ?? 0,
    overridden_fields: overridden,
    shard,
  };
  const optional: Partial<Summary> = {
    type: text(model.type),
    family: text(model.family),
    canonical_id: text(model.canonical_id),
    status: text(model.status),
    release_date: text(model.release_date),
    context: count(limit.context),
    input: count(limit.input),
    max_output: count(limit.output),
    price_in: basePrice(model, "input"),
    price_out: basePrice(model, "output"),
    price_from: extension.inherited?.fields.includes("cost") ? extension.inherited.from : undefined,
    measured_warm_min_s: warm.length > 0 ? Math.min(...warm) : undefined,
    measured_warm_max_s: warm.length > 0 ? Math.max(...warm) : undefined,
    measured_cache: runs.length > 0 ? poolCache(runs) : undefined,
    measured_input_accepted: accepted.length > 0 ? Math.max(...accepted) : undefined,
    measured_input_refused: refused.length > 0 ? Math.min(...refused) : undefined,
    verified: extension.verified,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) (summary as unknown as Record<string, unknown>)[key] = value;
  }
  return summary;
}

export function buildIndex(catalog: Catalog, datasetVersion: string, generatedAt: string, upstreamFetchedAt: string): Index {
  const providers: ProviderSummary[] = [];
  const entries: Summary[] = [];
  for (const [id, provider] of Object.entries(catalog)) {
    const extension = provider[NS] as unknown as ProviderExtension;
    const models = Object.values(provider.models);
    let with_evidence = 0;
    models.forEach((model, position) => {
      const summary = summarize(id, model, Math.floor(position / SHARD_SIZE));
      if (summary.origin !== "upstream") with_evidence += 1;
      entries.push(summary);
    });
    providers.push({
      id,
      name: provider.name,
      ...(typeof provider.doc === "string" ? { doc: provider.doc } : {}),
      access: extension.access,
      access_reviewed: extension.access_reviewed,
      origin: extension.origin,
      models: models.length,
      with_evidence,
    });
  }
  return { dataset_version: datasetVersion, generated_at: generatedAt, upstream_fetched_at: upstreamFetchedAt, providers, entries };
}
