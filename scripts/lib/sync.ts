// The sync. It fetches models.dev, the measurements file and pi's model catalog once each, checks what came back,
// and only then replaces that source's snapshot (data/upstream/, data/sources/, data/pi/). Anything that goes wrong
// with a source leaves its previous snapshot exactly as it was; the three parts never affect one another.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deepEqual } from "../../src/core/merge.ts";
import { PiFeed, type PiCatalog, type PiModel } from "../../src/core/pi.ts";
import { ObservedFile, PiMeta, PROVIDER_ID, UPSTREAM_SCHEMA, UpstreamCatalog, type SourceMeta, type UpstreamMeta } from "../../src/core/schema.ts";
import { pretty, readJson, readJsonIfExists, sha256, swapDir, writeFileAtomic } from "./files.ts";

// models.dev hides `openai-codex` (a ChatGPT subscription login) unless a client asks for it (models.dev f648ddb,
// 2026-11-17). providers.dev lists it as a subscription, so it asks. The README says more, under Syncing.
export const UPSTREAM_URL = "https://models.dev/experimental/v2.0/api.json?include=openai-codex";
export const UPSTREAM_COMMIT_URL = "https://api.github.com/repos/anomalyco/models.dev/commits/dev";
export const OBSERVED_URL = "https://raw.githubusercontent.com/ngvoicu/groundtruth/main/observed.json";
/** pi's model catalog, the second imported source (design/pi-source.md). */
export const PI_URL = "https://pi.dev/api/models";

/** An import smaller than this is treated as broken, whatever the previous snapshot held. */
const MIN_PROVIDERS = 20;
const MIN_MODELS = 500;
/** A pi import smaller than this is treated as broken, whatever the previous snapshot held. */
const PI_MIN_PROVIDERS = 10;
const PI_MIN_MODELS = 300;
/** The whole pi request, headers and body together, must be done within this. Passing it is a pi failure. */
export const PI_DEADLINE_MS = 60_000;
/** An import that lost more than this share of the previous snapshot is treated as broken. Shared by every part. */
const MIN_SHARE = 0.6;
const LOCK_STALE_MS = 30 * 60 * 1000;

export interface SyncOptions {
  dataDir: string;
  fetch: typeof fetch;
  now?: () => Date;
  log?: (line: string) => void;
  /** Ignore the stored ETag and download again. Applies to every part that runs. */
  force?: boolean;
  /** Run the pi part alone: models.dev and the measurements are not requested and their status is left as it was. */
  only?: "pi";
}

export interface PartReport {
  /** `skipped`: the part did not run (`only`). Never written to data/sync-status.json. */
  status: "updated" | "unchanged" | "failed" | "skipped";
  error?: string;
  summary?: string[];
}

export interface SyncReport {
  /** models.dev and the measurements did not fail. The pi part never changes it. */
  ok: boolean;
  upstream: PartReport;
  measurements: PartReport;
  pi: PartReport;
}

/** What data/sync-status.json can hold for a part: a part that did not run is never recorded there. */
export type StoredStatus = Exclude<PartReport["status"], "skipped">;
/** The report of a part that ran. */
type RanPart = PartReport & { status: StoredStatus };

export interface SyncStatus {
  // These five speak of models.dev and the measurements only.
  last_attempt_at: string;
  last_attempt_ok: boolean;
  last_error?: string;
  upstream: StoredStatus;
  measurements: StoredStatus;
  /** The last attempt to import pi's catalog. */
  pi?: { last_attempt_at: string; status: StoredStatus; error?: string };
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

/** The models of each provider: provider id -> model id -> model. */
type ModelsByProvider = Record<string, Record<string, unknown>>;

const modelsOf = (catalog: UpstreamCatalog): ModelsByProvider => Object.fromEntries(Object.entries(catalog).map(([id, provider]) => [id, provider.models]));

function summarize(before: ModelsByProvider | undefined, after: ModelsByProvider): string[] {
  const total = (catalog: ModelsByProvider): number => Object.values(catalog).reduce((sum, models) => sum + Object.keys(models).length, 0);
  if (!before) return [`first import: ${Object.keys(after).length} providers, ${total(after)} models`];
  const lines: string[] = [];
  const addedProviders = Object.keys(after).filter((id) => !before[id]);
  const removedProviders = Object.keys(before).filter((id) => !after[id]);
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [id, models] of Object.entries(after)) {
    const old = before[id] ?? {};
    for (const [modelId, model] of Object.entries(models)) {
      if (!old[modelId]) added += 1;
      else if (!deepEqual(old[modelId], model)) changed += 1;
    }
    removed += Object.keys(old).filter((modelId) => !models[modelId]).length;
  }
  for (const id of removedProviders) removed += Object.keys(before[id] ?? {}).length;
  if (addedProviders.length) lines.push(`providers added: ${addedProviders.join(", ")}`);
  if (removedProviders.length) lines.push(`providers removed: ${removedProviders.join(", ")}`);
  lines.push(`models: +${added} added, -${removed} removed, ${changed} changed`);
  return lines;
}

