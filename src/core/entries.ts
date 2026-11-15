// The flat view of the catalog: one summary per provider-model entry.
// The website tables, /api/v1/entries and the compact index all use these summaries, built once by buildIndex().
import { cacheFacts, type CacheLifetimeRecord, type CacheMode, type CacheRetention, type CacheSummaryRow, type CacheSupport, type Support } from "./cache.ts";
import { isObject, type JsonObject } from "./merge.ts";
import type { Pricing, RequestControls } from "./policy-contract.ts";
import { NS, type Access, type Catalog, type ModelExtension, type ProviderExtension } from "./schema.ts";

export { cacheFacts, durationSeconds } from "./cache.ts";
export type { CacheMode, CacheSupport } from "./cache.ts";
export type Origin = "upstream" | "modified" | "added";

/**
 * One entry in short. Every summary has every field: a value no source gives is null, never left out, so that a
 * client can read any field of any entry without checking that it is there.
 */
export interface Summary {
  /** `provider/model`. Provider ids never contain a slash, so the first slash ends the provider. */
  ref: string;
  provider: string;
  model: string;
  name: string;
  type: string | null;
  family: string | null;
  canonical_id: string | null;
  status: string | null;
  release_date: string | null;
  access: Access;
  /** upstream = as imported; modified = an upstream entry with our overrides or measurements; added = an entry models.dev does not have. */
  origin: Origin;
  /** limit.context: the context window this provider exposes for the model, in tokens. Null = unknown. */
  context: number | null;
  /** limit.input: the largest input this provider accepts, where it is lower than the context window. Null = not stated. */
  input: number | null;
  /** limit.output: the most tokens one response can hold. A maximum, not a default. Null = unknown. */
  max_output: number | null;
  cache: CacheSupport;
  cache_modes: CacheMode[];
  cache_mode_support: Record<CacheMode, Support>;
  /** Cache lifetimes the provider documents, in seconds, shortest first. */
  cache_ttl_s: number[];
  /** The documented lifetimes of each mode, in seconds. Null = no lifetime is documented for the mode. */
  cache_ttl_by_mode_s: Record<CacheMode, number[] | null>;
  /** Whether a request can ask for a cache lifetime on this entry: `providers_dev.cache.retention.support` of the full entry. */
  cache_retention: CacheRetention["support"];
  /** Every cache lifetime of this entry and the safe value of each profile: the same object as `providers_dev.cache.lifetime` of the full entry. */
  cache_lifetime: CacheLifetimeRecord;
  /** How many cache evaluations this entry has. */
  evaluation_count: number;
  /**
   * The cache evaluations of this entry as one table: a line per retention setting (short first, then long), each with
   * its results by exact age. The same object as `providers_dev.cache.results` of the full entry. Null = not evaluated.
   */
  cache_results: CacheSummaryRow[] | null;
  /** The base price of text input, in US dollars per million tokens, before any conditional rate. Null = unknown, or priced in another unit. */
  price_in: number | null;
  /** The same for output. */
  price_out: number | null;
  /** The ref of the API entry whose list price this is, on a subscription entry. Null = the price is the entry's own. */
  price_from: string | null;
  pricing: Pricing;
  request_controls: RequestControls;
  /** The largest input an evaluation saw accepted on this entry, in tokens. The real limit is at least this. Null = not measured. */
  measured_input_accepted: number | null;
  /** The smallest input an evaluation saw refused. The real limit is below this. Null = not measured. */
  measured_input_refused: number | null;
  /** How many limit evaluations this entry has. */
  measured_limit_count: number;
  overridden_fields: string[];
  /** Newest date of our own evidence for this entry. Null = it has none. */
  verified: string | null;
  /** Which file under /data/entries/<provider>/ holds the full entry. */
  shard: number;
}

export interface ProviderSummary {
  id: string;
  name: string;
  /** The provider's documentation. Null = models.dev records none. */
  doc: string | null;
  /** The environment variables a client reads the key from, as models.dev records them. */
  env: string[];
  access: Access;
  access_reviewed: boolean;
  origin: "upstream" | "added";
  /** How many entries the provider has. */
  entry_count: number;
  /** How many of them have providers.dev corrections or evaluations. */
  evidence_entry_count: number;
  /** How the provider is reached and why it is classified so, with evidence where providers.dev added it. */
  providers_dev: ProviderExtension;
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

const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** The base price of one side of `cost.text`. A price in another unit (per character) is not a price per token. */
function basePrice(pricing: Pricing, side: "input" | "output"): number | null {
  const rules = pricing.rules?.filter((rule) => rule.meter === `text.${side}` && rule.when === null && rule.operation === "set" && rule.currency === "USD" && rule.unit?.name === "token" && rule.unit.quantity === 1000000) ?? [];
  return (rules.length === 1 ? rules[0]!.amount : pricing.rule_order === "listed" ? rules.at(-1)?.amount : undefined) ?? null;
}

export function summarize(providerId: string, model: JsonObject, shard: number): Summary {
  const extension = model[NS] as unknown as ModelExtension;
  const limit = isObject(model.limit) ? model.limit : {};
  const runs = extension.cache.evaluations;
  const overridden = extension.provenance.map((change) => change.path);
  const measuredLimits = extension.limits.measured;
  const accepted = measuredLimits.map((item) => item.input_accepted).filter((value): value is number => typeof value === "number");
  const refused = measuredLimits.map((item) => item.input_refused).filter((value): value is number => typeof value === "number");
  const touched = overridden.length > 0 || runs.length > 0 || extension.evidence.length > 0 || measuredLimits.length > 0;
  // One fixed order of keys, the same on every entry.
  return {
    ref: `${providerId}/${String(model.id)}`,
    provider: providerId,
    model: String(model.id),
    name: String(model.name),
    type: text(model.type),
    family: text(model.family),
    canonical_id: text(model.canonical_id),
    status: text(model.status),
    release_date: text(model.release_date),
    access: extension.access,
    origin: extension.origin === "added" ? "added" : touched ? "modified" : "upstream",
    context: count(limit.context),
    input: count(limit.input),
    max_output: count(limit.output),
    ...cacheFacts(extension.cache.documented),
    cache_retention: extension.cache.retention.support,
    cache_lifetime: extension.cache.lifetime,
    evaluation_count: runs.length,
    cache_results: extension.cache.results,
    price_in: basePrice(extension.pricing, "input"),
    price_out: basePrice(extension.pricing, "output"),
    price_from: extension.pricing.billing === "reference" ? extension.pricing.reference_ref : null,
    pricing: extension.pricing,
    request_controls: extension.request_controls,
    measured_input_accepted: accepted.length > 0 ? Math.max(...accepted) : null,
    measured_input_refused: refused.length > 0 ? Math.min(...refused) : null,
    measured_limit_count: measuredLimits.length,
    overridden_fields: overridden,
    verified: extension.verified,
    shard,
  };
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
      doc: typeof provider.doc === "string" ? provider.doc : null,
      env: Array.isArray(provider.env) ? provider.env.filter((name): name is string => typeof name === "string") : [],
      access: extension.access,
      access_reviewed: extension.access_reviewed,
      origin: extension.origin,
      entry_count: models.length,
      evidence_entry_count: with_evidence,
      providers_dev: extension,
    });
  }
  return { dataset_version: datasetVersion, generated_at: generatedAt, upstream_fetched_at: upstreamFetchedAt, providers, entries };
}
