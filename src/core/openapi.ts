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
  { path: "/api/v1/meta", summary: "The dataset: version, counts, freshness, open issues", params: [], returns: "Meta" },
  { path: "/api/v1/catalog", summary: "Everything in one file", description: "`{ meta, data }`, where `data` is keyed by provider id and each provider holds `models` keyed by model id. Includes full pricing and request controls; use paginated resources when a full download is unnecessary.", params: [], returns: "The catalog, keyed by provider id" },
  { path: "/api/v1/openapi.json", summary: "This document", params: [], returns: "OpenAPI 3.1" },
  // What the pages of the website are drawn from, beyond the resources above.
  { path: "/api/v1/facets", summary: "Catalog filter options and counts", params: [], returns: "Facets" },
  { path: "/api/v1/corrections", summary: "Corrections grouped by identical change and evidence", params: CORRECTION_PARAMS, returns: "A page of Correction" },
  { path: "/api/v1/docs/{document}", summary: "Authored reference documentation", description: "The methodology and licensing text shown by the website. Compiled with the templates; contains no dataset values. API documentation is generated from /api/v1/openapi.json.", params: [], returns: "Documentation" },
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
      version: "1.3.0",
      description:
        "Read-only data about AI models as each provider and access method exposes them: limits, prices, prompt caching, and what providers.dev measured. " +
        "The baseline is imported from models.dev (MIT); everything providers.dev adds is under the `providers_dev` key. No key is needed.",
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
      { id: "unknown", title: "Unknown values", paragraphs: [
        "Null means no value is known. Zero is a real value. Unsupported means explicitly unavailable; not_applicable means the field has no meaning for this access method. Limits are tokens; max_output is a maximum, not a default.",
        "One structure. An entry summary, the providers_dev record of an entry or a provider, an evaluation, a correction and a piece of evidence each have the same keys on every object: an unknown value is null and an empty list is [], never a missing key. The answer of an endpoint has the same keys whatever its parameters: /providers/{provider} has models: null until view=full asks for it. The fields imported from models.dev (limit, cost, capabilities, modalities and the like) keep the models.dev shape, where an absent field means models.dev has no value.",
        "Unknown limits do not match minimum filters. Unknown release dates do not match max_age_months. Cache mode support is separate for automatic and manual caching. Evaluations do not establish documented parameter support.",
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
        "Read the case from basis, documented_s and measured_s: documented and not measured (basis documented, measured_s null); documented, measured and not contradicted (basis documented, both numbers, and hits_inside of checks_inside: the checks at ages up to documented_s and how many hit); documented and contradicted (basis measured, both numbers, safe_s equal to measured_s); measured with nothing documented (basis measured, documented_s null). basis none exactly when safe_s is null.",
        "0 is a value and null is not. safe_s 0 with basis documented: the provider documents that the entry does not cache (two documented items of 0 seconds, mode and documented_as null). safe_s 0 with basis measured: no age at which every check hit; first_miss_s 0 means the immediate re-send already missed. safe_s null: nothing is known; caching may be documented without a lifetime, which cache and providers_dev.cache.documented say.",
        "A measured lifetime is strict. For one evaluation, it is the oldest age through which every check hit, walking the control and then the ages in order and stopping at the first age where any check missed; a later hit does not raise it. An evaluation with no timed check whose control hit says nothing about how long and is in no item. An item's lifetime_s is the lowest over its evaluations, and measured_s is the lowest over the clients: one client whose cache did not hold lowers it, and each client's own value is its item. tested_from_s is the youngest age checked: no younger age was tested.",
        "A measured item's results are its evaluations' results added up by exact age. lifetime_s is read from each evaluation on its own and the lowest taken, so where an item has several evaluations the added-up results can show full hits at an older age than lifetime_s, never a younger one. The sums over different clients are not published as a value.",
        "The record states what the documentation says and what evaluations found on their dates, through the clients named. It is not a guarantee of how long a provider keeps a prompt. Every value is worked out once, when the data is built; the website prints it as published.",
      ] },
      { id: "cache", title: "Cache evaluations", paragraphs: [
        "cache_results on a summary equals providers_dev.cache.results on the full entry. It contains separate short and long rows with parameter, value and results. Null results mean not evaluated, never a zero hit rate.",
        "Each result records kind, exact age_s, hits, checks and hit_rate_pct. kind: control at age_s: 0 means the immediate resend. A check at 450 seconds remains 7.5 minutes. /meta lists shared display ages; other measured ages remain in results. Missing ages were not checked.",
        "Each row identifies its evaluations. /evaluations/cache and the full entry retain the client, route, date, request settings and raw evidence. Results describe that access method and date, not a guaranteed cache lifetime.",
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
      "/api/v1/docs/{document}": get("/api/v1/docs/{document}", { 200: ok("Reference text", oneOf(ref("Documentation"))), 304: notModified, 400: badParams, 404: errorResponse("No such document") }, [pathParam("document", "methodology or licensing.", "methodology")]),
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
