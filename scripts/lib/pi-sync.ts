// pi's part of the sync: everything that touches files and the network for pi's model catalog (design/pi-source.md,
// sections b and k). sync() reaches it through the fence.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PiFeed, type PiCatalog, type PiModel } from "../../src/core/pi.ts";
import { PI_URL, PiMeta, PROVIDER_ID } from "../../src/core/schema.ts";
import { pretty, readJson, readJsonIfExists, sha256, swapDir, writeFileAtomic } from "./files.ts";
import { etagOf, MIN_SHARE, summarize, type RanPart, type SyncOptions } from "./sync.ts";

/** A pi import smaller than this is treated as broken, whatever the previous snapshot held. */
const PI_MIN_PROVIDERS = 10;
const PI_MIN_MODELS = 300;
/** The whole pi request, headers and body together, must be done within this. Passing it is a pi failure. */
export const PI_DEADLINE_MS = 60_000;

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

export async function syncPi(options: Required<Pick<SyncOptions, "dataDir" | "fetch" | "now">> & SyncOptions): Promise<RanPart> {
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
