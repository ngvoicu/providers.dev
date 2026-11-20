// The OpenAPI document. Nothing in it is written by hand twice: the response schemas come from the contract
// (contract.ts), the query parameters from the lists the API validates with (query.ts).
import { z } from "zod";
import { BriefMetaSchema, COMPONENTS } from "./contract.ts";
import { CONTROL_EXAMPLE, PRICING_EXAMPLE } from "./policy-examples.ts";
import { CACHE_EVALUATION_PARAMS, CORRECTION_PARAMS, DEFAULT_LIMIT, LIMIT_EVALUATION_PARAMS, MAX_AGE_MONTHS, MAX_LIMIT, MODEL_PARAMS, PARAMS, PROVIDER_PARAMS, PROVIDER_VIEW_PARAMS, type ParamDoc } from "./query.ts";

type Schema = Record<string, unknown>;

/** A contract definition as JSON Schema (2020-12, which is what OpenAPI 3.1 uses). */
export function jsonSchema(schema: z.ZodType, component?: string): Schema {
  const out = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any", io: "output" }) as Schema;
  delete out.$schema;
  // Keep recursive definitions. In OpenAPI a local JSON Schema reference must point into its component,
  // not the document root; erasing these refs would erase nested condition and arbitrary-JSON schemas.
  const tidy = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(tidy);
    if (node === null || typeof node !== "object") return node;
    const object = node as Schema;
    const result: Schema = {};
    for (const [key, value] of Object.entries(object)) {
      if (key === "maximum" && value === Number.MAX_SAFE_INTEGER) continue;
      if (key === "minimum" && value === Number.MIN_SAFE_INTEGER) continue;
      result[key] = key === "$ref" && component && typeof value === "string" && value.startsWith("#") ? `#/components/schemas/${component}${value.slice(1)}` : tidy(value);
    }
    return result;
  };
  return tidy(out) as Schema;
}

const ref = (name: keyof typeof COMPONENTS | "BriefMeta"): Schema => ({ $ref: `#/components/schemas/${name}` });
const pageOf = (item: Schema): Schema => ({
  type: "object",
  required: ["meta", "total", "limit", "offset", "next_offset", "data"],
  additionalProperties: false,
  properties: {
    meta: ref("BriefMeta"),
    total: { type: "integer", description: "How many items match." },
    limit: { type: "integer" },
    offset: { type: "integer" },
    next_offset: { type: ["integer", "null"], description: "The offset of the next page. Null on the last page." },
    data: { type: "array", items: item },
  },
});
const oneOf = (data: Schema): Schema => ({ type: "object", required: ["meta", "data"], additionalProperties: false, properties: { meta: ref("BriefMeta"), data } });

const errorResponse = (description: string) => ({ description, content: { "application/json": { schema: ref("Error") } } });
const ok = (description: string, schema: Schema) => ({
  description,
  headers: {
    ETag: { schema: { type: "string" }, description: "An opaque validator for this response representation, including metadata. Send it back to the same URL as If-None-Match to get 304. It is not the dataset version." },
    "X-Dataset-Version": { schema: { type: "string" } },
    "X-Dataset-Generated-At": { schema: { type: "string", format: "date-time" } },
    "X-Upstream-Fetched-At": { schema: { type: "string", format: "date-time" } },
  },
  content: { "application/json": { schema } },
});
const notModified = { description: "Not modified" };
const badParams = errorResponse("A parameter is unknown or not valid");

function queryParameters(docs: readonly ParamDoc[]): Schema[] {
  return docs.map((param) => {
    const schema: Schema =
      param.kind === "integer"
        ? param.name === "max_age_months"
          ? { type: "integer", minimum: 1, maximum: MAX_AGE_MONTHS }
          : { type: "integer", minimum: param.name === "limit" ? 1 : 0, ...(param.name === "limit" ? { maximum: MAX_LIMIT, default: DEFAULT_LIMIT } : {}) }
        : param.kind === "boolean"
          ? { type: "boolean" }
          : param.kind === "enum"
            ? { type: "string", enum: param.values }
            : { type: "string" };
    const allowed = param.kind === "list" && param.values ? ` Allowed: ${param.values.join(", ")}.` : "";
    return { name: param.name, in: "query", required: false, description: param.description + allowed, schema };
  });
}

const pathParam = (name: string, description: string, example: string): Schema => ({ name, in: "path", required: true, description, schema: { type: "string" }, example });

