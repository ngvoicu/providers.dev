// The API contract: the shape of everything the API returns, written once. The OpenAPI document and the field tables
// of the documentation are generated from these definitions, and the tests check every published object against them.
// Each schema is tied to the TypeScript type the code uses (`satisfies`), so the two cannot drift apart.
// Build-time and server only: nothing in the browser imports this file.
import { z } from "zod";
import type { CacheEvaluation, CacheResult, CacheSummaryRow, EntryCache } from "./cache.ts";
import { CacheDocumentationSchema, CacheModeDocumentationSchema, CacheRetentionSchema, RetentionProfileSchema, SupportSchema } from "./cache-contract.ts";
import { ApiEndpointSchema, CapabilitiesSchema, CachePriceSchema, CostSchema, DocumentedCacheSchema, ModelMetadataShape, PriceConditionSchema, TextPriceSchema } from "./metadata-contract.ts";
import { BillingUnitSchema, ConditionSchema, PolicyEvidenceSchema, PricingRuleSchema, PricingSchema, RequestBindingSchema, RequestControlSchema, RequestControlsSchema, RequestOptionSchema, RequestSettingSchema } from "./policy-contract.ts";
import type { ProviderSummary, Summary } from "./entries.ts";
import type { CanonicalModel, CanonicalModelDetail, Correction, Documentation, Facets } from "./resources.ts";
import { Access, Evidence, type MeasuredLimit, type ModelExtension, type ProviderExtension, type Provenance } from "./schema.ts";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const json = z.json();

// ---- cache: results, summary lines, evaluations, retention
export { CacheRetentionSchema } from "./cache-contract.ts";

export const CacheResultSchema = z
  .strictObject({
    kind: z.enum(["control", "timed"]).describe("control = the prompt sent again at once, which shows it was cached at all. timed = sent again at age_s."),
    age_s: z.int().min(0).describe("Seconds since the prompt was cached. 0 for the control. Exact: 450 (7.5 minutes) is its own age, never folded into 600."),
    hits: z.int().min(0).describe("Re-sends served from the cache."),
    checks: z.int().min(1).describe("Re-sends made. An age nobody checked has no result at all."),
    hit_rate_pct: z.number().min(0).max(100).describe("hits / checks, in percent, two decimals."),
  })
  .describe("What was seen at one age.") satisfies z.ZodType<CacheResult>;

const retentionSetting = {
  retention_profile: RetentionProfileSchema,
  parameter: z.string().nullable().describe("The request field that asked for the lifetime, for example cache_control.ttl or prompt_cache_retention. Null = no lifetime was asked for."),
  value: z.string().nullable().describe("The value sent in it, for example 1h. Null together with parameter."),
};

export const CacheSummaryRowSchema = z
  .strictObject({
    ...retentionSetting,
    evaluations: z.int().min(0).describe("How many evaluations the line adds up. 0 = this retention setting was not evaluated."),
    evaluation_ids: z.array(z.string()).describe("Their ids, as in the entry's evaluations and in /api/v1/evaluations."),
    last_date: date.nullable().describe("The date of the newest of them. Null when not evaluated."),
    results: z.array(CacheResultSchema).nullable().describe("One result per exact age that was checked, the control first. Null = not evaluated, which is not 0 %."),
  })
  .describe("One line of an entry's cache summary: every evaluation with the same retention setting, added up age by age.") satisfies z.ZodType<CacheSummaryRow>;

export const CacheEvaluationSchema = z
  .strictObject({
    id: z.string().describe("The id of the evaluation in the results repository."),
    route: z.string().describe("The access method the requests went through."),
    route_label: z.string(),
    client: z.string().describe("What sent the requests: direct, cliproxyapi, a coding tool."),
    client_label: z.string(),
    date,
    request_settings: z.record(z.string(), json).describe("What the requests were sent with, as recorded: format, reasoning effort, lifetime and so on."),
    ...retentionSetting,
    results: z.array(CacheResultSchema).describe("One result per exact age, the control first."),
    late_excluded: z.int().optional().describe("Checks left out because they ran too late for their age."),
    note: z.string().optional(),
    source: z.url().describe("The raw result."),
  })
  .describe("One cache evaluation: a fresh prompt cached once, then sent again at once and at set ages.") satisfies z.ZodType<CacheEvaluation>;