async function syncUpstream(options: Required<Pick<SyncOptions, "dataDir" | "fetch" | "now">> & SyncOptions): Promise<RanPart> {
  const dir = join(options.dataDir, "upstream");
  const previous = loadUpstream(options.dataDir);
  const now = options.now().toISOString();

  // A stored ETag and digest belong to the address they were read from; after a change of address they are not sent
  // or compared, so the first import from the new address is a full one.
  const sameSource = previous?.meta.source === UPSTREAM_URL;
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "providers.dev sync" };
  if (sameSource && previous?.meta.etag && !options.force) headers["If-None-Match"] = previous.meta.etag;
  const response = await options.fetch(UPSTREAM_URL, { headers });

  if (response.status === 304 && previous && sameSource) {
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
  if (previous && sameSource && previous.meta.sha256 === digest && !options.force) {
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

  return { status: "updated", summary: summarize(previous ? modelsOf(previous.catalog) : undefined, modelsOf(catalog)) };
}

function etagOf(response: Response): { etag?: string } {
  const etag = response.headers.get("etag");
  return etag ? { etag } : {};
}

/** Run `work` with an abort signal; abort it and fail once `ms` milliseconds have passed. */
async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`pi.dev did not answer in full within ${ms / 1000} s`));
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The last good pi snapshot, or undefined where data/pi/meta.json or data/pi/providers/ is missing. Not validated. */
export function loadPi(dataDir: string): { catalog: PiCatalog; meta: PiMeta } | undefined {
  const dir = join(dataDir, "pi");
  const meta = readJsonIfExists<PiMeta>(join(dir, "meta.json"));
  if (!meta || !existsSync(join(dir, "providers"))) return undefined;
  const catalog: PiCatalog = {};
  for (const file of readdirSync(join(dir, "providers")).sort()) {
    if (!file.endsWith(".json")) continue;
    const provider = readJson<{ id: string; models: Record<string, PiModel> }>(join(dir, "providers", file));
    catalog[provider.id] = provider.models;
  }
  return { catalog, meta };
}

/**
 * Why the pi snapshot in data/pi/ is not whole, or null where it is (and where there is none). Whole: every provider
 * file is named by its id, every model's key is its id and its provider the file's id, the provider files number
 * meta.json's `providers` and their models meta.json's `models`. It cannot tell a file exchanged for another with
 * the same counts; the sync never writes one (it writes the whole folder and swaps it in).
 */
