// One query language for the entry list. The website's URL, /api/v1/entries and the tests all go through
// parseQuery() and runQuery(), so a filter means the same thing everywhere.
import type { Summary } from "./entries.ts";

export const SORT_KEYS = ["provider", "model", "name", "context", "max_output", "price_in", "price_out", "release_date", "verified", "cache_short", "cache_long", "input_window"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

/** The order the website opens with: entries with providers.dev evidence first, newest first. The API's default is by provider. */
export const SITE_DEFAULT = "sort=verified&order=desc";

export const MAX_LIMIT = 200;
export const MAX_AGE_MONTHS = 600;
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
  lifetime_basis?: string[];
  min_context?: number;
  min_output?: number;
  min_input_window?: number;
  max_age_months?: number;
  evaluated?: boolean;
  disagree?: boolean;
  sort: SortKey;
  order: "asc" | "desc";
  limit: number;
  offset: number;
}

export interface ParamDoc<Name extends string = string> {
  name: Name;
  kind: "text" | "list" | "integer" | "boolean" | "enum";
  values?: readonly string[];
  description: string;
}

/** The single description of every query parameter of the entry list: validation, the OpenAPI document and the docs page read it. */
export const PARAMS: ParamDoc<keyof Query & string>[] = [
  { name: "q", kind: "text", description: "Words to find in the provider id or name, the model id or name, the family or the canonical id. Every word must match." },
  { name: "provider", kind: "list", description: "Provider ids, comma-separated. An entry matches any of them." },
  { name: "family", kind: "text", description: "Exact model family, for example claude-opus." },
  { name: "canonical_id", kind: "text", description: "Exact canonical model, for example anthropic/claude-opus-5-5: every access method to that model." },
  { name: "type", kind: "list", description: "Model types, comma-separated, for example chat or embedding." },
  { name: "access", kind: "list", values: ["api", "subscription", "unknown"], description: "How the provider is reached: an API key billed by use, a subscription login or plan, or not classified." },
  { name: "origin", kind: "list", values: ["upstream", "modified", "added"], description: "upstream = as imported from models.dev; modified = imported, with providers.dev corrections or evaluations; added = an entry models.dev does not have." },
  { name: "cache", kind: "list", values: ["yes", "no", "unknown"], description: "Prompt caching as documented. unknown means the source says nothing, which is not the same as no." },
  { name: "cache_mode", kind: "list", values: ["implicit", "explicit"], description: "implicit = the provider caches on its own; explicit = the request marks what to cache." },
  { name: "lifetime_basis", kind: "list", values: ["documented", "measured"], description: "The basis of the safe cache lifetime (cache_lifetime.short.basis, cache_lifetime.long.basis). An entry matches when the basis of its short or of its long profile is one of the values. An entry with no safe lifetime in either profile (basis none) does not match." },
  { name: "min_context", kind: "integer", description: "Smallest context window, in tokens, that this provider exposes for the model (limit.context). Entries with an unknown window do not match." },
  { name: "min_output", kind: "integer", description: "Smallest maximum response size, in tokens: the safe maximum output (max_output, safe.max_output.value). A maximum, not a default. Entries with an unknown maximum do not match." },
  { name: "min_input_window", kind: "integer", description: "Smallest safe input window, in tokens (safe.input_window.value, the same as input_window.tokens): the most input one request can carry. Entries with an unknown input window do not match. Since 1.4.0." },
  { name: "max_age_months", kind: "integer", description: `Only models released in the last N months, counted back from today (UTC), 1 to ${MAX_AGE_MONTHS}. A release date given only to the month counts when that month is in range. Entries with an unknown release date do not match.` },
  { name: "evaluated", kind: "boolean", description: "true = only entries with providers.dev cache evaluations; false = only entries without." },
  { name: "disagree", kind: "boolean", description: "true = only entries where the sources of at least one safe value contradict each other (safe.differing is not empty: the website shows a warning); false = only the others. Since 1.4.0." },
  { name: "sort", kind: "enum", values: SORT_KEYS, description: "Sort key. cache_short and cache_long sort by the safe cache lifetime in seconds, cache_lifetime.short.safe_s and cache_lifetime.long.safe_s; 0 is a value. input_window sorts by the safe input window, safe.input_window.value; max_output by the safe maximum output; context by limit.context. Ties are broken by provider id, then model id. Entries with no value for the key (null) come last in either order." },
  { name: "order", kind: "enum", values: ["asc", "desc"], description: "Sort direction." },
  { name: "limit", kind: "integer", description: `Entries per page, 1 to ${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.` },
  { name: "offset", kind: "integer", description: "Entries to skip. Default 0." },
];

