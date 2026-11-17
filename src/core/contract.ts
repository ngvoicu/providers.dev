// The API contract: the shape of everything the API returns, written once. The OpenAPI document and the field tables
// of the documentation are generated from these definitions, and the tests check every published object against them.
// Each schema is tied to the TypeScript type the code uses (`satisfies`), so the two cannot drift apart.
// Build-time and server only: nothing in the browser imports this file.
//
// One rule for everything providers.dev publishes of its own: every object has all of its keys. A value that is not
// known is null and a list with nothing in it is empty; no key is left out. So none of these schemas has an optional
// field. Only the models.dev part of an entry or a provider keeps models.dev's shape, where a field can be absent.
import { z } from "zod";
import type { CacheEvaluation, CacheLifetimeItem, CacheLifetimeRecord, CacheResult, EntryCache, SafeLifetime } from "./cache.ts";
import { CacheDocumentationSchema, CacheModeDocumentationSchema, CacheRetentionSchema, RetentionProfileSchema, SupportSchema } from "./cache-contract.ts";
import { ApiEndpointSchema, CapabilitiesSchema, CachePriceSchema, CostSchema, DocumentedCacheSchema, ModelMetadataShape, PriceConditionSchema, TextPriceSchema } from "./metadata-contract.ts";
import { BillingUnitSchema, ConditionSchema, PolicyEvidenceSchema, PricingRuleSchema, PricingSchema, RequestBindingSchema, RequestControlSchema, RequestControlsSchema, RequestOptionSchema, RequestSettingSchema } from "./policy-contract.ts";
import type { ProviderSummary, Summary } from "./entries.ts";
import type { InputWindow, InputWindowMeasurement } from "./limits.ts";
import type { CanonicalModel, CanonicalModelDetail, Correction, Documentation, Facets, ModelInputWindowEnd } from "./resources.ts";
import { Access, type Exclusion, type MeasuredLimit, type ModelExtension, type ProviderExtension, type Provenance, type PublishedEvidence } from "./schema.ts";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const json = z.json();

export const EvidenceSchema = z
  .strictObject({
    kind: z.enum(["documented", "measured", "listed"]).describe("documented = the provider says so. measured = providers.dev ran it. listed = the provider's own model list reports it."),
    url: z.url(),
    date: date.describe("When the source was read or the measurement taken."),
    note: z.string().nullable().describe("What the source says. Null = no note."),
  })
  .describe("A source for something providers.dev publishes.") satisfies z.ZodType<PublishedEvidence>;

// ---- cache: results, evaluations, the lifetime record, retention
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
  parameter: z.string().nullable().describe("The request field that asked for the lifetime, for example cache_control.ttl, prompt_cache_retention or prompt_cache_options.ttl. Null = no lifetime was asked for."),
  value: z.string().nullable().describe("The value sent in it, for example 1h. Null together with parameter."),
};

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
    late_excluded: z.int().min(0).nullable().describe("Checks left out because they ran too late for their age. Null = the evaluation does not record it."),
    note: z.string().nullable().describe("Null = no note."),
    source: z.url().describe("The raw result."),
  })
  .describe("One cache evaluation: a fresh prompt cached once, then sent again at once and at set ages.") satisfies z.ZodType<CacheEvaluation>;

const lifetimeSource = z.enum(["providers.dev", "models.dev"]);

