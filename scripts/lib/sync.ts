// The sync. It fetches models.dev, the measurements file, groundtruth's discovery file and pi's model catalog once
// each, checks what came back, and only then replaces that source's snapshot (data/upstream/, data/sources/, data/pi/).
// Anything that goes wrong with a source leaves its previous snapshot exactly as it was; the parts never affect one
// another.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deepEqual } from "../../src/core/merge.ts";
import { ListedFile, ListedSyncRecord, ObservedFile, UPSTREAM_SCHEMA, UpstreamCatalog, type PiSyncRecord, type SourceMeta, type UpstreamMeta } from "../../src/core/schema.ts";
import { storedListed } from "../../src/core/listings.ts";
import { pretty, readJson, readJsonIfExists, sha256, swapDir, writeFileAtomic } from "./files.ts";
import { piOfSync } from "./pi-fence.ts";

// models.dev hides `openai-codex` (a ChatGPT subscription login) unless a client asks for it (models.dev f648ddb,
// 2026-11-17). providers.dev lists it as a subscription, so it asks. The README says more, under Syncing.
export const UPSTREAM_URL = "https://models.dev/experimental/v2.0/api.json?include=openai-codex";
export const UPSTREAM_COMMIT_URL = "https://api.github.com/repos/anomalyco/models.dev/commits/dev";
export const OBSERVED_URL = "https://raw.githubusercontent.com/ngvoicu/groundtruth/main/observed.json";
/** groundtruth's discovery: what each login's vendor listed, beside observed.json at the root of its repository. */
export const LISTED_URL = "https://raw.githubusercontent.com/ngvoicu/groundtruth/main/listed.json";

/** An import smaller than this is treated as broken, whatever the previous snapshot held. */
const MIN_PROVIDERS = 20;
const MIN_MODELS = 500;
/** An import that lost more than this share of the previous snapshot is treated as broken. Shared by every part. */
const MIN_SHARE = 0.6;
const LOCK_STALE_MS = 30 * 60 * 1000;
/** A discovery file larger than this is not read. */
export const LISTED_MAX_BYTES = 8 * 1024 * 1024;

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
  /** groundtruth's discovery file. Never changes `ok`: a failure keeps the last good file and is a warning of the build. */
  listed: PartReport;
  /** For the commit message: 7 hexadecimal characters of the stored pi snapshot's revision, else "snapshot". */
  piRevision7: string;
}

/** What data/sync-status.json can hold for a part: a part that did not run is never recorded there. */
export type StoredStatus = Exclude<PartReport["status"], "skipped">;
/** The report of a part that ran. */
export type RanPart = PartReport & { status: StoredStatus };