export function piSnapshotFault(dataDir: string): string | null {
  const dir = join(dataDir, "pi");
  try {
    const meta = readJsonIfExists<Partial<PiMeta>>(join(dir, "meta.json"));
    if (!meta || !existsSync(join(dir, "providers"))) return null;
    const files = readdirSync(join(dir, "providers")).filter((file) => file.endsWith(".json")).sort();
    let models = 0;
    for (const file of files) {
      const provider = readJson<{ id?: unknown; models?: unknown }>(join(dir, "providers", file));
      if (`${String(provider.id)}.json` !== file) return `providers/${file} holds the provider "${String(provider.id)}"`;
      if (!provider.models || typeof provider.models !== "object") return `providers/${file} has no models`;
      for (const [key, model] of Object.entries(provider.models as Record<string, Partial<PiModel>>)) {
        if (model?.id !== key) return `the model "${String(provider.id)}/${key}" has the id "${String(model?.id)}"`;
        if (model.provider !== provider.id) return `the model "${String(provider.id)}/${key}" names the provider "${String(model.provider)}"`;
        models += 1;
      }
    }
    if (files.length !== meta.providers) return `${files.length} provider files, meta.json says ${String(meta.providers)}`;
    if (models !== meta.models) return `${models} models, meta.json says ${String(meta.models)}`;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The pi snapshot stored in data/pi/: none, one that cannot be used (and why), or one that can. */
export type StoredPi = { state: "none" } | { state: "unusable"; why: string } | { state: "usable"; catalog: PiCatalog; meta: PiMeta };

/**
 * The one answer to "is there a usable stored pi snapshot", for the build and the sync alike. None where
 * data/pi/meta.json or data/pi/providers/ is missing. Usable where it loads, its meta.json fits PiMeta, it is whole
 * (`piSnapshotFault`) and it fits PiFeed. Anything else is unusable: the build takes no pi data, and the sync
 * imports as on a first import.
 */
export function storedPi(dataDir: string): StoredPi {
  const unusable = (why: string): StoredPi => ({ state: "unusable", why });
  let loaded: ReturnType<typeof loadPi>;
  try {
    loaded = loadPi(dataDir);
  } catch (error) {
    return unusable(error instanceof Error ? error.message : String(error));
  }
  if (!loaded) return { state: "none" };
  const meta = PiMeta.safeParse(loaded.meta);
  if (!meta.success) {
    const first = meta.error.issues[0];
    return unusable(`meta.json does not fit: ${first ? `${first.path.join(".") || "(the file)"}: ${first.message}` : "unknown"}`);
  }
  const fault = piSnapshotFault(dataDir);
  if (fault) return unusable(`not whole: ${fault}`);
  const checked = PiFeed.safeParse(loaded.catalog);
  if (!checked.success) {
    const first = checked.error.issues[0];
    return unusable(`${checked.error.issues.length} problems; first: ${first ? `${first.path.join(".")}: ${first.message}` : "unknown"}`);
  }
  return { state: "usable", catalog: checked.data, meta: meta.data };
}

/**
 * The file a pi provider is stored in: `{ id, models }`, the models sorted by id (plain character order), each model
 * as the feed gives it, every key in the feed's order, `headers` included.
 */
export function piProviderFile(id: string, models: Record<string, PiModel>): string {
  const sorted = Object.fromEntries(Object.keys(models).sort().map((modelId) => [modelId, models[modelId]]));
  return pretty({ id, models: sorted });
}

async function syncPi(options: Required<Pick<SyncOptions, "dataDir" | "fetch" | "now">> & SyncOptions): Promise<RanPart> {
  const dir = join(options.dataDir, "pi");
  // A stored snapshot that cannot be used is no snapshot: the import is in every respect a first import.
  const stored = storedPi(options.dataDir);
  const previous = stored.state === "usable" ? stored : undefined;
  const now = options.now().toISOString();

  // As for models.dev: a stored ETag and digest belong to the address they were read from.
  const sameSource = previous?.meta.source === PI_URL;
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "providers.dev sync" };
  if (sameSource && previous?.meta.etag && !options.force) headers["If-None-Match"] = previous.meta.etag;
  // One deadline over the request and the whole body: a slow feed fails the pi part, not the job.
  const { response, body } = await withDeadline(PI_DEADLINE_MS, async (signal) => {
    const answer = await options.fetch(PI_URL, { headers, signal });
    return { response: answer, body: answer.ok ? await answer.text() : null };
  });

  if (response.status === 304 && previous && sameSource) {
    writeFileAtomic(join(dir, "meta.json"), pretty(PiMeta.parse({ ...previous.meta, checked_at: now })));
    return { status: "unchanged" };
  }
  if (!response.ok || body === null) throw new Error(`pi.dev answered HTTP ${response.status}`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("pi.dev did not return JSON");
  }
  const checked = PiFeed.safeParse(parsed);
  if (!checked.success) {
    const first = checked.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`the pi feed does not match the expected structure (${checked.error.issues.length} problems; first: ${first.join("; ")})`);
  }
  // Written as the feed gives it: the parsed body, not the checked copy, whose keys the schema has put in its own order.
  const catalog = parsed as PiCatalog;

  for (const [key, models] of Object.entries(catalog)) {
    if (!PROVIDER_ID.test(key)) throw new Error(`pi provider key "${key}" is not a valid provider id`);
    for (const [modelKey, model] of Object.entries(models)) {
      if (model.id !== modelKey) throw new Error(`pi model key "${key}/${modelKey}" does not match its id "${model.id}"`);
      if (model.provider !== key) throw new Error(`pi model "${key}/${modelKey}" names the provider "${model.provider}", not its provider key`);
    }
  }

  const providers = Object.keys(catalog).length;
  const models = Object.values(catalog).reduce((sum, items) => sum + Object.keys(items).length, 0);
  if (providers < PI_MIN_PROVIDERS || models < PI_MIN_MODELS) {
    throw new Error(`the pi feed is unexpectedly small: ${providers} providers, ${models} models`);
  }
  if (previous && (providers < previous.meta.providers * MIN_SHARE || models < previous.meta.models * MIN_SHARE)) {
    throw new Error(
      `the pi feed shrank too much to trust: ${providers} providers and ${models} models, from ${previous.meta.providers} and ${previous.meta.models}`,
    );
  }

  const digest = sha256(body);
  if (previous && sameSource && previous.meta.sha256 === digest && !options.force) {
    writeFileAtomic(join(dir, "meta.json"), pretty(PiMeta.parse({ ...previous.meta, checked_at: now, ...etagOf(response) })));
    return { status: "unchanged" };
  }

  const lastModified = response.headers.get("last-modified");
  const revision = response.headers.get("x-pi-model-catalog-revision");
  // What is written fits the one definition the sync and the build read it back by.
  const meta = PiMeta.parse({
    source: PI_URL,
    fetched_at: now,
    checked_at: now,
    ...etagOf(response),
    ...(lastModified ? { last_modified: lastModified } : {}),
    ...(revision ? { revision } : {}),
    sha256: digest,
    providers,
    models,
  });

  const next = `${dir}.tmp-${process.pid}`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(join(next, "providers"), { recursive: true });
  for (const [id, items] of Object.entries(catalog)) writeFileSync(join(next, "providers", `${id}.json`), piProviderFile(id, items));
  writeFileSync(join(next, "meta.json"), pretty(meta));
  swapDir(next, dir);

  return { status: "updated", summary: summarize(previous?.catalog, catalog) };
}

