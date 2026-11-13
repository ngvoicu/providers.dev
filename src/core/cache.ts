// Prompt caching as the API reports it: what is documented, what a request can ask for (retention), and what
// evaluations measured. Everything a page shows about cache evaluations is made here, at build time, and published.
// A page formats these values; it does not add them up, work out a percentage or decide what is supported.
// No dependencies beyond the JSON helpers: this file also runs in the browser.
import { isObject, type Json, type JsonObject } from "./merge.ts";

/**
 * The ages every summary table has a column for, in seconds since the prompt was cached: the ladder every
 * evaluation follows (2.5, 5 and 7.5 minutes, then on to 2 hours; 4, 8, 12 and 24 hours where the cache lasts).
 * The control ("at once", age 0) comes before them. Results at other ages are published too, at their exact age.
 */
export const CACHE_AGES_S = [150, 300, 450, 600, 900, 1200, 1500, 1800, 2400, 3000, 3600, 4500, 5400, 7200, 14400, 28800, 43200, 86400] as const;

export type CacheSupport = "yes" | "no" | "unknown";
export type CacheMode = "implicit" | "explicit";
/** short = the cache a request gets without asking for a lifetime, or with the shortest one; long = a longer lifetime it asked for. */
export type RetentionProfile = "short" | "long";
export const RETENTION_PROFILES = ["short", "long"] as const;

export interface CacheResult {
  /** control = the prompt sent again at once, to show it was cached at all; timed = sent again at `age_s`. */
  kind: "control" | "timed";
  /** Seconds since the prompt was cached. 0 for the control. Exact: 450 (7.5 min) is never folded into 600. */
  age_s: number;
  /** Re-sends served from the cache. */
  hits: number;
  /** Re-sends made. Always at least 1: an age nobody checked has no result. */
  checks: number;
  /** hits / checks, in percent, two decimals. */
  hit_rate_pct: number;
}

/** One line of an entry's summary table: every evaluation that used the same retention setting, added up by exact age. */
export interface CacheSummaryRow {
  retention_profile: RetentionProfile;
  /** The request field that asked for the lifetime, for example `cache_control.ttl`. Null = no lifetime was asked for. */
  parameter: string | null;
  /** The value sent in it, for example `1h`. Null with `parameter`. */
  value: string | null;
  /** How many evaluations the line adds up. 0 = this setting was not evaluated. */
  evaluations: number;
  /** Their ids, as in `evaluations[].id` of the entry and in /api/v1/evaluations. */
  evaluation_ids: string[];
  /** The date of the newest of them. Null when not evaluated. */
  last_date: string | null;
  /** Null = not evaluated. That is not 0 %. */
  results: CacheResult[] | null;
}

export interface CacheEvaluation {
  id: string;
  route: string;
  route_label: string;
  client: string;
  client_label: string;
  date: string;
  /** What the evaluation's requests were sent with, as recorded: format, reasoning effort, lifetime and so on. */
  request_settings: JsonObject;
  retention_profile: RetentionProfile;
  parameter: string | null;
  value: string | null;
  results: CacheResult[];
  /** Checks left out because they ran too late for their age. */
  late_excluded?: number;
  note?: string;
  /** The raw result. */
  source: string;
}

export interface RetentionEvidence {
  kind: "documented" | "measured";
  url: string;
  /** Null where the source carries no date. */
  date: string | null;
  note: string;
}

/** What a request can do about the cache lifetime on this entry. The same fields on every entry. */
export interface CacheRetention {
  /** supported = the access method accepts a lifetime from the request; unsupported = it does not; unknown = no source says. */
  support: "supported" | "unsupported" | "unknown";
  /** The request field, and where in the request it goes. Null = not known. */
  parameter: { name: string; location: string } | null;
  /** Values the access method is documented to accept, or accepted in an evaluation. Null = not known. */
  accepted_values: string[] | null;
  /** The lifetime a request gets when it leaves the parameter out. Null = not known. */
  default: string | null;
  /** Which value gives which profile. A null value = leave the parameter out. Empty = not known. */
  profiles: { profile: RetentionProfile; value: string | null }[];
  /** Restrictions: a client, a protocol, a header. */
  conditions: string[];
  evidence: RetentionEvidence[];
}

/** `providers_dev.cache` of an entry. */
export interface EntryCache {
  retention: CacheRetention;
  /** The summary table. Null = no evaluation on this entry. */
  results: CacheSummaryRow[] | null;
  evaluations: CacheEvaluation[];
}

const UNIT_SECONDS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 };

/** "5m" -> 300. Returns undefined for anything that is not a models.dev duration. */
export function durationSeconds(value: unknown): number | undefined {
  const match = typeof value === "string" ? /^(\d+)(ms|s|m|h|d)$/.exec(value) : null;
  if (!match) return undefined;
  return Number(match[1]) * (UNIT_SECONDS[match[2] as string] as number);
}

