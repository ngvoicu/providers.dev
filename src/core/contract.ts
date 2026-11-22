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
import type { PiBlock, PiCost, PiCostTier, PiDifference, PiSummary, PiValue } from "./pi.ts";
import type { Listing, ListingModel, ListingReasoning, ListingReasoningSources, ListingSources } from "./listings.ts";
import type { PiStatements, PriceStatement, PriceTier, SafePrice, SafeValue, SafeValues, SourceValue } from "./safe.ts";
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

/** The kind of a client (since 1.4.0). */
const clientKind = z
  .enum(["direct", "own_client", "proxy"])
  .nullable()
  .describe("How the client reaches the provider: direct = plain requests sent straight to the provider; own_client = the vendor's own client; proxy = requests through a proxy, plain or made by a coding agent. Which kind counts for a safe value depends on the entry: on an API-key entry direct only; on a login own_client, else direct, else proxy. Null = the client has no kind, and its measurements feed no safe value. Since 1.4.0.");
const chosen = z
  .boolean()
  .describe("True where the item is of the kind of client that gives the measured value of its quantity (on an API-key entry direct; on a login own_client, else direct, else proxy). False on every other item, and on a documented one: an item that is not chosen is evidence and feeds nothing. Since 1.4.0.");

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
    client_kind: clientKind,
  })
  .describe("One cache evaluation: a fresh prompt cached once, then sent again at once and at set ages.") satisfies z.ZodType<CacheEvaluation>;

const lifetimeSource = z.enum(["providers.dev", "models.dev"]);
/** Who a safe value is from, as the records name it: a measured value is providers.dev's. */
const safeSource = z.enum(["providers.dev", "models.dev", "pi.dev"]);

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
    client_kind: clientKind.describe("Measured: the kind of its client (direct, own_client, proxy). Null on a documented item, and for a client with no kind. Since 1.4.0."),
    chosen,
  })
  .describe("One lifetime of an entry: documented by a source, or measured for one client with one retention setting. One shape for both; the keys of the other kind are null, 0 or empty.") satisfies z.ZodType<CacheLifetimeItem>;

export const SafeLifetimeSchema = z
  .strictObject({
    safe_s: z.int().min(0).nullable().describe("Seconds a cached prompt can be relied on: the safe value of the profile, the same as safe.cache_short.value or safe.cache_long.value of the entry. It is the value of the first source that states one, in the order measured (the most direct measurement that exists), providers.dev, models.dev, pi.dev. A measured value is the safe value also where it is above or below what a source documents. 0 = no cache to rely on. Null = not known. Since 1.4.0 the rule of safe (see the guide, Safe values); before, the documented lifetime unless an evaluation contradicted it."),
    basis: z.enum(["measured", "documented", "none"]).describe("measured: safe_s is measured (safe's source is measured). documented: a source states it (providers.dev, models.dev or, since 1.4.0, pi.dev; source says which). none: exactly when safe_s is null."),
    source: safeSource.nullable().describe("Who the value is from: providers.dev where it is measured or providers.dev's own; models.dev; pi.dev (since 1.4.0) where no other source states one. Null with none."),
    date: date.nullable().describe("The date of safe's statement: of the evaluation that gives a measured value, of the evidence for providers.dev, of the import for models.dev and pi.dev. Null with none, and where the source has no date."),
    documented_s: z.int().min(0).nullable().describe("The documented lifetime of the profile: the lowest lifetime_s of its documented items. 0 = the provider documents that it does not cache. Null = none is documented."),
    measured_s: z.int().min(0).nullable().describe("The measured lifetime of the profile: the lowest lifetime_s of its chosen measured items, those of the kind of client that counts on the entry (on an API-key entry direct; on a login own_client, else direct, else proxy). 0 = no age through which every check hit. Null = no client of a kind that counts measured it. Since 1.4.0 over the chosen items only; before, over every client."),
    documented_status: z.enum(["contradicted", "not_contradicted"]).nullable().describe("Whether the measurement that counts contradicts the documented lifetime, where a lifetime above 0 is documented and one is measured by a kind that counts. contradicted: every check of the chosen evaluations still hit after documented_s (documented_s below measured_s), or a check missed at an age documented_s covers (documented_s at or above first_miss_s). not_contradicted: neither; that is not the same as confirmed. It no longer says which of the two is the safe value. Null: nothing documented, nothing measured by a kind that counts, or documented_s 0."),
    clients: z.int().min(0).describe("How many clients of the kind that counts were measured. 0 = none."),
    evaluations: z.int().min(0).describe("How many evaluations of the chosen items were counted. 0 = none."),
    checks: z.int().min(0).describe("Re-sends made in them, the control included."),
    hits: z.int().min(0).describe("How many of those were served from the cache."),
    checks_inside: z.int().min(0).nullable().describe("Of checks, those at an age up to and including documented_s, the control included. Null where the profile is not both documented and measured by a kind that counts."),
    hits_inside: z.int().min(0).nullable().describe("How many of checks_inside were served from the cache. Null with checks_inside."),
    tested_from_s: z.int().min(0).nullable().describe("The youngest age, after the control, that any chosen evaluation checked. No age below it was checked. Null = not measured, or no timed check was made."),
    first_miss_s: z.int().min(0).nullable().describe("The youngest age at which any check of a chosen evaluation missed. 0 = the immediate re-send missed. Null = not measured, or no check missed."),
  })
  .describe("The safe lifetime of an entry for one retention profile, copied from safe, with the documented and the measured lifetime beside it and what was measured.") satisfies z.ZodType<SafeLifetime>;

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
    client_kind: clientKind,
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
    client_kind: clientKind.describe("The kind of its client, as on the evaluation. Since 1.4.0."),
    chosen,
  })
  .describe("One limit evaluation of the entry that counts for the input window, with the value it gives. One route, one client, one model.") satisfies z.ZodType<InputWindowMeasurement>;