export const CacheLifetimeItemSchema = z
  .strictObject({
    retention_profile: RetentionProfileSchema.describe("Documented: short for the shortest lifetime the entry documents, long for every other. Measured: the profile of its evaluations."),
    basis: z.enum(["measured", "documented"]).describe("documented = a lifetime the source documents. measured = what the evaluations of one client with one retention setting showed. Says which of the keys below apply."),
    source: lifetimeSource.describe("Documented: models.dev, or providers.dev where the lifetime is a providers.dev correction or the entry is one providers.dev added. Measured: always providers.dev."),
    date: date.nullable().describe("Documented: the import date for models.dev, the newest evidence date for providers.dev. Measured: the newest of its evaluations. Null = the source has no date."),
    lifetime_s: z.int().min(0).describe("Documented: the lifetime in whole seconds; 0 only on the item that says the entry does not cache. A documented text that is not a whole number of seconds above 0 is no item. Measured: the oldest tested age through which every check of every one of its evaluations hit; 0 = no such age."),
    mode: z.enum(["implicit", "explicit"]).nullable().describe("Documented: the way of caching the lifetime is documented for. Null on the item that says the entry does not cache, and on a measured item."),
    documented_as: z.string().nullable().describe("Documented: the lifetime as the source writes it, for example 5m. Null on the item that says the entry does not cache, and on a measured item."),
    client: z.string().nullable().describe("Measured: the public id of the client the requests went through, as on the evaluations. Null on a documented item."),
    client_label: z.string().nullable().describe("Measured: its public label. Null on a documented item."),
    parameter: z.string().nullable().describe("Measured: the request field that asked for the lifetime, as on the evaluations. Null = no lifetime was asked for, and on a documented item."),
    value: z.string().nullable().describe("Measured: the value sent in it. Null together with parameter."),
    evaluations: z.int().min(0).describe("Measured: how many evaluations the item is made from, at least 1. 0 on a documented item."),
    evaluation_ids: z.array(z.string()).describe("Measured: their ids, sorted, as in the entry's evaluations and in /api/v1/evaluations/cache. Empty on a documented item."),
    checks: z.int().min(0).describe("Measured: re-sends made in them, the control included. 0 on a documented item."),
    hits: z.int().min(0).describe("Measured: how many of those were served from the cache. 0 on a documented item."),
    tested_from_s: z.int().min(0).nullable().describe("Measured: the youngest timed age any of them checked; no younger age was checked. Null = none made a timed check, and on a documented item."),
    first_miss_s: z.int().min(0).nullable().describe("Measured: the youngest age at which any of them had a check that missed; 0 = the immediate re-send. Null = no miss, and on a documented item."),
    results: z.array(CacheResultSchema).nullable().describe("Measured: the results of its evaluations added up by exact age, the control first. lifetime_s is read from each evaluation on its own and the lowest taken, so on an item of several evaluations it can be below what these sums show. Null on a documented item."),
  })
  .describe("One lifetime of an entry: documented by a source, or measured for one client with one retention setting. One shape for both; the keys of the other kind are null, 0 or empty.") satisfies z.ZodType<CacheLifetimeItem>;

export const SafeLifetimeSchema = z
  .strictObject({
    safe_s: z.int().min(0).nullable().describe("Seconds a cached prompt can be relied on: documented_s, unless an evaluation of the profile contradicts it (at an age up to documented_s, fewer than half of its checks hit), and then measured_s; measured_s where nothing is documented. Never above documented_s. 0 = no cache to rely on (basis says whether documented or measured). Null = not known."),
    basis: z.enum(["measured", "documented", "none"]).describe("documented: safe_s is documented_s. measured: safe_s is measured_s. none: exactly when safe_s is null."),
    source: lifetimeSource.nullable().describe("Who the value is from. measured: always providers.dev. documented: the source of the documented item it is taken from. Null with none."),
    date: date.nullable().describe("measured: the newest evaluation counted. documented: the date of the documented item it is taken from. Null with none, and where the source has no date."),
    documented_s: z.int().min(0).nullable().describe("The documented lifetime of the profile: the lowest lifetime_s of its documented items. 0 = the provider documents that it does not cache. Null = none is documented."),
    measured_s: z.int().min(0).nullable().describe("The measured lifetime of the profile: the lowest lifetime_s of its measured items, the oldest age through which every check hit in every client. 0 = no such age. Null = not measured."),
    documented_status: z.enum(["contradicted", "not_contradicted"]).nullable().describe("What the rule found of the documented lifetime, where a lifetime above 0 is documented and one is measured. contradicted: an evaluation of the profile contradicts documented_s, and safe_s is measured_s (basis measured). not_contradicted: no evaluation contradicts it, and safe_s is documented_s (basis documented); that is not the same as confirmed. Null: nothing documented, nothing measured, or documented_s 0 (the provider documents that it does not cache, which the rule never calls contradicted; measured_s is beside it)."),
    clients: z.int().min(0).describe("How many clients were measured. 0 = not measured."),
    evaluations: z.int().min(0).describe("How many evaluations were counted. 0 = not measured."),
    checks: z.int().min(0).describe("Re-sends made in them, the control included."),
    hits: z.int().min(0).describe("How many of those were served from the cache."),
    checks_inside: z.int().min(0).nullable().describe("Of checks, those at an age up to and including documented_s, the control included. Null where the profile is not both documented and measured."),
    hits_inside: z.int().min(0).nullable().describe("How many of checks_inside were served from the cache. Null with checks_inside."),
    tested_from_s: z.int().min(0).nullable().describe("The youngest age, after the control, that any counted evaluation checked. No age below it was checked. Null = not measured, or no timed check was made."),
    first_miss_s: z.int().min(0).nullable().describe("The youngest age at which any check of a counted evaluation missed. 0 = the immediate re-send missed. Null = not measured, or no check missed."),
  })
  .describe("The safe lifetime of an entry for one retention profile, with the documented and the measured lifetime it was chosen from and what was measured.") satisfies z.ZodType<SafeLifetime>;