export interface CacheFacts {
  cache: CacheSupport;
  cache_modes: CacheMode[];
  /** Cache lifetimes the provider documents, in seconds, shortest first. */
  cache_ttl_s: number[];
  /** The documented lifetimes of each mode, in seconds. A mode with no documented lifetime has no key. */
  cache_ttl_by_mode_s?: Partial<Record<CacheMode, number[]>>;
}

/** Documented caching, from `capabilities.cache` as models.dev records it. */
export function cacheFacts(model: JsonObject): CacheFacts {
  const capabilities = isObject(model.capabilities) ? model.capabilities : {};
  const cache = capabilities.cache;
  // models.dev: a missing `cache` says nothing; `false` says the entry does not cache.
  if (cache === false) return { cache: "no", cache_modes: [], cache_ttl_s: [] };
  if (!isObject(cache)) return { cache: "unknown", cache_modes: [], cache_ttl_s: [] };
  const modes: CacheMode[] = [];
  const ttl = new Set<number>();
  const byMode: Partial<Record<CacheMode, number[]>> = {};
  for (const mode of ["implicit", "explicit"] as const) {
    const value = cache[mode];
    if (value === undefined) continue;
    modes.push(mode);
    if (isObject(value) && Array.isArray(value.ttl)) {
      const own = new Set<number>();
      for (const item of value.ttl) {
        const seconds = durationSeconds(item);
        if (seconds !== undefined) own.add(seconds);
      }
      for (const seconds of own) ttl.add(seconds);
      if (own.size > 0) byMode[mode] = [...own].sort((a, b) => a - b);
    }
  }
  return {
    cache: modes.length > 0 ? "yes" : "unknown",
    cache_modes: modes,
    cache_ttl_s: [...ttl].sort((a, b) => a - b),
    ...(Object.keys(byMode).length > 0 ? { cache_ttl_by_mode_s: byMode } : {}),
  };
}

/** The documented lifetimes as written in the source ("5m", "1h"), shortest first. */
function documentedLifetimes(model: JsonObject): string[] {
  const capabilities = isObject(model.capabilities) ? model.capabilities : {};
  const cache = capabilities.cache;
  if (!isObject(cache)) return [];
  const found = new Map<string, number>();
  for (const mode of ["implicit", "explicit"] as const) {
    const value = cache[mode];
    if (!isObject(value) || !Array.isArray(value.ttl)) continue;
    for (const item of value.ttl) {
      const seconds = durationSeconds(item);
      if (typeof item === "string" && seconds !== undefined) found.set(item, seconds);
    }
  }
  return [...found].sort((a, b) => a[1] - b[1]).map(([text]) => text);
}

/**
 * The evaluation settings that ask for a cache lifetime, and the request field each one stands for.
 * `ttl` is how the evaluation tool names the lifetime of a cache marker.
 */
const LIFETIME_SETTINGS: Record<string, { name: string; location: string }> = {
  ttl: { name: "cache_control.ttl", location: "Request body, in each cache_control marker" },
  prompt_cache_retention: { name: "prompt_cache_retention", location: "Request body, top level" },
};

/** The lifetime an evaluation's requests asked for. Null = none: they left it to the provider. */
export function lifetimeAsked(settings: JsonObject | undefined): { parameter: string; location: string; value: string } | null {
  for (const [setting, field] of Object.entries(LIFETIME_SETTINGS)) {
    const value = settings?.[setting];
    if (typeof value === "string" && value) return { parameter: field.name, location: field.location, value };
  }
  return null;
}

/** No lifetime asked, or the shortest documented one: short. Any other lifetime asked: long. */
export function profileOf(value: string | null, model: JsonObject): RetentionProfile {
  if (value === null) return "short";
  return documentedLifetimes(model)[0] === value ? "short" : "long";
}

/** hits of checks as one result. The percentage is worked out here and nowhere else. */
export function cacheResult(kind: CacheResult["kind"], ageS: number, hits: number, checks: number): CacheResult {
  return { kind, age_s: ageS, hits, checks, hit_rate_pct: Math.round((hits / checks) * 10000) / 100 };
}

/** Results of several evaluations added up, age by age. Ages stay exact; the control comes first. */
export function addResults(lists: readonly (readonly CacheResult[])[]): CacheResult[] {
  const sums = new Map<string, { kind: CacheResult["kind"]; age_s: number; hits: number; checks: number }>();
  for (const list of lists) {
    for (const item of list) {
      const key = `${item.kind}:${item.age_s}`;
      const sum = sums.get(key) ?? { kind: item.kind, age_s: item.age_s, hits: 0, checks: 0 };
      sum.hits += item.hits;
      sum.checks += item.checks;
      sums.set(key, sum);
    }
  }
  return [...sums.values()]
    .sort((a, b) => (a.kind === b.kind ? a.age_s - b.age_s : a.kind === "control" ? -1 : 1))
    .map((sum) => cacheResult(sum.kind, sum.age_s, sum.hits, sum.checks));
}