export const EntryCacheSchema = z
  .strictObject({
    documented: CacheDocumentationSchema,
    retention: CacheRetentionSchema,
    results: z.array(CacheSummaryRowSchema).nullable().describe("The summary table: a line per retention setting, short before long. Null = no evaluation on this entry."),
    evaluations: z.array(CacheEvaluationSchema).describe("The evaluations the summary adds up, newest first."),
  })
  .describe("Documented caching, confirmed retention controls and evaluations, shared by the website and API.") satisfies z.ZodType<EntryCache>;

// ---- limits, provenance
export const MeasuredLimitSchema = z
  .strictObject({
    route: z.string(),
    route_label: z.string(),
    client: z.string(),
    client_label: z.string(),
    context: z.number().optional().describe("Tokens: the context window found."),
    output: z.number().optional().describe("Tokens: the largest response found."),
    input_accepted: z.number().optional().describe("Tokens: the largest input seen accepted. The real limit is at least this."),
    input_refused: z.number().optional().describe("Tokens: the smallest input seen refused. The real limit is below this."),
    output_accepted: z.number().optional().describe("Tokens: the largest requested output seen accepted."),
    note: z.string().optional(),
    date: date.optional(),
    source: z.url(),
  })
  .describe("One limit evaluation.") satisfies z.ZodType<MeasuredLimit>;

export const ProvenanceSchema = z
  .strictObject({
    path: z.string().describe("The field, for example limit.context."),
    op: z.enum(["set", "unknown", "delete"]).describe("set = a value is published; unknown = published as unknown on purpose; delete = removed."),
    value: json.optional(),
    had_upstream: z.boolean().describe("Whether models.dev has a value for the field."),
    upstream: json.optional().describe("What models.dev says."),
    redundant: z.boolean().optional(),
    reason: z.string(),
    evidence: z.array(Evidence),
  })
  .describe("One correction by providers.dev to a field imported from models.dev.");

// ---- the providers_dev record of an entry and of a provider
export const EntryExtensionSchema = z
  .strictObject({
    origin: z.enum(["upstream", "added"]).describe("upstream = the entry is imported from models.dev. added = models.dev has no entry for this access method."),
    access: Access,
    provenance: z.array(ProvenanceSchema).optional().describe("Corrections to imported fields."),
    inherited: z
      .strictObject({ from: z.string(), fields: z.array(z.string()) })
      .optional()
      .describe("Fields an added entry takes from another entry: identity, and cost where a subscription entry carries the API list price."),
    cache: EntryCacheSchema,
    pricing: PricingSchema,
    request_controls: RequestControlsSchema,
    limits: z
      .strictObject({
        measured: z.array(MeasuredLimitSchema).optional(),
        from_measurement: z.array(z.enum(["context", "output"])).optional().describe("On an added entry: which of limit.context and limit.output are measured values."),
      })
      .optional(),
    evidence: z.array(Evidence).optional(),
    verified: date.optional().describe("The newest date of providers.dev evidence or evaluations for this entry."),
  })
  .describe("Everything providers.dev adds to an entry.");

export const ProviderExtensionSchema = z
  .strictObject({
    origin: z.enum(["upstream", "added"]),
    access: Access,
    access_basis: z.string().describe("Why the provider is classified this way."),
    access_reviewed: z.boolean().describe("False = classified by a general rule, not looked at one by one."),
    access_source: z.url().optional(),
    note: z.string().optional(),
    evidence: z.array(Evidence).optional(),
    provenance: z.array(ProvenanceSchema).optional(),
  })
  .describe("Everything providers.dev adds to a provider.");