export const CacheLifetimeRecordSchema = z
  .strictObject({
    short: SafeLifetimeSchema.describe("The short profile: no lifetime asked for, or the shortest documented one."),
    long: SafeLifetimeSchema.describe("The long profile: a longer lifetime asked for."),
    lifetimes: z.array(CacheLifetimeItemSchema).describe("Every lifetime known for the entry: short, then long; in each, the documented items by seconds, implicit before explicit, then by text; then the measured ones, the setting that asked for no lifetime first, then by seconds and value, then by client, then by parameter. Text is compared in plain character order. Empty = none is known."),
  })
  .describe("Every cache lifetime of an entry in one list, and the safe value of each retention profile. Worked out once when the data is built. What the documentation says and what evaluations found on their dates, not a guarantee.") satisfies z.ZodType<CacheLifetimeRecord>;

export const EntryCacheSchema = z
  .strictObject({
    documented: CacheDocumentationSchema,
    retention: CacheRetentionSchema,
    lifetime: CacheLifetimeRecordSchema,
    evaluations: z.array(CacheEvaluationSchema).describe("Every published evaluation of the entry, each with its own results, newest first, then by id in plain character order. The measured items of lifetime name them by id."),
  })
  .describe("Documented caching, confirmed retention controls and evaluations, shared by the website and API.") satisfies z.ZodType<EntryCache>;

// ---- limits, provenance
export const MeasuredLimitSchema = z
  .strictObject({
    route: z.string(),
    route_label: z.string(),
    client: z.string(),
    client_label: z.string(),
    context: z.number().nullable().describe("Tokens: the context window found. Null = this evaluation did not measure it."),
    output: z.number().nullable().describe("Tokens: the largest response found. Null = not measured."),
    input_accepted: z.number().nullable().describe("Tokens: the largest input seen accepted. The real limit is at least this. Null = not measured."),
    input_refused: z.number().nullable().describe("Tokens: the smallest input seen refused. The real limit is below this. Null = not measured."),
    input_read: z.number().nullable().describe("Tokens: the largest input for which the reply showed the route read it to the end (a word before the filler and one after it, both returned). Never above input_accepted. Null = not checked."),
    output_accepted: z.number().nullable().describe("Tokens: the largest requested output seen accepted. Null = not measured."),
    note: z.string().nullable().describe("Null = no note."),
    date: date.nullable().describe("The day the requests were sent: the evaluation's own date, else the date in the name of its results folder. Null = the result carries no date."),
    source: z.url(),
  })
  .describe("One limit evaluation. Every evaluation has every field; what it did not measure is null.") satisfies z.ZodType<MeasuredLimit>;

const windowBound = z.enum(["limit", "at_least"]);
const windowKind = z.enum(["window", "bracket", "accepted"]);
const tokens = z.int().positive();

export const InputWindowMeasurementSchema = z
  .strictObject({
    client: z.string().describe("The public id of the client the requests went through, as on the evaluation."),
    client_label: z.string(),
    route: z.string().describe("The access method the requests went through, as on the evaluation."),
    route_label: z.string(),
    date: date.nullable().describe("The day the requests were sent, as on the evaluation. Null = the result carries no date."),
    tokens: tokens.describe("The value this evaluation gives: named for kind window, accepted for bracket, read for accepted."),
    bound: windowBound.describe("limit for kind window: the route named its limit. at_least for bracket and accepted: the largest input seen accepted; the real limit is this or more."),
    kind: windowKind.describe("window: the route's own answer named its context window, and no smaller input was refused. bracket: an input was accepted and a larger one refused; the value is the accepted one. accepted: an input was accepted and the reply showed it was read to the end, nothing refused and no window named."),
    accepted: tokens.nullable().describe("input_accepted of the evaluation: the largest input seen accepted. Null = none recorded."),
    refused: tokens.nullable().describe("input_refused of the evaluation: the smallest input seen refused. Null = none."),
    named: tokens.nullable().describe("context of the evaluation: the window the route names. Null = it named none."),
    read: tokens.nullable().describe("input_read of the evaluation: the largest input the reply showed was read to the end. Null = not checked."),
    source: z.url().describe("The raw result, as on the evaluation."),
  })
  .describe("One limit evaluation of the entry that counts for the input window, with the value it gives. One route, one client, one model.") satisfies z.ZodType<InputWindowMeasurement>;

