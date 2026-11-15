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
export type Support = "supported" | "unsupported" | "unknown";

export interface CacheModeDocumentation {
  support: Support;
  ttl: string[] | null;
  min_tokens: number | null;
  max_breakpoints: number | null;
  targets: string[] | null;
}

/** Normalized once for both the API and the website. An absent mode remains unknown. */
export interface CacheDocumentation {
  support: Support;
  modes: Record<CacheMode, CacheModeDocumentation>;
}
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
  /** Their ids, as in `evaluations[].id` of the entry and in /api/v1/evaluations/cache. */
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
  /** Checks left out because they ran too late for their age. Null = the evaluation does not record it. */
  late_excluded: number | null;
  note: string | null;
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
  /** Values explicitly confirmed by the evidence. Sending a value is not confirmation. Null = not known. */
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
  documented: CacheDocumentation;
  retention: CacheRetention;
  /** Every lifetime known for the entry, documented or measured, and the safe value of each retention profile. */
  lifetime: CacheLifetimeRecord;
  /** The summary table. Null = no evaluation on this entry. */
  results: CacheSummaryRow[] | null;
  evaluations: CacheEvaluation[];
}

/** Who a lifetime is from: models.dev's documentation as imported, or providers.dev (a correction, an added entry, a measurement). */
export type LifetimeSource = "providers.dev" | "models.dev";

/**
 * One lifetime of an entry: documented by a source, or measured for one client with one retention setting. One shape
 * for both kinds; a key that does not apply to the kind is null, 0 or [].
 */
export interface CacheLifetimeItem {
  retention_profile: RetentionProfile;
  basis: "measured" | "documented";
  source: LifetimeSource;
  /** Documented: the import date (models.dev) or the newest evidence date (providers.dev). Measured: the newest of its evaluations. */
  date: string | null;
  /** Documented: the lifetime in seconds, 0 on the "does not cache" item. Measured: the oldest age through which every check of every one of its evaluations hit, 0 = none. */
  lifetime_s: number;
  // what a documented item has; null on a measured one
  mode: CacheMode | null;
  documented_as: string | null;
  // what a measured item has; null, 0 or [] on a documented one
  client: string | null;
  client_label: string | null;
  parameter: string | null;
  value: string | null;
  evaluations: number;
  evaluation_ids: string[];
  checks: number;
  hits: number;
  tested_from_s: number | null;
  first_miss_s: number | null;
  results: CacheResult[] | null;
}

/** The safe lifetime of an entry for one retention profile, and what it was chosen from. */
export interface SafeLifetime {
  /** Seconds a cached prompt can be relied on: `documented_s` unless an evaluation contradicts it, else `measured_s`. Null = not known. */
  safe_s: number | null;
  basis: "measured" | "documented" | "none";
  source: LifetimeSource | null;
  date: string | null;
  documented_s: number | null;
  measured_s: number | null;
  clients: number;
  evaluations: number;
  checks: number;
  hits: number;
  checks_inside: number | null;
  hits_inside: number | null;
  tested_from_s: number | null;
  first_miss_s: number | null;
}

/** `providers_dev.cache.lifetime` of an entry and `cache_lifetime` of a summary. */
export interface CacheLifetimeRecord {
  short: SafeLifetime;
  long: SafeLifetime;
  lifetimes: CacheLifetimeItem[];
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
  cache_mode_support: Record<CacheMode, Support>;
  /** Cache lifetimes the provider documents, in seconds, shortest first. */
  cache_ttl_s: number[];
  /** The documented lifetimes of each mode, in seconds, shortest first. Null = no lifetime is documented for the mode. */
  cache_ttl_by_mode_s: Record<CacheMode, number[] | null>;
}