const limitSource = z.enum(["providers.dev", "models.dev"]);

export const InputWindowSchema = z
  .strictObject({
    tokens: tokens.nullable().describe("The most input a request can carry on this entry, in tokens as the provider counts them, the client's own system prompt and tools included: the safe value, the same as safe.input_window.value. It is the value of the first source that states one, in the order measured (the most direct measurement that exists, a lower bound included), providers.dev, models.dev, pi.dev; where that is a window and a later source states a cap on the input not above it, the cap. Null = not known. Never 0. Since 1.4.0 the rule of safe (see the guide, Safe values); before, the documented value unless an evaluation clearly contradicted it."),
    basis: z.enum(["documented", "measured", "none"]).describe("measured: the value is measured (safe's source is measured). documented: a source states it (providers.dev, models.dev or, since 1.4.0, pi.dev; source says which). none: exactly when tokens is null."),
    bound: windowBound.nullable().describe("limit: the value is the limit, as documented or as the route names it. at_least: the value is the largest input seen accepted, and the real limit is this or more; measured_refused, where set, is an input seen refused. A stated value is always limit. Null with none."),
    scope: z.enum(["input", "window"]).nullable().describe("input: a figure for the input alone (limit.input, or an input size seen accepted). window: a context window that input and output share (limit.context, or a window the route names): the response is counted against the same figure. Null with none."),
    source: safeSource.nullable().describe("Who the value is from: providers.dev where it is measured or providers.dev's own; models.dev; pi.dev (since 1.4.0) where no other source states one. Null with none."),
    date: date.nullable().describe("The date of safe's statement: of the evaluation that gives a measured value, of the evidence for providers.dev, of the import for models.dev and pi.dev. Null with none, and where the source has no date."),
    documented_tokens: tokens.nullable().describe("The documented input of the entry: limit.input where it is above 0, else limit.context where it is above 0 and not a measured value named in limits.from_measurement. 0 means none stated. Nothing is read from another entry. Null = none is documented."),
    documented_field: z.enum(["limit.input", "limit.context"]).nullable().describe("The field of the entry documented_tokens is read from. Null with documented_tokens."),
    documented_source: limitSource.nullable().describe("models.dev for an imported value; providers.dev for a correction of the field and for a value in an entry providers.dev added. Null with documented_tokens."),
    documented_date: date.nullable().describe("The import date for models.dev; the newest evidence date for providers.dev. Null = none is documented, or the source has no date."),
    documented_status: z.enum(["contradicted", "not_contradicted"]).nullable().describe("Whether the measurement that counts contradicts the documented value, where one is documented and a chosen item of measurements exists. contradicted: a chosen evaluation names a window below it, names another window than a documented limit.context, refused an input at or below 99 % of it, or accepted one at or above 101 % of it. not_contradicted: none does; that is not the same as confirmed. It no longer says which of the two is the safe value. Null in every other case."),
    measured_tokens: tokens.nullable().describe("The measured value of the entry: the lowest tokens of the chosen items of measurements, those of the kind of client that counts (on an API-key entry direct; on a login own_client, else direct, else proxy). Null = no evaluation of a kind that counts. Since 1.4.0 over the chosen items only; before, whatever the client."),
    measured_bound: windowBound.nullable().describe("The bound of the measurement that gives measured_tokens (the first chosen item). Null with measured_tokens."),
    measured_kind: windowKind.nullable().describe("Its kind. Null with measured_tokens."),
    measured_refused: tokens.nullable().describe("Its refused where its kind is bracket: the smallest input it saw refused; the limit is below this. Null otherwise."),
    measured_date: date.nullable().describe("Its date. Null with measured_tokens, and where the evaluation has no date."),
    clients: z.int().min(0).describe("How many different clients the chosen items of measurements have. 0 = none."),
    evaluations: z.int().min(0).describe("How many items of measurements are chosen. 0 = none."),
    measurements: z.array(InputWindowMeasurementSchema).describe("One item per counted limit evaluation, of every client, ordered by tokens, then limit before at_least, then by client, route, date and source in plain character order, null first. The first chosen item gives the measured_* keys. Empty = none counts. An evaluation that does not count (a refusal with nothing accepted, an accepted size with no refusal, no named window and no read check, the output alone) stays in limits.measured and is in no item."),
  })
  .describe("How much input a request can carry on this entry, and what that rests on: the safe value, copied from safe.input_window, the documented value and the measured one beside it. Worked out once when the data is built. What the documentation says and what evaluations found on their dates, not a guarantee.") satisfies z.ZodType<InputWindow>;

