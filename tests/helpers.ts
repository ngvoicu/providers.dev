import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import type { z } from "zod";
import { handleApi, modelsFor, type ApiDeps } from "../src/core/api.ts";
import {
  CacheEvaluationRecordSchema,
  CanonicalModelDetailSchema,
  CanonicalModelSchema,
  EntryDetailSchema,
  EntrySummarySchema,
  LimitEvaluationRecordSchema,
  MetaSchema,
  one,
  pageOf,
  ProviderDetailSchema,
  ProviderSchema,
  ProviderSummarySchema,
} from "../src/core/contract.ts";
import { entryHref } from "../src/core/format.ts";
import { addResults, documentedCache, emptyCacheLifetime, RETENTION_PROFILES, type CacheDocumentation, type CacheEvaluation, type CacheLifetimeRecord, type CacheResult, type EntryCache } from "../src/core/cache.ts";
import type { Index, Summary } from "../src/core/entries.ts";
import { controlsOf, pricingOf } from "../src/core/policies.ts";
import { emptyInputWindow, type InputWindow } from "../src/core/limits.ts";
import { countingKind, emptySafeValues, layPi, measuredLifetime, measuredWindow, mirror, piStatements, SAFE_QUANTITIES, safeNumber, VALUE_SOURCES, type EntryAccess, type SafeValue, type SafeValues, type SourceValue } from "../src/core/safe.ts";
import { priceParts } from "../src/core/policies.ts";
import { ext, type Catalog, type MeasuredLimit, type Meta, type ModelExtension, type PiAliases, type UpstreamCatalog } from "../src/core/schema.ts";
import { piPart, type PiBlock, type PiCatalog, type PiModel, type PiReport, type PiSummary } from "../src/core/pi.ts";
import { resolve, type ResolveInput, type ResolveResult } from "../src/core/resolve.ts";
import { pretty, ROOT } from "../scripts/lib/files.ts";
import { piProviderFile } from "../scripts/lib/pi-sync.ts";

/** The cache record of an entry nothing is known about. */
export const NO_CACHE: EntryCache = { documented: documentedCache({}), retention: { support: "unknown", parameter: null, accepted_values: null, default: null, profiles: [], conditions: [], evidence: [] }, lifetime: emptyCacheLifetime(), evaluations: [] };

/** A complete providers_dev record, as published: every key is there. */
export function extensionOf(more: Partial<ModelExtension> = {}): ModelExtension {
  return {
    origin: "upstream",
    access: "api",
    provenance: [],
    inherited: null,
    cache: NO_CACHE,
    pricing: pricingOf({}, more.access ?? "api", null, []),
    request_controls: controlsOf({}, NO_CACHE.retention, []),
    limits: { measured: [], from_measurement: [], input_window: emptyInputWindow() },
    safe: emptySafeValues(),
    evidence: [],
    verified: null,
    pi: null,
    ...more,
  };
}

/** A complete limit evaluation: what it did not measure is null. */
export function limitOf(more: Partial<MeasuredLimit> = {}): MeasuredLimit {
  return { route: "r", route_label: "R", client: "direct", client_label: "Direct", context: null, output: null, input_accepted: null, input_refused: null, input_read: null, output_accepted: null, note: null, date: null, source: "https://example.com/result", client_kind: "direct", ...more };
}

/** A complete entry summary with nothing known. */
export function summaryOf(more: Partial<Summary> = {}): Summary {
  return {
    ref: "p/m", provider: "p", model: "m", name: "M", type: null, family: null, canonical_id: null, status: null, release_date: null,
    access: "api", origin: "upstream", context: null, input: null, max_output: null, input_window: emptyInputWindow(), safe: emptySafeValues(),
    cache: "unknown", cache_modes: [], cache_mode_support: { implicit: "unknown", explicit: "unknown" },
    cache_retention: "unknown", cache_lifetime: emptyCacheLifetime(), evaluation_count: 0,
    price_in: null, price_out: null, price_from: null, pricing: pricingOf({}, "api", null, []), request_controls: controlsOf({}, NO_CACHE.retention, []),
    measured_input_accepted: null, measured_input_refused: null, measured_limit_count: 0, overridden_fields: [], verified: null, shard: 0, pi: null,
    ...more,
  };
}

export const evidence = [{ kind: "documented", url: "https://example.com/docs", date: "2026-11-01" }];

/** A statement of a catalog (2.3), as `safeValues` makes it. */
const stated = (source: "providers.dev" | "models.dev", value: number, date: string | null, scope: SourceValue["scope"] = null): SourceValue => ({
  source, value, withheld: false, at_least: false, below: null, scope, date, evidence_url: null, client: null, client_label: null, client_kind: null, evaluation_id: null,
});

/**
 * An input window record with its safe value, as the build makes it of one entry with no other source than the one
 * its documented value names: the measured statement, the documented one, the rule, and `mirror`. `context` is the
 * entry's published limit.context, for `window_tokens`.
 */
export function finishWindow(record: InputWindow, context: number | null = null): InputWindow {
  const measured = measuredWindow(record.measurements);
  const sources = [
    ...(measured ? [measured.statement] : []),
    ...(record.documented_tokens !== null && record.documented_source !== null ? [stated(record.documented_source, record.documented_tokens, record.documented_date, record.documented_field === "limit.input" ? "input" : "window")] : []),
  ];
  const extension = extensionOf({ limits: { measured: [], from_measurement: [], input_window: record } });
  extension.safe.input_window = safeNumber("input_window", sources, measured?.items ?? [], context);
  return mirror(extension).limits.input_window;
}