// ---- summaries
export const EntrySummarySchema = z
  .strictObject({
    ref: z.string().describe("provider/model. Provider ids never contain a slash, so the first slash ends the provider."),
    provider: z.string(),
    model: z.string().describe("The model's id at this provider."),
    name: z.string(),
    type: z.string().optional(),
    family: z.string().optional(),
    canonical_id: z.string().optional().describe("The canonical model this entry serves, as in /api/v1/models."),
    status: z.string().optional(),
    release_date: z.string().optional().describe("When the model was released, as models.dev records it. Absent = unknown."),
    access: Access,
    origin: z.enum(["upstream", "modified", "added"]).describe("upstream = as imported. modified = imported, with providers.dev corrections or evaluations. added = an entry models.dev does not have."),
    context: z.number().optional().describe("limit.context in tokens: the window this provider exposes for the model. Absent = unknown."),
    input: z.number().optional().describe("limit.input in tokens, stated where the input limit is lower than the window. Absent = unknown."),
    max_output: z.number().optional().describe("limit.output in tokens: the most one response can hold. A maximum, not a default. Absent = unknown."),
    cache: z.enum(["yes", "no", "unknown"]).describe("Prompt caching as documented. unknown = the source says nothing, which is not the same as no."),
    cache_modes: z.array(z.enum(["implicit", "explicit"])).describe("implicit = the provider caches on its own. explicit = the request marks what to cache."),
    cache_mode_support: z.strictObject({ implicit: SupportSchema, explicit: SupportSchema }).describe("Support for each mode, from providers_dev.cache.documented.modes. An omitted mode stays unknown."),
    cache_ttl_s: z.array(z.number()).describe("Documented cache lifetimes in seconds, of every mode together, shortest first."),
    cache_ttl_by_mode_s: z
      .strictObject({ implicit: z.array(z.number()).optional(), explicit: z.array(z.number()).optional() })
      .optional()
      .describe("The documented lifetimes of each mode, in seconds. A mode with no documented lifetime has no key."),
    cache_retention: CacheRetentionSchema.shape.support.describe("Whether a request can ask for a cache lifetime: providers_dev.cache.retention.support of the full entry."),
    evaluation_count: z.int().min(0).describe("How many cache evaluations this entry has."),
    cache_results: z
      .array(CacheSummaryRowSchema)
      .nullable()
      .describe("The cache evaluations as one table: a line per retention setting, short before long, each with its results by exact age. Null = not evaluated. Every page of the website draws this object as it is."),
    price_in: z.number().optional().describe("cost.text.input.price: the list price of input in US dollars per million tokens, before any change by context size or service tier. Absent = unknown."),
    price_out: z.number().optional().describe("The same for output."),
    pricing: PricingSchema.describe("The same normalized pricing record as providers_dev.pricing on the full entry, including all conditions and unparsed source fields."),
    request_controls: RequestControlsSchema.describe("The same controls as providers_dev.request_controls on the full entry. Unknown and unsupported are distinct."),
    price_from: z.string().optional().describe("Present where the price is inherited: the ref of the API entry whose list price this is. The entry itself is a subscription and is not paid per token."),
    measured_input_accepted: z.number().optional().describe("Tokens: the largest input a limit evaluation saw accepted. The real limit is at least this."),
    measured_input_refused: z.number().optional().describe("Tokens: the smallest input a limit evaluation saw refused. The real limit is below this."),
    measured_limit_count: z.int().min(0).describe("How many limit evaluations this entry has."),
    overridden_fields: z.array(z.string()).describe("The imported fields providers.dev corrected."),
    verified: date.optional().describe("The newest date of providers.dev evidence. Imported entries have none."),
    shard: z.int().min(0).describe("Which file under /data/entries/<provider>/ holds the full entry."),
  })
  .describe("One provider-model entry in short: what the lists return and what the tables of the website show.") satisfies z.ZodType<Summary>;

export const ProviderSummarySchema = z
  .strictObject({
    id: z.string(),
    name: z.string(),
    doc: z.string().optional().describe("The provider's documentation."),
    env: z.array(z.string()).describe("The environment variables a client reads the key from."),
    access: Access,
    access_reviewed: z.boolean(),
    origin: z.enum(["upstream", "added"]),
    entry_count: z.int().min(0),
    evidence_entry_count: z.int().min(0).describe("Entries with providers.dev corrections or evaluations."),
    providers_dev: ProviderExtensionSchema,
  })
  .describe("One provider.") satisfies z.ZodType<ProviderSummary>;