// ---- the safe values: one per quantity, and what every source states (since 1.4.0)
const valueSource = z.enum(["measured", "providers.dev", "models.dev", "pi.dev"]);
const statedScope = z.enum(["input", "window"]).nullable();
const agreement = z
  .enum(["agree", "differ", "single", "none"])
  .describe("none = no source states anything. single = one does. agree = two or more, and no two contradict each other. differ = at least two contradict each other: the website shows a warning. Two numbers contradict where they are not equal, except: a cap on the input contradicts a window only where it is above it; a measured input window contradicts a stated one by the test of documented_status (a window named below it or other than a stated window, a refusal at or below 99 %, an input accepted at or above 101 %), so a lower bound below a larger stated value does not; a measured lifetime m with its first miss f contradicts a stated lifetime S where S is below m or S is at or above f; providers.dev withholding contradicts every later stated value, and a measurement contradicts no withheld one. Prices contradict per part.");

export const SourceValueSchema = z
  .strictObject({
    source: valueSource.describe("measured = providers.dev's own evaluations of the entry, the most direct that exist. providers.dev = a correction of the imported entry, or a value of an entry providers.dev adds, with evidence. models.dev = the entry as imported. pi.dev = pi's catalog."),
    value: z.number().min(0).nullable().describe("The number the source states: tokens or seconds. 0 is a value for a lifetime (no cache to rely on). Null exactly where withheld."),
    withheld: z.boolean().describe("True on providers.dev where it publishes the value as unknown on purpose, against a value models.dev states. False on every other item."),
    at_least: z.boolean().describe("A measured lower bound: the real value is this or more. False on every other item."),
    below: z.number().min(0).nullable().describe("Measured: the smallest value seen to fail, an input refused or the youngest age with a cache miss. Null = none seen, and on every other source."),
    scope: statedScope.describe("Input window only: input = a cap on the input alone; window = a window input and output share. Null on every other quantity."),
    date: date.nullable().describe("measured: the day of the evaluation it names. providers.dev: the newest evidence of the corrections that touch the fields read, or of the entry it adds. models.dev: the import date. pi.dev: the day of pi's snapshot. Null = no date."),
    evidence_url: z.url().nullable().describe("providers.dev: the evidence that gives its date. measured: the raw result of the evaluation it names. Null on the two catalogs."),
    client: z.string().nullable().describe("Measured: the public id of the client the evaluation went through. Null on every other source."),
    client_label: z.string().nullable().describe("Measured: its public label. Null on every other source."),
    client_kind: clientKind.describe("Measured: its kind. Null on every other source."),
    evaluation_id: z.string().nullable().describe("Measured: the id of the cache evaluation that gives the value, as in /evaluations/cache. Null for a limit evaluation, which has no id, and on every other source."),
  })
  .describe("What one source states of one quantity. Since 1.4.0.") satisfies z.ZodType<SourceValue>;

export const SafeValueSchema = z
  .strictObject({
    value: z.number().min(0).nullable().describe("The safe value: the statement of the first source in sources (measured, providers.dev, models.dev, pi.dev) that makes one. Input window only: where that is a window and a later source states a cap on the input not above it, the cap. Null = no source states one, or providers.dev withholds it."),
    unit: z.enum(["tokens", "seconds"]),
    at_least: z.boolean().describe("The value is a measured lower bound: the real value is this or more."),
    scope: statedScope.describe("Input window only: whether the value is a cap on the input or a window input and output share. Null on every other quantity, and with no value."),
    window_tokens: z.int().positive().nullable().describe("Input window only: the window input shares with the answer, where the entry states one above value (its published limit.context, not a measured one). Null where it states none or none larger, and on every other quantity."),
    source: valueSource.nullable().describe("The source whose statement the value is, an item of sources. Null exactly where sources is empty."),
    date: date.nullable().describe("The date of that statement."),
    agreement,
    sources: z.array(SourceValueSchema).describe("One item per source that states something, in the order measured, providers.dev, models.dev, pi.dev. Empty = none does."),
  })
  .describe("The safe value of one quantity and every statement it was chosen from. Since 1.4.0.") satisfies z.ZodType<SafeValue>;

export const PriceTierSchema = z
  .strictObject({
    input_tokens_above: z.int().min(0).describe("The tier holds for a request whose context is above this many tokens."),
    input: z.number().min(0).nullable().describe("US dollars per million tokens. Null = the source states none in this tier."),
    output: z.number().min(0).nullable(),
    cache_read: z.number().min(0).nullable(),
    cache_write: z.number().min(0).nullable(),
  })
  .describe("One price tier by size of request, as a source states it. Since 1.4.0.") satisfies z.ZodType<PriceTier>;

