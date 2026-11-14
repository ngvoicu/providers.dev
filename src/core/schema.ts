// Shapes of everything that enters or leaves the build: the upstream snapshot, our authored files,
// the measurements file, and the published catalog.
import { z } from "zod";
import type { EntryCache } from "./cache.ts";
import { CacheRetentionDeclarationSchema } from "./cache-contract.ts";
import { ModelMetadataShape } from "./metadata-contract.ts";
import { PricingDeclarationSchema, RequestControlDeclarationsSchema, type Pricing, type RequestControls } from "./policy-contract.ts";
import type { Change, Json, JsonObject } from "./merge.ts";

export const SCHEMA_VERSION = 1;
export const UPSTREAM_SCHEMA = "models.dev v2 (experimental)";
/** Everything we add to a provider or model lives under this one key. */
export const NS = "providers_dev";

export const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-13");

// ---- upstream (models.dev v2). Lenient on purpose: we check identity and the fields we read, and keep the rest.
export const UpstreamModel = z.looseObject(ModelMetadataShape);

export const UpstreamProvider = z.looseObject({
  id: z.string().regex(PROVIDER_ID),
  name: z.string().min(1),
  doc: z.string().optional(),
  env: z.array(z.string()).optional(),
  models: z.record(z.string(), UpstreamModel),
});

export const UpstreamCatalog = z.record(z.string(), UpstreamProvider);
export type UpstreamCatalog = z.infer<typeof UpstreamCatalog>;

export interface UpstreamMeta {
  source: string;
  schema: string;
  fetched_at: string;
  checked_at: string;
  etag?: string;
  commit?: string;
  commit_date?: string;
  sha256: string;
  providers: number;
  models: number;
}

// ---- authored: evidence
export const Evidence = z.strictObject({
  /** documented = the provider says so; measured = we ran it; listed = the provider's own model list reports it. */
  kind: z.enum(["documented", "measured", "listed"]),
  url: z.url(),
  date: isoDate,
  note: z.string().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

export const Access = z.enum(["api", "subscription", "unknown"]);
export type Access = z.infer<typeof Access>;

// ---- authored: providers we add (data/authored/providers/<id>.yaml)
export const AuthoredModel = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  /** `provider/model` of an upstream entry to take identity fields from (never limits, cache or prices). */
  inherits: z.string().optional(),
  fields: z.record(z.string(), z.json()).optional(),
  cache_retention: CacheRetentionDeclarationSchema.optional(),
  pricing: PricingDeclarationSchema.optional(),
  request_controls: RequestControlDeclarationsSchema.optional(),
  evidence: z.array(Evidence).min(1),
});
export type AuthoredModel = z.infer<typeof AuthoredModel>;

export const AuthoredProvider = z.strictObject({
  id: z.string().regex(PROVIDER_ID),
  name: z.string().min(1),
  doc: z.url().optional(),
  access: Access,
  access_basis: z.string().min(1),
  note: z.string().optional(),
  evidence: z.array(Evidence).min(1),
  models: z.array(AuthoredModel).default([]),
});
export type AuthoredProvider = z.infer<typeof AuthoredProvider>;

// ---- authored: overrides on upstream entries (data/authored/overrides/<provider>.yaml)
export const OverrideRule = z.strictObject({
  /** Model ids this rule applies to. */
  models: z.array(z.string().min(1)).min(1),
  /** Fields to merge over the upstream entry. null = explicitly unknown, "$delete" = remove. */
  set: z.record(z.string(), z.json()).optional(),
  cache_retention: CacheRetentionDeclarationSchema.optional(),
  pricing: PricingDeclarationSchema.optional(),
  request_controls: RequestControlDeclarationsSchema.optional(),
  /** True removes the entries from the published catalog (a tombstone). */
  exclude: z.boolean().optional(),
  reason: z.string().min(1),
  evidence: z.array(Evidence).min(1),
});
export type OverrideRule = z.infer<typeof OverrideRule>;

export const OverrideFile = z.strictObject({
  provider: z.string().regex(PROVIDER_ID),
  /** Tombstone for the whole provider. */
  exclude: z
    .strictObject({ reason: z.string().min(1), evidence: z.array(Evidence).min(1) })
    .optional(),
  /** Fields to merge over the provider itself (not its models). */
  set: z.record(z.string(), z.json()).optional(),
  set_reason: z.string().optional(),
  set_evidence: z.array(Evidence).optional(),
  rules: z.array(OverrideRule).default([]),
});
export type OverrideFile = z.infer<typeof OverrideFile>;

// ---- authored: access classification (data/authored/access.yaml)
export const AccessRules = z.strictObject({
  default: Access,
  default_basis: z.string(),
  patterns: z.array(z.strictObject({ match: z.string(), access: Access, basis: z.string() })).default([]),
  providers: z.record(z.string(), z.strictObject({ access: Access, basis: z.string(), source: z.url().optional() })).default({}),
});
export type AccessRules = z.infer<typeof AccessRules>;

// ---- authored: where each measured route lands (data/authored/routes.yaml)
export const RouteMap = z.record(z.string(), z.strictObject({ provider: z.string().regex(PROVIDER_ID) }));
export type RouteMap = z.infer<typeof RouteMap>;

// ---- authored: public names for the measurement file's clients (data/authored/measurement-labels.yaml)
export const MeasurementLabels = z.strictObject({
  clients: z.record(z.string(), z.strictObject({ id: z.string().min(1), label: z.string().min(1) })),
  omit_note_parts_mentioning: z.array(z.string().min(1)).default([]),
});
export type MeasurementLabels = z.infer<typeof MeasurementLabels>;

