// The data build: read the three kinds of input, resolve them, check the result, and publish it in one step.
// data/published/ is replaced only when everything succeeded; otherwise the last good publication stays.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ZodType } from "zod";
import { buildIndex, SHARD_SIZE, type Index } from "../../src/core/entries.ts";
import { resolve } from "../../src/core/resolve.ts";
import {
  AccessRules,
  AuthoredProvider,
  MeasurementLabels,
  NS,
  ObservedFile,
  OverrideFile,
  RouteMap,
  SCHEMA_VERSION,
  UPSTREAM_SCHEMA,
  type Catalog,
  type Issue,
  type Meta,
  type ProviderExtension,
  type SourceMeta,
} from "../../src/core/schema.ts";
import { readJsonIfExists, sha256, swapDir } from "./files.ts";
import { loadUpstream, type SyncStatus } from "./sync.ts";

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

  const observedPath = join(dataDir, "sources", "observed.json");
  let observed: ObservedFile | undefined;
  if (existsSync(observedPath)) {
    const checked = ObservedFile.safeParse(JSON.parse(readFileSync(observedPath, "utf8")));
    if (checked.success) observed = checked.data;
    else errors.push(`${observedPath}: ${checked.error.issues[0]?.message}`);
  }
  if (errors.length > 0 || !access || !routes) return { ok: false, errors, issues: [] };

  const { catalog, issues, exclusions } = resolve({ upstream: upstream.catalog, additions, overrides, access, routes, ...(labels ? { labels } : {}), ...(observed ? { observed } : {}) });
  for (const issue of issues) if (issue.level === "error") errors.push(`${issue.target}: ${issue.message}`);
  if (errors.length > 0) return { ok: false, errors, issues };

  const generatedAt = options.now().toISOString();
  const datasetVersion = sha256(compact({ catalog, exclusions })).slice(0, 16);
  const index = buildIndex(catalog, datasetVersion, generatedAt);
  const observedMeta = readJsonIfExists<SourceMeta>(join(dataDir, "sources", "observed.meta.json"));
  const status = readJsonIfExists<SyncStatus>(join(dataDir, "sync-status.json"));

  const meta: Meta = {
    api_version: "v1",
    schema_version: SCHEMA_VERSION,
    upstream_schema: UPSTREAM_SCHEMA,
    dataset_version: datasetVersion,
    generated_at: generatedAt,
    counts: {
      providers: index.providers.length,
      models: index.entries.length,
      added_providers: index.providers.filter((provider) => provider.origin === "added").length,
      added_models: index.entries.filter((entry) => entry.origin === "added").length,
      overridden_models: index.entries.filter((entry) => entry.overridden_fields.length > 0).length,
      measured_models: index.entries.filter((entry) => entry.evaluations > 0).length,
    },
    upstream: upstream.meta,
    ...(observed && observedMeta
      ? { measurements: { ...observedMeta, repository: observed.repository, runs: index.entries.reduce((sum, entry) => sum + entry.evaluations, 0), limits: observed.limits.length } }
      : {}),
    sync: status
      ? { last_attempt_at: status.last_attempt_at, last_attempt_ok: status.last_attempt_ok, ...(status.last_error ? { last_error: status.last_error } : {}) }
      : {},
    exclusions,
    issues,
    license: {
      data: "MIT",
      upstream: "models.dev, MIT License, Copyright (c) 2025 models.dev",
      notice: "Baseline imported from https://models.dev. providers.dev is not affiliated with or endorsed by models.dev.",
    },
  };

  if (index.providers.length === 0 || index.entries.length === 0) return { ok: false, errors: ["The resolved catalog is empty."], issues };

  const next = `${join(dataDir, "published")}.tmp-${process.pid}`;
  rmSync(next, { recursive: true, force: true });
  try {
    writeSnapshot(next, catalog, index, meta, options.rootDir);
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
  writeFileSync(join(site, "data", "catalog.json"), compact({ meta: short, providers: catalog }));
  writeFileSync(join(site, "data", "meta.json"), compact(meta));
  writeFileSync(join(site, "data", "index.json"), compact(index));
  writeFileSync(
    join(site, "data", "providers.json"),
    compact({
      meta: short,
      data: index.providers.map((provider) => ({ ...provider, [NS]: (catalog[provider.id] as Catalog[string])[NS] as unknown as ProviderExtension })),
    }),
  );
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
      "Everything under a `providers_dev` key, every entry whose `providers_dev.origin` is \"added\", and every field listed",
      "in a `providers_dev.provenance` array is by providers.dev and is not part of models.dev.",
      "providers.dev is not affiliated with or endorsed by models.dev.",
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

  // What the Worker bundles: the index for /api/v1/models and the metadata.
  mkdirSync(join(dir, "worker"), { recursive: true });
  writeFileSync(join(dir, "worker", "index.json"), compact(index));
  writeFileSync(join(dir, "worker", "meta.json"), compact(meta));
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