const limitSource = z.enum(["providers.dev", "models.dev"]);

export const InputWindowSchema = z
  .strictObject({
    tokens: tokens.nullable().describe("The most input a request can carry on this entry, in tokens as the provider counts them, the client's own system prompt and tools included: documented_tokens unless a counted evaluation clearly contradicts it, else measured_tokens, else null. basis says which. Null = not known. Never 0."),
    basis: z.enum(["documented", "measured", "none"]).describe("documented: tokens is documented_tokens. measured: tokens is measured_tokens. none: exactly when tokens is null."),
    bound: windowBound.nullable().describe("limit: the value is the limit, as documented or as the route names it. at_least: the value is the largest input seen accepted, and the real limit is this or more; measured_refused, where set, is an input seen refused. A documented value is always limit. Null with none."),
    scope: z.enum(["input", "window"]).nullable().describe("input: a figure for the input alone (limit.input, or an input size seen accepted). window: a context window that input and output share (limit.context, or a window the route names): the response is counted against the same figure. Null with none."),
    source: limitSource.nullable().describe("Who the value is from. measured: always providers.dev. documented: documented_source. Null with none."),
    date: date.nullable().describe("measured: measured_date. documented: documented_date. Null with none, and where the source has no date."),
    documented_tokens: tokens.nullable().describe("The documented input of the entry: limit.input where it is above 0, else limit.context where it is above 0 and not a measured value named in limits.from_measurement. 0 means none stated. Nothing is read from another entry. Null = none is documented."),
    documented_field: z.enum(["limit.input", "limit.context"]).nullable().describe("The field of the entry documented_tokens is read from. Null with documented_tokens."),
    documented_source: limitSource.nullable().describe("models.dev for an imported value; providers.dev for a correction of the field and for a value in an entry providers.dev added. Null with documented_tokens."),
    documented_date: date.nullable().describe("The import date for models.dev; the newest evidence date for providers.dev. Null = none is documented, or the source has no date."),
    documented_status: z.enum(["contradicted", "not_contradicted"]).nullable().describe("What the rule found of the documented value, where one is documented and at least one evaluation counts. contradicted: an evaluation names a window below it, names another window than a documented limit.context, refused an input at or below 99 % of it, or accepted one at or above 101 % of it; tokens is measured_tokens. not_contradicted: none does, and tokens is documented_tokens; that is not the same as confirmed. Null in every other case."),
    measured_tokens: tokens.nullable().describe("The measured value of the entry: the lowest tokens of measurements, whatever the client. Null = no evaluation counts."),
    measured_bound: windowBound.nullable().describe("The bound of the measurement that gives measured_tokens (measurements[0]). Null with measured_tokens."),
    measured_kind: windowKind.nullable().describe("Its kind. Null with measured_tokens."),
    measured_refused: tokens.nullable().describe("Its refused where its kind is bracket: the smallest input it saw refused; the limit is below this. Null otherwise."),
    measured_date: date.nullable().describe("Its date. Null with measured_tokens, and where the evaluation has no date."),
    clients: z.int().min(0).describe("How many different clients measurements has. 0 = not measured."),
    evaluations: z.int().min(0).describe("How many items measurements has: the limit evaluations of the entry that count. 0 = none counts."),
    measurements: z.array(InputWindowMeasurementSchema).describe("One item per counted limit evaluation, ordered by tokens, then limit before at_least, then by client, route, date and source in plain character order, null first. The first item gives the measured_* keys. Empty = none counts. An evaluation that does not count (a refusal with nothing accepted, an accepted size with no refusal, no named window and no read check, the output alone) stays in limits.measured and is in no item."),
  })
  .describe("How much input a request can carry on this entry, and what that rests on: the documented value, the measured one beside it, and which the rule chose. Worked out once when the data is built. What the documentation says and what evaluations found on their dates, not a guarantee.") satisfies z.ZodType<InputWindow>;