const canonicalModel = {
  id: z.string().describe("lab/model: the canonical_id of its entries."),
  name: z.string(),
  lab: z.string(),
  reference_ref: z.string().nullable().describe("The entry at the lab's own provider, where the catalog has one."),
  entry_count: z.int().min(1),
  subscription_entry_count: z.int().min(0),
  evidence_entry_count: z.int().min(0),
  context_min: z.number().nullable().describe("The smallest context window among its entries, in tokens. Null = no entry states one."),
  context_max: z.number().nullable(),
  max_output_min: z.number().nullable(),
  max_output_max: z.number().nullable(),
};
export const CanonicalModelSchema = z.strictObject(canonicalModel).describe("A model as its lab names it, and how its entries compare.") satisfies z.ZodType<CanonicalModel>;
export const CanonicalModelDetailSchema = z
  .strictObject({ ...canonicalModel, entries: z.array(EntrySummarySchema).describe("Every entry for the model: the lab's own API first, then subscriptions, then the rest by provider.") })
  .describe("A canonical model with every entry that serves it.") satisfies z.ZodType<CanonicalModelDetail>;

// ---- full objects. The part that comes from models.dev is theirs and grows with it, so unknown fields are allowed there.
export const EntrySchema = z
  .looseObject({
    ...ModelMetadataShape,
    providers_dev: EntryExtensionSchema,
  })
  .describe("One entry in full: the models.dev record of the model at this provider, with providers_dev added. Fields not listed here are passed on from models.dev unchanged.");

export const ProviderSchema = z
  .looseObject({
    id: z.string(),
    name: z.string(),
    doc: z.string().optional(),
    env: z.array(z.string()).optional(),
    models: z.record(z.string(), EntrySchema).describe("The provider's entries in full, by model id."),
    providers_dev: ProviderExtensionSchema,
  })
  .describe("One provider in full, in the models.dev structure.");

// ---- evaluations as a list
const ofEntry = { entry_ref: z.string().describe("The entry the evaluation was made on."), entry_name: z.string(), access: Access };
export const EvaluationRecordSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("cache"), ...ofEntry, ...CacheEvaluationSchema.shape }),
    z.strictObject({ kind: z.literal("limit"), ...ofEntry, ...MeasuredLimitSchema.shape }),
  ])
  .describe("One evaluation with the entry it was made on. kind = cache or limit.");

// ---- metadata, envelopes, errors
const issue = z.looseObject({ level: z.enum(["error", "warning", "notice"]), code: z.string(), target: z.string(), message: z.string() });
export const MetaSchema = z
  .looseObject({
    api_version: z.literal("v1"),
    schema_version: z.int(),
    upstream_schema: z.string(),
    dataset_version: z.string().describe("A hash of the catalog and summaries. It changes when their data changes. ETags identify each response representation separately."),
    generated_at: z.iso.datetime(),
    counts: z.strictObject({
      providers: z.int(),
      entries: z.int().describe("Provider-model entries."),
      models: z.int().describe("Canonical models."),
      added_providers: z.int(),
      added_entries: z.int(),
      corrected_entries: z.int(),
      evaluated_entries: z.int(),
      cache_evaluations: z.int(),
      limit_evaluations: z.int(),
    }),
    cache_ages_s: z.array(z.int()).describe("The ages, in seconds, that every cache summary table has a column for, after the control at age 0. Results at other ages are in the data at their exact age."),
    upstream: z.looseObject({ source: z.string(), fetched_at: z.string(), providers: z.int(), models: z.int() }).describe("The models.dev import this dataset is built on."),
    measurements: z.looseObject({ repository: z.url() }).optional().describe("The results repository the evaluations come from."),
    sync: z.looseObject({}),
    exclusions: z.array(z.looseObject({ target: z.string(), reason: z.string() })),
    issues: z.array(issue).describe("Corrections and evaluations that no longer match an entry."),
    license: z.looseObject({ data: z.string(), upstream: z.string(), notice: z.string() }),
  })
  .describe("The dataset: its version, what it holds and where it comes from.");

export const BriefMetaSchema = z
  .strictObject({ dataset_version: z.string(), generated_at: z.string(), upstream_fetched_at: z.string() })
  .describe("Which dataset the answer is from.");

/** The envelope of every collection. */
export const pageOf = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    meta: BriefMetaSchema,
    total: z.int().describe("How many items match."),
    limit: z.int(),
    offset: z.int(),
    next_offset: z.int().nullable().describe("The offset of the next page. Null on the last page."),
    data: z.array(item),
  });
/** The envelope of every single object. */
export const one = <T extends z.ZodType>(data: T) => z.strictObject({ meta: BriefMetaSchema, data });