/** The safe values of the two lifetime profiles of a cache record, as the build makes them of an entry with no other source. */
export function lifetimeSafe(record: CacheLifetimeRecord, evaluations: readonly CacheEvaluation[]): Pick<SafeValues, "cache_short" | "cache_long"> {
  const safe = emptySafeValues();
  for (const [profile, key] of [["short", "cache_short"], ["long", "cache_long"]] as const) {
    const kind = record.lifetimes.find((item) => item.retention_profile === profile && item.chosen)?.client_kind ?? null;
    const measured = measuredLifetime(evaluations, profile, kind);
    const own = record.lifetimes.filter((item) => item.retention_profile === profile && item.basis === "documented");
    const lowest = own.reduce<(typeof own)[number] | null>((best, item) => (best === null || item.lifetime_s < best.lifetime_s ? item : best), null);
    const sources = [...(measured ? [measured] : []), ...(lowest ? [stated(lowest.source, lowest.lifetime_s, lowest.date)] : [])];
    safe[key] = safeNumber(key, sources);
  }
  return { cache_short: safe.cache_short, cache_long: safe.cache_long };
}

/** A cache lifetime record with the safe value of each profile, the same way (`finishWindow`). */
export function finishLifetime(record: CacheLifetimeRecord, evaluations: readonly CacheEvaluation[]): CacheLifetimeRecord {
  const extension = extensionOf({ cache: { ...NO_CACHE, lifetime: record } });
  Object.assign(extension.safe, lifetimeSafe(record, evaluations));
  return mirror(extension).cache.lifetime;
}

/**
 * What always holds for the cache lifetime record of an entry (section 2.6 of design/safe-cache-lifetime.md, with the
 * rule of design/sources-side-by-side.md), checked from the record, the entry's evaluations, its documented caching
 * and its access. Written apart from `cacheLifetime` and `safeValues`: the walk, which kind counts and the test for
 * "contradicted" are redone here. Returns the rules that fail, empty when all hold.
 */
