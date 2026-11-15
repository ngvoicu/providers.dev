import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import type { ApiDeps } from "../src/core/api.ts";
import { documentedCache, type EntryCache } from "../src/core/cache.ts";
import type { Index, Summary } from "../src/core/entries.ts";
import { controlsOf, pricingOf } from "../src/core/policies.ts";
import type { MeasuredLimit, Meta, ModelExtension, UpstreamCatalog } from "../src/core/schema.ts";
import { ROOT } from "../scripts/lib/files.ts";

/** The cache record of an entry nothing is known about. */
export const NO_CACHE: EntryCache = { documented: documentedCache({}), retention: { support: "unknown", parameter: null, accepted_values: null, default: null, profiles: [], conditions: [], evidence: [] }, results: null, evaluations: [] };

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
