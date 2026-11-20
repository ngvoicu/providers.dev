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
    evidence: [],
    verified: null,
    pi: null,
    ...more,
  };
}

/** A complete limit evaluation: what it did not measure is null. */
export function limitOf(more: Partial<MeasuredLimit> = {}): MeasuredLimit {
  return { route: "r", route_label: "R", client: "direct", client_label: "Direct", context: null, output: null, input_accepted: null, input_refused: null, input_read: null, output_accepted: null, note: null, date: null, source: "https://example.com/result", ...more };
}

/** A complete entry summary with nothing known. */
export function summaryOf(more: Partial<Summary> = {}): Summary {
  return {
    ref: "p/m", provider: "p", model: "m", name: "M", type: null, family: null, canonical_id: null, status: null, release_date: null,
    access: "api", origin: "upstream", context: null, input: null, max_output: null, input_window: emptyInputWindow(),
    cache: "unknown", cache_modes: [], cache_mode_support: { implicit: "unknown", explicit: "unknown" },
    cache_retention: "unknown", cache_lifetime: emptyCacheLifetime(), evaluation_count: 0,
    price_in: null, price_out: null, price_from: null, pricing: pricingOf({}, "api", null, []), request_controls: controlsOf({}, NO_CACHE.retention, []),
    measured_input_accepted: null, measured_input_refused: null, measured_limit_count: 0, overridden_fields: [], verified: null, shard: 0, pi: null,
    ...more,
  };
}

export const evidence = [{ kind: "documented", url: "https://example.com/docs", date: "2026-11-01" }];

/**
 * What always holds for the cache lifetime record of an entry (section 2.6 of design/safe-cache-lifetime.md), checked
 * from the record, the entry's evaluations and its documented caching. Written apart from `cacheLifetime`: the walk
 * and the test for "contradicted" are redone here. Returns the rules that fail, empty when all hold.
 */