export const PriceStatementSchema = z
  .strictObject({
    source: z.enum(["providers.dev", "models.dev", "pi.dev"]),
    withheld: z.boolean().describe("True on providers.dev where it publishes the price as unknown on purpose. Every part is null then."),
    input: z.number().min(0).nullable().describe("The base price of text input, US dollars per million tokens. Null = the source states none."),
    output: z.number().min(0).nullable(),
    cache_read: z.number().min(0).nullable(),
    cache_write: z.number().min(0).nullable().describe("The base price of a cache write. Null where the source states none, or keys it by lifetime."),
    tiers: z.array(PriceTierSchema).nullable().describe("Tiers by size of request, ascending. Empty = the source states a price and no tier. Null = its tiers cannot be read as tiers, or withheld."),
    date: date.nullable(),
    evidence_url: z.url().nullable().describe("providers.dev: the evidence that gives its date. Null on the catalogs."),
  })
  .describe("What one source states of the price, in the parts sources are compared on. Since 1.4.0.") satisfies z.ZodType<PriceStatement>;

export const SafePriceSchema = z
  .strictObject({
    source: z.enum(["providers.dev", "models.dev", "pi.dev"]).nullable().describe("Whose price pricing is, whole: the first of providers.dev, models.dev, pi.dev that states one. A part one source lacks is never filled from another. Null = none states a price."),
    date: date.nullable(),
    agreement,
    differs: z.array(z.enum(["input", "output", "cache_read", "cache_write", "tiers", "other"])).describe("The parts on which two sources contradict: a price both state that is not equal; tiers with other thresholds or a price both state in a tier that is not equal; other (every rule that is no base price and no tier), compared between providers.dev and models.dev only. Empty unless agreement is differ."),
    sources: z.array(PriceStatementSchema).describe("One item per source that states a price, in the order providers.dev, models.dev, pi.dev."),
  })
  .describe("Whose price pricing is, and every source's price beside it. The price itself is pricing. Since 1.4.0.") satisfies z.ZodType<SafePrice>;

export const SafeValuesSchema = z
  .strictObject({
    input_window: SafeValueSchema.describe("The most input one request can carry on the entry, in tokens. input_window.tokens of the record carries the same value."),
    max_output: SafeValueSchema.describe("The most tokens one response can hold. max_output of the summary carries the same value."),
    cache_short: SafeValueSchema.describe("Seconds a cached prompt can be relied on where the request asks for no lifetime or the shortest one. cache_lifetime.short.safe_s carries the same value."),
    cache_long: SafeValueSchema.describe("The same where the request asks for a longer lifetime. cache_lifetime.long.safe_s carries the same value."),
    price: SafePriceSchema,
    differing: z.array(z.enum(["input_window", "max_output", "cache_short", "cache_long", "price"])).describe("The quantities whose agreement is differ, in this order. Empty = no warning on the entry."),
  })
  .describe("The safe value of each quantity, its source, whether the sources agree, and what each source states. One rule for all: the first source in the order measured, providers.dev, models.dev, pi.dev that states a value gives it. Worked out once when the data is built; the records beside it copy it. Since 1.4.0.") satisfies z.ZodType<SafeValues>;

/** What pi states of one entry (`piStatements`), as plain data that crosses the fence (scripts/lib/pi-fence.ts). Never published: not a component. */
export const PiStatementsSchema = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  input_window: z.int().positive().nullable(),
  max_output: z.int().positive().nullable(),
  cache_short: z.int().min(0).nullable(),
  cache_long: z.int().min(0).nullable(),
  price: z
    .strictObject({
      input: z.number().positive().nullable(),
      output: z.number().positive().nullable(),
      cache_read: z.number().positive().nullable(),
      cache_write: z.number().positive().nullable(),
      tiers: z.array(PriceTierSchema),
    })
    .nullable(),
}) satisfies z.ZodType<PiStatements>;
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

// ---- pi's model catalog, the second imported source (design/pi-source.md, section d). Since 1.2.0.
export const PiCostTierSchema = z
  .strictObject({
    input_tokens_above: z.int().min(0).describe("The tier prices the whole request once its input tokens (input, cache reads and cache writes together) are above this number."),
    input: z.number().min(0).nullable().describe("US dollars per million input tokens. Null only on a tier read from the entry's own cost, where the entry states none."),
    output: z.number().min(0).nullable(),
    cache_read: z.number().min(0).nullable(),
    cache_write: z.number().min(0).nullable(),
  })
  .describe("One price tier by size of request.") satisfies z.ZodType<PiCostTier>;

export const PiCostSchema = z
  .strictObject({
    input: z.number().min(0).describe("US dollars per million input tokens, as pi's catalog states it."),
    output: z.number().min(0),
    cache_read: z.number().min(0),
    cache_write: z.number().min(0).describe("The price of a cache write of the short lifetime."),
    tiers: z.array(PiCostTierSchema).describe("Tiers by size of request, ascending. Empty = pi states none."),
  })
  .describe("pi's prices. In pi's catalog a price is always a number: 0 stands for no charge and for no price recorded alike, so a 0 here is not a statement that the provider charges nothing.") satisfies z.ZodType<PiCost>;

