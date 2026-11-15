// The upstream sync. It fetches models.dev once, checks what came back, and only then replaces the snapshot
// in data/upstream/. Anything that goes wrong leaves the previous snapshot exactly as it was.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deepEqual } from "../../src/core/merge.ts";
import { ObservedFile, UPSTREAM_SCHEMA, UpstreamCatalog, type SourceMeta, type UpstreamMeta } from "../../src/core/schema.ts";
import { pretty, readJson, readJsonIfExists, sha256, swapDir, writeFileAtomic } from "./files.ts";

export const UPSTREAM_URL = "https://models.dev/experimental/v2.0/api.json";
export const UPSTREAM_COMMIT_URL = "https://api.github.com/repos/anomalyco/models.dev/commits/dev";
export const OBSERVED_URL = "https://raw.githubusercontent.com/ngvoicu/groundtruth/main/observed.json";

/** An import smaller than this is treated as broken, whatever the previous snapshot held. */
const MIN_PROVIDERS = 20;
const MIN_MODELS = 500;
/** An import that lost more than this share of the previous snapshot is treated as broken. */
const MIN_SHARE = 0.6;
const LOCK_STALE_MS = 30 * 60 * 1000;

export interface SyncOptions {
  dataDir: string;
  fetch: typeof fetch;
  now?: () => Date;
  log?: (line: string) => void;
  /** Ignore the stored ETag and download again. */
  force?: boolean;
}

export interface PartReport {
  status: "updated" | "unchanged" | "failed";
  error?: string;
  summary?: string[];
}

export interface SyncReport {
  ok: boolean;
  upstream: PartReport;
  measurements: PartReport;
}

export interface SyncStatus {
  last_attempt_at: string;
  last_attempt_ok: boolean;
  last_error?: string;
  upstream: PartReport["status"];
  measurements: PartReport["status"];
}

export class SyncBusyError extends Error {}

function acquireLock(path: string): () => void {
  const take = (): number => openSync(path, "wx");
  let handle: number;
  try {
    handle = take();
  } catch {
    const age = Date.now() - statSync(path).mtimeMs;
    if (age < LOCK_STALE_MS) throw new SyncBusyError(`Another sync holds ${path} (started ${Math.round(age / 1000)} s ago).`);
    rmSync(path, { force: true });
    handle = take();
  }
  writeFileSync(handle, String(process.pid));
  closeSync(handle);
  return () => rmSync(path, { force: true });
}

export function loadUpstream(dataDir: string): { catalog: UpstreamCatalog; meta: UpstreamMeta } | undefined {
  const dir = join(dataDir, "upstream");
  const meta = readJsonIfExists<UpstreamMeta>(join(dir, "meta.json"));
  if (!meta || !existsSync(join(dir, "providers"))) return undefined;
  const catalog: UpstreamCatalog = {};
  for (const file of readdirSync(join(dir, "providers")).sort()) {
    if (!file.endsWith(".json")) continue;
    const provider = readJson<UpstreamCatalog[string]>(join(dir, "providers", file));
    catalog[provider.id] = provider;
  }
  return { catalog, meta };
}

/**
 * The file a provider is stored in. models.dev sends the models of a provider in no fixed order, so they are written
 * sorted by id: the same content gives the same file. Nothing else is reordered: inside a model the key order can
 * carry meaning (the pricing rules follow the keys of `cost`), and arrays keep their order.
 */
export function providerFile(provider: UpstreamCatalog[string]): string {
  const models = Object.fromEntries(Object.keys(provider.models).sort().map((id) => [id, provider.models[id]]));
  return pretty({ ...provider, models });
}

function countModels(catalog: UpstreamCatalog): number {
  return Object.values(catalog).reduce((sum, provider) => sum + Object.keys(provider.models).length, 0);
}