/** Every endpoint, once. The documentation page lists them from here too. */
export const ENDPOINTS: { path: string; summary: string; description?: string; params: readonly ParamDoc[]; returns: string }[] = [
  { path: "/api/v1/entries", summary: "Search and filter entries", description: "An entry is a model at a provider and access method. Returns entry summaries. The order is fixed: the sort key, then provider id, then model id.", params: PARAMS, returns: "A page of EntrySummary" },
  { path: "/api/v1/entries/{provider}/{model}", summary: "One entry in full", description: "The provider is the first path segment; the model id is the rest of the path and may contain slashes. URL-encode each segment.", params: [], returns: "provider, summary and entry" },
  { path: "/api/v1/providers", summary: "List providers", params: PROVIDER_PARAMS, returns: "A page of ProviderSummary" },
  { path: "/api/v1/providers/{provider}", summary: "One provider with its entries", params: PROVIDER_VIEW_PARAMS, returns: "provider, entries and models (null unless view=full)" },
  { path: "/api/v1/models", summary: "List canonical models", description: "A canonical model is a model as its lab names it. Several entries can serve the same one.", params: MODEL_PARAMS, returns: "A page of CanonicalModel" },
  { path: "/api/v1/models/{lab}/{model}", summary: "One canonical model with every entry that serves it", params: [], returns: "CanonicalModelDetail" },
  { path: "/api/v1/evaluations/cache", summary: "List cache evaluations", description: "Every cache evaluation, newest first, each with the entry it was made on.", params: CACHE_EVALUATION_PARAMS, returns: "A page of CacheEvaluationRecord" },
  { path: "/api/v1/evaluations/limits", summary: "List limit evaluations", description: "Every limit evaluation, newest first, each with the entry it was made on.", params: LIMIT_EVALUATION_PARAMS, returns: "A page of LimitEvaluationRecord" },
  { path: "/api/v1/meta", summary: "The dataset: version, counts, freshness, the stale threshold, what is left out, open issues", params: [], returns: "Meta" },
  { path: "/api/v1/catalog", summary: "Everything in one file", description: "`{ meta, data }`, where `data` is keyed by provider id and each provider holds `models` keyed by model id. Includes full pricing and request controls; use paginated resources when a full download is unnecessary.", params: [], returns: "The catalog, keyed by provider id" },
  { path: "/api/v1/openapi.json", summary: "This document", params: [], returns: "OpenAPI 3.1" },
  // What the pages of the website are drawn from, beyond the resources above.
  { path: "/api/v1/facets", summary: "Catalog filter options and counts", params: [], returns: "Facets" },
  { path: "/api/v1/corrections", summary: "Corrections grouped by identical change and evidence", params: CORRECTION_PARAMS, returns: "A page of Correction" },
  { path: "/api/v1/docs/{document}", summary: "Authored reference documentation", description: "The methodology, licensing, contributing and support text shown by the website. Compiled with the templates; contains no dataset values. API documentation is generated from /api/v1/openapi.json.", params: [], returns: "Documentation" },
];