export function lifetimeRuleBreaks(record: CacheLifetimeRecord, evaluations: readonly CacheEvaluation[], documented: CacheDocumentation, access: EntryAccess = "api"): string[] {
  const broken: string[] = [];
  const fail = (rule: string, holds: boolean): void => {
    if (!holds) broken.push(rule);
  };
  const min = (values: (number | null)[]): number | null => {
    const known = values.filter((value): value is number => value !== null);
    return known.length > 0 ? Math.min(...known) : null;
  };
  const walk = (results: readonly CacheResult[]): { safe: number; miss: number | null } => {
    const ordered = [...results.filter((result) => result.kind === "control"), ...results.filter((result) => result.kind === "timed").sort((a, b) => a.age_s - b.age_s)];
    let safe = 0;
    for (const result of ordered) {
      if (result.hits !== result.checks) return { safe, miss: result.age_s };
      safe = result.age_s;
    }
    return { safe, miss: null };
  };
  const counts = (evaluation: CacheEvaluation): boolean => evaluation.results.some((result) => result.kind === "timed") || evaluation.results.some((result) => result.kind === "control" && result.hits < result.checks);
  const counted = evaluations.filter(counts);
  const byId = new Map(evaluations.map((evaluation) => [evaluation.id, evaluation]));
  for (const profile of RETENTION_PROFILES) {
    const p = record[profile];
    const docs = record.lifetimes.filter((item) => item.retention_profile === profile && item.basis === "documented");
    const all = record.lifetimes.filter((item) => item.retention_profile === profile && item.basis === "measured");
    // Which kind counts (2.3), redone: the first of the entry's order among the kinds measured.
    const order = access === "subscription" ? ["own_client", "direct", "proxy"] : ["direct"];
    const kind = order.find((k) => all.some((item) => item.client_kind === k)) ?? null;
    const measured = all.filter((item) => kind !== null && item.client_kind === kind);
    fail(`${profile} 0 chosen`, all.every((item) => item.chosen === measured.includes(item)) && docs.every((item) => !item.chosen && item.client_kind === null));
    fail(`${profile} 0 countingKind`, countingKind(access, all.map((item) => item.client_kind)) === kind);
    fail(`${profile} 1 documented_s`, p.documented_s === min(docs.map((item) => item.lifetime_s)));
    fail(`${profile} 2 measured_s`, p.measured_s === min(measured.map((item) => item.lifetime_s)));
    fail(`${profile} 2 sums`, p.evaluations === measured.reduce((sum, item) => sum + item.evaluations, 0) && p.checks === measured.reduce((sum, item) => sum + item.checks, 0) && p.hits === measured.reduce((sum, item) => sum + item.hits, 0));
    fail(`${profile} 2 clients`, p.clients === new Set(measured.map((item) => item.client)).size);
    fail(`${profile} 2 ages`, p.tested_from_s === min(measured.map((item) => item.tested_from_s)) && p.first_miss_s === min(measured.map((item) => item.first_miss_s)));
    const none = p.basis === "none";
    // pi.dev gives the value only where nothing documented or measured states one (design/sources-side-by-side.md, 4).
    const fromPi = p.source === "pi.dev";
    fail(`${profile} 3 none`, [p.safe_s === null, p.source === null].every((value) => value === none) && (fromPi || none === (docs.length + measured.length === 0)));
    if (fromPi) fail(`${profile} 3 pi`, p.basis === "documented" && p.safe_s !== null && docs.length + measured.length === 0);
    if (p.basis === "documented" && !fromPi) {
      const first = docs.find((item) => item.lifetime_s === p.documented_s);
      fail(`${profile} 4 documented`, p.documented_s !== null && p.safe_s === p.documented_s && first !== undefined && p.source === first.source && p.date === first.date);
    }
    if (p.basis === "measured") {
      const runs = counted.filter((run) => run.retention_profile === profile && measured.some((item) => item.evaluation_ids.includes(run.id)));
      fail(`${profile} 5 measured`, p.measured_s !== null && p.safe_s === p.measured_s && p.source === "providers.dev" && runs.some((run) => run.date === p.date && walk(run.results).safe === p.measured_s));
    }
    // The first source that states a value gives it: a measurement that counts, else the documentation.
    if (!fromPi) fail(`${profile} 7 order`, p.basis === (p.measured_s !== null ? "measured" : p.documented_s !== null ? "documented" : "none"));
    const both = p.documented_s !== null && p.measured_s !== null;
    fail(`${profile} 8 inside`, (p.checks_inside !== null && p.hits_inside !== null) === both && (!both || (p.hits_inside! <= p.checks_inside! && p.checks_inside! <= p.checks)));
    if (p.first_miss_s !== null) fail(`${profile} 9 first miss`, p.first_miss_s > (p.measured_s ?? -1) || (p.first_miss_s === 0 && p.measured_s === 0));
    // documented_status (2.5), redone: set where a lifetime above 0 is documented and one is measured by a kind that
    // counts; contradicted where every check still hit after it, or a check missed at an age it covers.
    const S = p.documented_s;
    const judged = S !== null && S > 0 && p.measured_s !== null;
    const contradicted = judged && (S! < p.measured_s! || (p.first_miss_s !== null && S! >= p.first_miss_s));
    fail(`${profile} 2.5 status`, p.documented_status === (judged ? (contradicted ? "contradicted" : "not_contradicted") : null));
  }
  for (const item of record.lifetimes.filter((entry) => entry.basis === "measured")) {
    const members = item.evaluation_ids.map((id) => byId.get(id));
    const where = `item ${item.client} ${item.value}`;
    fail(`${where} 10 evaluations`, members.every((member) => member !== undefined) && members.length === item.evaluations && item.evaluations >= 1);
    const results = addResults(members.flatMap((member) => (member ? [member.results] : [])));
    fail(`${where} 10 results`, JSON.stringify(item.results) === JSON.stringify(results));
    fail(`${where} 10 sums`, item.checks === results.reduce((sum, result) => sum + result.checks, 0) && item.hits === results.reduce((sum, result) => sum + result.hits, 0));
    const summed = walk(results).safe;
    fail(`${where} 10 walk`, item.evaluations === 1 ? summed === item.lifetime_s : summed >= item.lifetime_s);
    fail(`${where} 10 minimum`, item.lifetime_s === Math.min(...members.map((member) => walk(member!.results).safe)));
    if (item.first_miss_s !== null) fail(`${where} 9 first miss`, item.first_miss_s > item.lifetime_s || (item.first_miss_s === 0 && item.lifetime_s === 0));
    fail(`${where} kind`, item.mode === null && item.documented_as === null && item.source === "providers.dev" && members.every((member) => member?.client === item.client && member.client_kind === item.client_kind && member.retention_profile === item.retention_profile && member.parameter === item.parameter && member.value === item.value));
  }
  for (const evaluation of evaluations) {
    const named = record.lifetimes.filter((item) => item.evaluation_ids.includes(evaluation.id)).length;
    fail(`11 ${evaluation.id}`, named === (counts(evaluation) ? 1 : 0));
  }
  for (const profile of RETENTION_PROFILES) {
    const zero = record.lifetimes.filter((item) => item.retention_profile === profile && item.basis === "documented" && item.lifetime_s === 0 && item.mode === null && item.documented_as === null).length;
    fail(`${profile} 12 does not cache`, zero === (documented.support === "unsupported" ? 1 : 0));
  }
  return broken;
}

/**
 * What always holds for the input window record of an entry (section 2.6 of design/usable-input-window.md, with the
 * rule of design/sources-side-by-side.md), checked from the record and the entry's own published `limit`,
 * `limits.from_measurement`, `limits.measured` and access. Written apart from `inputWindow` and `safeValues`: the
 * documented input (3.1), what each evaluation gives (3.3), which kind counts (2.3) and the test for "contradicted"
 * (4.2) are redone here. Returns the rules that fail, empty when all hold.
 */
