// The data build: read the three kinds of input, resolve them, check the result, and publish it in one step.
// data/published/ is replaced only when everything succeeded; otherwise the last good publication stays.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parse as parseYaml } from "yaml";
import type { ZodType } from "zod";
import { CACHE_AGES_S } from "../../src/core/cache.ts";
import { MetaSchema, PiBlockSchema, PiSummarySchema } from "../../src/core/contract.ts";
import { buildIndex, SHARD_SIZE, type Index } from "../../src/core/entries.ts";
import { listCorrections, listEvaluations } from "../../src/core/resources.ts";
import type { PiCatalog } from "../../src/core/pi.ts";
import { resolve } from "../../src/core/resolve.ts";
import {
  AccessRules,
  AuthoredProvider,
  CatalogRules,
  ext,
  MeasurementLabels,
  ObservedFile,
  OverrideFile,
  PI_URL,
  PiAliases,
  RouteMap,
  UPSTREAM_SCHEMA,
  type Catalog,
  type Issue,
  type Meta,
  type PiMeta,
  type SourceMeta,
} from "../../src/core/schema.ts";
import { readJsonIfExists, sha256, swapDir } from "./files.ts";
import { storedPi } from "./pi-sync.ts";
import { loadUpstream, PiSyncRecord, type SyncStatus } from "./sync.ts";

/**
 * providers.dev evidence (a correction, an evaluation, a measured lifetime) whose date is more than this many days before
 * today is shown as stale. Set here once and published as `stale_after_days` of /api/v1/meta: pages read it from there.
 */
export const STALE_AFTER_DAYS = 90;

export interface PublishOptions {
  dataDir: string;
  /** The folder holding LICENSES/models.dev-MIT.txt. */
  rootDir: string;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface PublishReport {
  ok: boolean;
  errors: string[];
  issues: Issue[];
  meta?: Meta;
}

function loadYamlDir<T>(dir: string, schema: ZodType<T>, errors: string[], idOf: (value: T) => string): T[] {
  if (!existsSync(dir)) return [];
  const out: T[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".yaml")) continue;
    const loaded = loadYaml(join(dir, file), schema, errors);
    if (!loaded) continue;
    const expected = file.replace(/\.yaml$/, "");
    if (idOf(loaded) !== expected) errors.push(`${join(dir, file)}: the file name must be the provider id (${idOf(loaded)}.yaml).`);
    else out.push(loaded);
  }
  return out;
}