/** Missing fields stay unknown, including a mode omitted from an otherwise populated cache object. */
export function documentedCache(model: JsonObject): CacheDocumentation {
  const capabilities = isObject(model.capabilities) ? model.capabilities : {};
  const cache = capabilities.cache;
  const mode = (name: CacheMode): CacheModeDocumentation => {
    const value = isObject(cache) ? cache[name] : undefined;
    const support = cache === false || value === false ? "unsupported" : value === true || isObject(value) ? "supported" : "unknown";
    const detail = isObject(value) ? value : {};
    return {
      support,
      ttl: Array.isArray(detail.ttl) ? detail.ttl.filter((item): item is string => typeof item === "string") : null,
      min_tokens: typeof detail.min_tokens === "number" ? detail.min_tokens : null,
      max_breakpoints: typeof detail.max_breakpoints === "number" ? detail.max_breakpoints : null,
      targets: Array.isArray(detail.targets) ? detail.targets.filter((item): item is string => typeof item === "string") : null,
    };
  };
  const modes = { implicit: mode("implicit"), explicit: mode("explicit") };
  const states = Object.values(modes).map((item) => item.support);
  return { support: states.includes("supported") ? "supported" : states.every((state) => state === "unsupported") ? "unsupported" : "unknown", modes };
}