export function inputWindowRuleBreaks(
  record: InputWindow,
  limit: unknown,
  fromMeasurement: readonly string[],
  measured: readonly (Omit<MeasuredLimit, "input_read"> & { input_read?: number | null })[],
  access: EntryAccess = "api",
): string[] {
  const broken: string[] = [];
  const fail = (rule: string, holds: boolean): void => {
    if (!holds) broken.push(rule);
  };
  const r = record;
  // 3.1, redone.
  const object = typeof limit === "object" && limit !== null && !Array.isArray(limit) ? (limit as Record<string, unknown>) : {};
  const above0 = (value: unknown): value is number => typeof value === "number" && value > 0;
  const documented = above0(object.input) ? { tokens: object.input, field: "limit.input" } : above0(object.context) && !fromMeasurement.includes("context") ? { tokens: object.context, field: "limit.context" } : null;
  // 3.3, redone: what each evaluation gives, or null where it does not count.
  const gives = (e: (typeof measured)[number]): { tokens: number; bound: string; kind: string } | null => {
    const v = e.input_read ?? null;
    if (e.context !== null && (e.input_refused === null || e.input_refused > e.context)) return { tokens: e.context, bound: "limit", kind: "window" };
    if (e.input_accepted !== null && e.input_refused !== null) return { tokens: e.input_accepted, bound: "at_least", kind: "bracket" };
    if (v !== null && e.input_refused === null) return { tokens: v, bound: "at_least", kind: "accepted" };
    return null;
  };
  const counted = measured.filter((e) => gives(e) !== null);
  // 2.3, redone: the first kind of the entry's order among the kinds of the counted evaluations.
  const order = access === "subscription" ? ["own_client", "direct", "proxy"] : ["direct"];
  const kind = order.find((k) => counted.some((e) => e.client_kind === k)) ?? null;
  const chosen = r.measurements.filter((item) => item.chosen);
  fail("0 chosen", r.measurements.every((item) => item.chosen === (kind !== null && item.client_kind === kind)));
  const none = r.basis === "none";
  // pi.dev gives the value only where nothing documented or measured states one (design/sources-side-by-side.md, 4).
  const fromPi = r.source === "pi.dev";
  fail("1 none", [r.tokens === null, r.bound === null && r.scope === null && r.source === null].every((value) => value === none) && (fromPi || none === (r.documented_tokens === null && r.measured_tokens === null)));
  if (fromPi) fail("2 pi", r.basis === "documented" && r.tokens !== null && r.bound === "limit" && r.scope === "window" && r.documented_tokens === null && r.measured_tokens === null);
  if (r.basis === "documented" && !fromPi) {
    fail("2 documented", r.tokens === r.documented_tokens && r.bound === "limit" && r.source === r.documented_source && r.date === r.documented_date && r.scope === (r.documented_field === "limit.input" ? "input" : "window"));
  }
  if (r.basis === "measured") {
    fail("3 measured", r.tokens === r.measured_tokens && r.bound === r.measured_bound && r.source === "providers.dev" && r.date === r.measured_date && r.scope === (r.measured_kind === "window" ? "window" : "input"));
  }
  fail("4 documented null", (r.documented_tokens === null) === (r.documented_field === null) && (r.documented_tokens === null) === (r.documented_source === null));
  fail("4 documented value", r.documented_tokens === (documented?.tokens ?? null) && r.documented_field === (documented?.field ?? null));
  const first = chosen[0];
  const empty = r.measured_tokens === null;
  fail("5 measured null", [chosen.length === 0, r.evaluations === 0, r.clients === 0, r.measured_bound === null && r.measured_kind === null && r.measured_refused === null && r.measured_date === null].every((value) => value === empty));
  if (first) {
    fail("5 first", r.measured_tokens === first.tokens && r.measured_bound === first.bound && r.measured_kind === first.kind && r.measured_date === first.date && r.measured_refused === (first.kind === "bracket" ? first.refused : null));
    fail("5 lowest", chosen.every((item) => item.tokens >= first.tokens));
  }
  fail("5 counts", r.evaluations === chosen.length && r.clients === new Set(chosen.map((item) => item.client)).size);
  // 6: one item per counted evaluation, of every client, and the item is what the evaluation gives.
  const unused = [...r.measurements];
  for (const e of counted) {
    const g = gives(e)!;
    const at = unused.findIndex((item) => item.client === e.client && item.client_kind === e.client_kind && item.route === e.route && item.date === e.date && item.source === e.source && item.tokens === g.tokens && item.bound === g.bound && item.kind === g.kind && item.accepted === e.input_accepted && item.refused === e.input_refused && item.named === e.context && item.read === (e.input_read ?? null) && item.client_label === e.client_label && item.route_label === e.route_label);
    fail(`6 item of ${e.client} ${e.route} ${e.date}`, at >= 0);
    if (at >= 0) unused.splice(at, 1);
  }
  fail("6 no other item", unused.length === 0);
  const both = r.documented_tokens !== null && r.measured_tokens !== null;
  fail("7 status set", (r.documented_status !== null) === both);
  if (both) {
    // 4.2, redone from the chosen items.
    const D = r.documented_tokens!;
    const contradicted = chosen.some(
      (item) =>
        (item.named !== null && item.named < D) ||
        (item.kind === "window" && r.documented_field === "limit.context" && item.named !== D) ||
        (item.kind === "bracket" && item.refused !== null && item.refused * 100 <= D * 99) ||
        (item.kind !== "window" && item.tokens * 100 >= D * 101),
    );
    fail("7 rule", r.documented_status === (contradicted ? "contradicted" : "not_contradicted"));
  }
  // 2.4, redone: the measurement first; a measured window gives way to a documented cap that is not above it.
  if (r.measured_tokens !== null) {
    const capped = r.measured_kind === "window" && r.documented_field === "limit.input" && r.documented_tokens! <= r.measured_tokens;
    fail("8 measured first", r.basis === (capped ? "documented" : "measured"));
  }
  if (r.documented_tokens !== null && r.measured_tokens === null) fail("8 documented only", r.basis === "documented");
  for (const item of r.measurements) {
    const where = `9 ${item.client} ${item.route}`;
    if (item.accepted !== null && item.refused !== null) fail(`${where} accepted below refused`, item.accepted < item.refused);
    if (item.accepted !== null && item.named !== null) fail(`${where} accepted within named`, item.accepted <= item.named);
    if (item.read !== null && item.accepted !== null) fail(`${where} read within accepted`, item.read <= item.accepted);
    fail(`${where} kind`, item.kind === "window" ? item.tokens === item.named && item.bound === "limit" : item.kind === "bracket" ? item.tokens === item.accepted && item.bound === "at_least" : item.tokens === item.read && item.bound === "at_least");
  }
  return broken;
}