async function syncMeasurements(options: Required<Pick<SyncOptions, "dataDir" | "fetch" | "now">> & SyncOptions): Promise<RanPart> {
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
    const part = async (run: () => Promise<RanPart>): Promise<RanPart> => {
      try {
        return await run();
      } catch (error) {
        return { status: "failed", error: error instanceof Error ? error.message : String(error) };
      }
    };
    const statusPath = join(options.dataDir, "sync-status.json");
    if (options.only === "pi") {
      const pi = await part(() => syncPi(options));
      // The five fields of models.dev and the measurements stay as they were (absent where there were none).
      const previous = readJsonIfExists<Partial<SyncStatus>>(statusPath) ?? {};
      writeFileAtomic(statusPath, pretty({ ...previous, pi: piStatus(pi, options.now()) }));
      return { ok: true, upstream: { status: "skipped" }, measurements: { status: "skipped" }, pi };
    }
    const upstream = await part(() => syncUpstream(options));
    const measurements = await part(() => syncMeasurements(options));
    const ok = upstream.status !== "failed" && measurements.status !== "failed";
    const errors = [upstream, measurements].map((item) => item.error).filter(Boolean);
    const lastAttemptAt = options.now().toISOString();
    const pi = await part(() => syncPi(options));
    const status: SyncStatus = {
      last_attempt_at: lastAttemptAt,
      last_attempt_ok: ok,
      ...(errors.length > 0 ? { last_error: errors.join(" | ") } : {}),
      upstream: upstream.status,
      measurements: measurements.status,
      pi: piStatus(pi, options.now()),
    };
    writeFileAtomic(statusPath, pretty(status));
    return { ok, upstream, measurements, pi };
  } finally {
    release();
  }
}

/** The `pi` key of data/sync-status.json; its time is when the pi part ended. */
function piStatus(pi: RanPart, at: Date): NonNullable<SyncStatus["pi"]> {
  return { last_attempt_at: at.toISOString(), status: pi.status, ...(pi.error ? { error: pi.error } : {}) };
}

/**
 * The step outputs of the `Import` step of the Publish workflow: `upstream=…`, `measurements=…` and `pi=…`, one line
 * each, appended to the file GitHub names in GITHUB_OUTPUT. A part that did not run (`--only=pi`) gets no line.
 */
export function writeStepOutputs(report: SyncReport, path: string): void {
  const parts: [string, PartReport][] = [["upstream", report.upstream], ["measurements", report.measurements], ["pi", report.pi]];
  const lines = parts.flatMap(([name, part]) => (part.status === "skipped" ? [] : [`${name}=${part.status}\n`]));
  appendFileSync(path, lines.join(""));
}