export const ProvenanceSchema = z
  .strictObject({
    path: z.string().describe("The field, for example limit.context."),
    op: z.enum(["set", "unknown", "delete"]).describe("set = a value is published; unknown = published as unknown on purpose; delete = removed."),
    value: json.describe("The published value. Null unless op is set."),
    had_upstream: z.boolean().describe("Whether models.dev has a value for the field."),
    upstream: json.describe("What models.dev says. Null unless had_upstream is true."),
    reason: z.string(),
    evidence: z.array(EvidenceSchema),
  })
  .describe("One correction by providers.dev to a field imported from models.dev.") satisfies z.ZodType<Provenance>;

// ---- the providers_dev record of an entry and of a provider
export const EntryExtensionSchema = z
  .strictObject({
    origin: z.enum(["upstream", "added"]).describe("upstream = the entry is imported from models.dev. added = models.dev has no entry for this access method."),
    access: Access,
    provenance: z.array(ProvenanceSchema).describe("Corrections to imported fields. Empty = none."),
    inherited: z
      .strictObject({ from: z.string(), fields: z.array(z.string()) })
      .nullable()
      .describe("Fields an added entry takes from another entry: identity, and cost where a subscription entry carries the API list price. Null = nothing is inherited."),
    cache: EntryCacheSchema,
    pricing: PricingSchema,
    request_controls: RequestControlsSchema,
    limits: z.strictObject({
      measured: z.array(MeasuredLimitSchema).describe("Limit evaluations on this entry. Empty = none."),
      from_measurement: z.array(z.enum(["context", "output"])).describe("On an added entry: which of limit.context and limit.output are measured values. Empty = none."),
      input_window: InputWindowSchema,
    }),
    evidence: z.array(EvidenceSchema).describe("Sources for an added entry and for authored declarations. Empty = none."),
    verified: date.nullable().describe("The newest date of providers.dev evidence or evaluations for this entry. Null = it has none."),
  })
  .describe("Everything providers.dev adds to an entry. The same keys on every entry.") satisfies z.ZodType<ModelExtension>;

export const ProviderExtensionSchema = z
  .strictObject({
    origin: z.enum(["upstream", "added"]),
    access: Access,
    access_basis: z.string().describe("Why the provider is classified this way."),
    access_reviewed: z.boolean().describe("False = classified by a general rule, not looked at one by one."),
    access_source: z.url().nullable().describe("The source of the classification. Null = none recorded."),
    note: z.string().nullable(),
    evidence: z.array(EvidenceSchema).describe("Sources for a provider that providers.dev added. Empty = none."),
    provenance: z.array(ProvenanceSchema).describe("Corrections to the provider's imported fields. Empty = none."),
  })
  .describe("Everything providers.dev adds to a provider. The same keys on every provider.") satisfies z.ZodType<ProviderExtension>;