function loadYaml<T>(path: string, schema: ZodType<T>, errors: string[]): T | undefined {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${path}: not valid YAML (${error instanceof Error ? error.message : String(error)})`);
    return undefined;
  }
  const checked = schema.safeParse(raw);
  if (!checked.success) {
    for (const issue of checked.error.issues) errors.push(`${path}: ${issue.path.join(".") || "(file)"}: ${issue.message}`);
    return undefined;
  }
  return checked.data;
}

const compact = (value: unknown): string => JSON.stringify(value);

/** pi's project, licence and the copyright line of its LICENSE file (LICENSES/pi-MIT.txt). */
const PI_LICENSE = "pi (https://github.com/earendil-works/pi), MIT License, Copyright (c) 2025 Mario Zechner";

/**
 * The pi snapshot in data/pi/, where it is usable (`storedPi`, the sync's answer too). Undefined where there is none,
 * and where it cannot be used (an edit by hand, or a schema that moved on): then the warning pi-snapshot-unreadable is raised.
 */
function readPi(dataDir: string, issues: Issue[]): { catalog: PiCatalog; meta: PiMeta } | undefined {
  const stored = storedPi(dataDir);
  if (stored.state === "unusable") issues.push(piUnreadable(stored.why));
  return stored.state === "usable" ? { catalog: stored.catalog, meta: stored.meta } : undefined;
}

/** The warning of a dataset built without pi data because what came from pi cannot be used. */
function piUnreadable(why: string): Issue {
  return { level: "warning", code: "pi-snapshot-unreadable", target: "data/pi", message: `The pi snapshot in data/pi/ cannot be read (${why}). The dataset is built without pi data: no entry has a pi block.` };
}

/**
 * The first value the build would publish for pi that the contract refuses, and where, or null where all fit:
 * `meta.pi`, the `pi` of every entry and the `pi` of every summary, each against the contract's own schema.
 */
export function piMisfit(catalog: Catalog, index: Index, meta: Meta): string | null {
  const first = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }, where: string): string | null => {
    if (result.success) return null;
    const issue = result.error?.issues[0];
    return `${where}${issue && issue.path.length > 0 ? `.${issue.path.map(String).join(".")}` : ""}: ${issue?.message ?? "does not fit"}`;
  };
  const found = first(MetaSchema.shape.pi.safeParse(meta.pi), "meta.pi");
  if (found) return found;
  for (const [provider, record] of Object.entries(catalog)) {
    for (const [model, entry] of Object.entries(record.models)) {
      const block = first(PiBlockSchema.nullable().safeParse(ext(entry).pi), `providers_dev.pi of the entry ${provider}/${model}`);
      if (block) return block;
    }
  }
  for (const summary of index.entries) {
    const short = first(PiSummarySchema.nullable().safeParse(summary.pi), `pi of the summary ${summary.ref}`);
    if (short) return short;
  }
  return null;
}

/**
 * The last attempt to import pi's catalog, from the `pi` key of data/sync-status.json. All null = none is recorded, or
 * the record does not fit PiSyncRecord: then the warning pi-snapshot-unreadable says so.
 */
function piSync(status: Partial<SyncStatus> | undefined, issues: Issue[]): Meta["pi"]["sync"] {
  const none = { last_attempt_at: null, last_attempt_ok: null, last_error: null };
  if (status?.pi === undefined) return none;
  const checked = PiSyncRecord.safeParse(status.pi);
  if (!checked.success) {
    const first = checked.error.issues[0];
    issues.push({ level: "warning", code: "pi-snapshot-unreadable", target: "data/sync-status.json", message: `The record of the last pi import in data/sync-status.json cannot be read (${first ? `pi${first.path.length > 0 ? `.${first.path.join(".")}` : ""}: ${first.message}` : "unknown"}). It is published as no attempt recorded.` });
    return none;
  }
  const pi = checked.data;
  return { last_attempt_at: pi.last_attempt_at, last_attempt_ok: pi.status !== "failed", last_error: pi.error ?? null };
}

export function publish(input: PublishOptions): PublishReport {
  const options = { now: () => new Date(), ...input };
  const { dataDir } = options;
  const errors: string[] = [];

  const upstream = loadUpstream(dataDir);
  if (!upstream) {
    return { ok: false, issues: [], errors: [`No upstream snapshot in ${join(dataDir, "upstream")}. Run \`npm run sync\` first.`] };
  }

  const authored = join(dataDir, "authored");
  const additions = loadYamlDir(join(authored, "providers"), AuthoredProvider, errors, (value) => value.id);
  const overrides = loadYamlDir(join(authored, "overrides"), OverrideFile, errors, (value) => value.provider);
  const access = loadYaml(join(authored, "access.yaml"), AccessRules, errors);
  const routes = loadYaml(join(authored, "routes.yaml"), RouteMap, errors);
  const labelsPath = join(authored, "measurement-labels.yaml");
  const labels = existsSync(labelsPath) ? loadYaml(labelsPath, MeasurementLabels, errors) : undefined;
  const rulesPath = join(authored, "catalog-rules.yaml");
  const catalogRules = existsSync(rulesPath) ? loadYaml(rulesPath, CatalogRules, errors) : undefined;
  // The adapter between pi's spelling and the catalog's. May be absent: then only equal ids match.
  const aliasesPath = join(authored, "pi-aliases.yaml");
  const piAliases = existsSync(aliasesPath) ? loadYaml(aliasesPath, PiAliases, errors) : undefined;

  const observedPath = join(dataDir, "sources", "observed.json");
  let observed: ObservedFile | undefined;
  if (existsSync(observedPath)) {
    const checked = ObservedFile.safeParse(JSON.parse(readFileSync(observedPath, "utf8")));
    if (checked.success) observed = checked.data;
    else errors.push(`${observedPath}: ${checked.error.issues[0]?.message}`);
  }
  if (errors.length > 0 || !access || !routes) return { ok: false, errors, issues: [] };

  // The pi snapshot, checked against PiFeed. A snapshot that is missing builds the dataset without pi data; one that
  // the code cannot read does too, with a warning. The build never fails for pi.
  const piIssues: Issue[] = [];
  const stored = readPi(dataDir, piIssues);
  const status = readJsonIfExists<Partial<SyncStatus>>(join(dataDir, "sync-status.json"));
  const piRecord = piSync(status, piIssues);
  const generatedAt = options.now().toISOString();

  /** The dataset from the catalog's sources and `pi`, the pi snapshot or none. */
  const assemble = (pi: ReturnType<typeof readPi>) => {
    const { catalog, issues: resolved, exclusions, pi: piResult } = resolve({
      upstream: upstream.catalog,
      additions,
      overrides,
      access,
      routes,
      upstreamDate: upstream.meta.fetched_at.slice(0, 10),
      ...(labels ? { labels } : {}),
      ...(catalogRules ? { catalogRules } : {}),
      ...(observed ? { observed } : {}),
      ...(pi ? { pi: { catalog: pi.catalog, ...(piAliases ? { aliases: piAliases } : {}) } } : {}),
    });
    const issues = [...resolved, ...piIssues];
    // The version covers everything a reader can get: the catalog and the summaries made from it. A new summary field
    // changes the version (and with it every ETag) also when the catalog itself did not change.
    const draft = buildIndex(catalog, "", generatedAt, upstream.meta.fetched_at);
    const datasetVersion = sha256(compact({ catalog, exclusions, providers: draft.providers, entries: draft.entries })).slice(0, 16);
    const index = buildIndex(catalog, datasetVersion, generatedAt, upstream.meta.fetched_at);
    const observedMeta = readJsonIfExists<SourceMeta>(join(dataDir, "sources", "observed.meta.json"));

    const meta: Meta = {
      api_version: "v1",
      upstream_schema: UPSTREAM_SCHEMA,
      dataset_version: datasetVersion,
      generated_at: generatedAt,
      counts: {
        providers: index.providers.length,
        entries: index.entries.length,
        models: new Set(index.entries.map((entry) => entry.canonical_id).filter(Boolean)).size,
        added_providers: index.providers.filter((provider) => provider.origin === "added").length,
        added_entries: index.entries.filter((entry) => entry.origin === "added").length,
        corrected_entries: index.entries.filter((entry) => entry.overridden_fields.length > 0).length,
        evaluated_entries: index.entries.filter((entry) => entry.evaluation_count > 0).length,
        cache_evaluations: index.entries.reduce((sum, entry) => sum + entry.evaluation_count, 0),
        limit_evaluations: index.entries.reduce((sum, entry) => sum + entry.measured_limit_count, 0),
      },
      cache_ages_s: [...CACHE_AGES_S],
      stale_after_days: STALE_AFTER_DAYS,
      // Every key is always there: what is not known is null.
      upstream: {
        source: upstream.meta.source,
        schema: upstream.meta.schema,
        fetched_at: upstream.meta.fetched_at,
        checked_at: upstream.meta.checked_at,
        etag: upstream.meta.etag ?? null,
        commit: upstream.meta.commit ?? null,
        commit_date: upstream.meta.commit_date ?? null,
        sha256: upstream.meta.sha256,
        providers: upstream.meta.providers,
        models: upstream.meta.models,
      },
      measurements:
        observed && observedMeta
          ? { source: observedMeta.source, fetched_at: observedMeta.fetched_at, checked_at: observedMeta.checked_at, etag: observedMeta.etag ?? null, sha256: observedMeta.sha256, repository: observed.repository }
          : null,
      sync: { last_attempt_at: status?.last_attempt_at ?? null, last_attempt_ok: status?.last_attempt_ok ?? null, last_error: status?.last_error ?? null },
      exclusions,
      issues,
      license: {
        data: "MIT",
        upstream: "models.dev, MIT License, Copyright (c) 2025 models.dev",
        notice: "Baseline imported from https://models.dev. providers.dev is not affiliated with or endorsed by models.dev.",
        pi: PI_LICENSE,
        pi_notice: "The pi block of an entry (providers_dev.pi) is imported from https://pi.dev/api/models. providers.dev is not affiliated with or endorsed by pi.",
      },
      pi: {
        source: PI_URL,
        snapshot: pi
          ? {
              fetched_at: pi.meta.fetched_at,
              checked_at: pi.meta.checked_at,
              etag: pi.meta.etag ?? null,
              last_modified: pi.meta.last_modified ?? null,
              revision: pi.meta.revision ?? null,
              sha256: pi.meta.sha256,
              providers: pi.meta.providers,
              models: pi.meta.models,
            }
          : null,
        sync: piRecord,
        counts: {
          entries_with_block: piResult ? piResult.totals.matched_id + piResult.totals.matched_alias : 0,
          left_out_models: piResult?.totals.left_out ?? 0,
          unmatched_models: piResult?.totals.unmatched ?? 0,
        },
      },
    };

    return { catalog, issues, exclusions, piResult, index, meta };
  };
  let built = assemble(stored);
  // The net under the pi part: what the build is about to publish for pi must fit the contract. Where it does not, the
  // dataset is built without pi data, as for a snapshot that cannot be used. It decides nothing else and repairs nothing.
  const misfit = stored ? piMisfit(built.catalog, built.index, built.meta) : null;
  if (misfit) {
    piIssues.push(piUnreadable(`what the build would publish for pi does not fit the contract: ${misfit}`));
    built = assemble(undefined);
  }
  const { catalog, issues, index, meta, piResult } = built;
  for (const issue of issues) if (issue.level === "error") errors.push(`${issue.target}: ${issue.message}`);
  if (errors.length > 0) return { ok: false, errors, issues };

  if (index.providers.length === 0 || index.entries.length === 0) return { ok: false, errors: ["The resolved catalog is empty."], issues };

  const next = `${join(dataDir, "published")}.tmp-${process.pid}`;
  rmSync(next, { recursive: true, force: true });
  try {
    writeSnapshot(next, catalog, index, meta, options.rootDir);
    // Beside the published data, not under site/: never staged, served or part of the API.
    if (piResult) writeFileSync(join(next, "pi-report.json"), `${JSON.stringify(piResult, null, 1)}\n`);
    verifySnapshot(next, index);
  } catch (error) {
    rmSync(next, { recursive: true, force: true });
    return { ok: false, errors: [`Writing the snapshot failed: ${error instanceof Error ? error.message : String(error)}`], issues };
  }
  swapDir(next, join(dataDir, "published"));
  return { ok: true, errors: [], issues, meta };
}