export const ErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().describe("invalid_parameters, provider_not_found, entry_not_found, model_not_found, method_not_allowed, not_found or snapshot_incomplete."),
    message: z.string(),
    details: json.optional(),
  }),
});

export const EntryDetailSchema = z
  .strictObject({ provider: ProviderSummarySchema, summary: EntrySummarySchema, entry: EntrySchema })
  .describe("One entry: its provider, its summary as in the lists, and the entry in full.");
export const ProviderDetailSchema = z
  .strictObject({
    provider: ProviderSummarySchema,
    entries: z.array(EntrySummarySchema).describe("The provider's entries, by name."),
    models: z.record(z.string(), EntrySchema).optional().describe("With view=full: the entries in full, by model id."),
  })
  .describe("One provider with its entries.");

export const FacetsSchema = z.strictObject({
  providers: z.array(z.strictObject({ id: z.string(), name: z.string() })).describe("Provider options, ordered by name then id."),
  types: z.array(z.string()).describe("Known entry types, sorted alphabetically."),
  evidence_entries: z.int().min(0),
  subscription_providers: z.int().min(0),
}).describe("Catalog filter options and counts, calculated by the API.") satisfies z.ZodType<Facets>;
export const CorrectionSchema = z.strictObject({
  provider: z.string(),
  change: ProvenanceSchema,
  entry_refs: z.array(z.string()).describe("Entries with this exact correction, original value and evidence."),
}).describe("An identical correction grouped across entries.") satisfies z.ZodType<Correction>;
export const DocumentationSchema = z.strictObject({
  title: z.string(), description: z.string(), lead: z.string(),
  toc: z.array(z.strictObject({ id: z.string(), label: z.string() })),
  body_html: z.string().describe("Authored reference content as an HTML fragment, compiled with the site templates. It contains no dataset values."),
}).describe("The reference text displayed by the website.") satisfies z.ZodType<Documentation>;

/** The named parts of the contract: the components of the OpenAPI document and the tables of the documentation. */
export const COMPONENTS = {
  Facets: FacetsSchema,
  Correction: CorrectionSchema,
  Documentation: DocumentationSchema,
  EntrySummary: EntrySummarySchema,
  Entry: EntrySchema,
  EntryExtension: EntryExtensionSchema,
  EntryCache: EntryCacheSchema,
  CacheDocumentation: CacheDocumentationSchema,
  CacheModeDocumentation: CacheModeDocumentationSchema,
  CacheRetention: CacheRetentionSchema,
  CacheSummaryRow: CacheSummaryRowSchema,
  CacheResult: CacheResultSchema,
  CacheEvaluation: CacheEvaluationSchema,
  Capabilities: CapabilitiesSchema,
  DocumentedCache: DocumentedCacheSchema,
  Cost: CostSchema,
  TextPrice: TextPriceSchema,
  CachePrice: CachePriceSchema,
  PriceCondition: PriceConditionSchema,
  ApiEndpoint: ApiEndpointSchema,
  Condition: ConditionSchema,
  PolicyEvidence: PolicyEvidenceSchema,
  BillingUnit: BillingUnitSchema,
  PricingRule: PricingRuleSchema,
  Pricing: PricingSchema,
  RequestBinding: RequestBindingSchema,
  RequestSetting: RequestSettingSchema,
  RequestOption: RequestOptionSchema,
  RequestControl: RequestControlSchema,
  RequestControls: RequestControlsSchema,
  MeasuredLimit: MeasuredLimitSchema,
  Provenance: ProvenanceSchema,
  ProviderSummary: ProviderSummarySchema,
  ProviderExtension: ProviderExtensionSchema,
  Provider: ProviderSchema,
  CanonicalModel: CanonicalModelSchema,
  CanonicalModelDetail: CanonicalModelDetailSchema,
  Evaluation: EvaluationRecordSchema,
  Meta: MetaSchema,
  Error: ErrorSchema,
} as const;

// The types the code uses for the providers_dev records must fit their schemas.
type Fits<T, S extends z.ZodType> = T extends z.input<S> ? true : never;
export const _fits: [Fits<ModelExtension, typeof EntryExtensionSchema>, Fits<ProviderExtension, typeof ProviderExtensionSchema>, Fits<Provenance, typeof ProvenanceSchema>] = [true, true, true];