/**
 * What always holds for `safe` of every entry of a catalog (design/sources-side-by-side.md, the ten sentences of 5.1),
 * and for the records that copy it (5.2). Written apart from `safeValues`: agreement, which kind counts and the copies
 * are redone here from the published entry. Returns the rules that fail, as `ref: rule`, empty when all hold.
 */
export function safeBreaks(catalog: Catalog): string[] {
  const broken: string[] = [];
  const order = (source: string): number => (VALUE_SOURCES as readonly string[]).indexOf(source);
  for (const [providerId, provider] of Object.entries(catalog)) {
    for (const [modelId, model] of Object.entries(provider.models)) {
      const ref = `${providerId}/${modelId}`;
      const fail = (rule: string, holds: boolean): void => {
        if (!holds) broken.push(`${ref}: ${rule}`);
      };
      const x = ext(model);
      const safe = x.safe;
      const kinds = (access: EntryAccess, list: readonly (string | null)[]): string | null => {
        const sequence = access === "subscription" ? ["own_client", "direct", "proxy"] : ["direct"];
        return sequence.find((kind) => list.includes(kind)) ?? null;
      };
      const chosenWindow = x.limits.input_window.measurements.filter((item) => item.chosen);
      // The kind that gives each number quantity a measured value, redone from the evaluations.
      const counting: Record<string, string | null> = {
        input_window: kinds(x.access, x.limits.input_window.measurements.map((item) => item.client_kind)),
        max_output: kinds(x.access, x.limits.measured.filter((limit) => typeof limit.output === "number" && limit.output > 0).map((limit) => limit.client_kind)),
        cache_short: kinds(x.access, x.cache.lifetime.lifetimes.filter((item) => item.basis === "measured" && item.retention_profile === "short").map((item) => item.client_kind)),
        cache_long: kinds(x.access, x.cache.lifetime.lifetimes.filter((item) => item.basis === "measured" && item.retention_profile === "long").map((item) => item.client_kind)),
      };
      fail("0 countingKind", ["input_window", "max_output", "cache_short", "cache_long"].every((quantity) => {
        const list = quantity === "input_window" ? x.limits.input_window.measurements.map((item) => item.client_kind) : quantity === "max_output" ? x.limits.measured.filter((limit) => typeof limit.output === "number" && limit.output > 0).map((limit) => limit.client_kind) : x.cache.lifetime.lifetimes.filter((item) => item.basis === "measured" && item.retention_profile === (quantity === "cache_short" ? "short" : "long")).map((item) => item.client_kind);
        return countingKind(x.access, list) === counting[quantity];
      }));
      for (const quantity of ["input_window", "max_output", "cache_short", "cache_long"] as const) {
        const q: SafeValue = safe[quantity];
        const where = (rule: string) => `${quantity} ${rule}`;
        // 1. At most one item per source, in order.
        fail(where("1 order"), q.sources.every((item, index) => index === 0 || order(item.source) > order(q.sources[index - 1]!.source)));
        // 2. source names an item; the value is that item's. Null exactly with no item.
        const item = q.sources.find((candidate) => candidate.source === q.source);
        fail(where("2 source"), (q.source === null) === (q.sources.length === 0) && (q.source === null || item !== undefined));
        if (item) fail(where("2 the item's"), q.value === (item.withheld ? null : item.value) && q.at_least === (item.withheld ? false : item.at_least) && q.scope === (item.withheld ? null : item.scope) && q.date === item.date);
        // 3. The first item's, but for the refinement of the input window.
        const first = q.sources[0];
        if (first && item && item !== first) fail(where("3 refinement"), quantity === "input_window" && first.scope === "window" && !first.withheld && item.scope === "input" && item.value! <= first.value!);
        // 4. value null exactly where nothing states one or providers.dev withholds it.
        fail(where("4 null"), (q.value === null) === (item === undefined || item.withheld));
        // 5. Agreement, redone.
        const clash = (a: SourceValue, b: SourceValue): boolean => {
          if (a.withheld || b.withheld) return a.withheld && b.source !== "measured";
          if (a.source === "measured" && quantity === "input_window") return chosenWindow.some((m) => (m.named !== null && m.named < b.value!) || (m.kind === "window" && b.scope === "window" && m.named !== b.value) || (m.kind === "bracket" && m.refused !== null && 100 * m.refused <= 99 * b.value!) || (m.kind !== "window" && 100 * m.tokens >= 101 * b.value!));
          if (a.source === "measured" && (quantity === "cache_short" || quantity === "cache_long")) return b.value! < a.value! || (a.below !== null && b.value! >= a.below);
          if (quantity === "input_window" && a.scope !== b.scope) return (a.scope === "input" ? a.value! : b.value!) > (a.scope === "input" ? b.value! : a.value!);
          return a.value !== b.value;
        };
        const differ = q.sources.some((a, i) => q.sources.slice(i + 1).some((b) => clash(a, b)));
        fail(where("5 agreement"), q.agreement === (q.sources.length === 0 ? "none" : q.sources.length === 1 ? "single" : differ ? "differ" : "agree"));
        // 6. pi.dev only where it is alone.
        fail(where("6 pi"), q.source !== "pi.dev" || q.sources.length === 1);
        // 9. A measured item names the measurement, of the kind that counts; every other item names none.
        for (const candidate of q.sources) {
          if (candidate.source === "measured") fail(where("9 measured"), candidate.client !== null && candidate.client_label !== null && candidate.client_kind !== null && candidate.client_kind === counting[quantity] && candidate.evidence_url !== null && (quantity.startsWith("cache") ? candidate.evaluation_id !== null : candidate.evaluation_id === null));
          else fail(where("9 others"), candidate.client === null && candidate.client_label === null && candidate.client_kind === null && candidate.evaluation_id === null && candidate.below === null && !candidate.at_least);
          fail(where("9 withheld"), !candidate.withheld || (candidate.source === "providers.dev" && candidate.value === null));
        }
        fail(where("9 measured present"), q.sources.some((candidate) => candidate.source === "measured") === (counting[quantity] !== null && (quantity !== "input_window" || chosenWindow.length > 0)));
        // 10. window_tokens above the value, on the input window only.
        fail(where("10 window_tokens"), q.window_tokens === null || (quantity === "input_window" && q.value !== null && q.window_tokens > q.value));
      }
      // 7. differs and differing.
      fail("7 differs", safe.price.agreement === "differ" || safe.price.differs.length === 0);
      fail("7 differing", JSON.stringify(safe.differing) === JSON.stringify(SAFE_QUANTITIES.filter((quantity) => safe[quantity].agreement === "differ")));
      // 1 and 8. The price: no measured item, in order; pricing is the price of its source, whole.
      fail("1 price order", safe.price.sources.every((item, index) => item.source !== ("measured" as string) && (index === 0 || order(item.source) > order(safe.price.sources[index - 1]!.source))));
      fail("2 price source", (safe.price.source === null) === (safe.price.sources.length === 0) && (safe.price.source === null || safe.price.source === safe.price.sources[0]!.source));
      const own = safe.price.sources[0];
      const parts = priceParts(x.pricing);
      if (!own || own.withheld) fail("8 pricing null", parts === null);
      else fail("8 pricing", parts !== null && parts.input === own.input && parts.output === own.output && parts.cache_read === own.cache_read && parts.cache_write === own.cache_write && JSON.stringify(parts.tiers) === JSON.stringify(own.tiers));
      // 2.4. A subscription entry is priced by the API entry it refers to, and only by it: with none to refer to, its
      // price is unknown (no statement, no rule), whatever its own cost lists. An entry providers.dev added with a
      // price of its own keeps it.
      if (x.access === "subscription") {
        const own = x.origin === "added" && model.cost !== undefined && !(x.inherited?.fields.includes("cost") ?? false);
        if (!own && x.pricing.billing !== "reference") fail("2.4 subscription without a reference", safe.price.source === null && safe.price.sources.length === 0 && x.pricing.rules === null);
        if (x.pricing.billing === "reference") fail("2.4 subscription reference", x.pricing.reference_ref !== null);
      }
      // 5.2. The copies.
      const w = x.limits.input_window;
      const iw = safe.input_window;
      const basisOf = (value: SafeValue): string => (value.value === null ? "none" : value.source === "measured" ? "measured" : "documented");
      const sourceOf = (value: SafeValue): string | null => (value.value === null ? null : value.source === "measured" ? "providers.dev" : value.source);
      fail("5.2 input_window", w.tokens === iw.value && w.basis === basisOf(iw) && w.source === sourceOf(iw) && w.scope === iw.scope && w.date === (iw.value === null ? null : iw.date) && w.bound === (iw.value === null ? null : iw.at_least ? "at_least" : "limit"));
      const measuredWindowItem = iw.sources.find((candidate) => candidate.source === "measured");
      fail("5.2 measured_tokens", w.measured_tokens === (measuredWindowItem?.value ?? null) && w.measurements.every((m) => m.chosen === (m.client_kind !== null && m.client_kind === counting.input_window)));
      for (const [profile, key] of [["short", "cache_short"], ["long", "cache_long"]] as const) {
        const p = x.cache.lifetime[profile];
        const value = safe[key];
        fail(`5.2 ${profile}`, p.safe_s === value.value && p.basis === basisOf(value) && p.source === sourceOf(value) && p.date === (value.value === null ? null : value.date));
        const measured = value.sources.find((candidate) => candidate.source === "measured");
        fail(`5.2 ${profile} measured_s`, p.measured_s === (measured?.value ?? null) && p.first_miss_s === (measured?.below ?? null));
        fail(`5.2 ${profile} chosen`, x.cache.lifetime.lifetimes.filter((item) => item.retention_profile === profile).every((item) => item.chosen === (item.basis === "measured" && item.client_kind !== null && item.client_kind === counting[key])));
      }
    }
  }
  return broken;
}