function summarize(before: UpstreamCatalog | undefined, after: UpstreamCatalog): string[] {
  if (!before) return [`first import: ${Object.keys(after).length} providers, ${countModels(after)} models`];
  const lines: string[] = [];
  const addedProviders = Object.keys(after).filter((id) => !before[id]);
  const removedProviders = Object.keys(before).filter((id) => !after[id]);
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [id, provider] of Object.entries(after)) {
    const old = before[id]?.models ?? {};
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!old[modelId]) added += 1;
      else if (!deepEqual(old[modelId], model)) changed += 1;
    }
    removed += Object.keys(old).filter((modelId) => !provider.models[modelId]).length;
  }
  for (const id of removedProviders) removed += Object.keys(before[id]?.models ?? {}).length;
  if (addedProviders.length) lines.push(`providers added: ${addedProviders.join(", ")}`);
  if (removedProviders.length) lines.push(`providers removed: ${removedProviders.join(", ")}`);
  lines.push(`models: +${added} added, -${removed} removed, ${changed} changed`);
  return lines;
}

async function syncUpstream(options: Required<Pick<SyncOptions, "dataDir" | "fetch" | "now">> & SyncOptions): Promise<PartReport> {
  const dir = join(options.dataDir, "upstream");
  const previous = loadUpstream(options.dataDir);
  const now = options.now().toISOString();

  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "providers.dev sync" };
  if (previous?.meta.etag && !options.force) headers["If-None-Match"] = previous.meta.etag;
  const response = await options.fetch(UPSTREAM_URL, { headers });

  if (response.status === 304 && previous) {
    writeFileAtomic(join(dir, "meta.json"), pretty({ ...previous.meta, checked_at: now }));
    return { status: "unchanged" };
  }
  if (!response.ok) throw new Error(`models.dev answered HTTP ${response.status}`);

  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("models.dev did not return JSON");
  }
  const checked = UpstreamCatalog.safeParse(parsed);
  if (!checked.success) {
    const first = checked.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`the import does not match the expected v2 structure (${checked.error.issues.length} problems; first: ${first.join("; ")})`);
  }
  const catalog = checked.data;

  for (const [key, provider] of Object.entries(catalog)) {
    if (provider.id !== key) throw new Error(`provider key "${key}" does not match its id "${provider.id}"`);
    for (const [modelKey, model] of Object.entries(provider.models)) {
      if (model.id !== modelKey) throw new Error(`model key "${key}/${modelKey}" does not match its id "${model.id}"`);
    }
  }

  const providers = Object.keys(catalog).length;
  const models = countModels(catalog);
  if (providers < MIN_PROVIDERS || models < MIN_MODELS) {
    throw new Error(`the import is unexpectedly small: ${providers} providers, ${models} models`);
  }
  if (previous && (providers < previous.meta.providers * MIN_SHARE || models < previous.meta.models * MIN_SHARE)) {
    throw new Error(
      `the import shrank too much to trust: ${providers} providers and ${models} models, from ${previous.meta.providers} and ${previous.meta.models}`,
    );
  }

  const digest = sha256(body);
  if (previous && previous.meta.sha256 === digest && !options.force) {
    writeFileAtomic(join(dir, "meta.json"), pretty({ ...previous.meta, checked_at: now, ...etagOf(response) }));
    return { status: "unchanged" };
  }

  // The commit is a label, not a requirement: the import is good without it.
  let commit: Pick<UpstreamMeta, "commit" | "commit_date"> = {};
  try {
    const answer = await options.fetch(UPSTREAM_COMMIT_URL, { headers: { Accept: "application/vnd.github+json", "User-Agent": "providers.dev sync" } });
    if (answer.ok) {
      const data = (await answer.json()) as { sha?: string; commit?: { committer?: { date?: string } } };
      if (data.sha) commit = { commit: data.sha, ...(data.commit?.committer?.date ? { commit_date: data.commit.committer.date } : {}) };
    }
  } catch {
    options.log?.("upstream commit: not available (the import continues)");
  }

  const meta: UpstreamMeta = {
    source: UPSTREAM_URL,
    schema: UPSTREAM_SCHEMA,
    fetched_at: now,
    checked_at: now,
    ...etagOf(response),
    ...commit,
    sha256: digest,
    providers,
    models,
  };

  const next = `${dir}.tmp-${process.pid}`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(join(next, "providers"), { recursive: true });
  for (const [id, provider] of Object.entries(catalog)) writeFileSync(join(next, "providers", `${id}.json`), providerFile(provider));
  writeFileSync(join(next, "meta.json"), pretty(meta));
  swapDir(next, dir);

  return { status: "updated", summary: summarize(previous?.catalog, catalog) };
}

