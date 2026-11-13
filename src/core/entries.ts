// The flat view of the catalog: one summary per provider-model entry.
// The website table, /api/v1/models and the compact index all use these summaries, built once by buildIndex().
import { isObject, type JsonObject } from "./merge.ts";
import { NS, type Access, type Catalog, type ModelExtension, type ProviderExtension } from "./schema.ts";

export type CacheSupport = "yes" | "no" | "unknown";
export type CacheMode = "implicit" | "explicit";
export type Origin = "upstream" | "modified" | "added";

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

export function cacheFacts(model: JsonObject): Pick<Summary, "cache" | "cache_modes" | "cache_ttl_s"> {
  const capabilities = isObject(model.capabilities) ? model.capabilities : {};
  const cache = capabilities.cache;
  // models.dev: a missing `cache` says nothing; `false` says the entry does not cache.
  if (cache === false) return { cache: "no", cache_modes: [], cache_ttl_s: [] };
  if (!isObject(cache)) return { cache: "unknown", cache_modes: [], cache_ttl_s: [] };
  const modes: CacheMode[] = [];
  const ttl = new Set<number>();
  for (const mode of ["implicit", "explicit"] as const) {
    const value = cache[mode];
    if (value === undefined) continue;
    modes.push(mode);
    if (isObject(value) && Array.isArray(value.ttl)) {
      for (const item of value.ttl) {
        const seconds = durationSeconds(item);
        if (seconds !== undefined) ttl.add(seconds);
      }
    }
  }
  return { cache: modes.length > 0 ? "yes" : "unknown", cache_modes: modes, cache_ttl_s: [...ttl].sort((a, b) => a - b) };
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