const emptyRow = (profile: RetentionProfile): CacheSummaryRow => ({
  retention_profile: profile,
  parameter: null,
  value: null,
  evaluations: 0,
  evaluation_ids: [],
  last_date: null,
  results: null,
});

/**
 * The summary table of an entry: one line per retention setting, short before long. An entry with evaluations always
 * has a short line and at least one long line; a setting nobody evaluated has `results: null`. Null = no evaluation at all.
 */
export function summarizeCache(evaluations: readonly CacheEvaluation[]): CacheSummaryRow[] | null {
  if (evaluations.length === 0) return null;
  const groups = new Map<string, CacheEvaluation[]>();
  for (const evaluation of evaluations) {
    const key = JSON.stringify([evaluation.retention_profile, evaluation.parameter, evaluation.value]);
    groups.set(key, [...(groups.get(key) ?? []), evaluation]);
  }
  const rows = [...groups.values()].map((members): CacheSummaryRow => {
    const first = members[0] as CacheEvaluation;
    return {
      retention_profile: first.retention_profile,
      parameter: first.parameter,
      value: first.value,
      evaluations: members.length,
      evaluation_ids: members.map((member) => member.id).sort(),
      last_date: members.map((member) => member.date).sort().at(-1) ?? null,
      results: addResults(members.map((member) => member.results)),
    };
  });
  for (const profile of RETENTION_PROFILES) if (!rows.some((row) => row.retention_profile === profile)) rows.push(emptyRow(profile));
  const rank = (row: CacheSummaryRow): number => (row.retention_profile === "short" ? 0 : 1) * 2 + (row.value === null ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b) || (durationSeconds(a.value) ?? 0) - (durationSeconds(b.value) ?? 0) || String(a.value).localeCompare(String(b.value)));
}

/**
 * What a request can do about the cache lifetime on this entry, from what is documented and what evaluations sent.
 * Nothing is assumed: an entry no source speaks about is `unknown`.
 * - The source documents more than one lifetime: supported, with those values.
 * - An evaluation sent a lifetime and the control was served from the cache: the access method accepts that value.
 *   That is acceptance, not a promise: what lifetime it then gives is in the results.
 * - The source says the entry does not cache: unsupported.
 */
export function retentionOf(model: JsonObject, evaluations: readonly CacheEvaluation[], documentedOn: string | null): CacheRetention {
  const facts = cacheFacts(model);
  if (facts.cache === "no") {
    return {
      support: "unsupported",
      parameter: null,
      accepted_values: null,
      default: null,
      profiles: [],
      conditions: ["The source says this entry does not cache prompts."],
      evidence: [{ kind: "documented", url: "https://models.dev", date: documentedOn, note: "capabilities.cache is false in models.dev." }],
    };
  }
  const documented = documentedLifetimes(model);
  const evidence: RetentionEvidence[] = [];
  const values = new Map<string, number>();
  let parameter: CacheRetention["parameter"] = null;
  if (documented.length > 1) {
    for (const value of documented) values.set(value, durationSeconds(value) ?? 0);
    evidence.push({ kind: "documented", url: "https://models.dev", date: documentedOn, note: `models.dev lists the lifetimes ${documented.join(" and ")} in capabilities.cache.` });
  }
  for (const evaluation of evaluations) {
    const asked = lifetimeAsked(evaluation.request_settings);
    const control = evaluation.results.find((item) => item.kind === "control");
    if (!asked || !control || control.hits === 0) continue;
    parameter ??= { name: asked.parameter, location: asked.location };
    values.set(asked.value, durationSeconds(asked.value) ?? 0);
    evidence.push({ kind: "measured", url: evaluation.source, date: evaluation.date, note: `A request with ${asked.parameter}=${asked.value} was accepted and cached (${evaluation.client_label}).` });
  }
  if (values.size === 0) return { support: "unknown", parameter: null, accepted_values: null, default: null, profiles: [], conditions: [], evidence: [] };
  const accepted = [...values].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([value]) => value);
  return {
    support: "supported",
    parameter,
    accepted_values: accepted,
    default: null,
    profiles: [{ profile: "short", value: null }, ...accepted.map((value) => ({ profile: profileOf(value, model), value }))],
    conditions: [],
    evidence,
  };
}

/** The settings of an evaluation in one line: `format=messages, ttl=1h`. */
export function settingsText(settings: JsonObject | undefined): string {
  return Object.entries(settings ?? {})
    .map(([key, value]: [string, Json]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
}