export const PiDifferenceSchema = z
  .strictObject({
    field: z.enum(["context_window", "max_tokens", "cost.input", "cost.output", "cost.cache_read", "cost.cache_write", "cost.tiers"]).describe("The field of the pi block that differs."),
    entry_field: z.string().describe("The field of the entry it was compared with: limit.context, limit.output, cost.text.input.price, cost.text.output.price, cost.text.input.cache.read, cost.text.input.cache.write, or cost.text for the tiers."),
    unit: z.enum(["tokens", "usd_per_million_tokens"]),
    pi: z.number().nullable().describe("pi's value. Null for cost.tiers."),
    published: z.number().nullable().describe("The entry's value, as published. Null for cost.tiers."),
    pi_tiers: z.array(PiCostTierSchema).nullable().describe("For cost.tiers: pi's tiers. Null otherwise."),
    published_tiers: z.array(PiCostTierSchema).nullable().describe("For cost.tiers: the entry's tiers by size of request, read from its cost. Null otherwise."),
  })
  .describe("One value that pi's catalog states otherwise than the entry publishes it. No price and no tiers are listed on a subscription entry.") satisfies z.ZodType<PiDifference>;

export const PiValueSchema = z
  .strictObject({
    // The list of PI_VALUE_FIELDS in src/core/pi.ts, spelled out: the contract imports only types from pi's modules.
    field: z.enum(["context_window", "max_tokens", "cost.input", "cost.output", "cost.cache_read", "cost.cache_write", "cost.tiers", "prompt_cache.short", "prompt_cache.long"]).describe("The value of pi's catalog the item speaks of."),
    entry_field: z.string().describe("The field of the entry it stands beside: limit.context, limit.output, cost.text.input.price, cost.text.output.price, cost.text.input.cache.read, cost.text.input.cache.write, cost.text for the tiers, providers_dev.cache.lifetime.short.documented_s, providers_dev.cache.lifetime.long.documented_s."),
    unit: z.enum(["tokens", "usd_per_million_tokens", "seconds"]),
    standing: z.enum(["agrees", "differs", "only", "not_compared", "silent"]).describe("agrees = pi and the entry state the same value. differs = they state different values: the entry's is published in its own field, pi's is here. only = pi states a value and the entry states none: pi's value is here and in no field of the entry. not_compared = pi states a value that is not compared with the entry's: a price on a subscription entry, a price in another unit, a cache-write price the entry keys by lifetime, tiers that cannot be read as tiers, or a field providers.dev publishes as unknown. silent = pi states no value: a limit or a price of 0 in pi's catalog is no statement."),
    pi: z.number().min(0).nullable().describe("pi's value, where pi states one. Null with silent, and for cost.tiers."),
    pi_tiers: z.array(PiCostTierSchema).nullable().describe("For cost.tiers, where the standing is not silent: pi's tiers, ascending; an empty list = pi states none. Null otherwise."),
  })
  .describe("Where pi's catalog stands beside one value of the entry. providers.dev's own value comes first, then models.dev's, then pi's: pi's value never replaces the entry's.") satisfies z.ZodType<PiValue>;

export const PiBlockSchema = z
  .strictObject({
    ref: z.string().describe("provider/model in pi's catalog: pi's provider id, then pi's model id. They can be spelled otherwise than the entry's."),
    provider: z.string().describe("pi's provider id."),
    model: z.string().describe("pi's model id."),
    match: z.enum(["id", "alias"]).describe("How the entry and pi's model belong together. id = pi's provider id and model id are the entry's. alias = providers.dev paired the provider id, the model id or both by hand, because pi spells them otherwise."),
    name: z.string(),
    type: z.string().describe("As pi states it, for example chat."),
    api: z.string().describe("The request format pi uses for the model, in pi's words: openai-completions, openai-responses, azure-openai-responses, openai-codex-responses, anthropic-messages, bedrock-converse-stream, google-generative-ai, google-vertex, mistral-conversations, pi-messages. Other values may be added."),
    base_url: z.string().nullable().describe("The address pi sends requests to, as stated, placeholders such as {CLOUDFLARE_ACCOUNT_ID} included. Null = pi states none."),
    reasoning: z.boolean().describe("Whether pi treats the model as one that reasons."),
    input: z.array(z.string()).describe("The kinds of input pi sends: text, image."),
    context_window: z.int().min(0).describe("Tokens."),
    max_tokens: z.int().min(0).describe("Tokens: the most pi asks for in one response."),
    cost: PiCostSchema,
    thinking_level_map: z.record(z.string(), z.string().nullable()).nullable().describe("pi's thinking levels (off, minimal, low, medium, high, xhigh, max) and the value pi sends for each. A level whose value is null is one pi marks as not supported. A level that is not named follows pi's own default for the request format, which is not published here. Null = pi states no map."),
    compat: z.record(z.string(), json).nullable().describe("pi's compatibility flags for the model, names and values exactly as pi's catalog states them (supportsLongCacheRetention, cacheControlFormat, forceAdaptiveThinking, thinkingFormat, supportsStrictTools and others; the set grows with pi). Only what the catalog states: a flag that is not here follows pi's own default for the request format, which lives in pi's code and is not published. Null = pi states none."),
    prompt_cache: z.strictObject({ short_s: z.int().min(0).nullable(), long_s: z.int().min(0).nullable() }).nullable().describe("The cache lifetimes pi reckons with, in seconds, for its short and its long retention. Null = pi states none, which pi reads as: the provider's cache behaviour is not known. Not part of providers_dev.cache."),
    input_limits: z
      .strictObject({
        max_request_bytes: z.int().min(0).nullable(),
        max_images_per_request: z.int().min(0).nullable(),
        max_images_per_message: z.int().min(0).nullable(),
      })
      .describe("The provider's limits on a request as pi states them. Each is null where pi states none."),
    differences: z.array(PiDifferenceSchema).describe("Where pi's price, context window or output limit is not the entry's published value, in a fixed order: context_window, max_tokens, cost.input, cost.output, cost.cache_read, cost.cache_write, cost.tiers. Empty = they agree wherever both state a value."),
    values: z.array(PiValueSchema).length(9).describe("One item for each value pi's catalog can state of an entry, in a fixed order: context_window, max_tokens, cost.input, cost.output, cost.cache_read, cost.cache_write, cost.tiers, prompt_cache.short, prompt_cache.long. Since 1.3.0."),
  })
  .describe("What pi's model catalog (https://pi.dev/api/models) states for this entry. Imported, not checked by providers.dev, and never merged into the entry's own fields: models.dev stays the reference.") satisfies z.ZodType<PiBlock>;