export function openapi(): Record<string, unknown> {
  const endpoint = (path: string) => ENDPOINTS.find((item) => item.path === path) as (typeof ENDPOINTS)[number];
  const get = (path: string, responses: Schema, parameters: Schema[] = []) => {
    const { summary, description, params } = endpoint(path);
    return { get: { summary, ...(description ? { description } : {}), parameters: [...parameters, ...queryParameters(params)], responses } };
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "providers.dev API",
      version: "1.2.0",
      description:
        "Read-only data about AI models as each provider and access method exposes them: limits, prices, prompt caching, and what providers.dev measured. " +
        "The baseline is imported from models.dev (MIT); everything providers.dev adds is under the `providers_dev` key. " +
        "A second catalog, pi's (MIT), is imported beside it: what it states for an entry is under providers_dev.pi. No key is needed.",
      contact: { name: "providers.dev", email: "office@providers.dev", url: "https://providers.dev/docs/contributing/" },
      license: { name: "MIT", url: "https://providers.dev/docs/licensing/" },
    },
    servers: [{ url: "https://providers.dev" }],
    "x-guide": [
      { id: "usage", title: "Requests and pagination", paragraphs: [
        "Four resources: providers, entries (a model at a provider and access method), models (canonical: a model as its lab names it) and evaluations (of the cache at /evaluations/cache, of limits at /evaluations/limits). Limits, prices and caching belong to an entry, because the same model differs from one provider to the next.",
        "No authentication is required. GET and HEAD are supported; OPTIONS answers CORS preflights. Public requests read a published snapshot and never fetch upstream providers.",
        `Every collection returns { meta, total, limit, offset, next_offset, data }. Use limit from 1 to ${MAX_LIMIT} (default ${DEFAULT_LIMIT}) and continue with next_offset until it is null. Every single resource returns { meta, data }, /meta and /catalog included. Only /openapi.json and the compatibility export /api.json return their documents directly.`,
        "Filters combine with AND. Unknown parameters, duplicate parameters and invalid values return 400 with details. URL-encode each provider/model path segment; model ids may contain slashes. Keep dataset_version and generated_at when joining pages; restart pagination if either changes.",
      ] },
      { id: "stability", title: "Stability", paragraphs: [
        "/api/v1 only grows. Nothing in it is removed, renamed or retyped: every path, parameter, property, schema and enumerated value of version 1.0.0 stays, with the same type. A property that is always present stays present, one that is never null stays so, and an allowed value of a parameter stays allowed. What can be added: a path, an optional parameter, an allowed value of a parameter, a property, a schema, a value of an enumerated field.",
        "That promise covers everything providers.dev makes itself: summaries, providers_dev records, evaluations, corrections, evidence, paths and parameters. The fields imported from models.dev (limit, cost, capabilities, modalities and the like) follow the models.dev v2 schema, which models.dev calls experimental. When models.dev changes one of them, providers.dev takes the change over, and that is not a new major version of this API. The first case was on 2026-11-17: capabilities.tools.updates, until then true or false, became a list of the tool changes an API accepts in the middle of a conversation (add, remove, replace; [] for none).",
        "A client must ignore keys it does not know, and must tolerate a value of an enumerated field that it does not know, for example by reading it as unknown. A client that refuses either can break on a change /api/v1 allows.",
        "A change that removes, renames or retypes something would be /api/v2, published beside /api/v1, which is kept.",
        "The version of this document, info.version, is the version of the structure of /api/v1. It started at 1.0.0 with the first public release. A release that adds something takes a minor step: 1.1.0, then 1.2.0. A correction of the text alone can take a patch step. The major number stays 1 within /api/v1.",
        "X-Dataset-Version, and dataset_version of /meta, are about the data, not about the structure: they change when the data changes, as a rule every day. They are not this version.",
      ] },
      { id: "unknown", title: "Unknown values", paragraphs: [
        "Null means no value is known. Zero is a real value. Unsupported means explicitly unavailable; not_applicable means the field has no meaning for this access method. Limits are tokens; max_output is a maximum, not a default.",
        "One structure. An entry summary, the providers_dev record of an entry or a provider, an evaluation, a correction and a piece of evidence each have the same keys on every object: an unknown value is null and an empty list is [], never a missing key. The answer of an endpoint has the same keys whatever its parameters: /providers/{provider} has models: null until view=full asks for it. The fields imported from models.dev (limit, cost, capabilities, modalities and the like) keep the models.dev shape, where an absent field means models.dev has no value.",
        "Unknown limits do not match minimum filters. Unknown release dates do not match max_age_months. sort=cache_short and sort=cache_long order entries by cache_lifetime.short.safe_s and cache_lifetime.long.safe_s: an unknown safe lifetime (null) comes last in either order, and 0 is a value. lifetime_basis=documented or measured keeps the entries whose short or long safe lifetime has that basis. Cache mode support is separate for automatic and manual caching. Evaluations do not establish documented parameter support.",
      ] },
      { id: "input-window", title: "Input window", paragraphs: [
        "Every entry has one input window record, providers_dev.limits.input_window, and every summary the same object as input_window. Its tokens is the most input a request can carry on the entry: the number a client should take as its input budget on this provider and access method, in tokens as the provider counts them, the client's own system prompt and tools included. It is null where that is not known, and never 0. The rest of the record says what the number rests on.",
        "The rule. Where an input limit or a context window is documented for the entry, that is the value (basis documented), unless a limit evaluation of the entry clearly contradicts it; then the value is the measured one (basis measured). Where nothing is documented, the value is the measured one. Where several clients were measured, the lowest value decides, and each client's own value is an item of measurements. Where nothing is known, tokens is null and basis is none. An evaluation contradicts a documented value D when it names a window below D; when it names a window other than D and D is a limit.context; when it refused an input at or below 99 % of D (for 922,000: 912,780 or less) above an accepted one; or when it accepted an input at or above 101 % of D (931,220 or more) that was below a refusal or read to the end. A window the route names is exact and has no margin; a refused or accepted size has a margin of 1 %, because a refused size is the probe's own count and routes add tokens of their own. A measurement can raise the value above a documented one. documented_status says what the rule found where both a documented and a measured value exist: contradicted (tokens is measured_tokens) or not_contradicted (tokens is documented_tokens); not contradicted is not confirmed.",
        "bound. limit: the value is the limit, as documented or as the route names it. at_least: the value is the largest input seen accepted, and the real limit is that or more; where an input was refused above it, measured_refused gives the smallest one, and the limit is below that. A documented value is always limit.",
        "scope. window: the value is a context window that input and output share (limit.context, or a window the route names), so the response is counted against the same figure, and a client that wants room for a reply takes it off itself. input: the value is a figure for the input alone (limit.input, or an input size seen accepted); compare limit.context and limit.output of the entry for the room left for the reply.",
        "What is read as documented: the entry's own limit.input where it is a number above 0, else its limit.context where it is one and is not a measured value (a field named in limits.from_measurement is a measurement, read as one). 0 is \"none stated\", not a limit: an image or audio model with a window of 0 gets null, unless it states an input. Nothing is read from another entry: an entry providers.dev added takes no limit from the entry it names. documented_source is models.dev with the import date, or providers.dev with the newest evidence date where providers.dev corrected the field or added the entry.",
        "What is read as measured: the entry's limit evaluations, providers_dev.limits.measured, nothing else, so every value can be redone from the entry. One evaluation gives a value of one of three kinds. window: the route's own answer named its context window (context), and no smaller input was refused; the value is that window, bound limit. bracket: an input was accepted (input_accepted) and a larger one refused (input_refused); the value is the accepted one, bound at_least. accepted: an input was accepted and the reply showed it was read to the end (input_read), with nothing refused and no window named; the value is input_read, bound at_least. An evaluation that fits none of these counts for nothing: a refusal with nothing accepted, an accepted size with no refusal, no named window and no read check (a route can answer a request it did not read), or the output alone. It stays in limits.measured and /evaluations/limits, is in no item, and /meta lists it as the notice limit-not-counted.",
        "A model (/models, /models/{lab}/{model}) gives the two ends among its entries, since 1.1.0: input_window_min and input_window_max, each the entry it is on (entry_ref) with that entry's tokens, bound, basis and scope, input_window_unknown_count, the entries with none, and input_window_reference, the same for the reference entry (reference_ref, the lab's own), null where there is none or it is not known. At an equal number of tokens a lower bound counts as the larger. They are not context_min and context_max, which are limit.context: an input limit can be below the context window, and a window counts the output too.",
        "Nothing that existed before changes. limit of an imported entry stays models.dev's, and limit.context and limit.output of an added entry stay what a measurement stated. context, input and max_output of a summary are limit as published; measured_input_accepted, measured_input_refused and measured_limit_count stay the widest accepted, the narrowest refused and the number of limit evaluations, whether they count for the input window or not.",
        "The limits of the evidence. A measurement is one account on one route on one date: another plan, region or account can have another limit, and a provider can change it the next day, so every measured value carries its date and goes stale as all providers.dev evidence does. A walk sends few requests: the real limit lies between the accepted size and the refused one, and an at_least value is lower than the limit by as much as that gap. Where no refusal was seen, nothing shows where the limit is, only that it is not below the value. A refused size is the probe's count, not the provider's. The requests were short questions over filler text with replies of a few tokens: a window that input and output share has less room for input when a long reply is asked for. A window a route names is its total; a cap on the input inside it shows only as a refusal. The documented value is models.dev's unless marked.",
      ] },
      { id: "pi", title: "pi's catalog", paragraphs: [
        "Since 1.2.0. A second catalog is imported beside models.dev: the model catalog of pi, a coding agent (https://pi.dev/api/models, MIT). models.dev stays the reference. Nothing of pi's is merged into limit, cost or capabilities of an entry, nor into any other key providers.dev publishes: what pi states for an entry is one block of its own, providers_dev.pi, and pi pushes no value into another field. A model that only pi lists is not an entry: pi adds no entry and no provider, and every list and count of the API is what it would be without pi. providers.dev is not affiliated with pi.",
        "The block. Every entry has providers_dev.pi, and every summary pi: null where pi's catalog does not list the entry, else the block (on a summary, the block in short: ref, api, match and difference_count). The block gives pi's own provider id and model id (provider, model, and ref, the two joined by a slash), the request format pi uses (api), the address it sends requests to (base_url), what it sends as input, whether it treats the model as one that reasons, its context window and output limit, its prices, its thinking levels, its compatibility flags, the cache lifetimes it reckons with and the provider's request limits it records. match says how the entry and pi's model belong together: id where pi's provider id and model id are the entry's own; alias where providers.dev paired the provider id, the model id or both by hand because pi spells them otherwise. A pairing rests on an address both catalogs or the provider state; nothing is ever matched by a resemblance of names. Where two pi models would reach one entry, the one with the entry's own ids keeps it.",
        "Only what pi's catalog states is published. A compatibility flag missing from compat, or a thinking level missing from thinking_level_map, follows pi's own default for the request format, which lives in pi's code and is not published here: a missing flag is not false. A level whose value is null is one pi marks as not supported. compat, thinking_level_map and prompt_cache are null where pi states none, and each key of input_limits is null where pi states none. In pi's catalog every price is a number, and 0 stands for no charge and for no price recorded alike: a price of 0 in the block is not a statement that the provider charges nothing. cache_write is pi's price of a cache write of the short lifetime. A tier prices the whole request once its input tokens (input, cache reads and cache writes together) are above input_tokens_above, the highest such tier applying.",
        "The differences. differences lists, in a fixed order (context_window, max_tokens, cost.input, cost.output, cost.cache_read, cost.cache_write, cost.tiers), each field where pi's value is not the entry's published value, after every providers.dev correction: context_window against limit.context, max_tokens against limit.output, cost.input against cost.text.input.price, cost.output against cost.text.output.price, cost.cache_read against cost.text.input.cache.read, cost.cache_write against cost.text.input.cache.write where that is one number. Both sides must state a value: nothing is listed where the entry has none, where a limit is 0 on either side (0 is none stated), or where pi's price is 0; a price of 0 on the entry's side is a price and is compared. Limits are compared exactly. Prices are compared exactly, with no tolerance, and an entry price with a unit of its own (per character) is not compared; nor is a cache-write price the entry keys by lifetime, since pi states one price and does not say for which lifetime. The entry's tiers are its input and output overrides whose condition is the context alone, greater than a number (that number) or at least a number (that number less 1); other overrides and every multiplier are not tiers. Where the tiers differ, one side having none included, one item is listed, field cost.tiers, with both lists in full in pi_tiers and published_tiers; pi and published are then null. Base prices are compared on their own, tiers or not. An item gives the two values and nothing else: no percentage, no verdict on which is right. An empty list means agreement wherever both state a value.",
        "/meta.pi gives the address the catalog is imported from, the snapshot this dataset is built on (null where there is none, and then no entry has a block), the last attempt to import it, which can have failed while the snapshot stays the last good one, and three counts that add up to the snapshot's models: entries_with_block, left_out_models (pi models whose entry providers.dev leaves out) and unmatched_models (pi models that belong to no entry). sync beside upstream speaks of models.dev and the evaluations only. license.pi and license.pi_notice name pi's licence.",
      ] },
      { id: "pricing-rules", title: "Pricing and request controls", paragraphs: [
        "Every entry summary has pricing and request_controls, identical to providers_dev.pricing and providers_dev.request_controls on the full entry. This includes entries nested in provider, model and catalog responses. Provider and model list items do not aggregate prices across entries.",
        "Coverage is unknown, partial, complete or not_applicable. Imported pricing is partial. rules: null means unknown; an empty array proves no conditions only with complete coverage. Unrecognized source fields remain in unparsed. Original cost, capabilities and api fields are preserved.",
        "Each rate identifies its meter, operation, amount, currency and billing unit. The meter is the kind of content and what is charged for it: text.input, text.cache_read, audio.input, image.output, video.output, and web_search for web searches. The unit is the source's: 1,000,000 tokens or characters, 1 second, minute, image or megapixel, 1,000 searches. price_in and price_out are the text prices per million tokens only. A rule with when: null is a base rate. Conditions can combine context size, cache lifetime, service tier, region, date, the day and hour in UTC, and what a request for an image, a video or a transcription asks for (resolution, quality, duration and the like) with all, any and not. Unknown conditions retain their raw source shape. An imported rule holds for the whole request that matches its condition (applies_to: all_usage), because that is how models.dev evaluates one; an authored rule can say above_threshold, and null means it is not established.",
        "A set rule replaces a rate and a multiply rule scales it. rule_order: listed means apply matching rules in listed order. Imported records are listed: base rates first, then the overrides in models.dev's order, then every matching multiplier, which is how models.dev defines a price. Null means precedence is unconfirmed.",
        "A multiply rule carries resulting_rates: each base rate in its scope times the factor, which is the price when that rule applies and no other conditional rule does. A set rule has resulting_rates: null, because its amount is the rate. Nothing combines several conditional rules for you: this API describes rates and is not a quote calculator.",
        "Peak and off-peak. A rule whose condition reads request.utc_hours or request.utc_days has a period: peak where it raises the base rate in its window, off_peak where it lowers it. The base rate is the price outside the window. Every other rule has period: null.",
        "Controls bind to headers, body fields or query parameters. Body paths are JSON Pointers relative to the stated scope. Options preserve the provider's actual values and may include companion headers or body fields. profile: short or long is a display grouping, not a universal duration; retention_s gives a known duration.",
        "Every entry includes cache.retention and service_tier controls. Unknown bindings, options and defaults are null. A known default wraps { value: ... }, so an explicit null value is distinct from an unknown default. Control support and option availability may have conditions. Controls are never inherited across access methods.",
        "A subscription entry is not paid per token, so it has no price of its own. Its pricing is the API list price of the same model: billing is reference and reference_ref names the API entry, which is the entry a providers.dev entry inherits from, or else the entry of the lab's own provider for the same canonical model. price_in, price_out and price_from of the summary say the same. Where the catalog has no such API entry, billing is not_applicable and rules is null; where the source lists a price for the entry all the same, billing is unknown. An imported entry's own cost field stays as models.dev has it.",
        "Component examples below use fictional rates, endpoints and headers.",
      ] },
      { id: "cache-lifetimes", title: "Cache lifetimes", paragraphs: [
        "Every entry has one cache lifetime record, providers_dev.cache.lifetime, and every summary the same object as cache_lifetime. Its list lifetimes holds every lifetime known for the entry, documented and measured, as items of one shape: retention_profile (short or long), basis (documented or measured), source (models.dev or providers.dev), date and lifetime_s in seconds. A documented item is one lifetime the source documents for one way of caching (mode, and documented_as, the text as written, such as 5m); the shortest lifetime the entry documents is short, every other is long. A measured item is one client with one retention setting: client, client_label, parameter and value, the evaluations it is made from (evaluation_ids, as in /evaluations/cache), checks, hits, tested_from_s, first_miss_s and results. The keys of the other kind are null, 0 or [], and basis says which half to read. An empty list means no lifetime is known.",
        "short and long each give a safe value, safe_s, with its basis, source and date, and beside it the two lifetimes it was chosen from. documented_s is the lowest documented lifetime of the profile and measured_s the lowest measured one. Where the provider documents a lifetime, it is the safe value, unless an evaluation of the profile contradicts it: at an age up to and including documented_s, the control included, fewer than half of that evaluation's checks hit (1 of 3 contradicts; 1 of 2 and 2 of 3 do not). Then the safe value is measured_s. Where nothing is documented, it is measured_s. Where nothing is documented or measured, it is null. The safe value is never above documented_s, and a measurement never raises it.",
        "documented_status is what the rule found of the documented lifetime, published where a lifetime above 0 is documented and one is measured: contradicted (safe_s is measured_s) or not_contradicted (safe_s is documented_s; not contradicted is not confirmed). It is null where nothing is documented, nothing is measured, or documented_s is 0: a provider that documents that it does not cache is never called contradicted, and measured_s says what was measured beside it.",
        "Read the case from basis, documented_status, documented_s and measured_s: documented and not measured (basis documented, measured_s null); documented, measured and not contradicted (documented_status not_contradicted, basis documented, and hits_inside of checks_inside: the checks at ages up to documented_s and how many hit); documented and contradicted (documented_status contradicted, basis measured, safe_s equal to measured_s); measured with nothing documented (basis measured, documented_s null); documented as not caching (documented_s 0, basis documented, documented_status null). basis none exactly when safe_s is null.",
        "0 is a value and null is not. safe_s 0 with basis documented: the provider documents that the entry does not cache (two documented items of 0 seconds, mode and documented_as null). safe_s 0 with basis measured: a check missed at the immediate re-send or at the youngest tested age (tested_from_s), and later ages may still have hit; first_miss_s 0 means the immediate re-send already missed. safe_s null: nothing is known; caching may be documented without a lifetime, which cache and providers_dev.cache.documented say.",
        "A measured lifetime is strict. For one evaluation, it is the oldest age through which every check hit, walking the control and then the ages in order and stopping at the first age where any check missed; a later hit does not raise it. An evaluation with no timed check whose control hit says nothing about how long and is in no item. An item's lifetime_s is the lowest over its evaluations, and measured_s is the lowest over the clients: one client whose cache did not hold lowers it, and each client's own value is its item. tested_from_s is the youngest age checked: no younger age was tested.",
        "A measured item's results are its evaluations' results added up by exact age. lifetime_s is read from each evaluation on its own and the lowest taken, so where an item has several evaluations the added-up results can show full hits at an older age than lifetime_s, never a younger one. The sums over different clients are not published as a value.",
        "The record states what the documentation says and what evaluations found on their dates, through the clients named. It is not a guarantee of how long a provider keeps a prompt. Every value is worked out once, when the data is built; the website prints it as published.",
      ] },
      { id: "cache", title: "Cache evaluations", paragraphs: [
        "Results by age are published in two places: on each evaluation (providers_dev.cache.evaluations of the full entry, and /evaluations/cache), and on each measured item of the lifetime record (results of an item in cache_lifetime.lifetimes, the same object as providers_dev.cache.lifetime.lifetimes), where the evaluations of one client with one retention setting are added up age by age. Short and long are separate items, and so is each client. A profile with no measured item has no lifetime measured: its evaluations count is 0, never a zero hit rate. An evaluation whose control hit and that has no timed check is published, but counts for no lifetime. Results added up over different clients are not published.",
        "Each result records kind, exact age_s, hits, checks and hit_rate_pct. kind: control at age_s: 0 means the immediate resend. A check at 450 seconds remains 7.5 minutes. /meta lists shared display ages; other measured ages remain in results. Missing ages were not checked.",
        "Each measured item names its evaluations in evaluation_ids. /evaluations/cache and the full entry retain the client, route, date, request settings and raw evidence. Results describe that access method and date, not a guaranteed cache lifetime.",
      ] },
      { id: "dates", title: "Dates and staleness", paragraphs: [
        "Every piece of providers.dev evidence has a date: a correction, an evaluation, a measured lifetime, and verified, the newest of an entry. stale_after_days of /meta is the threshold: evidence whose date is more than this many days before today is shown as stale. It is set once when the data is built. The API publishes the dates and this number, never a stale flag, because a flag fixed when the data is built would go wrong as days pass; a reader applies the number to its own date, as the website does. Imported models.dev values carry no such date.",
      ] },
      { id: "caching", title: "Versions and caching", paragraphs: [
        "X-Dataset-Version identifies the catalog and summaries. X-Dataset-Generated-At identifies publication time. Each response has an opaque ETag; reuse it only for the same URL. A 304 has no body. Fresh responses can be cached for 300 seconds with stale-while-revalidate for 3600 seconds.",
        "HTML pages are rendered on request from API responses pinned to one publication. The browser sends filters to /api/v1/entries. Publishing data updates the API and pages without rebuilding page templates. Reference text is built with templates and available at /api/v1/docs/{document}.",
      ] },
      { id: "errors", title: "Errors and exports", paragraphs: [
        "Errors return { error: { code, message, details? } }. 400 means invalid parameters, 404 an unknown resource, 405 an unsupported method, and 503 an incomplete or unavailable snapshot. Errors are not cached.",
        "/api.json is the provider-keyed compatibility export without an envelope. /api/v1/catalog returns the same catalog as { meta, data }. Both preserve the models.dev structure and additions under providers_dev. Added entries can lack upstream-required fields. Data is MIT licensed; retain attribution and notices.",
      ] },
    ],
    paths: {
      "/api/v1/entries": get("/api/v1/entries", { 200: ok("A page of entries", pageOf(ref("EntrySummary"))), 304: notModified, 400: badParams }),
      "/api/v1/entries/{provider}/{model}": get(
        "/api/v1/entries/{provider}/{model}",
        {
          200: ok("The entry", oneOf({ type: "object", required: ["provider", "summary", "entry"], additionalProperties: false, properties: { provider: ref("ProviderSummary"), summary: ref("EntrySummary"), entry: ref("Entry") } })),
          304: notModified,
          400: badParams,
          404: errorResponse("No such entry"),
        },
        [pathParam("provider", "The provider id.", "openrouter"), pathParam("model", "The model id at that provider. It may contain slashes.", "anthropic/claude-opus-5.5")],
      ),
      "/api/v1/providers": get("/api/v1/providers", { 200: ok("A page of providers", pageOf(ref("ProviderSummary"))), 304: notModified, 400: badParams }),
      "/api/v1/providers/{provider}": get(
        "/api/v1/providers/{provider}",
        {
          200: ok(
            "The provider",
            oneOf({
              type: "object",
              required: ["provider", "entries", "models"],
              additionalProperties: false,
              properties: {
                provider: ref("ProviderSummary"),
                entries: { type: "array", items: ref("EntrySummary"), description: "The provider's entries, by name." },
                models: { type: ["object", "null"], additionalProperties: ref("Entry"), description: "With view=full: the entries in full, by model id. Null with view=summary, so that the answer has the same keys in both views." },
              },
            }),
          ),
          304: notModified,
          400: badParams,
          404: errorResponse("No such provider"),
        },
        [pathParam("provider", "The provider id.", "anthropic")],
      ),
      "/api/v1/models": get("/api/v1/models", { 200: ok("A page of canonical models", pageOf(ref("CanonicalModel"))), 304: notModified, 400: badParams }),
      "/api/v1/models/{lab}/{model}": get(
        "/api/v1/models/{lab}/{model}",
        { 200: ok("The model", oneOf(ref("CanonicalModelDetail"))), 304: notModified, 400: badParams, 404: errorResponse("No such model") },
        [pathParam("lab", "The first part of the canonical id.", "anthropic"), pathParam("model", "The rest of the canonical id.", "claude-opus-5-5")],
      ),
      "/api/v1/evaluations/cache": get("/api/v1/evaluations/cache", { 200: ok("A page of cache evaluations", pageOf(ref("CacheEvaluationRecord"))), 304: notModified, 400: badParams }),
      "/api/v1/evaluations/limits": get("/api/v1/evaluations/limits", { 200: ok("A page of limit evaluations", pageOf(ref("LimitEvaluationRecord"))), 304: notModified, 400: badParams }),
      "/api/v1/meta": get("/api/v1/meta", { 200: ok("The dataset", oneOf(ref("Meta"))), 304: notModified, 400: badParams }),
      "/api/v1/catalog": get("/api/v1/catalog", {
        200: ok("The catalog", oneOf({ type: "object", description: "Keyed by provider id.", additionalProperties: ref("Provider") })),
        304: notModified,
      }),
      "/api/v1/openapi.json": get("/api/v1/openapi.json", { 200: ok("OpenAPI 3.1", { type: "object" }) }),
      "/api/v1/facets": get("/api/v1/facets", { 200: ok("Filter options and counts", oneOf(ref("Facets"))), 304: notModified, 400: badParams }),
      "/api/v1/corrections": get("/api/v1/corrections", { 200: ok("A page of corrections", pageOf(ref("Correction"))), 304: notModified, 400: badParams }),
      "/api/v1/docs/{document}": get("/api/v1/docs/{document}", { 200: ok("Reference text", oneOf(ref("Documentation"))), 304: notModified, 400: badParams, 404: errorResponse("No such document") }, [pathParam("document", "methodology, licensing, contributing or support.", "methodology")]),
      "/api.json": {
        get: {
          summary: "Compatibility export",
          description:
            "The merged catalog keyed by provider id, in the models.dev v2 structure, with no envelope. Added entries may lack fields that models.dev requires; every entry carries `providers_dev`. The dataset version is in the X-Dataset-Version header.",
          responses: { 200: ok("Provider-keyed catalog", { type: "object", additionalProperties: ref("Provider") }) },
        },
      },
    },
    components: {
      schemas: { BriefMeta: jsonSchema(BriefMetaSchema, "BriefMeta"), ...Object.fromEntries(Object.entries(COMPONENTS).map(([name, schema]) => [name, { ...jsonSchema(schema, name), ...(name === "Pricing" ? { examples: [PRICING_EXAMPLE] } : name === "RequestControl" ? { examples: [CONTROL_EXAMPLE] } : {}) }])) },
    },
  };
}