/** A small upstream catalog in the v2 shape: big enough to pass the sync's size checks when repeated. */
export function fixtureUpstream(providers = 30, modelsEach = 20): UpstreamCatalog {
  const catalog: UpstreamCatalog = {};
  for (let p = 0; p < providers; p += 1) {
    const id = `provider-${String(p).padStart(2, "0")}`;
    const models: UpstreamCatalog[string]["models"] = {};
    for (let m = 0; m < modelsEach; m += 1) {
      const modelId = m % 2 === 0 ? `lab/model-${m}` : `model-${m}`;
      models[modelId] = {
        id: modelId,
        name: `Model ${m}`,
        type: m === 19 ? "embedding" : "chat",
        family: `family-${m % 3}`,
        canonical_id: `lab/model-${m}`,
        release_date: `2026-0${(m % 9) + 1}-01`,
        limit: m === 7 ? {} : { context: (m + 1) * 100000, output: m === 0 ? 0 : (m + 1) * 1000 },
        capabilities:
          m % 4 === 0
            ? { cache: { explicit: { ttl: ["5m", "1h"] } } }
            : m % 4 === 1
              ? { cache: { implicit: true } }
              : m % 4 === 2
                ? { cache: false }
                : {},
      };
    }
    catalog[id] = { id, name: `Provider ${p}`, doc: "https://example.com", models };
  }
  return catalog;
}