export const PiSummarySchema = z
  .strictObject({
    ref: z.string().describe("providers_dev.pi.ref of the full entry."),
    api: z.string().describe("providers_dev.pi.api of the full entry."),
    match: z.enum(["id", "alias"]).describe("providers_dev.pi.match of the full entry."),
    difference_count: z.int().min(0).describe("How many items providers_dev.pi.differences of the full entry has."),
  })
  .describe("The pi block of an entry in short.") satisfies z.ZodType<PiSummary>;

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
    safe: SafeValuesSchema,
    evidence: z.array(EvidenceSchema).describe("Sources for an added entry and for authored declarations. Empty = none."),
    verified: date.nullable().describe("The newest date of providers.dev evidence or evaluations for this entry. Null = it has none."),
    pi: PiBlockSchema.nullable().describe("What pi's catalog states for this entry. Null = pi does not list it."),
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
    max_output: z.number().nullable().describe("The most tokens one response can hold: the safe value, safe.max_output.value. A maximum, not a default. Null = unknown; a limit of 0 states nothing. Since 1.4.0; before, limit.output as published."),
    input_window: InputWindowSchema.describe("How much input a request can carry on this entry, and what that rests on: the same object as providers_dev.limits.input_window of the full entry. context and input beside it are limit as published, unchanged."),
    safe: SafeValuesSchema.describe("The safe values of the entry: the same object as providers_dev.safe of the full entry. Since 1.4.0."),
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
    pi: PiSummarySchema.nullable().describe("The pi block of the entry in short: providers_dev.pi of the full entry. Null = pi's catalog does not list the entry. Since 1.2.0."),
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
  max_output_min: z.number().nullable().describe("The smallest max_output among its entries: the safe maximum output of each summary since 1.4.0 (null and so left out where unknown, possibly pi.dev's figure), before that limit.output as published. Null = no entry has one."),
  max_output_max: z.number().nullable().describe("The largest max_output among its entries, read the same way. Null = no entry has one."),
  input_window_min: ModelInputWindowEndSchema.nullable().describe("The smallest input window among its entries (input_window of each), with the entry it is on. At an equal number of tokens a value that is not a lower bound counts as the smaller. Null = no entry has one. Since 1.1.0."),
  input_window_max: ModelInputWindowEndSchema.nullable().describe("The largest input window among its entries, with the entry it is on. At an equal number of tokens a lower bound (bound at_least) counts as the larger: the real limit there can be more. Null = no entry has one. Since 1.1.0."),
  input_window_unknown_count: z.int().min(0).describe("Entries with no input window (input_window.tokens null). Since 1.1.0."),
  input_window_reference: ModelInputWindowEndSchema.nullable().describe("The input window of the reference entry (reference_ref, the lab's own), with its scope: what the lab itself gives. Null where there is no reference entry, or where its input window is not known. Since 1.1.0."),
};
export const CanonicalModelSchema = z.strictObject(canonicalModel).describe("A model as its lab names it, and how its entries compare.") satisfies z.ZodType<CanonicalModel>;
export const CanonicalModelDetailSchema = z
  .strictObject({ ...canonicalModel, entries: z.array(EntrySummarySchema).describe("Every entry for the model: the lab's own API first, then subscriptions, then the rest by provider.") })
  .describe("A canonical model with every entry that serves it.") satisfies z.ZodType<CanonicalModelDetail>;

// ---- listings: every model a provider and access method offers, measured or not. Since 1.5.0.
const listingSource = z.enum(["listed", "providers.dev", "models.dev", "pi.dev"]);
const fieldSource = listingSource.nullable();