export interface FieldRow {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

function typeText(schema: Schema | undefined): string {
  if (!schema) return "any";
  if (typeof schema.$ref === "string") return schema.$ref.includes("/$defs/") ? "JSON value or nested schema" : schema.$ref.split("/").at(-1)!;
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.anyOf)) return (schema.anyOf as Schema[]).map(typeText).join(" | ");
  if (Array.isArray(schema.type)) return (schema.type as string[]).join(" | ");
  if (schema.type === "array") return `${typeText(schema.items as Schema | undefined)}[]`;
  return typeof schema.type === "string" ? schema.type : "any";
}

/** The fields of one part of the contract, for a table in the documentation. */
export function fieldRows(name: keyof typeof COMPONENTS): FieldRow[] {
  const schema = jsonSchema(COMPONENTS[name], name);
  const variants = (Array.isArray(schema.anyOf) ? schema.anyOf : [schema]) as Schema[];
  return variants.flatMap((variant) => {
    const required = new Set((variant.required as string[] | undefined) ?? []);
    const properties = (variant.properties as Record<string, Schema> | undefined) ?? {};
    const prefix = variants.length > 1 ? `${typeText(properties.kind)}.` : "";
    return Object.entries(properties).map(([field, value]) => ({ name: prefix + field, type: typeText(value), required: required.has(field), description: typeof value.description === "string" ? value.description : "" }));
  });
}
