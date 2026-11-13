// One query language for the entry list. The website's URL, /api/v1/models and the tests all go through
// parseQuery() and runQuery(), so a filter means the same thing everywhere.
import type { Summary } from "./entries.ts";

export const SORT_KEYS = ["provider", "model", "name", "context", "max_output", "price_in", "price_out", "release_date", "verified"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

/** The order the website opens with: entries with providers.dev evidence first, newest first. The API's default is by provider. */
export const SITE_DEFAULT = "sort=verified&order=desc";

export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 50;

export interface Query {
  q?: string;
  provider?: string[];
  family?: string;
  canonical_id?: string;
  type?: string[];
  access?: string[];
  origin?: string[];
  cache?: string[];
  cache_mode?: string[];
  min_context?: number;
  min_output?: number;
  measured?: boolean;
  sort: SortKey;
  order: "asc" | "desc";
  limit: number;
  offset: number;
}

interface ParamDoc {
  name: keyof Query;
  kind: "text" | "list" | "integer" | "boolean" | "enum";
  values?: readonly string[];
  description: string;
}

/** The single description of every query parameter: validation, the OpenAPI document and the docs page read it. */
export const PARAMS: ParamDoc[] = [
  { name: "q", kind: "text", description: "Words to find in the provider id or name, the model id or name, the family or the canonical id. Every word must match." },
  { name: "provider", kind: "list", description: "Provider ids, comma-separated. An entry matches any of them." },
  { name: "family", kind: "text", description: "Exact model family, for example claude-opus." },
  { name: "canonical_id", kind: "text", description: "Exact canonical model, for example anthropic/claude-opus-5-5: every access method to that model." },
  { name: "type", kind: "list", description: "Model types, comma-separated, for example chat or embedding." },
  { name: "access", kind: "list", values: ["api", "subscription", "unknown"], description: "How the provider is reached: an API key billed by use, a subscription login or plan, or not classified." },
  { name: "origin", kind: "list", values: ["upstream", "modified", "added"], description: "upstream = as imported from models.dev; modified = imported, with providers.dev corrections or evaluations; added = an entry models.dev does not have." },
  { name: "cache", kind: "list", values: ["yes", "no", "unknown"], description: "Prompt caching as documented. unknown means the source says nothing, which is not the same as no." },
  { name: "cache_mode", kind: "list", values: ["implicit", "explicit"], description: "implicit = the provider caches on its own; explicit = the request marks what to cache." },
  { name: "min_context", kind: "integer", description: "Smallest context window, in tokens, that this provider exposes for the model (limit.context). Entries with an unknown window do not match." },
  { name: "min_output", kind: "integer", description: "Smallest maximum response size, in tokens (limit.output). A maximum, not a default. Entries with an unknown maximum do not match." },
  { name: "measured", kind: "boolean", description: "true = only entries with providers.dev cache evaluations; false = only entries without." },
  { name: "sort", kind: "enum", values: SORT_KEYS, description: "Sort key. Ties are broken by provider id, then model id. Entries with no value for the key come last in either order." },
  { name: "order", kind: "enum", values: ["asc", "desc"], description: "Sort direction." },
  { name: "limit", kind: "integer", description: `Entries per page, 1 to ${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.` },
  { name: "offset", kind: "integer", description: "Entries to skip. Default 0." },
];

export interface QueryError {
  param: string;
  message: string;
}

export type ParseResult = { ok: true; query: Query } | { ok: false; errors: QueryError[] };

/**
 * Validate query parameters. `strict` rejects names that are not query parameters (the API);
 * the website passes false so that unrelated URL parameters are ignored.
 */
export function parseQuery(params: URLSearchParams, strict = true): ParseResult {
  const errors: QueryError[] = [];
  const query: Record<string, unknown> = { sort: "provider", order: "asc", limit: DEFAULT_LIMIT, offset: 0 };
  const known = new Map(PARAMS.map((param) => [param.name as string, param]));
  const seen = new Set<string>();

  for (const [name, raw] of params) {
    const doc = known.get(name);
    if (!doc) {
      if (strict) errors.push({ param: name, message: `Unknown parameter. Allowed: ${[...known.keys()].join(", ")}.` });
      continue;
    }
    if (seen.has(name)) {
      errors.push({ param: name, message: "Given more than once. Use one comma-separated value." });
      continue;
    }
    seen.add(name);
    const value = raw.trim();
    if (value === "") continue;

    if (doc.kind === "text") {
      if (value.length > 200) errors.push({ param: name, message: "Longer than 200 characters." });
      else query[name] = value;
    } else if (doc.kind === "list") {
      const items = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
      const bad = doc.values ? items.filter((item) => !doc.values?.includes(item)) : [];
      if (bad.length > 0) errors.push({ param: name, message: `Not allowed: ${bad.join(", ")}. Allowed: ${doc.values?.join(", ")}.` });
      else if (items.length > 50) errors.push({ param: name, message: "More than 50 values." });
      else query[name] = items;
    } else if (doc.kind === "enum") {
      if (!doc.values?.includes(value)) errors.push({ param: name, message: `Must be one of: ${doc.values?.join(", ")}.` });
      else query[name] = value;
    } else if (doc.kind === "boolean") {
      if (value !== "true" && value !== "false") errors.push({ param: name, message: "Must be true or false." });
      else query[name] = value === "true";
    } else {
      const number = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      if (!Number.isSafeInteger(number)) errors.push({ param: name, message: "Must be a whole number, 0 or more." });
      else if (name === "limit" && (number < 1 || number > MAX_LIMIT)) errors.push({ param: name, message: `Must be between 1 and ${MAX_LIMIT}.` });
      else query[name] = number;
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, query: query as unknown as Query };
}

/** The canonical query string of a query: defaults left out, fixed order. Used for URLs and ETags. */
export function serializeQuery(query: Partial<Query>): string {
  const out = new URLSearchParams();
  for (const { name } of PARAMS) {
    const value = query[name];
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) continue;
    if (name === "sort" && value === "provider") continue;
    if (name === "order" && value === "asc") continue;
    if (name === "limit" && value === DEFAULT_LIMIT) continue;
    if (name === "offset" && value === 0) continue;
    out.set(name, Array.isArray(value) ? value.join(",") : String(value));
  }
  return out.toString();
}

function matches(entry: Summary, query: Query, words: string[]): boolean {
  if (query.provider && !query.provider.includes(entry.provider)) return false;
  if (query.family && entry.family !== query.family) return false;
  if (query.canonical_id && entry.canonical_id !== query.canonical_id) return false;
  if (query.type && !query.type.includes(entry.type ?? "")) return false;
  if (query.access && !query.access.includes(entry.access)) return false;
  if (query.origin && !query.origin.includes(entry.origin)) return false;
  if (query.cache && !query.cache.includes(entry.cache)) return false;
  if (query.cache_mode && !query.cache_mode.some((mode) => (entry.cache_modes as string[]).includes(mode))) return false;
  if (query.min_context !== undefined && !(entry.context !== undefined && entry.context >= query.min_context)) return false;
  if (query.min_output !== undefined && !(entry.max_output !== undefined && entry.max_output >= query.min_output)) return false;
  if (query.measured !== undefined && query.measured !== entry.evaluations > 0) return false;
  if (words.length > 0) {
    const haystack = `${entry.provider} ${entry.model} ${entry.name} ${entry.family ?? ""} ${entry.canonical_id ?? ""}`.toLowerCase();
    if (!words.every((word) => haystack.includes(word))) return false;
  }
  return true;
}

function sortValue(entry: Summary, key: SortKey): string | number | undefined {
  switch (key) {
    case "provider":
      return entry.provider;
    case "model":
      return entry.model;
    case "name":
      return entry.name.toLowerCase();
    case "context":
      return entry.context;
    case "max_output":
      return entry.max_output;
    case "price_in":
      return entry.price_in;
    case "price_out":
      return entry.price_out;
    case "release_date":
      return entry.release_date;
    case "verified":
      return entry.verified;
  }
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface QueryResult {
  total: number;
  limit: number;
  offset: number;
  next_offset: number | null;
  data: Summary[];
}

export function runQuery(entries: readonly Summary[], query: Query): QueryResult {
  const words = (query.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const found = entries.filter((entry) => matches(entry, query, words));
  const direction = query.order === "desc" ? -1 : 1;
  found.sort((a, b) => {
    const left = sortValue(a, query.sort);
    const right = sortValue(b, query.sort);
    if (left !== right) {
      if (left === undefined) return 1;
      if (right === undefined) return -1;
      const result = typeof left === "number" && typeof right === "number" ? left - right : compareText(String(left), String(right));
      if (result !== 0) return result * direction;
    }
    return compareText(a.provider, b.provider) || compareText(a.model, b.model);
  });
  const data = found.slice(query.offset, query.offset + query.limit);
  const next = query.offset + data.length;
  return { total: found.length, limit: query.limit, offset: query.offset, next_offset: next < found.length ? next : null, data };
}