export const ListingReasoningSchema = z
  .strictObject({
    supported: z.boolean().nullable().describe("The model reasons (thinks) at all. Null = no source says."),
    levels: z.array(z.string()).nullable().describe("The reasoning levels a request can ask for, in the source's order, for example low, medium, high. Null = no source states them. Empty = the source states none."),
    budget_min: z.int().min(0).nullable().describe("The smallest thinking budget, in tokens. Null = not stated."),
    budget_max: z.int().min(0).nullable().describe("The largest thinking budget, in tokens. Null = not stated."),
    can_disable: z.boolean().nullable().describe("Thinking can be turned off. Null = not stated."),
    dynamic: z.boolean().nullable().describe("The model may choose its own budget. Null = not stated."),
    disable_with: z.string().nullable().describe("The vendor's word for off, where it is not the usual one. Null = not stated."),
  })
  .describe("What the sources say of a listed model's reasoning. Each key from the first source that states it.") satisfies z.ZodType<ListingReasoning>;

export const ListingReasoningSourcesSchema = z
  .strictObject({
    supported: fieldSource,
    levels: fieldSource,
    budget_min: fieldSource,
    budget_max: fieldSource,
    can_disable: fieldSource,
    dynamic: fieldSource,
    disable_with: fieldSource,
  })
  .describe("Per key of reasoning, the source that gave it. Null = no source states it.") satisfies z.ZodType<ListingReasoningSources>;

export const ListingSourcesSchema = z
  .strictObject({
    name: fieldSource,
    owner: fieldSource,
    released: fieldSource,
    context_window: fieldSource,
    max_input: fieldSource,
    max_output: fieldSource,
    input_modalities: fieldSource,
    output_modalities: fieldSource,
    reasoning: ListingReasoningSourcesSchema,
    web_search: fieldSource,
    aliases: fieldSource,
    variants: fieldSource,
    plans: fieldSource,
    hidden: fieldSource,
  })
  .describe("Per field of a listed model, the source that gave it: listed (the vendor's own list, through groundtruth's discovery), providers.dev (an authored statement with evidence), models.dev, pi.dev. Null = no source states it. Other values may be added.") satisfies z.ZodType<ListingSources>;

export const ListingModelSchema = z
  .strictObject({
    id: z.string().min(1).describe("The id a request names on this access method."),
    name: z.string().nullable().describe("The name from the first source that states one; where none does, the id (its source is then the listing's basis). Never taken from the vendor's list."),
    owner: z.string().nullable().describe("The lab that makes the model. Null = not stated."),
    entry: z.strictObject({ provider: z.string(), model: z.string() }).nullable().describe("The catalog entry for this model on this provider, as in /api/v1/entries/{provider}/{model}. Null = listed, not an entry of the catalog."),
    canonical: z.string().nullable().describe("canonical_id of that entry. Null without an entry, or where the entry names none."),
    released: z.string().nullable().describe("The release date as the source writes it. Null = not stated."),
    context_window: z.int().positive().nullable().describe("Tokens: the window input and output share. Null = not stated; never 0."),
    max_input: z.int().positive().nullable().describe("Tokens: the most input, where the source states it apart from the window. Null = not stated."),
    max_output: z.int().positive().nullable().describe("Tokens: the most one response can hold. A maximum, not a default. Null = not stated."),
    input_modalities: z.array(z.string()).nullable().describe("The kinds of input: text, image, audio, video, pdf, and others as the source names them. Null = not stated."),
    output_modalities: z.array(z.string()).nullable().describe("The kinds of output. Null = not stated."),
    reasoning: ListingReasoningSchema.nullable().describe("Null = no source says anything about reasoning."),
    web_search: z.boolean().nullable().describe("The access method runs the vendor's own web search for this model. Null = not stated."),
    aliases: z.array(z.string()).describe("Other ids the access method accepts for the model, from an authored statement. Empty = none stated. Never taken from the vendor's list."),
    variants: z.array(z.string()).describe("The vendor's own ids where it has one id per reasoning level (Devin), from an authored statement. Empty where id itself is what a request names. Never taken from the vendor's list."),
    plans: z.array(z.string()).describe("Plan names the vendor's own list attaches to the model, from a fixed list of single words (free, go, plus, pro, team, business, enterprise, edu, education, max), in lower case; any other name is left out. Empty = none. No prices, allowances or quotas."),
    hidden: z.boolean().nullable().describe("The vendor's list marks the model as not shown in pickers. Null = not stated."),
    sources: ListingSourcesSchema,
  })
  .describe("One model of a listing: what the sources state of it on this access method. A listed model need not be an entry.") satisfies z.ZodType<ListingModel>;