function writeSnapshot(dir: string, catalog: Catalog, index: Index, meta: Meta, rootDir: string): void {
  const site = join(dir, "site");
  const short = { dataset_version: meta.dataset_version, generated_at: meta.generated_at, upstream_fetched_at: meta.upstream.fetched_at };
  mkdirSync(join(site, "data", "providers"), { recursive: true });

  // The compatibility export: provider-keyed, no envelope.
  writeFileSync(join(site, "api.json"), compact(catalog));
  writeFileSync(join(site, "api.json.gz"), gzipSync(compact(catalog), { level: 9 }));
  writeFileSync(join(site, "data", "catalog.json"), compact({ meta: short, data: catalog }));
  writeFileSync(join(site, "data", "catalog.json.gz"), gzipSync(compact({ meta: short, data: catalog }), { level: 9 }));
  writeFileSync(join(site, "data", "meta.json"), compact(meta));
  writeFileSync(join(site, "data", "index.json"), compact(index));
  // The index holds every summary with its pricing record and grows with the catalog: it is staged as gzip too.
  writeFileSync(join(site, "data", "index.json.gz"), gzipSync(compact(index), { level: 9 }));
  // Every evaluation with the entry it was made on: what /api/v1/evaluations/cache and /limits answer from.
  writeFileSync(join(site, "data", "evaluations.json"), compact({ meta: short, data: listEvaluations(catalog, index) }));
  writeFileSync(join(site, "data", "corrections.json"), compact({ meta: short, data: listCorrections(catalog, index) }));
  for (const [id, provider] of Object.entries(catalog)) {
    writeFileSync(join(site, "data", "providers", `${id}.json`), compact({ meta: short, data: provider }));
    const models = Object.entries(provider.models);
    mkdirSync(join(site, "data", "entries", id), { recursive: true });
    for (let start = 0; start < models.length; start += SHARD_SIZE) {
      const shard = Object.fromEntries(models.slice(start, start + SHARD_SIZE));
      writeFileSync(join(site, "data", "entries", id, `${start / SHARD_SIZE}.json`), compact(shard));
    }
  }

  const license = readFileSync(join(rootDir, "LICENSES", "models.dev-MIT.txt"), "utf8");
  writeFileSync(join(site, "data", "LICENSE-models.dev.txt"), license);
  writeFileSync(join(site, "data", "LICENSE-pi.txt"), readFileSync(join(rootDir, "LICENSES", "pi-MIT.txt"), "utf8"));
  const piSnapshot = meta.pi.snapshot;
  writeFileSync(
    join(site, "data", "NOTICE.txt"),
    [
      "providers.dev dataset",
      `Dataset version ${meta.dataset_version}, generated ${meta.generated_at}.`,
      "",
      "The baseline of this dataset is imported from models.dev (https://models.dev,",
      "https://github.com/anomalyco/models.dev), MIT License, Copyright (c) 2025 models.dev.",
      `Imported ${meta.upstream.fetched_at}${meta.upstream.commit ? ` at commit ${meta.upstream.commit}` : ""}. The full license is in LICENSE-models.dev.txt.`,
      "",
      "Everything under a `providers_dev` key except `providers_dev.pi`, every entry whose `providers_dev.origin` is \"added\"",
      "(its `providers_dev.pi` excepted), and every field listed in a `providers_dev.provenance` array is by providers.dev",
      "and is not part of models.dev.",
      "providers.dev is not affiliated with or endorsed by models.dev.",
      "",
      "The pi block of an entry (providers_dev.pi) is imported from the model catalog of pi",
      "(https://pi.dev/api/models, https://github.com/earendil-works/pi), MIT License, Copyright (c) 2025 Mario Zechner.",
      piSnapshot
        ? `Imported ${piSnapshot.fetched_at}${piSnapshot.revision ? ` at catalog revision ${piSnapshot.revision}` : ""}. The full license is in LICENSE-pi.txt.`
        : "This dataset holds no pi data. The full license is in LICENSE-pi.txt.",
      "providers.dev is not affiliated with or endorsed by pi.",
      "",
    ].join("\n"),
  );

  const freshness = [
    "  Access-Control-Allow-Origin: *",
    "  Access-Control-Expose-Headers: ETag, X-Dataset-Version, X-Dataset-Generated-At, X-Upstream-Fetched-At",
    "  Cache-Control: public, max-age=300, stale-while-revalidate=3600",
    `  X-Dataset-Version: ${meta.dataset_version}`,
    `  X-Dataset-Generated-At: ${meta.generated_at}`,
    `  X-Upstream-Fetched-At: ${meta.upstream.fetched_at}`,
  ].join("\n");
  writeFileSync(join(site, "_headers"), `/api.json\n${freshness}\n\n/data/*\n${freshness}\n`);

}

/** Read the snapshot back the way a client would: every entry of the index must be found in its file. */
function verifySnapshot(dir: string, index: Index): void {
  const site = join(dir, "site");
  const exported = JSON.parse(readFileSync(join(site, "api.json"), "utf8")) as Catalog;
  const shards = new Map<string, Record<string, unknown>>();
  for (const entry of index.entries) {
    const key = `${entry.provider}/${entry.shard}`;
    let shard = shards.get(key);
    if (!shard) {
      shard = JSON.parse(readFileSync(join(site, "data", "entries", entry.provider, `${entry.shard}.json`), "utf8")) as Record<string, unknown>;
      shards.set(key, shard);
    }
    if (!shard[entry.model] || !exported[entry.provider]?.models[entry.model]) {
      throw new Error(`entry ${entry.ref} is in the index but not in the written files`);
    }
  }
}
