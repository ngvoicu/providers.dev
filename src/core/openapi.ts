// The OpenAPI document. Nothing in it is written by hand twice: the response schemas come from the contract
// (contract.ts), the query parameters from the lists the API validates with (query.ts).
import { z } from "zod";
import { BriefMetaSchema, COMPONENTS } from "./contract.ts";
import { CONTROL_EXAMPLE, PRICING_EXAMPLE } from "./policy-examples.ts";
import { CORRECTION_PARAMS, DEFAULT_LIMIT, EVALUATION_PARAMS, MAX_AGE_MONTHS, MAX_LIMIT, MODEL_PARAMS, PARAMS, PROVIDER_PARAMS, PROVIDER_VIEW_PARAMS, type ParamDoc } from "./query.ts";

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
  { path: "/api/v1/facets", summary: "Catalog filter options and counts", params: [], returns: "Facets" },
  { path: "/api/v1/corrections", summary: "Corrections grouped by identical change and evidence", params: CORRECTION_PARAMS, returns: "A page of Correction" },
  { path: "/api/v1/docs/{document}", summary: "Authored reference documentation", description: "The methodology and licensing text shown by the website. Compiled with the templates; contains no dataset values. API documentation is generated from /api/v1/openapi.json.", params: [], returns: "Documentation" },
  { path: "/api/v1/entries", summary: "Search and filter entries", description: "An entry is a model at a provider and access method. Returns entry summaries. The order is fixed: the sort key, then provider id, then model id.", params: PARAMS, returns: "A page of EntrySummary" },
  { path: "/api/v1/entries/{provider}/{model}", summary: "One entry in full", description: "The provider is the first path segment; the model id is the rest of the path and may contain slashes. URL-encode each segment.", params: [], returns: "provider, summary and entry" },
  { path: "/api/v1/providers", summary: "List providers", params: PROVIDER_PARAMS, returns: "A page of ProviderSummary" },
  { path: "/api/v1/providers/{provider}", summary: "One provider with its entries", params: PROVIDER_VIEW_PARAMS, returns: "provider and entries; with view=full also models" },
  { path: "/api/v1/models", summary: "List canonical models", description: "A canonical model is a model as its lab names it. Several entries can serve the same one.", params: MODEL_PARAMS, returns: "A page of CanonicalModel" },
  { path: "/api/v1/models/{lab}/{model}", summary: "One canonical model with every entry that serves it", params: [], returns: "CanonicalModelDetail" },
  { path: "/api/v1/evaluations", summary: "List evaluations", description: "Every cache and limit evaluation, each with the entry it was made on: cache evaluations newest first, then limit evaluations.", params: EVALUATION_PARAMS, returns: "A page of Evaluation" },
  { path: "/api/v1/meta", summary: "The dataset: version, counts, freshness, open issues", params: [], returns: "Meta" },
  { path: "/api/v1/catalog", summary: "Everything in one file", description: "`{ meta, providers }`, where `providers` is keyed by provider id and each provider holds `models` keyed by model id. Includes full pricing and request controls; use paginated resources when a full download is unnecessary.", params: [], returns: "meta and providers" },
  { path: "/api/v1/openapi.json", summary: "This document", params: [], returns: "OpenAPI 3.1" },
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
        "Read-only metadata about AI models as each provider and access method exposes them. The baseline is imported from models.dev (MIT); providers.dev additions, corrections and evaluations are under the `providers_dev` key. " +
        "Four resources: providers, entries (a model at a provider), models (canonical) and evaluations. Every collection answers `{ meta, total, limit, offset, next_offset, data }` and pages with `limit` and `offset`; every single object answers `{ meta, data }`. " +
        "Every entry summary contains pricing and request_controls, also available under providers_dev on full entries. Conditions share a recursive typed grammar; headers, body fields and query parameters have explicit bindings. " +
        "Unknown is never zero: an absent optional field, or null, means no source gives the value. Pricing coverage is partial unless completeness is explicitly confirmed; unsupported, unknown and not_applicable are distinct. This API describes rates, not a billing quote.",
      license: { name: "MIT", url: "https://providers.dev/docs/licensing/" },
    },
    servers: [{ url: "https://providers.dev" }],
    "x-guide": [
      { id: "usage", title: "Requests and pagination", paragraphs: [
        "No authentication is required. GET and HEAD are supported; OPTIONS answers CORS preflights. Public requests read a published snapshot and never fetch upstream providers.",
        `Every collection returns { meta, total, limit, offset, next_offset, data }. Use limit from 1 to ${MAX_LIMIT} (default ${DEFAULT_LIMIT}) and continue with next_offset until it is null. Every single resource returns { meta, data }; /meta and /openapi.json return their documents directly.`,
        "Filters combine with AND. Unknown parameters, duplicate parameters and invalid values return 400 with details. URL-encode each provider/model path segment; model ids may contain slashes. Keep dataset_version and generated_at when joining pages; restart pagination if either changes.",
      ] },
      { id: "unknown", title: "Unknown values", paragraphs: [
        "An absent optional field or null means no value is known. Zero is a real value. Unsupported means explicitly unavailable; not_applicable means the field has no meaning for this access method. Limits are tokens; max_output is a maximum, not a default.",
        "Unknown limits do not match minimum filters. Unknown release dates do not match max_age_months. Cache mode support is separate for automatic and manual caching. Evaluations do not establish documented parameter support.",
      ] },
      { id: "pricing-rules", title: "Pricing and request controls", paragraphs: [
        "Every entry summary has pricing and request_controls, identical to providers_dev.pricing and providers_dev.request_controls on the full entry. This includes entries nested in provider, model and catalog responses. Provider and model list items do not aggregate prices across entries.",
        "Coverage is unknown, partial, complete or not_applicable. Imported pricing is partial. rules: null means unknown; an empty array proves no conditions only with complete coverage. Unrecognized source fields remain in unparsed. Original cost, capabilities and api fields are preserved.",
        "Each rate identifies its meter, operation, amount, currency and billing unit. Conditions can combine input size, retention, endpoint, region and service tier with all, any and not. Unknown conditions retain their raw source shape. Context-dependent rates can apply to all usage or only above the threshold; null means this is unknown.",
        "A set rule replaces a rate and a multiply rule scales it. rule_order: listed means apply matching rules in listed order. Null means precedence is unconfirmed. Partial or unknown interactions cannot establish an effective bill. This API describes rates and is not a quote calculator.",
        "Controls bind to headers, body fields or query parameters. Body paths are JSON Pointers relative to the stated scope. Options preserve the provider's actual values and may include companion headers or body fields. profile: short or long is a display grouping, not a universal duration; retention_s gives a known duration.",
        "Every entry includes cache.retention and service_tier controls. Unknown bindings, options and defaults are null. A known default wraps { value: ... }, so an explicit null value is distinct from an unknown default. Control support and option availability may have conditions. Controls are never inherited across access methods.",
        "Subscription reference rates have billing: reference and reference_ref. They describe the named API entry, not the subscription price. Component examples below use fictional rates, endpoints and headers.",
      ] },
      { id: "cache", title: "Cache evaluations", paragraphs: [
        "cache_results on a summary equals providers_dev.cache.results on the full entry. It contains separate short and long rows with parameter, value and results. Null results mean not evaluated, never a zero hit rate.",
        "Each result records kind, exact age_s, hits, checks and hit_rate_pct. kind: control at age_s: 0 means the immediate resend. A check at 450 seconds remains 7.5 minutes. /meta lists shared display ages; other measured ages remain in results. Missing ages were not checked.",
        "Each row identifies its evaluations. /evaluations and the full entry retain the client, route, date, request settings and raw evidence. Results describe that access method and date, not a guaranteed cache lifetime.",
      ] },
      { id: "caching", title: "Versions and caching", paragraphs: [
        "X-Dataset-Version identifies the catalog and summaries. X-Dataset-Generated-At identifies publication time. Each response has an opaque ETag; reuse it only for the same URL. A 304 has no body. Fresh responses can be cached for 300 seconds with stale-while-revalidate for 3600 seconds.",
        "HTML pages are rendered on request from API responses pinned to one publication. The browser sends filters to /api/v1/entries. Publishing data updates the API and pages without rebuilding page templates. Reference text is built with templates and available at /api/v1/docs/{document}.",
      ] },
      { id: "errors", title: "Errors and exports", paragraphs: [
        "Errors return { error: { code, message, details? } }. 400 means invalid parameters, 404 an unknown resource, 405 an unsupported method, and 503 an incomplete or unavailable snapshot. Errors are not cached.",
        "/api.json is the provider-keyed compatibility export without an envelope. /api/v1/catalog returns { meta, providers }. Both preserve the models.dev structure and additions under providers_dev. Added entries can lack upstream-required fields. Data is MIT licensed; retain attribution and notices.",
      ] },
    ],
    paths: {
      "/api/v1/facets": get("/api/v1/facets", { 200: ok("Filter options and counts", oneOf(ref("Facets"))), 304: notModified, 400: badParams }),
      "/api/v1/corrections": get("/api/v1/corrections", { 200: ok("A page of corrections", pageOf(ref("Correction"))), 304: notModified, 400: badParams }),
      "/api/v1/docs/{document}": get("/api/v1/docs/{document}", { 200: ok("Reference text", oneOf(ref("Documentation"))), 304: notModified, 400: badParams, 404: errorResponse("No such document") }, [pathParam("document", "methodology or licensing.", "methodology")]),
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
              required: ["provider", "entries"],
              additionalProperties: false,
              properties: {
                provider: ref("ProviderSummary"),
                entries: { type: "array", items: ref("EntrySummary"), description: "The provider's entries, by name." },
                models: { type: "object", additionalProperties: ref("Entry"), description: "With view=full: the entries in full, by model id." },
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
      "/api/v1/evaluations": get("/api/v1/evaluations", { 200: ok("A page of evaluations", pageOf(ref("Evaluation"))), 304: notModified, 400: badParams }),
      "/api/v1/meta": get("/api/v1/meta", { 200: ok("The dataset", ref("Meta")), 304: notModified }),
      "/api/v1/catalog": get("/api/v1/catalog", {
        200: ok("The catalog", { type: "object", required: ["meta", "providers"], properties: { meta: ref("BriefMeta"), providers: { type: "object", additionalProperties: ref("Provider") } } }),
        304: notModified,
      }),
      "/api/v1/openapi.json": get("/api/v1/openapi.json", { 200: ok("OpenAPI 3.1", { type: "object" }) }),
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