// ---- summaries
export const EntrySummarySchema = z
  .strictObject({
    ref: z.string().describe("provider/model. Provider ids never contain a slash, so the first slash ends the provider."),
    provider: z.string(),
    model: z.string().describe("The model's id at this provider."),
    name: z.string(),
    type: z.string().nullable().describe("chat, embedding, image and so on, as models.dev records it. Null = unknown."),
    family: z.string().nullable(),
    canonical_id: z.string().nullable().describe("The canonical model this entry serves, as in /api/v1/models. Null = none is recorded."),
    status: z.string().nullable().describe("alpha, beta or deprecated. Null = none of these."),
    release_date: z.string().nullable().describe("When the model was released, as models.dev records it. Null = unknown."),
    access: Access,
    origin: z.enum(["upstream", "modified", "added"]).describe("upstream = as imported. modified = imported, with providers.dev corrections or evaluations. added = an entry models.dev does not have."),
    context: z.number().nullable().describe("limit.context in tokens: the window this provider exposes for the model. Null = unknown."),
    input: z.number().nullable().describe("limit.input in tokens, stated where the input limit is lower than the window. Null = not stated."),
    max_output: z.number().nullable().describe("limit.output in tokens: the most one response can hold. A maximum, not a default. Null = unknown."),
    input_window: InputWindowSchema.describe("How much input a request can carry on this entry, documented or measured, and what that rests on: the same object as providers_dev.limits.input_window of the full entry. context, input and max_output beside it are limit as published, unchanged."),
    cache: z.enum(["yes", "no", "unknown"]).describe("Prompt caching as documented. unknown = the source says nothing, which is not the same as no."),
    cache_modes: z.array(z.enum(["implicit", "explicit"])).describe("implicit = the provider caches on its own. explicit = the request marks what to cache."),
    cache_mode_support: z.strictObject({ implicit: SupportSchema, explicit: SupportSchema }).describe("Support for each mode, from providers_dev.cache.documented.modes. An omitted mode stays unknown."),
    cache_retention: CacheRetentionSchema.shape.support.describe("Whether a request can ask for a cache lifetime: providers_dev.cache.retention.support of the full entry."),
    cache_lifetime: CacheLifetimeRecordSchema.describe("Every cache lifetime of the entry, documented and measured, and the safe value of each retention profile: the same object as providers_dev.cache.lifetime of the full entry."),
    evaluation_count: z.int().min(0).describe("How many cache evaluations this entry has."),
    price_in: z.number().nullable().describe("The base price of text input in US dollars per million tokens, before any conditional rate. On a subscription entry it is the API reference price named by price_from. Null = unknown, or priced in another unit."),
    price_out: z.number().nullable().describe("The same for output."),
    price_from: z.string().nullable().describe("On a subscription entry: the ref of the API entry whose list price this is. The entry itself is not paid per token. Null = the price is the entry's own."),
    pricing: PricingSchema.describe("The same normalized pricing record as providers_dev.pricing on the full entry, including all conditions and unparsed source fields."),
    request_controls: RequestControlsSchema.describe("The same controls as providers_dev.request_controls on the full entry. Unknown and unsupported are distinct."),
    measured_input_accepted: z.number().nullable().describe("Tokens: the largest input a limit evaluation saw accepted. The real limit is at least this. Null = not measured."),
    measured_input_refused: z.number().nullable().describe("Tokens: the smallest input a limit evaluation saw refused. The real limit is below this. Null = not measured."),
    measured_limit_count: z.int().min(0).describe("How many limit evaluations this entry has."),
    overridden_fields: z.array(z.string()).describe("The imported fields providers.dev corrected."),
    verified: date.nullable().describe("The newest date of providers.dev evidence. Null = the entry has none."),
    shard: z.int().min(0).describe("Which file under /data/entries/<provider>/ holds the full entry."),
  })
  .describe("One provider-model entry in short: what the lists return and what the tables of the website show. Every summary has every field; a value no source gives is null.") satisfies z.ZodType<Summary>;

export const ProviderSummarySchema = z
  .strictObject({
    id: z.string(),
    name: z.string(),
    doc: z.string().nullable().describe("The provider's documentation. Null = none recorded."),
    env: z.array(z.string()).describe("The environment variables a client reads the key from."),
    access: Access,
    access_reviewed: z.boolean(),
    origin: z.enum(["upstream", "added"]),
    entry_count: z.int().min(0),
    evidence_entry_count: z.int().min(0).describe("Entries with providers.dev corrections or evaluations."),
    providers_dev: ProviderExtensionSchema,
  })
  .describe("One provider.") satisfies z.ZodType<ProviderSummary>;

export const ModelInputWindowEndSchema = z
  .strictObject({
    entry_ref: z.string().describe("The entry this input window is on, provider/model: its page is /entries/{entry_ref}."),
    tokens: tokens.describe("input_window.tokens of that entry."),
    bound: windowBound.describe("input_window.bound of that entry: limit, or at_least where the value is the largest input seen accepted and the real limit is this or more."),
    basis: z.enum(["documented", "measured"]).describe("input_window.basis of that entry."),
    scope: z.enum(["input", "window"]).describe("input_window.scope of that entry: input alone, or a window that input and output share."),
  })
  .describe("One end of the input windows of a model's entries: an entry and its input_window, as its summary has it.") satisfies z.ZodType<ModelInputWindowEnd>;

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
  input_window_min: ModelInputWindowEndSchema.nullable().describe("The smallest input window among its entries (input_window of each), with the entry it is on. At an equal number of tokens a value that is not a lower bound counts as the smaller. Null = no entry has one. Since 1.1.0."),
  input_window_max: ModelInputWindowEndSchema.nullable().describe("The largest input window among its entries, with the entry it is on. At an equal number of tokens a lower bound (bound at_least) counts as the larger: the real limit there can be more. Null = no entry has one. Since 1.1.0."),
  input_window_unknown_count: z.int().min(0).describe("Entries with no input window (input_window.tokens null). Since 1.1.0."),
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
export const CacheEvaluationRecordSchema = z
  .strictObject({ kind: z.literal("cache"), ...ofEntry, ...CacheEvaluationSchema.shape })
  .describe("One cache evaluation with the entry it was made on.");