/**
 * A small pi catalog in the feed's shape: provider ids `provider-00`… and the model ids of `fixtureUpstream`, so that
 * equal ids match. Every model has every field the import requires; some have the optional ones, `headers` included.
 */
export function fixturePi(providers = 12, modelsEach = 30): PiCatalog {
  const catalog: PiCatalog = {};
  for (let p = 0; p < providers; p += 1) {
    const provider = `provider-${String(p).padStart(2, "0")}`;
    const models: Record<string, PiModel> = {};
    for (let m = 0; m < modelsEach; m += 1) {
      const id = m % 2 === 0 ? `lab/model-${m}` : `model-${m}`;
      models[id] = {
        id,
        name: `Model ${m}`,
        api: m % 3 === 0 ? "anthropic-messages" : "openai-completions",
        provider,
        baseUrl: m === 5 ? "" : `https://api.${provider}.example/v1`,
        reasoning: m % 2 === 0,
        input: m % 4 === 0 ? ["text", "image"] : ["text"],
        cost: { input: m, output: m * 4, cacheRead: m / 10, cacheWrite: 0, ...(m === 3 ? { tiers: [{ inputTokensAbove: 199999, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5 }] } : {}) },
        contextWindow: (m + 1) * 100000,
        maxTokens: (m + 1) * 1000,
        type: "chat",
        ...(m % 5 === 0 ? { compat: { supportsStore: false, maxTokensField: "max_tokens" } } : {}),
        ...(m % 6 === 0 ? { thinkingLevelMap: { minimal: null, high: "high" } } : {}),
        ...(m % 7 === 0 ? { promptCache: { short: 300, long: 3600 } } : {}),
        ...(m === 1 ? { headers: { "X-Example": "1" } } : {}),
      };
    }
    catalog[provider] = models;
  }
  return catalog;
}

/**
 * Write data/pi/ as `npm run sync` writes it, and the pi key of sync-status.json (which must exist: run `sync` first).
 * Fetched and checked on the given times; `status` is the pi part of the last sync.
 */
export function writePiSnapshot(dataDir: string, catalog: PiCatalog, times = { fetched_at: "2026-11-20T14:19:45.000Z", checked_at: "2026-11-21T04:17:12.000Z" }, status: object = { last_attempt_at: "2026-11-21T04:17:12.000Z", status: "unchanged" }): void {
  mkdirSync(join(dataDir, "pi", "providers"), { recursive: true });
  for (const [id, models] of Object.entries(catalog)) writeFileSync(join(dataDir, "pi", "providers", `${id}.json`), piProviderFile(id, models));
  const models = Object.values(catalog).reduce((sum, items) => sum + Object.keys(items).length, 0);
  writeFileSync(join(dataDir, "pi", "meta.json"), pretty({ source: "https://pi.dev/api/models", ...times, etag: '"p1"', revision: "sha256-dd93eb27", sha256: "ab".repeat(32), providers: Object.keys(catalog).length, models }));
  const path = join(dataDir, "sync-status.json");
  writeFileSync(path, pretty({ ...JSON.parse(readFileSync(path, "utf8")), pi: status }));
}

/** One request a `fetchByAddress` stand-in received. */
export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * A `fetch` stand-in that answers per address: the answer of the first key that the requested address starts with.
 * Every request is pushed to `requests`. An address no key covers is answered 404.
 */
export function fetchByAddress(answers: Record<string, () => Response>, requests: RecordedRequest[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) } });
    const key = Object.keys(answers).find((address) => url.startsWith(address));
    return key ? answers[key]!() : new Response("not found", { status: 404 });
  }) as typeof fetch;
}

/** Folders made by `tempDataDir`; `tests/setup.ts` removes them when each test file is over, passed or failed. */
const tempDirs = new Set<string>();

export function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "providers-dev-"));
  tempDirs.add(dir);
  return dir;
}

export function removeTempDataDirs(): void {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
}

export function writeAuthored(dataDir: string): void {
  const authored = join(dataDir, "authored");
  mkdirSync(join(authored, "providers"), { recursive: true });
  mkdirSync(join(authored, "overrides"), { recursive: true });
  writeFileSync(join(authored, "access.yaml"), stringify({ default: "api", default_basis: "default", patterns: [], providers: {} }));
  writeFileSync(join(authored, "routes.yaml"), stringify({}));
  writeFileSync(
    join(authored, "providers", "added-login.yaml"),
    stringify({
      id: "added-login",
      name: "Added login",
      access: "subscription",
      access_basis: "a login",
      evidence,
      models: [{ id: "lab/model-2", inherits: "provider-00/lab/model-2", fields: { limit: { context: 900000 } }, evidence }],
    }),
  );
  writeFileSync(
    join(authored, "overrides", "provider-01.yaml"),
    stringify({
      provider: "provider-01",
      rules: [{ models: ["model-1"], set: { limit: { context: 5000000 } }, reason: "documented higher", evidence }],
    }),
  );
}

export function fetchReturning(body: string, init: ResponseInit = { status: 200, headers: { etag: '"v1"' } }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("api.github.com")) return new Response(JSON.stringify({ sha: "abc123", commit: { committer: { date: "2026-11-12T00:00:00Z" } } }));
    if (url.includes("observed.json")) return new Response("not found", { status: 404 });
    return new Response(body, init);
  }) as typeof fetch;
}

