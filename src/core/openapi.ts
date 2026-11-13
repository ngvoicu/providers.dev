// The OpenAPI document. Nothing in it is written by hand twice: the response schemas come from the contract
// (contract.ts), the query parameters from the lists the API validates with (query.ts).
import { z } from "zod";
import { BriefMetaSchema, COMPONENTS } from "./contract.ts";
import { DEFAULT_LIMIT, EVALUATION_PARAMS, MAX_AGE_MONTHS, MAX_LIMIT, MODEL_PARAMS, PARAMS, PROVIDER_PARAMS, PROVIDER_VIEW_PARAMS, type ParamDoc } from "./query.ts";

type Schema = Record<string, unknown>;

/** A contract definition as JSON Schema (2020-12, which is what OpenAPI 3.1 uses). */
export function jsonSchema(schema: z.ZodType): Schema {
  const out = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any", io: "output" }) as Schema;
  delete out.$schema;
  delete out.$defs;
  // "Any JSON value" is written as a reference to a local definition, which has no place inside a component: say it as {}.
  const tidy = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(tidy);
    if (node === null || typeof node !== "object") return node;
    const object = node as Schema;
    if (typeof object.$ref === "string" && object.$ref.startsWith("#/$defs/")) return object.description ? { description: object.description } : {};
    const result: Schema = {};
    for (const [key, value] of Object.entries(object)) {
      if (key === "maximum" && value === Number.MAX_SAFE_INTEGER) continue;
      if (key === "minimum" && value === Number.MIN_SAFE_INTEGER) continue;
      result[key] = tidy(value);
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
    ETag: { schema: { type: "string" }, description: "The dataset version in quotes. Send it back as If-None-Match to get 304." },
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
  { path: "/api/v1/providers/{provider}", summary: "One provider with its entries", params: PROVIDER_VIEW_PARAMS, returns: "provider and entries; with view=full also models" },
  { path: "/api/v1/models", summary: "List canonical models", description: "A canonical model is a model as its lab names it. Several entries can serve the same one.", params: MODEL_PARAMS, returns: "A page of CanonicalModel" },
  { path: "/api/v1/models/{lab}/{model}", summary: "One canonical model with every entry that serves it", params: [], returns: "CanonicalModelDetail" },
  { path: "/api/v1/evaluations", summary: "List evaluations", description: "Every cache and limit evaluation, each with the entry it was made on: cache evaluations newest first, then limit evaluations.", params: EVALUATION_PARAMS, returns: "A page of Evaluation" },
  { path: "/api/v1/meta", summary: "The dataset: version, counts, freshness, open issues", params: [], returns: "Meta" },
  { path: "/api/v1/catalog", summary: "Everything in one file", description: "`{ meta, providers }`, where `providers` is keyed by provider id and each provider holds `models` keyed by model id. About 14 MB before compression.", params: [], returns: "meta and providers" },
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
      version: "1.0.0",
      description:
        "Read-only metadata about AI models as each provider and access method exposes them. The baseline is imported from models.dev (MIT); providers.dev additions, corrections and evaluations are under the `providers_dev` key. " +
        "Four resources: providers, entries (a model at a provider), models (canonical) and evaluations. Every collection answers `{ meta, total, limit, offset, next_offset, data }` and pages with `limit` and `offset`; every single object answers `{ meta, data }`. " +
        "Unknown is never zero: an absent optional field, or null, means no source gives the value.",
      license: { name: "MIT", url: "https://providers.dev/docs/licensing/" },
    },
    servers: [{ url: "https://providers.dev" }],
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
      schemas: { BriefMeta: jsonSchema(BriefMetaSchema), ...Object.fromEntries(Object.entries(COMPONENTS).map(([name, schema]) => [name, jsonSchema(schema)])) },
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
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.anyOf)) return (schema.anyOf as Schema[]).map(typeText).join(" | ");
  if (Array.isArray(schema.type)) return (schema.type as string[]).join(" | ");
  if (schema.type === "array") return `${typeText(schema.items as Schema | undefined)}[]`;
  return typeof schema.type === "string" ? schema.type : "any";
}

/** The fields of one part of the contract, for a table in the documentation. */
export function fieldRows(name: keyof typeof COMPONENTS): FieldRow[] {
  const schema = jsonSchema(COMPONENTS[name]);
  const required = new Set((schema.required as string[] | undefined) ?? []);
  return Object.entries((schema.properties as Record<string, Schema> | undefined) ?? {}).map(([field, value]) => ({
    name: field,
    type: typeText(value),
    required: required.has(field),
    description: typeof value.description === "string" ? value.description : "",
  }));
}
