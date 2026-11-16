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
/**
 * Which entries of the provider a rule is about, by what the source documents for them. For a statement about the
 * provider's API rather than about one model: "at this provider, a request sets the cache lifetime with this field".
 */
export const RuleSelect = z.strictObject({
  /** The way of caching the entry must be documented to support. */
  cache_mode: z.enum(["implicit", "explicit"]),
  /** Lifetimes the entry must document for that mode, all of them, as the source writes them ("5m", "1h"). Left out = any lifetime, or none. */
  cache_ttl: z.array(z.string().min(1)).min(1).optional(),
  /** Only among these model ids: where the provider's page names the models its statement holds for. Left out = every entry of the provider. */
  models: z.array(z.string().min(1)).min(1).optional(),
});
export type RuleSelect = z.infer<typeof RuleSelect>;

export const OverrideRule = z
  .strictObject({
    /** Model ids this rule applies to. */
    models: z.array(z.string().min(1)).min(1).optional(),
    /** Instead of `models`: every entry of the provider that documents this. Only for declaring request controls. */
    select: RuleSelect.optional(),
    /** Fields to merge over the upstream entry. null = explicitly unknown, "$delete" = remove. */
    set: z.record(z.string(), z.json()).optional(),
    cache_retention: CacheRetentionDeclarationSchema.optional(),
    pricing: PricingDeclarationSchema.optional(),
    request_controls: RequestControlDeclarationsSchema.optional(),
    /** True removes the entries from the published catalog (a tombstone). */
    exclude: z.boolean().optional(),
    reason: z.string().min(1),
    evidence: z.array(Evidence).min(1),
  })
  .superRefine((rule, ctx) => {
    if ((rule.models === undefined) === (rule.select === undefined)) ctx.addIssue({ code: "custom", message: "A rule names its entries with `models` or selects them with `select`: exactly one of the two." });
    // A correction changes what is published for an entry, so it names the entry. A selection follows the catalog.
    if (rule.select && (rule.set !== undefined || rule.exclude !== undefined || rule.pricing !== undefined || rule.cache_retention !== undefined)) ctx.addIssue({ code: "custom", path: ["select"], message: "A `select` rule declares `request_controls` only. A correction, an exclusion or a price names its entries with `models`." });
    if (rule.select && !rule.request_controls?.length) ctx.addIssue({ code: "custom", path: ["request_controls"], message: "A `select` rule needs `request_controls`." });
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

// ---- authored: rules over the whole catalog (data/authored/catalog-rules.yaml)
/**
 * Leaves out the versions of a model family before a given one, at every provider, whoever added the entry. An
 * editorial choice of providers.dev, not a statement about a provider: it carries a reason and a date, no evidence.
 */
export const FamilyExclusion = z.strictObject({
  /** Names the rule in /api/v1/meta. */
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
  /** The published `family` of the entries the rule looks at, exactly as models.dev writes it; or a list of families that one rule covers. */
  family: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  /**
   * The word next to which the version is written ("opus" in claude-opus-4-1, claude-3-opus), or several words (gpt,
   * chatgpt). The word stands alone: "opus" is not read in "opusdistill" or "magnum-opus".
   */
  word: z.union([z.string().regex(/^[a-z]+$/), z.array(z.string().regex(/^[a-z]+$/)).min(1)]),
  /** The first version that is kept: major, or major.minor. Every version below it is left out, every one from it on is kept. */
  before: z.string().regex(/^\d{1,2}(\.\d)?$/),
  /** Words that, written right after `word` in a model id instead of a version, make the entry an alias that is kept (claude-opus-latest). */
  aliases: z.array(z.string().regex(/^[a-z]+$/)).default([]),
  /** Where the version is read, in this order: the first that has one counts. */
  read: z.array(z.enum(["id", "canonical_id", "name"])).min(1).default(["id", "canonical_id", "name"]),
  /** True: two digits written together right after the word are major and minor (gpt-56 is 5.6, gpt-61 is 6.1). A version 10 or above cannot be told from them. */
  joined_digits: z.boolean().default(false),
  /** An entry of the family with no version where the rule reads: `report` publishes it and reports a dataset issue; `keep` publishes it, silently (a moving alias, a model with numbering of its own). */
  no_version: z.enum(["report", "keep"]).default("report"),
  /** What the rule leaves out, in words, as published. */
  leaves_out: z.string().min(1),
  reason: z.string().min(1),
  /** The day the rule was decided (YYYY-MM-DD). */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type FamilyExclusion = z.infer<typeof FamilyExclusion>;

export const CatalogRules = z
  .strictObject({ exclude: z.array(FamilyExclusion).default([]) })
  .superRefine((rules, ctx) => {
    const seen = new Set<string>();
    rules.exclude.forEach((rule, index) => {
      if (seen.has(rule.id)) ctx.addIssue({ code: "custom", path: ["exclude", index, "id"], message: `Two rules have the id "${rule.id}".` });
      seen.add(rule.id);
    });
  });
export type CatalogRules = z.infer<typeof CatalogRules>;

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
/** What a client the labels file does not describe is published as. */
export const OTHER_CLIENT = { id: "other", label: "Another client" } as const;

// One public client id has one label: several raw clients may share an id only with the same label. So the label of
// a published client is a function of its id, and nothing depends on which of its evaluations comes first. The id
// `other` is taken by OTHER_CLIENT and keeps its label.
export const MeasurementLabels = z
  .strictObject({
    clients: z.record(z.string(), z.strictObject({ id: z.string().min(1), label: z.string().min(1) })),
    omit_note_parts_mentioning: z.array(z.string().min(1)).default([]),
  })
  .superRefine((file, ctx) => {
    const seen = new Map<string, { raw: string | null; label: string }>([[OTHER_CLIENT.id, { raw: null, label: OTHER_CLIENT.label }]]);
    for (const [raw, client] of Object.entries(file.clients)) {
      const before = seen.get(client.id);
      if (!before) {
        seen.set(client.id, { raw, label: client.label });
        continue;
      }
      if (before.label === client.label) continue;
      const first = before.raw === null ? `a client the file does not describe ("${before.label}")` : `"${before.raw}" ("${before.label}")`;
      ctx.addIssue({
        code: "custom",
        path: ["clients", raw, "label"],
        message: `Public client id "${client.id}" has two labels: ${first} and "${raw}" ("${client.label}"). One public client id has one label.`,
      });
    }
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
})
  // A run has one check result per age: groundtruth keys a run's checks by age, also where one run continues another.
  // A file that holds an age twice is wrong, and is refused rather than read in an order-dependent way.
  .superRefine((run, ctx) => {
    const seen = new Set<number>();
    for (const [index, item] of (run.checks ?? []).entries()) {
      if (seen.has(item.age_s)) {
        ctx.addIssue({ code: "custom", path: ["checks", index, "age_s"], message: `Run "${run.id}" has two checks at age ${item.age_s} s. A run has one check result per age.` });
      }
      seen.add(item.age_s);
    }
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
// Everything providers.dev publishes of its own has a fixed set of keys: a value that is not known is null, a list
// with nothing in it is empty, and no key is ever left out. Only the models.dev part of a provider or an entry keeps
// models.dev's own shape, where an absent field means models.dev has no value.

/** The same object with every optional field made a required one that can be null. */
export type Nulled<T> = { [K in keyof T]-?: undefined extends T[K] ? Exclude<T[K], undefined> | null : T[K] };

/** Evidence as published: the note is always there, null where the author wrote none. */
export type PublishedEvidence = Nulled<Evidence>;

/** A correction as it is being worked out. */
export interface DraftProvenance extends Change {
  reason: string;
  evidence: Evidence[];
}

/** One correction to a field imported from models.dev. */
export interface Provenance {
  /** Dot path of the field, for example `limit.context`. */
  path: string;
  op: Change["op"];
  /** The published value. Null unless `op` is `set`. */
  value: Json | null;
  /** True when models.dev has a value at this path. */
  had_upstream: boolean;
  /** What models.dev says. Null unless `had_upstream`. */
  upstream: Json | null;
  reason: string;
  evidence: PublishedEvidence[];
}

export interface MeasuredLimit {
  route: string;
  route_label: string;
  client: string;
  client_label: string;
  /** Tokens. Null = this evaluation did not measure it. */
  context: number | null;
  output: number | null;
  input_accepted: number | null;
  input_refused: number | null;
  output_accepted: number | null;
  note: string | null;
  date: string | null;
  source: string;
}

export interface ModelExtension {
  origin: "upstream" | "added";
  access: Access;
  /** Corrections that replaced, hid or removed an upstream value. Empty = none. */
  provenance: Provenance[];
  /** Fields copied from another entry, for entries we add: identity, and `cost` where a subscription entry carries the API list price. Null = nothing is inherited. */
  inherited: { from: string; fields: string[] } | null;
  /** Prompt caching beyond what the source documents: what a request can ask for, and what evaluations measured. On every entry. */
  cache: EntryCache;
  pricing: Pricing;
  request_controls: RequestControls;
  limits: {
    /** Limit evaluations. Empty = none. */
    measured: MeasuredLimit[];
    /** On an entry we add: which of limit.context and limit.output are our measured values. */
    from_measurement: ("context" | "output")[];
  };
  evidence: PublishedEvidence[];
  /** The newest date among our evidence and measurements for this entry. Null = none. */
  verified: string | null;
}

export interface ProviderExtension {
  origin: "upstream" | "added";
  access: Access;
  access_basis: string;
  access_reviewed: boolean;
  access_source: string | null;
  note: string | null;
  evidence: PublishedEvidence[];
  provenance: Provenance[];
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
    | "excluded-observation"
    | "rule-version-unread"
    | "redundant-override"
    | "addition-collides"
    | "inherit-target-missing"
    | "unmapped-route"
    | "unmapped-client"
    | "invalid-authored"
    | "reserved-field"
    | "lifetime-differs"
    | "unparsed-lifetime"
    | "retention-lifetime-differs";
  target: string;
  message: string;
}

/**
 * What is left out of the catalog. `entry` and `provider`: an override's `exclude`, with its evidence. `rule`: a rule of
 * data/authored/catalog-rules.yaml, an editorial choice with no evidence, its target the rule id.
 */
export interface Exclusion {
  kind: "entry" | "provider" | "rule";
  target: string;
  /** What a rule leaves out, in words. Null for an entry or a provider: the target says it. */
  leaves_out: string | null;
  reason: string;
  /** The day a rule was decided. Null for an entry or a provider: the evidence carries the dates. */
  date: string | null;
  evidence: PublishedEvidence[];
  /** The entries it removed in this build. */
  entries: number;
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
  /** The ages, in seconds, that every table of cache results by age has a column for, after the control at age 0. */
  cache_ages_s: number[];
  /**
   * providers.dev evidence (a correction, an evaluation, a measured lifetime) whose date is more than this many days
   * before today is shown as stale. The API publishes the dates and this number; a reader applies it to its own date.
   */
  stale_after_days: number;
  upstream: Nulled<UpstreamMeta>;
  /** The results repository the evaluations come from. Null = the dataset has none. */
  measurements: (Nulled<SourceMeta> & { repository: string }) | null;
  sync: { last_attempt_at: string | null; last_attempt_ok: boolean | null; last_error: string | null };
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