export const ListingSchema = z
  .strictObject({
    provider: z.string().describe("The provider id, as in /api/v1/providers/{provider}."),
    basis: listingSource.describe("The source the listing's models are taken from, whole: listed (the vendor's own list, read by groundtruth's discovery), providers.dev (an authored list), models.dev (the imported entries of the provider), pi.dev (pi's models of the provider). The first of these four that has a list for the provider. Other values may be added."),
    listed_at: date.nullable().describe("The day that source was read: the discovery's date for listed, the import's date for models.dev and pi.dev, the newest evidence date for providers.dev. Null = not known."),
    client: z.string().nullable().describe("For listed: the public id of the client that read the vendor's list, as in data/authored/measurement-labels.yaml. Null otherwise."),
    client_label: z.string().nullable().describe("Its public label. Null with client."),
    evidence: z.array(EvidenceSchema).describe("Where the list comes from: the discovery file for listed, the authored evidence for providers.dev. Empty for an imported list, whose date is listed_at."),
    model_count: z.int().min(0).describe("How many models the listing has."),
    models: z.array(ListingModelSchema).nullable().describe("The models, in the source's order. Null in /api/v1/listings without view=full, so that the answer has the same keys in both views."),
  })
  .describe("The model list of one provider and access method: what the vendor's own list said, read on a date through a named client, completed by sourced statements. Not an evaluation: a listed model need not be an entry, and nothing of a listing is written into an entry. Since 1.5.0.") satisfies z.ZodType<Listing>;

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
    license: z.looseObject({
      data: z.string(),
      upstream: z.string(),
      notice: z.string(),
      pi: z.string().describe("pi's catalog: its project, licence and copyright line. Since 1.2.0."),
      pi_notice: z.string().describe("Where the pi block of an entry comes from, and that providers.dev is not affiliated with pi. Since 1.2.0."),
    }),
    pi: z
      .strictObject({
        source: z.string().describe("The address pi's catalog is imported from."),
        snapshot: z
          .strictObject({
            fetched_at: z.string().describe("When the pi data of this dataset was imported."),
            checked_at: z.string().describe("When pi last confirmed that it had not changed."),
            etag: z.string().nullable(),
            last_modified: z.string().nullable().describe("The Last-Modified of pi's answer, as sent."),
            revision: z.string().nullable().describe("pi's own revision of its catalog, as sent."),
            sha256: z.string(),
            providers: z.int().describe("Provider ids in pi's catalog."),
            models: z.int().describe("Models in pi's catalog."),
          })
          .nullable()
          .describe("The pi import this dataset is built on. Null = it is built without pi data: no entry has a pi block."),
        sync: z
          .strictObject({ last_attempt_at: z.string().nullable(), last_attempt_ok: z.boolean().nullable(), last_error: z.string().nullable() })
          .describe("The last attempt to import pi's catalog. All null = no attempt is recorded. A failed attempt leaves the snapshot above as it was. `sync` beside `upstream` speaks of models.dev and the evaluations only."),
        counts: z
          .strictObject({
            entries_with_block: z.int().describe("Entries with a pi block."),
            left_out_models: z.int().describe("pi models whose entry providers.dev leaves out (exclusions)."),
            unmatched_models: z.int().describe("pi models that belong to no entry. Nothing of them is published."),
          })
          .describe("The three add up to snapshot.models."),
      })
      .describe("pi's model catalog, the second imported source: where it came from, whether the last import worked, and how much of it is in this dataset. Since 1.2.0."),
    listings: z
      .strictObject({
        count: z.int().min(0).describe("Listings in this dataset."),
        models: z.int().min(0).describe("Models in them, all listings together."),
        by_basis: z
          .strictObject({ listed: z.int().min(0), "providers.dev": z.int().min(0), "models.dev": z.int().min(0), "pi.dev": z.int().min(0) })
          .describe("Listings by the source of their models."),
        source: z.string().describe("The address groundtruth's discovery file, listed.json, is fetched from."),
        fetched_at: z.string().nullable().describe("When the discovery file this dataset is built on was fetched. Null = there is none."),
        checked_at: z.string().nullable().describe("When it was last confirmed unchanged. Null = there is none."),
        listed_at: date.nullable().describe("The newest day a provider's list in that file was read. Null = there is none."),
        sync: z
          .strictObject({ last_attempt_at: z.string().nullable(), last_attempt_ok: z.boolean().nullable(), last_error: z.string().nullable() })
          .describe("The last attempt to fetch the discovery file. All null = none is recorded. A failed attempt keeps the last good file."),
      })
      .describe("The listings (/api/v1/listings) and the discovery file they read. Since 1.5.0."),
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
    code: z.string().describe("invalid_parameters, provider_not_found, entry_not_found, model_not_found, listing_not_found, method_not_allowed, not_found or snapshot_incomplete."),
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
  PiBlock: PiBlockSchema,
  PiCost: PiCostSchema,
  PiCostTier: PiCostTierSchema,
  PiDifference: PiDifferenceSchema,
  PiSummary: PiSummarySchema,
  PiValue: PiValueSchema,
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
  SafeValues: SafeValuesSchema,
  SafeValue: SafeValueSchema,
  SourceValue: SourceValueSchema,
  SafePrice: SafePriceSchema,
  PriceStatement: PriceStatementSchema,
  PriceTier: PriceTierSchema,
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
  Listing: ListingSchema,
  ListingModel: ListingModelSchema,
  ListingReasoning: ListingReasoningSchema,
  ListingSources: ListingSourcesSchema,
  ListingReasoningSources: ListingReasoningSourcesSchema,
} as const;
