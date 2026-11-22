// The data build: read the three kinds of input, resolve them, check the result, and publish it in one step.
// data/published/ is replaced only when everything succeeded; otherwise the last good publication stays.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parse as parseYaml } from "yaml";
import { z, type ZodType } from "zod";
import { CACHE_AGES_S } from "../../src/core/cache.ts";
import { buildIndex, SHARD_SIZE, type Index } from "../../src/core/entries.ts";
import { listCorrections, listEvaluations } from "../../src/core/resources.ts";
import { resolve } from "../../src/core/resolve.ts";
import { layPi, mirror } from "../../src/core/safe.ts";
import {
  AccessRules,
  AuthoredListing,
  AuthoredProvider,
  CatalogRules,
  ext,
  MeasurementLabels,
  ObservedFile,
  OverrideFile,
  PiAliases,
  RouteMap,
  UPSTREAM_SCHEMA,
  type Catalog,
  type Issue,
  type Meta,
  type PublishedModel,
  type SourceMeta,
} from "../../src/core/schema.ts";
import { readJsonIfExists, sha256, swapDir } from "./files.ts";
import { fenced } from "./fenced.ts";
import { piOfBuild, type PiOfBuild } from "./pi-fence.ts";
import { LISTED_URL, loadUpstream, type SyncStatus } from "./sync.ts";
import { buildListings, type Listing } from "../../src/core/listings.ts";

/**
 * providers.dev evidence (a correction, an evaluation, a measured lifetime) whose date is more than this many days before
 * today is shown as stale. Set here once and published as `stale_after_days` of /api/v1/meta: pages read it from there.
 */
export const STALE_AFTER_DAYS = 90;

/** How many summaries one part of the index holds (data/index-parts/), about 1.2 MB of JSON each today. */
export const INDEX_PART_SIZE = 250;

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
  /** What became of pi's part (scripts/lib/pi-fence.ts). Absent on every return before it was looked at. */
  pi?: PiOfBuild["state"];
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
  // What providers.dev states of a provider's model list (src/core/listings.ts). May be absent.
  const authoredListings = loadYamlDir(join(authored, "listings"), AuthoredListing, errors, (value) => value.provider);
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


  // The dataset, complete without pi: every entry and summary has `pi: null`.
  const { catalog, issues: resolved, exclusions, before, ruledOut } = resolve({
    upstream: upstream.catalog,
    additions,
    overrides,
    access,
    routes,
    upstreamDate: upstream.meta.fetched_at.slice(0, 10),
    ...(labels ? { labels } : {}),
    ...(catalogRules ? { catalogRules } : {}),
    ...(observed ? { observed } : {}),
  });
  // An error or an empty catalog ends the build here, before anything of pi's is touched.
  for (const issue of resolved) if (issue.level === "error") errors.push(`${issue.target}: ${issue.message}`);
  if (errors.length > 0) return { ok: false, errors, issues: resolved };
  if (Object.keys(catalog).length === 0 || Object.values(catalog).every((provider) => Object.keys(provider.models).length === 0)) {
    return { ok: false, errors: ["The resolved catalog is empty."], issues: resolved };
  }

  const status = readJsonIfExists<Partial<SyncStatus>>(join(dataDir, "sync-status.json"));
  // pi's part, behind the fence: checked, plain data, or nothing and a warning that says why.
  const pi = piOfBuild({ dataDir, status, aliases: piAliases, catalog, before, ruledOut });
  // Each block laid on its entry, and pi's statements over the entry's safe values, by the reference's own code
  // (design/sources-side-by-side.md, section 4): pi's item is added last, and fills only what no other source states.
  for (const [providerId, provider] of Object.entries(catalog)) {
    for (const [modelId, model] of Object.entries(provider.models)) {
      const found = pi.entries.get(`${providerId}/${modelId}`);
      if (!found) continue;
      const extension = ext(model);
      extension.pi = found.block;
      extension.safe = layPi(extension.safe, found.statements, { access: extension.access, chosen: extension.limits.input_window.measurements.filter((item) => item.chosen) });
      mirror(extension);
    }
  }
  const withPi = (index: Index): Index => {
    for (const summary of index.entries) {
      const found = pi.entries.get(summary.ref);
      if (found) summary.pi = found.summary;
    }
    return index;
  };
  const issues = [...resolved, ...pi.issues];

  // The private report is pi's file, so its write goes through the guard, the one use of it in this module, and
  // before meta.json, so that a failure is a warning in it. Beside the published data, not under site/: never
  // staged, served or part of the API. A failure leaves the file out; the dataset is published as usual.
  const next = `${join(dataDir, "published")}.tmp-${process.pid}`;
  rmSync(next, { recursive: true, force: true });
  if (pi.report !== null) {
    const text = pi.report;
    const written = fenced(() => {
      mkdirSync(next, { recursive: true });
      try {
        writeFileSync(join(next, "pi-report.json"), text);
      } catch (error) {
        rmSync(join(next, "pi-report.json"), { force: true });
        throw error;
      }
      return true as const;
    }, z.literal(true));
    if (!written.ok) {
      issues.push({ level: "warning", code: "pi-snapshot-unreadable", target: "data/published/pi-report.json", message: `pi's report could not be written (${written.why}). The dataset is published with pi's data as usual; only data/published/pi-report.json is missing.` });
    }
  }
  const generatedAt = options.now().toISOString();

  // The version covers everything a reader can get: the catalog and the summaries made from it. A new summary field
  // changes the version (and with it every ETag) also when the catalog itself did not change.
  // The listings: every model a provider offers, measured or not (src/core/listings.ts). Built from the catalog as
  // published, after pi's blocks were laid on it; nothing of a listing is written back into an entry.
  const leftOut = ruledOut.flatMap(({ ref }) => {
    const slash = ref.indexOf("/");
    const model = upstream.catalog[ref.slice(0, slash)]?.models[ref.slice(slash + 1)];
    return model ? [{ ref, model: model as unknown as PublishedModel }] : [];
  });
  const built = buildListings({ catalog, upstreamDate: upstream.meta.fetched_at.slice(0, 10), authored: authoredListings, ruledOut: leftOut, pi: pi.lists });
  const listings = built.listings;
  issues.push(...built.issues);

  const draft = withPi(buildIndex(catalog, "", generatedAt, upstream.meta.fetched_at));
  const datasetVersion = sha256(compact({ catalog, exclusions, providers: draft.providers, entries: draft.entries, listings })).slice(0, 16);
  const index = withPi(buildIndex(catalog, datasetVersion, generatedAt, upstream.meta.fetched_at));
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
    pi: pi.meta,
    listings: {
      count: listings.length,
      models: listings.reduce((sum, listing) => sum + listing.model_count, 0),
      by_basis: {
        listed: listings.filter((listing) => listing.basis === "listed").length,
        "providers.dev": listings.filter((listing) => listing.basis === "providers.dev").length,
        "models.dev": listings.filter((listing) => listing.basis === "models.dev").length,
        "pi.dev": listings.filter((listing) => listing.basis === "pi.dev").length,
      },
      source: LISTED_URL,
      fetched_at: null,
      checked_at: null,
      listed_at: null,
      sync: { last_attempt_at: null, last_attempt_ok: null, last_error: null },
    },
  };

  try {
    writeSnapshot(next, catalog, index, meta, listings, options.rootDir);
    verifySnapshot(next, index);
  } catch (error) {
    rmSync(next, { recursive: true, force: true });
    return { ok: false, errors: [`Writing the snapshot failed: ${error instanceof Error ? error.message : String(error)}`], issues, pi: pi.state };
  }
  swapDir(next, join(dataDir, "published"));
  return { ok: true, errors: [], issues, meta, pi: pi.state };
}

