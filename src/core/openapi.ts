// The OpenAPI document, generated from the same parameter list the API validates with.
import { DEFAULT_LIMIT, MAX_AGE_MONTHS, MAX_LIMIT, PARAMS } from "./query.ts";

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

const ok = (description: string, schema: Record<string, unknown>) => ({
  description,
  headers: {
    ETag: { schema: { type: "string" }, description: "The dataset version in quotes. Send it back as If-None-Match to get 304." },
    "X-Dataset-Version": { schema: { type: "string" } },
    "X-Dataset-Generated-At": { schema: { type: "string", format: "date-time" } },
    "X-Upstream-Fetched-At": { schema: { type: "string", format: "date-time" } },
  },
  content: { "application/json": { schema } },
});

function queryParameters(): Record<string, unknown>[] {
  return PARAMS.map((param) => {
    const schema: Record<string, unknown> =
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

export function openapi(): Record<string, unknown> {
  const object = { type: "object", additionalProperties: true };
  return {
    openapi: "3.1.0",
    info: {
      title: "providers.dev API",
      version: "1.0.0",
      description:
        "Read-only metadata about AI models as each provider and access method exposes them. The baseline is imported from models.dev (MIT); providers.dev additions, corrections and evaluations are under the `providers_dev` key of each provider and model. `v1` is the version of this API; the model fields follow the models.dev v2 schema, which is experimental upstream.",
      license: { name: "MIT", url: "https://providers.dev/docs/licensing/" },
    },
    servers: [{ url: "https://providers.dev" }],
    paths: {
      "/api/v1/meta": {
        get: {
          summary: "Dataset version, freshness, upstream version and sync status",
          responses: { 200: ok("Metadata", { $ref: "#/components/schemas/Meta" }), 304: { description: "Not modified" } },
        },
      },
      "/api/v1/catalog": {
        get: {
          summary: "The complete merged catalog",
          description: "`{ meta, providers }`, where `providers` is keyed by provider id and each provider holds `models` keyed by model id. About 12 MB before compression.",
          responses: { 200: ok("Catalog", object), 304: { description: "Not modified" } },
        },
      },
      "/api/v1/providers": {
        get: { summary: "Provider directory", responses: { 200: ok("Providers", object), 304: { description: "Not modified" } } },
      },
      "/api/v1/providers/{providerId}": {
        get: {
          summary: "One provider and all its models",
          parameters: [{ name: "providerId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: ok("Provider", object), 304: { description: "Not modified" }, 404: errorResponse("No such provider") },
        },
      },
      "/api/v1/models": {
        get: {
          summary: "Search and filter provider-model entries",
          description: "Returns entry summaries. Order is deterministic: the sort key, then provider id, then model id.",
          parameters: queryParameters(),
          responses: {
            200: ok("A page of entries", {
              type: "object",
              required: ["meta", "total", "limit", "offset", "next_offset", "data"],
              properties: {
                meta: object,
                total: { type: "integer" },
                limit: { type: "integer" },
                offset: { type: "integer" },
                next_offset: { type: ["integer", "null"], description: "The offset of the next page, or null on the last page." },
                data: { type: "array", items: { $ref: "#/components/schemas/EntrySummary" } },
              },
            }),
            304: { description: "Not modified" },
            400: errorResponse("A parameter is unknown or not valid"),
          },
        },
      },
      "/api/v1/entry": {
        get: {
          summary: "One provider-model entry in full",
          description:
            "Model ids often contain slashes, so the entry is named in the query string, not the path. Give `ref=provider/model` (the provider is everything before the first slash), or `provider` and `model` separately. URL-encode the values.",
          parameters: [
            { name: "ref", in: "query", required: false, schema: { type: "string" }, example: "openrouter/anthropic/claude-opus-5.5" },
            { name: "provider", in: "query", required: false, schema: { type: "string" } },
            { name: "model", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: {
            200: ok("Entry", object),
            304: { description: "Not modified" },
            400: errorResponse("Parameters missing or not valid"),
            404: errorResponse("No such entry"),
          },
        },
      },
      "/api/v1/openapi.json": { get: { summary: "This document", responses: { 200: ok("OpenAPI 3.1", object) } } },
      "/api.json": {
        get: {
          summary: "Compatibility export",
          description:
            "The merged catalog keyed by provider id, in the models.dev v2 structure, with no envelope. Added entries may lack fields that models.dev requires; every entry carries `providers_dev`. The dataset version is in the X-Dataset-Version header.",
          responses: { 200: ok("Provider-keyed catalog", object) },
        },
      },
    },
    components: {
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string", examples: ["invalid_parameters", "provider_not_found", "entry_not_found", "method_not_allowed", "not_found"] },
                message: { type: "string" },
                details: {},
              },
            },
          },
        },
        Meta: {
          type: "object",
          required: ["api_version", "dataset_version", "generated_at", "upstream", "counts"],
          additionalProperties: true,
          properties: {
            api_version: { const: "v1" },
            schema_version: { type: "integer" },
            upstream_schema: { type: "string" },
            dataset_version: { type: "string", description: "A hash of the published data. Changes only when the data does." },
            generated_at: { type: "string", format: "date-time" },
            upstream: { type: "object", additionalProperties: true },
            counts: { type: "object", additionalProperties: { type: "integer" } },
            sync: { type: "object", additionalProperties: true },
            issues: { type: "array", items: object },
            exclusions: { type: "array", items: object },
          },
        },
        EntrySummary: {
          type: "object",
          required: ["ref", "provider", "model", "name", "access", "origin", "cache", "cache_modes", "cache_ttl_s", "evaluations"],
          properties: {
            ref: { type: "string", description: "provider/model" },
            provider: { type: "string" },
            model: { type: "string" },
            name: { type: "string" },
            type: { type: "string" },
            family: { type: "string" },
            canonical_id: { type: "string" },
            status: { type: "string" },
            release_date: { type: "string" },
            access: { enum: ["api", "subscription", "unknown"] },
            origin: { enum: ["upstream", "modified", "added"] },
            context: { type: "integer", description: "Tokens. Absent = unknown." },
            input: { type: "integer", description: "Tokens. Absent = not stated separately." },
            max_output: { type: "integer", description: "Tokens. Absent = unknown." },
            price_in: { type: "number", description: "List price of input in US dollars per million tokens (cost.text.input.price), before changes by context size or service tier. Absent = unknown. 0 on a plan or subscription entry means no price per token, not free." },
            price_out: { type: "number", description: "The same for output (cost.text.output.price)." },
            price_from: { type: "string", description: "Present where the price is inherited: the ref of the API entry whose list price this is. The entry itself is a subscription and is not paid per token." },
            cache: { enum: ["yes", "no", "unknown"] },
            cache_modes: { type: "array", items: { enum: ["implicit", "explicit"] } },
            cache_ttl_s: { type: "array", items: { type: "number" }, description: "Documented lifetimes in seconds." },
            evaluations: { type: "integer" },
            measured_warm_min_s: { type: "number" },
            measured_warm_max_s: { type: "number" },
            measured_cache: {
              type: "array",
              description: "The cache evaluations of this entry taken together, by age, across the clients they were sent through. One item per cache lifetime the requests asked for; the item without `asked` is the provider's default.",
              items: {
                type: "object",
                required: ["evaluations", "bands"],
                properties: {
                  asked: { type: "string", description: "The lifetime the requests asked for (ttl or prompt_cache_retention), for example 1h. Absent = none asked." },
                  evaluations: { type: "integer" },
                  bands: {
                    type: "array",
                    description: "One item per age band with at least one check. A band holds the checks up to up_to_s and above the band before it.",
                    items: {
                      type: "object",
                      required: ["up_to_s", "warm", "total"],
                      properties: {
                        up_to_s: { type: "integer", description: "The upper age of the band, in seconds: 300, 900, 1800, 3600, 7200, 14400, 28800, 43200 or 86400." },
                        warm: { type: "integer", description: "Re-sends served from the cache." },
                        total: { type: "integer", description: "Re-sends made." },
                      },
                    },
                  },
                },
              },
            },
            measured_limits: { type: "integer" },
            measured_input_accepted: { type: "integer", description: "Tokens. The largest input an evaluation saw accepted on this entry: the real input limit is at least this. Useful where no limit is documented." },
            measured_input_refused: { type: "integer", description: "Tokens. The smallest input an evaluation saw refused: the real input limit is below this." },
            overridden_fields: { type: "array", items: { type: "string" } },
            verified: { type: "string", format: "date", description: "Newest date of providers.dev evidence. Imported entries have none." },
            shard: { type: "integer" },
          },
        },
      },
    },
  };
}
