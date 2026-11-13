// Shapes of everything that enters or leaves the build: the upstream snapshot, our authored files,
// the measurements file, and the published catalog.
import { z } from "zod";
import type { Change, Json, JsonObject } from "./merge.ts";

export const SCHEMA_VERSION = 1;
export const UPSTREAM_SCHEMA = "models.dev v2 (experimental)";
/** Everything we add to a provider or model lives under this one key. */
export const NS = "providers_dev";

export const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-13");

// ---- upstream (models.dev v2). Lenient on purpose: we check identity and the fields we read, and keep the rest.
const upstreamCache = z.union([
  z.literal(false),
  z.looseObject({
    implicit: z.union([z.literal(true), z.looseObject({ ttl: z.array(z.string()).optional(), min_tokens: z.number().optional() })]).optional(),
    explicit: z
      .union([
        z.literal(true),
        z.looseObject({
          ttl: z.array(z.string()).optional(),
          max_breakpoints: z.number().optional(),
          targets: z.array(z.string()).optional(),
          min_tokens: z.number().optional(),
        }),
      ])
      .optional(),
  }),
]);

export const UpstreamModel = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.string().optional(),
  canonical_id: z.string().optional(),
  family: z.string().optional(),
  status: z.string().optional(),
  release_date: z.string().optional(),
  limit: z
    .looseObject({ context: z.number().min(0).optional(), input: z.number().min(0).optional(), output: z.number().min(0).optional() })
    .optional(),
  capabilities: z.looseObject({ cache: upstreamCache.optional() }).optional(),
});

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

// ---- measurements (observed.json from cache-ttl-probe)
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

export interface Measurement {
  run: string;
  route: string;
  route_label: string;
  client: string;
  client_label: string;
  options?: JsonObject;
  date: string;
  control?: { warm: number; total: number };
  checks?: { age_s: number; warm: number; total: number }[];
  late_excluded?: number;
  /** The longest age at which every check was still served from the cache. */
  all_warm_through_s: number | null;
  /** The longest age at which any check was served from the cache. */
  last_warm_s: number | null;
  /** The shortest age at which every check missed. */
  first_all_cold_s: number | null;
  note?: string;
  source: string;
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
  /** Fields of ours that replaced, hid or removed an upstream value. */
  provenance?: Provenance[];
  /** Identity fields copied from another entry, for entries we add. */
  inherited?: { from: string; fields: string[] };
  cache?: { observed?: Measurement[] };
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
  cache_known?: { client: string; client_label: string; ttl_s: number; basis: string; source: string; when?: JsonObject }[];
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
  counts: { providers: number; models: number; added_providers: number; added_models: number; overridden_models: number; measured_models: number };
  upstream: UpstreamMeta;
  measurements?: SourceMeta & { repository: string; runs: number; limits: number };
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