/** The compact API fields are a projection of the full entry's published documentation. */
export function cacheFacts(documented: CacheDocumentation): CacheFacts {
  const modes: CacheMode[] = [];
  const ttl = new Set<number>();
  const byMode: Record<CacheMode, number[] | null> = { implicit: null, explicit: null };
  for (const mode of ["implicit", "explicit"] as const) {
    const value = documented.modes[mode];
    if (value.support !== "supported") continue;
    modes.push(mode);
    if (value.ttl) {
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
    cache: documented.support === "supported" ? "yes" : documented.support === "unsupported" ? "no" : "unknown",
    cache_modes: modes,
    cache_mode_support: { implicit: documented.modes.implicit.support, explicit: documented.modes.explicit.support },
    cache_ttl_s: [...ttl].sort((a, b) => a - b),
    cache_ttl_by_mode_s: byMode,
  };
}

/**
 * The documented lifetimes of an entry in whole seconds (`lifetimeSeconds`), one per text of a supported mode's `ttl`
 * that converts, with the mode and the text. The one place the record reads documented lifetimes from.
 */
function documentedSeconds(documented: CacheDocumentation): { mode: CacheMode; text: string; seconds: number }[] {
  const found: { mode: CacheMode; text: string; seconds: number }[] = [];
  for (const mode of ["implicit", "explicit"] as const) {
    const value = documented.modes[mode];
    if (value.support !== "supported" || !value.ttl) continue;
    for (const text of value.ttl) {
      const seconds = lifetimeSeconds(text);
      if (seconds !== undefined) found.push({ mode, text, seconds });
    }
  }
  return found;
}

/** The shortest documented lifetime of an entry in whole seconds: what its short documented items carry. Null = none. */
function shortestDocumentedS(documented: CacheDocumentation): number | null {
  const found = documentedSeconds(documented);
  return found.length > 0 ? Math.min(...found.map((item) => item.seconds)) : null;
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

/**
 * No lifetime asked, or one that comes in whole seconds (`lifetimeSeconds`) to the shortest lifetime the entry
 * documents: short. Any other lifetime asked, one that does not convert included: long. Decided in seconds, so the
 * way a lifetime is written (`60s`, `1m`) and the order of the documented texts do not matter.
 */
export function profileOf(value: string | null, model: JsonObject): RetentionProfile {
  if (value === null) return "short";
  const asked = lifetimeSeconds(value);
  return asked !== undefined && asked === shortestDocumentedS(documentedCache(model)) ? "short" : "long";
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

// ---- The cache lifetime record: every lifetime of an entry in one list, and the safe value of each profile.
// Worked out once, in the data build, from the documented caching and the published evaluations; a page prints it.

/** What one evaluation shows about how long its cache held. */
export interface EvaluationLifetime {
  /** The oldest age through which every check hit, the control included. 0 = none. */
  safe_s: number;
  /** The age of the first result that was not a full hit. 0 = the control missed. Null = no miss. */
  first_miss_s: number | null;
  /** The youngest timed age checked. Null = no timed check. */
  tested_from_s: number | null;
}

/**
 * The strict measured value of one evaluation: walk the control, then the timed results by age, and stop at the
 * first result where not every check hit. Null = the evaluation does not count: it has no timed result and its
 * control (if any) hit, so it says that a prompt is cached and nothing about how long.
 */
export function evaluationLifetime(evaluation: CacheEvaluation): EvaluationLifetime | null {
  const control = evaluation.results.find((result) => result.kind === "control");
  const timed = evaluation.results.filter((result) => result.kind === "timed").sort((a, b) => a.age_s - b.age_s);
  if (timed.length === 0 && !(control && control.hits < control.checks)) return null;
  let safe = 0;
  let firstMiss: number | null = null;
  for (const result of [...(control ? [control] : []), ...timed]) {
    if (result.hits === result.checks) safe = result.age_s;
    else {
      firstMiss = result.age_s;
      break;
    }
  }
  return { safe_s: safe, first_miss_s: firstMiss, tested_from_s: timed[0]?.age_s ?? null };
}

/**
 * Whether one evaluation clearly contradicts a documented lifetime: at an age up to and including it (the control
 * too), fewer than half of the checks hit. Exactly half does not. Nothing contradicts a documented 0.
 */
export function contradicts(evaluation: CacheEvaluation, documentedS: number): boolean {
  if (documentedS <= 0) return false;
  return evaluation.results.some((result) => result.age_s <= documentedS && 2 * result.hits < result.checks);
}

const documentedItem = (profile: RetentionProfile, lifetime: number, mode: CacheMode | null, text: string | null, from: { source: LifetimeSource; date: string | null }): CacheLifetimeItem => ({
  retention_profile: profile,
  basis: "documented",
  source: from.source,
  date: from.date,
  lifetime_s: lifetime,
  mode,
  documented_as: text,
  client: null,
  client_label: null,
  parameter: null,
  value: null,
  evaluations: 0,
  evaluation_ids: [],
  checks: 0,
  hits: 0,
  tested_from_s: null,
  first_miss_s: null,
  results: null,
});

/**
 * The documented items of an entry: one per text of a supported mode's `ttl` that is a duration, `short` for the
 * shortest lifetime documented over both modes and `long` for every other; or, where the entry is documented as not
 * caching, one item of 0 seconds per profile. `sourceOf` names the source and date of a mode's lifetimes (null = the
 * "does not cache" item). Ordered by profile, then seconds, implicit before explicit, then the text in character order.
 */
export function documentedItems(documented: CacheDocumentation, sourceOf: (mode: CacheMode | null) => { source: LifetimeSource; date: string | null }): CacheLifetimeItem[] {
  if (documented.support === "unsupported") {
    const from = sourceOf(null);
    return RETENTION_PROFILES.map((profile) => documentedItem(profile, 0, null, null, from));
  }
  const found = documentedSeconds(documented);
  const shortest = shortestDocumentedS(documented);
  if (shortest === null) return [];
  const sources = new Map<CacheMode, { source: LifetimeSource; date: string | null }>();
  const from = (mode: CacheMode) => sources.get(mode) ?? sources.set(mode, sourceOf(mode)).get(mode)!;
  return found
    .map((item) => documentedItem(item.seconds === shortest ? "short" : "long", item.seconds, item.mode, item.text, from(item.mode)))
    .sort((a, b) => profileRank(a.retention_profile) - profileRank(b.retention_profile) || a.lifetime_s - b.lifetime_s || modeRank(a.mode) - modeRank(b.mode) || byCharacters(a.documented_as, b.documented_as));
}

/**
 * A documented lifetime text in whole seconds: a duration (`durationSeconds`) of at least one whole second. Anything
 * else (a range, words, a fraction of a second such as `500ms`, a lifetime of 0) is no documented lifetime: it makes no
 * item and the build reports it. Nothing is rounded.
 */
export function lifetimeSeconds(text: string): number | undefined {
  const seconds = durationSeconds(text);
  return seconds !== undefined && Number.isInteger(seconds) && seconds > 0 ? seconds : undefined;
}

/** Plain character (UTF-16 code unit) order, null first: the same on every machine, whatever its locale. */
const byCharacters = (a: string | null, b: string | null): number => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1);

const profileRank = (profile: RetentionProfile): number => (profile === "short" ? 0 : 1);
const modeRank = (mode: CacheMode | null): number => (mode === "implicit" ? 0 : 1);
const lowest = (values: readonly (number | null)[]): number | null => {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? Math.min(...known) : null;
};
const newest = (dates: readonly (string | null)[]): string | null => dates.filter((date): date is string => date !== null).sort().at(-1) ?? null;

const emptySafeLifetime = (): SafeLifetime => ({
  safe_s: null,
  basis: "none",
  source: null,
  date: null,
  documented_s: null,
  measured_s: null,
  clients: 0,
  evaluations: 0,
  checks: 0,
  hits: 0,
  checks_inside: null,
  hits_inside: null,
  tested_from_s: null,
  first_miss_s: null,
});

/** The lifetime record of an entry nothing is known about: both profiles null, an empty list. */
export function emptyCacheLifetime(): CacheLifetimeRecord {
  return { short: emptySafeLifetime(), long: emptySafeLifetime(), lifetimes: [] };
}

/**
 * One measured item: the counted evaluations of one profile, one setting and one client, combined by the minimum.
 * Every key taken from one member is part of the group's key, or a function of it: the label of a public client id is
 * one (`MeasurementLabels`), so the item does not depend on which evaluation comes first.
 */
function measuredItem(members: readonly { evaluation: CacheEvaluation; lifetime: EvaluationLifetime }[]): CacheLifetimeItem {
  const first = members[0]!.evaluation;
  const results = addResults(members.map((member) => member.evaluation.results));
  return {
    retention_profile: first.retention_profile,
    basis: "measured",
    source: "providers.dev",
    date: newest(members.map((member) => member.evaluation.date)),
    lifetime_s: Math.min(...members.map((member) => member.lifetime.safe_s)),
    mode: null,
    documented_as: null,
    client: first.client,
    client_label: first.client_label,
    parameter: first.parameter,
    value: first.value,
    evaluations: members.length,
    evaluation_ids: members.map((member) => member.evaluation.id).sort(),
    checks: results.reduce((sum, result) => sum + result.checks, 0),
    hits: results.reduce((sum, result) => sum + result.hits, 0),
    tested_from_s: lowest(members.map((member) => member.lifetime.tested_from_s)),
    first_miss_s: lowest(members.map((member) => member.lifetime.first_miss_s)),
    results,
  };
}

/**
 * The cache lifetime record of an entry: the documented items, a measured item per client and retention setting, in
 * one ordered list, and the safe value of each profile. The safe value is the documented lifetime unless a counted
 * evaluation of the profile contradicts it (`contradicts`), else the measured one (the lowest over the clients), else null.
 */
export function cacheLifetime(
  documented: CacheDocumentation,
  evaluations: readonly CacheEvaluation[],
  sourceOf: (mode: CacheMode | null) => { source: LifetimeSource; date: string | null },
): CacheLifetimeRecord {
  const counted = evaluations.flatMap((evaluation) => {
    const lifetime = evaluationLifetime(evaluation);
    return lifetime ? [{ evaluation, lifetime }] : [];
  });
  const groups = new Map<string, typeof counted>();
  for (const member of counted) {
    const { retention_profile, parameter, value, client } = member.evaluation;
    const key = JSON.stringify([retention_profile, parameter, value, client]);
    groups.set(key, [...(groups.get(key) ?? []), member]);
  }
  const measured = [...groups.values()].map(measuredItem).sort(
    (a, b) =>
      profileRank(a.retention_profile) - profileRank(b.retention_profile) ||
      (a.value === null ? 0 : 1) - (b.value === null ? 0 : 1) ||
      (a.value === null ? 0 : lifetimeSeconds(a.value) ?? 0) - (b.value === null ? 0 : lifetimeSeconds(b.value) ?? 0) ||
      byCharacters(a.value, b.value) ||
      byCharacters(a.client, b.client) ||
      byCharacters(a.parameter, b.parameter),
  );
  const docs = documentedItems(documented, sourceOf);
  const lifetimes = RETENTION_PROFILES.flatMap((profile) => [...docs, ...measured].filter((item) => item.retention_profile === profile));

  const safe = (profile: RetentionProfile): SafeLifetime => {
    const own = docs.filter((item) => item.retention_profile === profile);
    const items = measured.filter((item) => item.retention_profile === profile);
    const runs = counted.filter((member) => member.evaluation.retention_profile === profile).map((member) => member.evaluation);
    const documentedS = lowest(own.map((item) => item.lifetime_s));
    const measuredS = lowest(items.map((item) => item.lifetime_s));
    const record = emptySafeLifetime();
    record.documented_s = documentedS;
    record.measured_s = measuredS;
    record.clients = new Set(items.map((item) => item.client)).size;
    record.evaluations = items.reduce((sum, item) => sum + item.evaluations, 0);
    record.checks = items.reduce((sum, item) => sum + item.checks, 0);
    record.hits = items.reduce((sum, item) => sum + item.hits, 0);
    record.tested_from_s = lowest(items.map((item) => item.tested_from_s));
    record.first_miss_s = lowest(items.map((item) => item.first_miss_s));
    if (documentedS !== null && measuredS !== null) {
      const inside = runs.flatMap((run) => run.results).filter((result) => result.age_s <= documentedS);
      record.checks_inside = inside.reduce((sum, result) => sum + result.checks, 0);
      record.hits_inside = inside.reduce((sum, result) => sum + result.hits, 0);
    }
    if (documentedS !== null && !runs.some((run) => contradicts(run, documentedS))) {
      const chosen = own.find((item) => item.lifetime_s === documentedS)!;
      Object.assign(record, { safe_s: documentedS, basis: "documented", source: chosen.source, date: chosen.date });
    } else if (measuredS !== null) {
      Object.assign(record, { safe_s: measuredS, basis: "measured", source: "providers.dev", date: newest(items.map((item) => item.date)) });
    }
    return record;
  };
  return { short: safe("short"), long: safe("long"), lifetimes };
}

/**
 * Parameter support needs an explicit, sourced declaration. Documented cache lifetimes do not identify a request
 * parameter, and a cache hit does not show that a parameter was recognized. Requested settings stay in evaluations.
 */
export function retentionOf(documented: CacheDocumentation, evidence: readonly RetentionEvidence[], declaration?: CacheRetention): CacheRetention {
  if (declaration) return structuredClone(declaration);
  if (documented.support === "unsupported") {
    return {
      support: "unsupported",
      parameter: null,
      accepted_values: null,
      default: null,
      profiles: [],
      conditions: ["The source says this entry does not cache prompts."],
      evidence: structuredClone([...evidence]),
    };
  }
  return { support: "unknown", parameter: null, accepted_values: null, default: null, profiles: [], conditions: [], evidence: [] };
}

/** The settings of an evaluation in one line: `format=messages, ttl=1h`. */
export function settingsText(settings: JsonObject | undefined): string {
  return Object.entries(settings ?? {})
    .map(([key, value]: [string, Json]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
}