const PAGING: ParamDoc[] = [
  { name: "limit", kind: "integer", description: `Items per page, 1 to ${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.` },
  { name: "offset", kind: "integer", description: "Items to skip. Default 0." },
];
/** The parameters of the other lists. Every list pages the same way. */
export const PROVIDER_PARAMS: ParamDoc[] = [
  { name: "q", kind: "text", description: "Words to find in the provider's id or name. Every word must match." },
  { name: "access", kind: "list", values: ["api", "subscription", "unknown"], description: "How the provider is reached." },
  { name: "origin", kind: "list", values: ["upstream", "added"], description: "upstream = imported from models.dev; added = a provider models.dev does not list." },
  ...PAGING,
];
export const MODEL_PARAMS: ParamDoc[] = [
  { name: "q", kind: "text", description: "Words to find in the model's id or name. Every word must match." },
  { name: "lab", kind: "text", description: "Exact lab, the first part of the id, for example anthropic." },
  ...PAGING,
];
const EVALUATION_FILTERS: ParamDoc[] = [
  { name: "provider", kind: "list", description: "Provider ids, comma-separated." },
  { name: "entry", kind: "text", description: "Exact entry, provider/model." },
  { name: "client", kind: "list", description: "Client ids, comma-separated, for example direct or cliproxyapi." },
];
export const CACHE_EVALUATION_PARAMS: ParamDoc[] = [
  ...EVALUATION_FILTERS,
  { name: "retention_profile", kind: "enum", values: ["short", "long"], description: "Only evaluations with this retention profile." },
  ...PAGING,
];
export const LIMIT_EVALUATION_PARAMS: ParamDoc[] = [...EVALUATION_FILTERS, ...PAGING];
export const PROVIDER_VIEW_PARAMS: ParamDoc[] = [
  { name: "view", kind: "enum", values: ["summary", "full"], description: "summary (default) = the provider and the summaries of its entries; models is null. full = also every entry in full, under models." },
];
export const CORRECTION_PARAMS: ParamDoc[] = [
  { name: "provider", kind: "text", description: "Exact provider id." },
  ...PAGING,
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
  const parsed = parseParams(params, PARAMS, strict);
  if (!parsed.ok) return parsed;
  return { ok: true, query: { sort: "provider", order: "asc", limit: DEFAULT_LIMIT, offset: 0, ...parsed.values } as unknown as Query };
}

export type ParamsResult = { ok: true; values: Record<string, unknown> } | { ok: false; errors: QueryError[] };