// ---- measurements (observed.json from groundtruth)
const check = z.looseObject({ age: z.string().optional(), age_s: z.number(), warm: z.number(), total: z.number() });
export const ObservedRun = z.looseObject({
  id: z.string(),
  route: z.string(),
  client: z.string(),
  model: z.string(),
  models_dev: z.string().nullable().optional(),
  base_model: z.string().nullable().optional(),
  options: z.record(z.string(), z.json()).optional(),
  date: isoDate,
  source: z.string(),
  control: z.looseObject({ warm: z.number(), total: z.number() }).optional(),
  checks: z.array(check).optional(),
  late_excluded: z.number().optional(),
  all_warm_through_s: z.number().nullable().optional(),
  last_warm_s: z.number().nullable().optional(),
  first_all_cold_s: z.number().nullable().optional(),
  latest: z.boolean().optional(),
  /** Set on runs taken with a client that lacked something the route needs; such runs are not published. */
  lacks: z.string().optional(),
  note: z.string().optional(),
});
export type ObservedRun = z.infer<typeof ObservedRun>;

export const ObservedLimit = z.looseObject({
  route: z.string(),
  client: z.string(),
  model: z.string(),
  models_dev: z.string().nullable().optional(),
  base_model: z.string().nullable().optional(),
  context: z.number().nullable().optional(),
  output: z.number().nullable().optional(),
  input_accepted: z.number().optional(),
  input_refused: z.number().optional(),
  output_accepted: z.number().optional(),
  note: z.string().optional(),
  source: z.string(),
});
export type ObservedLimit = z.infer<typeof ObservedLimit>;

export const ObservedKnown = z.looseObject({
  route: z.string(),
  client: z.string(),
  model: z.string(),
  ttl_s: z.number(),
  basis: z.string(),
  source: z.string(),
  when: z.record(z.string(), z.json()).optional(),
});

export const ObservedFile = z.looseObject({
  schema: z.number(),
  repository: z.url(),
  routes: z.record(z.string(), z.string()),
  clients: z.record(z.string(), z.string()),
  cache: z.array(ObservedRun),
  limits: z.array(ObservedLimit).default([]),
  known: z.array(ObservedKnown).default([]),
});
export type ObservedFile = z.infer<typeof ObservedFile>;

export interface SourceMeta {
  source: string;
  fetched_at: string;
  checked_at: string;
  etag?: string;
  sha256: string;
}

// ---- published
export interface Provenance extends Change {
  reason: string;
  evidence: Evidence[];
}

export interface MeasuredLimit {
  route: string;
  route_label: string;
  client: string;
  client_label: string;
  context?: number;
  output?: number;
  input_accepted?: number;
  input_refused?: number;
  output_accepted?: number;
  note?: string;
  date?: string;
  source: string;
}

export interface ModelExtension {
  origin: "upstream" | "added";
  access: Access;
  /** Fields of with_evidence that replaced, hid or removed an upstream value. */
  provenance?: Provenance[];
  /** Fields copied from another entry, for entries we add: identity, and `cost` where a subscription entry carries the API list price. */
  inherited?: { from: string; fields: string[] };
  /** Prompt caching beyond what the source documents: what a request can ask for, and what evaluations measured. On every entry. */
  cache: EntryCache;
  pricing: Pricing;
  request_controls: RequestControls;
  limits?: {
    measured?: MeasuredLimit[];
    /** On an entry we add: which of limit.context and limit.output are our measured values. */
    from_measurement?: ("context" | "output")[];
  };
  evidence?: Evidence[];
  /** The newest date among our evidence and measurements for this entry. */
  verified?: string;
}

export interface ProviderExtension {
  origin: "upstream" | "added";
  access: Access;
  access_basis: string;
  access_reviewed: boolean;
  access_source?: string;
  note?: string;
  evidence?: Evidence[];
  provenance?: Provenance[];
}

export type PublishedModel = JsonObject & { id: string; name: string };
export type PublishedProvider = JsonObject & { id: string; name: string; models: Record<string, PublishedModel> };
export type Catalog = Record<string, PublishedProvider>;

export type IssueLevel = "error" | "warning" | "notice";
export interface Issue {
  level: IssueLevel;
  code:
    | "orphan-override"
    | "orphan-observation"
    | "redundant-override"
    | "addition-collides"
    | "inherit-target-missing"
    | "unmapped-route"
    | "unmapped-client"
    | "invalid-authored"
    | "reserved-field";
  target: string;
  message: string;
  file?: string;
}

export interface Exclusion {
  target: string;
  reason: string;
  evidence: Evidence[];
}

export interface Meta {
  api_version: "v1";
  schema_version: number;
  upstream_schema: string;
  dataset_version: string;
  generated_at: string;
  counts: {
    providers: number;
    /** Provider-model entries. */
    entries: number;
    /** Canonical models: the distinct `canonical_id` values of the entries. */
    models: number;
    added_providers: number;
    added_entries: number;
    corrected_entries: number;
    evaluated_entries: number;
    cache_evaluations: number;
    limit_evaluations: number;
  };
  /** The ages, in seconds, that every cache summary table has a column for, after the control at age 0. */
  cache_ages_s: number[];
  upstream: UpstreamMeta;
  measurements?: SourceMeta & { repository: string };
  sync: { last_attempt_at?: string; last_attempt_ok?: boolean; last_error?: string };
  exclusions: Exclusion[];
  issues: Issue[];
  license: { data: string; upstream: string; notice: string };
}

export function ext(model: JsonObject): ModelExtension {
  return model[NS] as unknown as ModelExtension;
}
export function providerExt(provider: JsonObject): ProviderExtension {
  return provider[NS] as unknown as ProviderExtension;
}
export type { Json, JsonObject };