export interface SyncStatus {
  // These five speak of models.dev and the measurements only.
  last_attempt_at: string;
  last_attempt_ok: boolean;
  last_error?: string;
  upstream: StoredStatus;
  measurements: StoredStatus;
  /** The last attempt to import pi's catalog. */
  pi?: PiSyncRecord;
  /** The last attempt to fetch groundtruth's discovery file. */
  listed?: ListedSyncRecord;
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

/**
 * groundtruth's discovery file, beside the measurements file. A missing file (404) is "no discovery yet": nothing
 * changes, a copy held before included. A file that is not JSON or does not fit ListedFile keeps the last good copy and
 * fails the part, which the build reports as a warning. Only what the site reads of the file is kept (storedListed), with
 * data/sources/listed.meta.json.
 */
async function syncListed(options: Required<Pick<SyncOptions, "dataDir" | "fetch" | "now">> & SyncOptions): Promise<RanPart & { absent?: true }> {
  const dir = join(options.dataDir, "sources");
  const file = join(dir, "listed.json");
  const metaFile = join(dir, "listed.meta.json");
  // What is stored may be damaged (by hand, or a disk): it is read here only as a hint, never as a reason to fail. A
  // stored copy that does not read is as if there were none, so a valid file always replaces it.
  const readable = <T>(path: string): T | undefined => {
    try {
      return readJsonIfExists<T>(path);
    } catch {
      return undefined;
    }
  };
  const storedCopy = existsSync(file) ? ListedFile.safeParse(readable<unknown>(file)) : undefined;
  const good = storedCopy?.success ? storedCopy.data : undefined;
  const previous = good ? readable<SourceMeta>(metaFile) : undefined;
  const now = options.now().toISOString();
  const headers: Record<string, string> = { "User-Agent": "providers.dev sync" };
  if (previous?.etag && !options.force) headers["If-None-Match"] = previous.etag;
  // Every failure is one of the fixed reasons of LISTED_REASONS: nothing of the file, of the parser or of the network
  // error reaches data/sync-status.json, and from there /api/v1/meta.
  let response: Response;
  let body: string;
  try {
    response = await options.fetch(LISTED_URL, { headers });
    if (response.status === 404) return { status: "unchanged", absent: true, summary: ["no discovery file yet"] };
    if (response.status === 304 && previous) {
      writeFileAtomic(metaFile, pretty({ ...previous, checked_at: now }));
      return { status: "unchanged" };
    }
    if (!response.ok) throw new ListedRefusal(LISTED_REASONS.http(response.status));
    body = await response.text();
  } catch (error) {
    throw error instanceof ListedRefusal ? error : new ListedRefusal(LISTED_REASONS.fetch);
  }
  if (body.length > LISTED_MAX_BYTES) throw new ListedRefusal(LISTED_REASONS.large);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ListedRefusal(LISTED_REASONS.json);
  }
  const checked = ListedFile.safeParse(parsed);
  if (!checked.success) throw new ListedRefusal(LISTED_REASONS.schema);
  // A file with no provider or no model says nothing a list can stand on: refused, on the first sync too. One that
  // lost more than 40 % of the providers or of the models of the last good copy is not trusted, as for every part.
  const modelsOf = (value: ListedFile): number => Object.values(value.providers).reduce((sum, part) => sum + part.models.length, 0);
  if (Object.keys(checked.data.providers).length === 0 || modelsOf(checked.data) === 0) throw new ListedRefusal(LISTED_REASONS.empty);
  if (good) {
    if (Object.keys(checked.data.providers).length < Object.keys(good.providers).length * MIN_SHARE) throw new ListedRefusal(LISTED_REASONS.shrank);
    if (modelsOf(checked.data) < modelsOf(good) * MIN_SHARE) throw new ListedRefusal(LISTED_REASONS.shrankModels);
  }
  const digest = sha256(body);
  if (previous?.sha256 === digest && !options.force) {
    writeFileAtomic(metaFile, pretty({ ...previous, checked_at: now, ...etagOf(response) }));
    return { status: "unchanged" };
  }
  mkdirSync(dir, { recursive: true });
  // Only what the site reads is stored (storedListed): the committed copy holds no text of the file. The digest and
  // the ETag are the fetched file's, so an unchanged file is still recognised.
  writeFileAtomic(file, pretty(storedListed(checked.data)));
  writeFileAtomic(metaFile, pretty({ source: LISTED_URL, fetched_at: now, checked_at: now, ...etagOf(response), sha256: digest } satisfies SourceMeta));
  const providers = Object.entries(checked.data.providers);
  return { status: "updated", summary: [`${providers.length} providers, ${providers.reduce((sum, [, part]) => sum + part.models.length, 0)} models`] };
}

/** The reasons a discovery file is refused, fixed texts: the only error the record of the part can hold. */
export const LISTED_REASONS = {
  fetch: "listed.json: could not be fetched",
  http: (status: number): string => `listed.json: answered HTTP ${Number.isSafeInteger(status) ? status : 0}`,
  large: `listed.json: larger than ${LISTED_MAX_BYTES / 1024 / 1024} MB`,
  json: "listed.json: not JSON",
  schema: "listed.json: refused by its schema",
  shrank: "listed.json: lost more than 40 % of its providers",
  shrankModels: "listed.json: lost more than 40 % of its models",
  empty: "listed.json: lists no model",
  keep: "listed.json: could not be kept",
} as const;
/** Whether a recorded error is one of the fixed reasons. Anything else is never published. */
export const isListedReason = (text: unknown): text is string =>
  typeof text === "string" && (Object.values(LISTED_REASONS).includes(text as never) || /^listed\.json: answered HTTP \d{1,3}$/.test(text));