export const LimitEvaluationRecordSchema = z
  .strictObject({ kind: z.literal("limit"), ...ofEntry, ...MeasuredLimitSchema.shape })
  .describe("One limit evaluation with the entry it was made on.");

// ---- metadata, envelopes, errors
const issue = z.looseObject({ level: z.enum(["error", "warning", "notice"]), code: z.string(), target: z.string(), message: z.string() });
export const MetaSchema = z
  .looseObject({
    api_version: z.literal("v1"),
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
    cache_ages_s: z.array(z.int()).describe("The ages, in seconds, that every table of cache results by age has a column for, after the control at age 0. Results at other ages are in the data at their exact age."),
    stale_after_days: z.int().positive().describe("providers.dev evidence (a correction, an evaluation, a measured lifetime) whose date is more than this many days before today is shown as stale. The API publishes the dates and this number, set once when the data is built; a reader applies it to its own date. Imported models.dev values carry no such date and are never stale."),
    upstream: z
      .strictObject({
        source: z.string(),
        schema: z.string(),
        fetched_at: z.string(),
        checked_at: z.string(),
        etag: z.string().nullable(),
        commit: z.string().nullable().describe("The models.dev commit of the import. Null = not known."),
        commit_date: z.string().nullable(),
        sha256: z.string(),
        providers: z.int(),
        models: z.int(),
      })
      .describe("The models.dev import this dataset is built on."),
    measurements: z
      .strictObject({ source: z.string(), fetched_at: z.string(), checked_at: z.string(), etag: z.string().nullable(), sha256: z.string(), repository: z.url() })
      .nullable()
      .describe("The results repository the evaluations come from. Null = the dataset has no evaluations file."),
    sync: z
      .strictObject({ last_attempt_at: z.string().nullable(), last_attempt_ok: z.boolean().nullable(), last_error: z.string().nullable() })
      .describe("The last attempt to import. All null = no attempt is recorded."),
    exclusions: z
      .array(
        z.strictObject({
          kind: z.enum(["entry", "provider", "rule"]).describe("entry or provider: an override left it out, with its evidence. rule: a catalog-wide rule, an editorial choice of providers.dev, left out every entry it matches."),
          target: z.string().describe("The entry (provider/model), the provider id, or the rule id."),
          leaves_out: z.string().nullable().describe("What a rule leaves out, in words. Null for an entry or a provider."),
          reason: z.string(),
          date: z.string().nullable().describe("The day a rule was decided (YYYY-MM-DD). Null for an entry or a provider: its evidence carries the dates."),
          evidence: z.array(EvidenceSchema).describe("The sources for an entry or a provider. Empty for a rule: an editorial choice cites none."),
          entries: z.int().min(0).describe("How many entries it removed in this build."),
        }) satisfies z.ZodType<Exclusion>,
      )
      .describe("What is left out of the catalog: one item per excluded entry or provider, and one per catalog-wide rule, never a list of the entries a rule removed."),
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
    models: z.record(z.string(), EntrySchema).nullable().describe("With view=full: the entries in full, by model id. Null with view=summary, so that the answer has the same keys in both views."),
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
  Evidence: EvidenceSchema,
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
  CacheLifetime: CacheLifetimeRecordSchema,
  SafeLifetime: SafeLifetimeSchema,
  CacheLifetimeItem: CacheLifetimeItemSchema,
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
  InputWindow: InputWindowSchema,
  InputWindowMeasurement: InputWindowMeasurementSchema,
  Provenance: ProvenanceSchema,
  ProviderSummary: ProviderSummarySchema,
  ProviderExtension: ProviderExtensionSchema,
  Provider: ProviderSchema,
  CanonicalModel: CanonicalModelSchema,
  CanonicalModelDetail: CanonicalModelDetailSchema,
  ModelInputWindowEnd: ModelInputWindowEndSchema,
  CacheEvaluationRecord: CacheEvaluationRecordSchema,
  LimitEvaluationRecord: LimitEvaluationRecordSchema,
  Meta: MetaSchema,
  Error: ErrorSchema,
} as const;