export function lifetimeRuleBreaks(record: CacheLifetimeRecord, evaluations: readonly CacheEvaluation[], documented: CacheDocumentation): string[] {
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
    const measured = record.lifetimes.filter((item) => item.retention_profile === profile && item.basis === "measured");
    const runs = counted.filter((evaluation) => evaluation.retention_profile === profile);
    fail(`${profile} 1 documented_s`, p.documented_s === min(docs.map((item) => item.lifetime_s)));
    fail(`${profile} 2 measured_s`, p.measured_s === min(measured.map((item) => item.lifetime_s)));
    fail(`${profile} 2 sums`, p.evaluations === measured.reduce((sum, item) => sum + item.evaluations, 0) && p.checks === measured.reduce((sum, item) => sum + item.checks, 0) && p.hits === measured.reduce((sum, item) => sum + item.hits, 0));
    fail(`${profile} 2 clients`, p.clients === new Set(measured.map((item) => item.client)).size);
    fail(`${profile} 2 ages`, p.tested_from_s === min(measured.map((item) => item.tested_from_s)) && p.first_miss_s === min(measured.map((item) => item.first_miss_s)));
    const none = p.basis === "none";
    fail(`${profile} 3 none`, [p.safe_s === null, p.source === null, p.documented_s === null && p.measured_s === null, docs.length + measured.length === 0].every((value) => value === none));
    if (p.basis === "documented") {
      const first = docs.find((item) => item.lifetime_s === p.documented_s);
      fail(`${profile} 4 documented`, p.documented_s !== null && p.safe_s === p.documented_s && first !== undefined && p.source === first.source && p.date === first.date);
    }
    if (p.basis === "measured") {
      fail(`${profile} 5 measured`, p.measured_s !== null && p.safe_s === p.measured_s && p.source === "providers.dev" && p.date === (measured.map((item) => item.date!).sort().at(-1) ?? null));
    }
    if (p.documented_s !== null) fail(`${profile} 6 not above documented`, p.safe_s !== null && p.safe_s <= p.documented_s);
    if (p.documented_s !== null && p.measured_s === null) fail(`${profile} 7 documented only`, p.basis === "documented");
    if (p.documented_s === null && p.measured_s !== null) fail(`${profile} 7 measured only`, p.basis === "measured");
    const both = p.documented_s !== null && p.measured_s !== null;
    fail(`${profile} 8 inside`, (p.checks_inside !== null && p.hits_inside !== null) === both && (!both || (p.hits_inside! <= p.checks_inside! && p.checks_inside! <= p.checks)));
    if (p.first_miss_s !== null) fail(`${profile} 9 first miss`, p.first_miss_s > (p.measured_s ?? -1) || (p.first_miss_s === 0 && p.measured_s === 0));
    // 4.1, redone: the documented lifetime is the safe value unless a counted evaluation has fewer than half its checks hit at an age inside it.
    const documentedS = p.documented_s;
    const contradicted = documentedS !== null && documentedS > 0 && runs.some((run) => run.results.some((result) => result.age_s <= documentedS && result.hits * 2 < result.checks));
    fail(`${profile} 4.1 rule`, p.basis === (documentedS !== null && !contradicted ? "documented" : p.measured_s !== null ? "measured" : "none"));
    // documented_status: set exactly where a lifetime above 0 is documented and one is measured; contradicted exactly
    // where the safe value is the measured one, not_contradicted where it is the documented one. Null everywhere else.
    const judged = documentedS !== null && documentedS > 0 && p.measured_s !== null;
    fail(`${profile} 4.1 status`, p.documented_status === (judged ? (contradicted ? "contradicted" : "not_contradicted") : null));
    fail(`${profile} 4.1 status and basis`, p.documented_status === (judged ? (p.basis === "measured" ? "contradicted" : "not_contradicted") : null));
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
    fail(`${where} kind`, item.mode === null && item.documented_as === null && item.source === "providers.dev" && members.every((member) => member?.client === item.client && member.retention_profile === item.retention_profile && member.parameter === item.parameter && member.value === item.value));
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
 * What always holds for the input window record of an entry (section 2.6 of design/usable-input-window.md), checked
 * from the record and the entry's own published `limit`, `limits.from_measurement` and `limits.measured`. Written
 * apart from `inputWindow`: the documented input (3.1), what each evaluation gives (3.3) and the test for
 * "contradicted" (4.2) are redone here. Returns the rules that fail, empty when all hold.
 */
export function inputWindowRuleBreaks(
  record: InputWindow,
  limit: unknown,
  fromMeasurement: readonly string[],
  measured: readonly (Omit<MeasuredLimit, "input_read"> & { input_read?: number | null })[],
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
  const none = r.basis === "none";
  fail("1 none", [r.tokens === null, r.bound === null && r.scope === null && r.source === null, r.documented_tokens === null && r.measured_tokens === null].every((value) => value === none));
  if (r.basis === "documented") {
    fail("2 documented", r.tokens === r.documented_tokens && r.bound === "limit" && r.source === r.documented_source && r.date === r.documented_date && r.scope === (r.documented_field === "limit.input" ? "input" : "window"));
  }
  if (r.basis === "measured") {
    fail("3 measured", r.tokens === r.measured_tokens && r.bound === r.measured_bound && r.source === "providers.dev" && r.date === r.measured_date && r.scope === (r.measured_kind === "window" ? "window" : "input"));
  }
  fail("4 documented null", (r.documented_tokens === null) === (r.documented_field === null) && (r.documented_tokens === null) === (r.documented_source === null));
  fail("4 documented value", r.documented_tokens === (documented?.tokens ?? null) && r.documented_field === (documented?.field ?? null));
  const first = r.measurements[0];
  const empty = r.measured_tokens === null;
  fail("5 measured null", [r.measurements.length === 0, r.evaluations === 0, r.clients === 0, r.measured_bound === null && r.measured_kind === null && r.measured_refused === null && r.measured_date === null].every((value) => value === empty));
  if (first) {
    fail("5 first", r.measured_tokens === first.tokens && r.measured_bound === first.bound && r.measured_kind === first.kind && r.measured_date === first.date && r.measured_refused === (first.kind === "bracket" ? first.refused : null));
    fail("5 lowest", r.measurements.every((item) => item.tokens >= first.tokens));
  }
  fail("5 counts", r.evaluations === r.measurements.length && r.clients === new Set(r.measurements.map((item) => item.client)).size);
  // 6: one item per counted evaluation, and the item is what the evaluation gives.
  const unused = [...r.measurements];
  for (const e of counted) {
    const g = gives(e)!;
    const at = unused.findIndex((item) => item.client === e.client && item.route === e.route && item.date === e.date && item.source === e.source && item.tokens === g.tokens && item.bound === g.bound && item.kind === g.kind && item.accepted === e.input_accepted && item.refused === e.input_refused && item.named === e.context && item.read === (e.input_read ?? null) && item.client_label === e.client_label && item.route_label === e.route_label);
    fail(`6 item of ${e.client} ${e.route} ${e.date}`, at >= 0);
    if (at >= 0) unused.splice(at, 1);
  }
  fail("6 no other item", unused.length === 0);
  const both = r.documented_tokens !== null && r.measured_tokens !== null;
  fail("7 status set", (r.documented_status !== null) === both);
  if (both) {
    fail("7 status and basis", (r.documented_status === "contradicted") === (r.basis === "measured") && (r.documented_status === "not_contradicted") === (r.basis === "documented"));
    // 4.2, redone from measurements.
    const D = r.documented_tokens!;
    const contradicted = r.measurements.some(
      (item) =>
        (item.named !== null && item.named < D) ||
        (item.kind === "window" && r.documented_field === "limit.context" && item.named !== D) ||
        (item.kind === "bracket" && item.refused !== null && item.refused * 100 <= D * 99) ||
        (item.kind !== "window" && item.tokens * 100 >= D * 101),
    );
    fail("7 rule", r.documented_status === (contradicted ? "contradicted" : "not_contradicted"));
  }
  if (r.documented_tokens !== null && r.measured_tokens === null) fail("8 documented only", r.basis === "documented");
  if (r.documented_tokens === null && r.measured_tokens !== null) fail("8 measured only", r.basis === "measured");
  for (const item of r.measurements) {
    const where = `9 ${item.client} ${item.route}`;
    if (item.accepted !== null && item.refused !== null) fail(`${where} accepted below refused`, item.accepted < item.refused);
    if (item.accepted !== null && item.named !== null) fail(`${where} accepted within named`, item.accepted <= item.named);
    if (item.read !== null && item.accepted !== null) fail(`${where} read within accepted`, item.read <= item.accepted);
    fail(`${where} kind`, item.kind === "window" ? item.tokens === item.named && item.bound === "limit" : item.kind === "bracket" ? item.tokens === item.accepted && item.bound === "at_least" : item.tokens === item.read && item.bound === "at_least");
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
      return entry ? { limit: structuredClone(entry.limit), cost: structuredClone(entry.cost) } : undefined;
    },
  });
  for (const { ref, block } of part.blocks) ext(lookup(ref)!).pi = block;
  return { ...result, issues: [...result.issues, ...part.issues], pi: part.report };
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