class ListedRefusal extends Error {}

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
    let five: FiveFields;
    let upstream: PartReport = { status: "skipped" };
    let measurements: PartReport = { status: "skipped" };
    let listed: PartReport = { status: "skipped" };
    // The record of the discovery file: this attempt's, or the one in the file where the part does not run.
    let listedRecord: ListedSyncRecord | undefined;
    let ok = true;
    if (options.only === "pi") {
      // The five fields of models.dev and the measurements, and nothing else, are kept from the file as it was
      // (absent where there were none). A file that does not parse counts as absent here.
      five = {};
      try {
        const kept = readJsonIfExists<unknown>(statusPath);
        five = fiveFieldsOf(kept);
        const record = ListedSyncRecord.safeParse(typeof kept === "object" && kept !== null ? (kept as { listed?: unknown }).listed : undefined);
        if (record.success) listedRecord = record.data;
      } catch (error) {
        options.log?.(`${statusPath} does not parse (${error instanceof Error ? error.message : String(error)}): it counts as absent, and its five fields are not kept.`);
      }
    } else {
      const ranUpstream = await part(() => syncUpstream(options));
      const ranMeasurements = await part(() => syncMeasurements(options));
      upstream = ranUpstream;
      measurements = ranMeasurements;
      // The discovery file: after the measurements, and outside `ok`.
      let absent = false;
      const ranListed = await part(async () => {
        const result = await syncListed(options).catch((error: unknown) => {
          throw error instanceof ListedRefusal ? error : new Error(LISTED_REASONS.keep);
        });
        absent = result.absent === true;
        const { absent: _absent, ...report } = result;
        return report;
      });
      listed = ranListed;
      listedRecord = { last_attempt_at: options.now().toISOString(), status: absent ? "absent" : ranListed.status, ...(ranListed.error ? { error: ranListed.error } : {}) };
      ok = ranUpstream.status !== "failed" && ranMeasurements.status !== "failed";
      const errors = [ranUpstream, ranMeasurements].map((item) => item.error).filter(Boolean);
      five = {
        last_attempt_at: options.now().toISOString(),
        last_attempt_ok: ok,
        ...(errors.length > 0 ? { last_error: errors.join(" | ") } : {}),
        upstream: ranUpstream.status,
        measurements: ranMeasurements.status,
      };
    }
    // Written before the pi part: models.dev's five fields never wait on pi, and a process that dies inside the pi part
    // leaves a record that says the attempt did not finish, never the previous attempt's success.
    const withListed = listedRecord ? { listed: listedRecord } : {};
    writeFileAtomic(statusPath, pretty({ ...five, ...withListed, pi: { last_attempt_at: options.now().toISOString(), status: "failed", error: "The pi part did not finish." } }));
    const pi = await piOfSync(options);
    // And after it: a literal of three checked strings; no pi code and no schema runs between the part and the file.
    const record: PiSyncRecord = { last_attempt_at: options.now().toISOString(), status: pi.report.status, ...(pi.report.error ? { error: pi.report.error } : {}) };
    writeFileAtomic(statusPath, pretty({ ...five, ...withListed, pi: record }));
    return { ok, upstream, measurements, pi: pi.report, listed, piRevision7: pi.revision7 };
  } finally {
    release();
  }
}

/** The five fields of models.dev and the measurements in data/sync-status.json, without the `pi` record. */
type FiveFields = Partial<Omit<SyncStatus, "pi">>;

/** The five fields of a parsed status file, where it has them, in their order. */
function fiveFieldsOf(previous: unknown): FiveFields {
  if (typeof previous !== "object" || previous === null || Array.isArray(previous)) return {};
  const keys = ["last_attempt_at", "last_attempt_ok", "last_error", "upstream", "measurements"] as const;
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(previous, key)).map((key) => [key, (previous as Record<string, unknown>)[key]])) as FiveFields;
}

/**
 * The step outputs of the `Import` step of the Publish workflow: `upstream=…`, `measurements=…`, `pi=…`, `listed=…`
 * and `pi_revision7=…`, one line each, appended to the file GitHub names in GITHUB_OUTPUT. A part that did not run
 * (`--only=pi`) gets no line.
 */
export function writeStepOutputs(report: SyncReport, path: string): void {
  const parts: [string, PartReport][] = [["upstream", report.upstream], ["measurements", report.measurements], ["pi", report.pi], ["listed", report.listed]];
  const lines = parts.flatMap(([name, part]) => (part.status === "skipped" ? [] : [`${name}=${part.status}\n`]));
  // The pi part always runs: the seven characters of the stored snapshot's revision, for the commit message.
  lines.push(`pi_revision7=${report.piRevision7}\n`);
  appendFileSync(path, lines.join(""));
}