export function depsFrom(publishedDir: string): ApiDeps {
  const index = JSON.parse(readFileSync(join(publishedDir, "site", "data", "index.json"), "utf8")) as Index;
  const meta = JSON.parse(readFileSync(join(publishedDir, "site", "data", "meta.json"), "utf8")) as Meta;
  return {
    index,
    meta,
    async asset(path) {
      if (/^\/reference-content\/docs\/(methodology|licensing|contributing|support)\.json$/.test(path)) {
        return new Response(JSON.stringify({ title: "Reference fixture", description: "Reference", lead: "Reference", toc: [], body_html: "<p>Reference fixture</p>" }));
      }
      const file = join(publishedDir, "site", path);
      return existsSync(file) ? new Response(readFileSync(file)) : null;
    },
  };
}

/**
 * resolve() and then pi's part over the finished dataset, as the build lays it (scripts/lib/pi-fence.ts), without the
 * fence: for the cases of pi's own code. `pi` is the report; null without a pi catalog.
 */
export function resolveWithPi(input: ResolveInput, pi?: { catalog: PiCatalog; aliases?: PiAliases }): ResolveResult & { pi: PiReport | null } {
  const result = resolve(input);
  if (!pi) return { ...result, pi: null };
  const lookup = (ref: string) => {
    const slash = ref.indexOf("/");
    return result.catalog[ref.slice(0, slash)]?.models[ref.slice(slash + 1)];
  };
  const part = piPart({
    pi: pi.catalog,
    aliases: pi.aliases,
    before: result.before,
    ruledOut: result.ruledOut,
    entryOf: (ref) => {
      const entry = lookup(ref);
      if (!entry) return undefined;
      const own = ext(entry);
      return structuredClone({
        limit: entry.limit,
        cost: entry.cost,
        access: own.access,
        corrections: own.provenance.map(({ path, op }) => ({ path, op })),
        documented_s: { short: own.cache.lifetime.short.documented_s, long: own.cache.lifetime.long.documented_s },
      });
    },
  });
  for (const { ref, block } of part.blocks) ext(lookup(ref)!).pi = block;
  return { ...result, issues: [...result.issues, ...part.issues], pi: part.report };
}

/**
 * pi's statements laid over every entry of a catalog that has a pi block, and the copies made, as `publish()` does after
 * the fence (scripts/lib/publish.ts): the safe values a page prints, pi the last source of each.
 */
export function layPiOver(catalog: Catalog, day: string | null): Catalog {
  for (const provider of Object.values(catalog)) {
    for (const entry of Object.values(provider.models)) {
      const extension = ext(entry);
      if (!extension.pi) continue;
      extension.safe = layPi(extension.safe, piStatements(extension.pi, day), { access: extension.access, chosen: extension.limits.input_window.measurements.filter((item) => item.chosen) });
      mirror(extension);
    }
  }
  return catalog;
}

/** The pi block in short, as the build writes it into a summary. */
export const piShort = (block: PiBlock | null): PiSummary | null => (block ? { ref: block.ref, api: block.api, match: block.match, difference_count: block.differences.length } : null);

/**
 * Every answer of the API from a published snapshot, checked against the definition the OpenAPI document is generated
 * from: the problems found, none = the snapshot fits the contract. The check of "the contract" in tests/api.test.ts.
 */
export async function contractProblems(dir: string): Promise<string[]> {
  const local = depsFrom(dir);
  const ask = async (path: string): Promise<unknown> => (await handleApi(new Request(`https://providers.dev${path}`), local)).json();
  const problems: string[] = [];
  const valid = (schema: z.ZodType, value: unknown, what: string): void => {
    const result = schema.safeParse(value);
    if (!result.success) problems.push(...result.error.issues.slice(0, 3).map((issue) => `${what}: ${issue.path.join(".")}: ${issue.message}`));
  };
  valid(one(MetaSchema), await ask("/api/v1/meta"), "meta");
  for (const entry of local.index.entries) valid(EntrySummarySchema, entry, entry.ref);
  for (const provider of local.index.providers) valid(ProviderSummarySchema, provider, provider.id);
  valid(pageOf(EntrySummarySchema), await ask("/api/v1/entries?limit=200"), "entries");
  valid(pageOf(ProviderSummarySchema), await ask("/api/v1/providers?limit=200"), "providers");
  valid(pageOf(CanonicalModelSchema), await ask("/api/v1/models?limit=200"), "models");
  valid(pageOf(CacheEvaluationRecordSchema), await ask("/api/v1/evaluations/cache?limit=200"), "cache evaluations");
  valid(pageOf(LimitEvaluationRecordSchema), await ask("/api/v1/evaluations/limits?limit=200"), "limit evaluations");
  const model = modelsFor(local.index)[0]!;
  valid(one(CanonicalModelDetailSchema), await ask(`/api/v1/models/${model.id}`), model.id);
  // Every entry in full, straight from the export: thousands of them, so no request each.
  const exported = JSON.parse(readFileSync(join(dir, "site", "api.json"), "utf8")) as Catalog;
  for (const [id, provider] of Object.entries(exported)) valid(ProviderSchema, provider, id);
  // The entries that carry the most: one with evaluations where there is one, and the first.
  const picks = [local.index.entries.find((entry) => entry.evaluation_count > 0), local.index.entries.find((entry) => entry.measured_limit_count > 0), local.index.entries[0]].filter((entry) => entry !== undefined);
  for (const entry of picks) {
    valid(one(EntryDetailSchema), await ask(`/api/v1${entryHref(entry.ref)}`), entry.ref);
    valid(one(ProviderDetailSchema), await ask(`/api/v1/providers/${entry.provider}?view=full`), entry.provider);
    valid(one(ProviderDetailSchema), await ask(`/api/v1/providers/${entry.provider}`), entry.provider);
  }
  return problems;
}

export { ROOT };
