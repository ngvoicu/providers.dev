import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import type { ApiDeps } from "../src/core/api.ts";
import { addResults, documentedCache, emptyCacheLifetime, RETENTION_PROFILES, type CacheDocumentation, type CacheEvaluation, type CacheLifetimeRecord, type CacheResult, type EntryCache } from "../src/core/cache.ts";
import type { Index, Summary } from "../src/core/entries.ts";
import { controlsOf, pricingOf } from "../src/core/policies.ts";
import type { MeasuredLimit, Meta, ModelExtension, UpstreamCatalog } from "../src/core/schema.ts";
import { ROOT } from "../scripts/lib/files.ts";

/** The cache record of an entry nothing is known about. */
export const NO_CACHE: EntryCache = { documented: documentedCache({}), retention: { support: "unknown", parameter: null, accepted_values: null, default: null, profiles: [], conditions: [], evidence: [] }, lifetime: emptyCacheLifetime(), results: null, evaluations: [] };

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
    limits: { measured: [], from_measurement: [] },
    evidence: [],
    verified: null,
    ...more,
  };
}

/** A complete limit evaluation: what it did not measure is null. */
export function limitOf(more: Partial<MeasuredLimit> = {}): MeasuredLimit {
  return { route: "r", route_label: "R", client: "direct", client_label: "Direct", context: null, output: null, input_accepted: null, input_refused: null, output_accepted: null, note: null, date: null, source: "https://example.com/result", ...more };
}

/** A complete entry summary with nothing known. */
export function summaryOf(more: Partial<Summary> = {}): Summary {
  return {
    ref: "p/m", provider: "p", model: "m", name: "M", type: null, family: null, canonical_id: null, status: null, release_date: null,
    access: "api", origin: "upstream", context: null, input: null, max_output: null,
    cache: "unknown", cache_modes: [], cache_mode_support: { implicit: "unknown", explicit: "unknown" }, cache_ttl_s: [], cache_ttl_by_mode_s: { implicit: null, explicit: null },
    cache_retention: "unknown", evaluation_count: 0, cache_results: null,
    price_in: null, price_out: null, price_from: null, pricing: pricingOf({}, "api", null, []), request_controls: controlsOf({}, NO_CACHE.retention, []),
    measured_input_accepted: null, measured_input_refused: null, measured_limit_count: 0, overridden_fields: [], verified: null, shard: 0,
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
      if (/^\/reference-content\/docs\/(methodology|licensing)\.json$/.test(path)) {
        return new Response(JSON.stringify({ title: "Reference fixture", description: "Reference", lead: "Reference", toc: [], body_html: "<p>Reference fixture</p>" }));
      }
      const file = join(publishedDir, "site", path);
      return existsSync(file) ? new Response(readFileSync(file)) : null;
    },
  };
}

export { ROOT };