/** Validate query parameters against their description. The same rules for every list of the API. */
export function parseParams(params: URLSearchParams, docs: readonly ParamDoc[], strict = true): ParamsResult {
  const errors: QueryError[] = [];
  const query: Record<string, unknown> = {};
  const known = new Map(docs.map((param) => [param.name as string, param]));
  const seen = new Set<string>();

  for (const [name, raw] of params) {
    const doc = known.get(name);
    if (!doc) {
      if (strict) errors.push({ param: name, message: known.size > 0 ? `Unknown parameter. Allowed: ${[...known.keys()].join(", ")}.` : "Unknown parameter. This endpoint takes none." });
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
      else if (name === "max_age_months" && (number < 1 || number > MAX_AGE_MONTHS)) errors.push({ param: name, message: `Must be between 1 and ${MAX_AGE_MONTHS}.` });
      else query[name] = number;
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values: query };
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

/** The date `months` calendar months before `today` (both YYYY-MM-DD). The 31st counts back to the last day of a shorter month. */
export function monthsBefore(today: string, months: number): string {
  const [year = 0, month = 1, day = 1] = today.split("-").map(Number);
  const index = year * 12 + (month - 1) - months;
  const y = Math.floor(index / 12);
  const m = index - y * 12;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

/** Today in UTC, as YYYY-MM-DD. */
export const utcToday = (): string => new Date().toISOString().slice(0, 10);

function matches(entry: Summary, query: Query, words: string[], releasedSince: string | undefined): boolean {
  // A date known only to the month ("2026-05") is compared at that precision.
  if (releasedSince !== undefined && !(entry.release_date !== null && entry.release_date >= releasedSince.slice(0, entry.release_date.length))) return false;
  if (query.provider && !query.provider.includes(entry.provider)) return false;
  if (query.family && entry.family !== query.family) return false;
  if (query.canonical_id && entry.canonical_id !== query.canonical_id) return false;
  if (query.type && !query.type.includes(entry.type ?? "")) return false;
  if (query.access && !query.access.includes(entry.access)) return false;
  if (query.origin && !query.origin.includes(entry.origin)) return false;
  if (query.cache && !query.cache.includes(entry.cache)) return false;
  if (query.cache_mode && !query.cache_mode.some((mode) => (entry.cache_modes as string[]).includes(mode))) return false;
  if (query.lifetime_basis && !query.lifetime_basis.some((basis) => entry.cache_lifetime.short.basis === basis || entry.cache_lifetime.long.basis === basis)) return false;
  if (query.min_context !== undefined && !(entry.context !== null && entry.context >= query.min_context)) return false;
  if (query.min_output !== undefined && !(entry.max_output !== null && entry.max_output >= query.min_output)) return false;
  if (query.min_input_window !== undefined && !(entry.safe.input_window.value !== null && entry.safe.input_window.value >= query.min_input_window)) return false;
  if (query.evaluated !== undefined && query.evaluated !== entry.evaluation_count > 0) return false;
  if (query.disagree !== undefined && query.disagree !== entry.safe.differing.length > 0) return false;
  if (words.length > 0) {
    const haystack = `${entry.provider} ${entry.model} ${entry.name} ${entry.family ?? ""} ${entry.canonical_id ?? ""}`.toLowerCase();
    if (!words.every((word) => haystack.includes(word))) return false;
  }
  return true;
}

/** The value an entry is sorted by. Null = the entry has none, and comes last in either order. */
function sortValue(entry: Summary, key: SortKey): string | number | null {
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
    case "cache_short":
      return entry.cache_lifetime.short.safe_s;
    case "cache_long":
      return entry.cache_lifetime.long.safe_s;
    case "input_window":
      return entry.safe.input_window.value;
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

/** `today` (YYYY-MM-DD, UTC) is what max_age_months counts back from. Everything else is a pure function of the entries and the query. */
export function runQuery(entries: readonly Summary[], query: Query, today: string = utcToday()): QueryResult {
  const words = (query.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const releasedSince = query.max_age_months === undefined ? undefined : monthsBefore(today, query.max_age_months);
  const found = entries.filter((entry) => matches(entry, query, words, releasedSince));
  const direction = query.order === "desc" ? -1 : 1;
  found.sort((a, b) => {
    const left = sortValue(a, query.sort);
    const right = sortValue(b, query.sort);
    if (left !== right) {
      if (left === null) return 1;
      if (right === null) return -1;
      const result = typeof left === "number" && typeof right === "number" ? left - right : compareText(String(left), String(right));
      if (result !== 0) return result * direction;
    }
    return compareText(a.provider, b.provider) || compareText(a.model, b.model);
  });
  const data = found.slice(query.offset, query.offset + query.limit);
  const next = query.offset + data.length;
  return { total: found.length, limit: query.limit, offset: query.offset, next_offset: next < found.length ? next : null, data };
}