/**
 * The step output of the build step of the Publish workflow: `pi=<published|published_without_blocks|none|turned_away>`, appended to the file
 * GitHub names in GITHUB_OUTPUT. No line where the report has no `pi` (the build ended before pi was looked at).
 */
export function writeBuildOutputs(report: PublishReport, path: string): void {
  if (report.pi === undefined) return;
  appendFileSync(path, `pi=${report.pi}\n`);
}

function writeSnapshot(dir: string, catalog: Catalog, index: Index, meta: Meta, listings: Listing[], rootDir: string): void {
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
  // The same index in parts, for the Worker: it parses them one after another, so that it never holds the whole
  // text beside the parsed summaries (src/core/snapshot.ts). The head carries everything but the summaries.
  mkdirSync(join(site, "data", "index-parts"), { recursive: true });
  const { entries: summaries, ...head } = index;
  const parts = Math.ceil(summaries.length / INDEX_PART_SIZE);
  writeFileSync(join(site, "data", "index-parts", "head.json.gz"), gzipSync(compact({ ...head, parts }), { level: 9 }));
  for (let part = 0; part < parts; part += 1) {
    writeFileSync(join(site, "data", "index-parts", `${part}.json.gz`), gzipSync(compact(summaries.slice(part * INDEX_PART_SIZE, (part + 1) * INDEX_PART_SIZE)), { level: 9 }));
  }
  // Every evaluation with the entry it was made on: what /api/v1/evaluations/cache and /limits answer from.
  writeFileSync(join(site, "data", "evaluations.json"), compact({ meta: short, data: listEvaluations(catalog, index) }));
  writeFileSync(join(site, "data", "corrections.json"), compact({ meta: short, data: listCorrections(catalog, index) }));
  // Every listing in full, by provider id: what /api/v1/listings and /api/v1/listings/{provider} answer from.
  // The listings: every one without its models in one file, and each one in full in a file of its own, so that no
  // answer reads more than the listings it gives (all of them in full are some 10 MB).
  writeFileSync(join(site, "data", "listings.json"), compact({ meta: short, data: listings.map((listing) => ({ ...listing, models: null })) }));
  mkdirSync(join(site, "data", "listings"), { recursive: true });
  for (const listing of listings) writeFileSync(join(site, "data", "listings", `${listing.provider}.json`), compact({ meta: short, data: listing }));
  for (const [id, provider] of Object.entries(catalog)) {
    writeFileSync(join(site, "data", "providers", `${id}.json`), compact({ meta: short, data: provider }));
    // The provider's entries in full, alone: the Worker streams them into /api/v1/providers/{id}?view=full without
    // parsing them (src/core/api.ts). The same bytes as `models` of the file above.
    mkdirSync(join(site, "data", "provider-models"), { recursive: true });
    writeFileSync(join(site, "data", "provider-models", `${id}.json`), compact(provider.models));
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