function etagOf(response: Response): { etag?: string } {
  const etag = response.headers.get("etag");
  return etag ? { etag } : {};
}

async function syncMeasurements(options: Required<Pick<SyncOptions, "dataDir" | "fetch" | "now">> & SyncOptions): Promise<PartReport> {
  const dir = join(options.dataDir, "sources");
  const previous = readJsonIfExists<SourceMeta>(join(dir, "observed.meta.json"));
  const now = options.now().toISOString();
  const headers: Record<string, string> = { "User-Agent": "providers.dev sync" };
  if (previous?.etag && !options.force && existsSync(join(dir, "observed.json"))) headers["If-None-Match"] = previous.etag;
  const response = await options.fetch(OBSERVED_URL, { headers });
  if (response.status === 304 && previous) {
    writeFileAtomic(join(dir, "observed.meta.json"), pretty({ ...previous, checked_at: now }));
    return { status: "unchanged" };
  }
  if (!response.ok) throw new Error(`the measurements file answered HTTP ${response.status}`);
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("the measurements file is not JSON");
  }
  const checked = ObservedFile.safeParse(parsed);
  if (!checked.success) throw new Error(`the measurements file does not match the expected structure: ${checked.error.issues[0]?.message}`);
  if (checked.data.cache.length === 0) throw new Error("the measurements file is unexpectedly empty");
  const digest = sha256(body);
  const meta: SourceMeta = { source: OBSERVED_URL, fetched_at: now, checked_at: now, ...etagOf(response), sha256: digest };
  if (previous?.sha256 === digest && !options.force) {
    writeFileAtomic(join(dir, "observed.meta.json"), pretty({ ...previous, checked_at: now, ...etagOf(response) }));
    return { status: "unchanged" };
  }
  writeFileAtomic(join(dir, "observed.json"), body.endsWith("\n") ? body : `${body}\n`);
  writeFileAtomic(join(dir, "observed.meta.json"), pretty(meta));
  return { status: "updated", summary: [`${checked.data.cache.length} cache runs, ${checked.data.limits.length} limits`] };
}

export async function sync(input: SyncOptions): Promise<SyncReport> {
  const options = { now: () => new Date(), ...input };
  mkdirSync(options.dataDir, { recursive: true });
  const release = acquireLock(join(options.dataDir, ".sync.lock"));
  try {
    const part = async (run: () => Promise<PartReport>): Promise<PartReport> => {
      try {
        return await run();
      } catch (error) {
        return { status: "failed", error: error instanceof Error ? error.message : String(error) };
      }
    };
    const upstream = await part(() => syncUpstream(options));
    const measurements = await part(() => syncMeasurements(options));
    const ok = upstream.status !== "failed" && measurements.status !== "failed";
    const errors = [upstream, measurements].map((item) => item.error).filter(Boolean);
    const status: SyncStatus = {
      last_attempt_at: options.now().toISOString(),
      last_attempt_ok: ok,
      ...(errors.length > 0 ? { last_error: errors.join(" | ") } : {}),
      upstream: upstream.status,
      measurements: measurements.status,
    };
    writeFileAtomic(join(options.dataDir, "sync-status.json"), pretty(status));
    return { ok, upstream, measurements };
  } finally {
    release();
  }
}
