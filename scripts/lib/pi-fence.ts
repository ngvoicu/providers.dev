// The fence around pi's part of the build and of the sync (design/pi-source.md, section k). pi's code runs only in
// here, each call through the one guard (`fenced`), and what it returns crosses the fence only as plain data that
// fits the contract. Turning a part away is doing nothing: the dataset is complete without pi before this runs.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MetaSchema, PiBlockSchema, PiStatementsSchema } from "../../src/core/contract.ts";
import { piPart, type PiBlock, type PiEntryFacts, type PiList, type PiSummary } from "../../src/core/pi.ts";
import { piStatements, type PiStatements } from "../../src/core/safe.ts";
import type { CatalogBefore } from "../../src/core/resolve.ts";
import { ext, noPiMeta, PiSyncRecord, type Catalog, type Issue, type Meta, type PiAliases } from "../../src/core/schema.ts";
import { fenced, fencedAsync, reasonOf } from "./fenced.ts";
import { storedPi, syncPi } from "./pi-sync.ts";
import type { RanPart } from "./sync.ts";

export interface PiOfBuildInput {
  dataDir: string;
  /** data/sync-status.json as publish() parsed it; undefined where there is none. */
  status: unknown;
  aliases: PiAliases | undefined;
  catalog: Catalog;
  before: CatalogBefore;
  ruledOut: { ref: string; rule: string }[];
}

export interface PiOfBuild {
  /** The entry's ref -> its block, the block in short, and what pi states of the entry's safe values. Empty = no pi data. */
  entries: Map<string, { block: PiBlock; summary: PiSummary; statements: PiStatements }>;
  /** `meta.pi`, whole. */
  meta: Meta["pi"];
  /** The alias issues of a dataset with pi data, then the fence's own: pi-no-blocks, and one pi-snapshot-unreadable per part turned away. */
  issues: Issue[];
  /** The text of data/published/pi-report.json; null = no pi data. */
  report: string | null;
  /** pi's list of each catalog provider, for the listings, and the day of the import. Empty = no pi data. */
  lists: { date: string | null; lists: PiList[] };
  state: "published" | "published_without_blocks" | "none" | "turned_away";
}

const piMetaShape = MetaSchema.shape.pi.shape;

/** What the data part must be, once plain: the contract's own schemas, and issues that can never be an error. */
const PiData = z.strictObject({
  // A dataset with pi data has a snapshot.
  snapshot: piMetaShape.snapshot.unwrap(),
  counts: piMetaShape.counts,
  blocks: z.array(z.strictObject({ ref: z.string(), block: PiBlockSchema })),
  issues: z.array(
    z.strictObject({
      level: z.enum(["warning", "notice"]),
      code: z.enum(["pi-provider-collides", "pi-alias-orphan", "pi-alias-conflict", "pi-alias-redundant"]),
      target: z.string(),
      message: z.string(),
    }),
  ),
  report: z.string(),
  // pi's lists for the listings: plain facts, each provider once.
  lists: z.array(
    z.strictObject({
      provider: z.string().min(1),
      pi_provider: z.string().min(1),
      models: z.array(
        z.strictObject({
          id: z.string().min(1),
          name: z.string().min(1),
          context_window: z.int().min(0),
          max_output: z.int().min(0),
          input: z.array(z.string().min(1)),
          reasoning: z.boolean(),
        }),
      ),
    }),
  ),
});
type PiData = z.infer<typeof PiData>;

const PiStatementsOfBlocks = z.array(z.strictObject({ ref: z.string(), statements: PiStatementsSchema }));

/** Everything the build publishes of pi. Never throws. */
export function piOfBuild(input: PiOfBuildInput): PiOfBuild {
  const issues: Issue[] = [];
  let turnedAway = false;

  // The data. Without the folder data/pi/ no pi code is called: the one state without pi data and without a warning
  // does not rest on pi's code.
  let data: PiData | null = null;
  let statements = new Map<string, PiStatements>();
  if (existsSync(join(input.dataDir, "pi"))) {
    const fencedData = fenced((): PiData => {
      const stored = storedPi(input.dataDir);
      if (stored.state !== "usable") throw new Error(stored.state === "unusable" ? stored.why : "the stored snapshot gave no usable answer");
      const entries = new Map<string, PiEntryFacts>();
      for (const [providerId, provider] of Object.entries(input.catalog)) {
        for (const [modelId, model] of Object.entries(provider.models)) {
          const own = ext(model);
          entries.set(`${providerId}/${modelId}`, {
            limit: model.limit,
            cost: model.cost,
            access: own.access,
            corrections: own.provenance.map(({ path, op }) => ({ path, op })),
            documented_s: { short: own.cache.lifetime.short.documented_s, long: own.cache.lifetime.long.documented_s },
          });
        }
      }
      const part = piPart({
        pi: stored.catalog,
        aliases: structuredClone(input.aliases),
        before: structuredClone(input.before),
        ruledOut: structuredClone(input.ruledOut),
        entryOf: (ref) => {
          const entry = entries.get(ref);
          return entry ? structuredClone(entry) : undefined;
        },
      });
      const meta = stored.meta;
      const totals = part.report.totals;
      return {
        snapshot: {
          fetched_at: meta.fetched_at,
          checked_at: meta.checked_at,
          etag: meta.etag ?? null,
          last_modified: meta.last_modified ?? null,
          revision: meta.revision ?? null,
          sha256: meta.sha256,
          providers: meta.providers,
          models: meta.models,
        },
        counts: { entries_with_block: totals.matched_id + totals.matched_alias, left_out_models: totals.left_out, unmatched_models: totals.unmatched },
        blocks: part.blocks,
        lists: part.lists,
        issues: part.issues as PiData["issues"],
        report: `${JSON.stringify(part.report, null, 1)}\n`,
      };
    }, PiData);
    // The fence's own four checks.
    let why = fencedData.ok ? misplaced(fencedData.value, input.catalog) : fencedData.why;
    // Then what pi states of each entry's safe values, read from the checked blocks by the reference's own code,
    // through the guard (design/sources-side-by-side.md, section 4): a throw or a misfit turns the part away, whole.
    if (why === null && fencedData.ok) {
      const blocks = fencedData.value.blocks;
      const day = fencedData.value.snapshot.fetched_at.slice(0, 10);
      const read = fenced(() => blocks.map(({ ref, block }) => ({ ref, statements: piStatements(block, /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null) })), PiStatementsOfBlocks);
      if (!read.ok) why = read.why;
      else if (read.value.length !== blocks.length || read.value.some((item, index) => item.ref !== blocks[index]!.ref)) why = reasonOf(new Error("pi's statements do not name the blocks they are read from"));
      else statements = new Map(read.value.map((item) => [item.ref, item.statements]));
    }
    if (why === null && fencedData.ok) {
      data = fencedData.value;
      // The fence's own count of the blocks of the part it has taken: a part with none is published whole, and said.
      if (data.blocks.length === 0) {
        const { snapshot, counts } = data;
        issues.push({ level: "warning", code: "pi-no-blocks", target: "data/pi", message: `Pi's snapshot has ${snapshot.models} models and no entry has a Pi block (left out: ${counts.left_out_models}, unmatched: ${counts.unmatched_models}). Pi's data is published as Pi's code gave it.` });
      }
    } else {
      turnedAway = true;
      issues.push({ level: "warning", code: "pi-snapshot-unreadable", target: "data/pi", message: `Pi's data is left out of this dataset (${why}). No entry has a Pi block.` });
    }
  }

  // The record of the last pi import, the `pi` key of data/sync-status.json.
  const status = input.status;
  const record = fenced((): Meta["pi"]["sync"] => {
    if (typeof status !== "object" || status === null || !Object.hasOwn(status, "pi")) return { last_attempt_at: null, last_attempt_ok: null, last_error: null };
    const pi = PiSyncRecord.parse((status as { pi: unknown }).pi);
    return { last_attempt_at: pi.last_attempt_at, last_attempt_ok: pi.status !== "failed", last_error: pi.error ?? null };
  }, piMetaShape.sync);
  let sync: Meta["pi"]["sync"] = { last_attempt_at: null, last_attempt_ok: null, last_error: null };
  if (record.ok) sync = record.value;
  else {
    turnedAway = true;
    issues.push({ level: "warning", code: "pi-snapshot-unreadable", target: "data/sync-status.json", message: `The record of the last Pi import is left out of this dataset (${record.why}). It is published as no attempt recorded.` });
  }

  const state: PiOfBuild["state"] = turnedAway ? "turned_away" : !data ? "none" : data.blocks.length === 0 ? "published_without_blocks" : "published";
  if (!data) return { entries: new Map(), meta: { ...noPiMeta(), sync }, issues, report: null, lists: { date: null, lists: [] }, state };
  const entries = new Map<string, { block: PiBlock; summary: PiSummary; statements: PiStatements }>();
  for (const { ref, block } of data.blocks) entries.set(ref, { block, summary: { ref: block.ref, api: block.api, match: block.match, difference_count: block.differences.length }, statements: statements.get(ref)! });
  return {
    entries,
    meta: { source: noPiMeta().source, snapshot: data.snapshot, sync, counts: data.counts },
    issues: [...data.issues, ...issues],
    report: data.report,
    lists: { date: data.snapshot.fetched_at.slice(0, 10), lists: data.lists },
    state,
  };
}

/**
 * The fence's own four checks of the plain, checked data: the blocks can be laid on the catalog (each ref an entry of
 * it, none twice), and pi's part agrees with itself in the contract's two sentences about its numbers. Why not, or null.
 */
function misplaced(data: PiData, catalog: Catalog): string | null {
  const { blocks, counts, snapshot } = data;
  const seen = new Set<string>();
  for (const { ref } of blocks) {
    const slash = ref.indexOf("/");
    const provider = slash < 0 ? undefined : Object.hasOwn(catalog, ref.slice(0, slash)) ? catalog[ref.slice(0, slash)] : undefined;
    const model = slash < 0 ? "" : ref.slice(slash + 1);
    if (!provider || !Object.hasOwn(provider.models, model)) return reasonOf(new Error(`a block names ${ref}, which is no entry of the catalog`));
    if (seen.has(ref)) return reasonOf(new Error(`two blocks name the entry ${ref}`));
    seen.add(ref);
  }
  // pi's lists are matched before any exclusion: a provider an override leaves out can have one, which the listings
  // never read. Each provider has one list at most.
  const listed = new Set<string>();
  for (const { provider } of data.lists) {
    if (listed.has(provider)) return reasonOf(new Error(`pi's lists name the provider ${provider} twice`));
    listed.add(provider);
  }
  if (counts.entries_with_block !== blocks.length) return reasonOf(new Error(`${blocks.length} blocks, and meta.pi says ${counts.entries_with_block} entries have one`));
  const sum = counts.entries_with_block + counts.left_out_models + counts.unmatched_models;
  if (sum !== snapshot.models) return reasonOf(new Error(`the counts add up to ${sum}, the snapshot has ${snapshot.models} models`));
  return null;
}

// ---- the sync

export interface PiOfSync {
  /** status "updated" or "unchanged" with pi's summary lines, or "failed" with a one-line error. */
  report: RanPart;
  /** For the commit message: 7 hexadecimal characters of the stored snapshot's revision, else "snapshot". */
  revision7: string;
}

/** What syncPi may hand back across the fence. */
const PiSyncResultSchema = z.strictObject({ status: z.enum(["updated", "unchanged"]), summary: z.array(z.string()).optional(), revision: z.string().optional() });

/**
 * The whole pi part of the sync. Never rejects. syncPi is handed an options object of its own: nothing pi's code
 * assigns on it (a clock, a fetch, a folder) reaches the caller, whose status write comes after.
 */
export async function piOfSync(options: Parameters<typeof syncPi>[0]): Promise<PiOfSync> {
  const result = await fencedAsync(() => syncPi({ ...options }), PiSyncResultSchema);
  if (!result.ok) return { report: { status: "failed", error: result.why }, revision7: "snapshot" };
  const { revision, ...report } = result.value;
  return { report, revision7: /^sha256-([0-9a-f]{7})/.exec(revision ?? "")?.[1] ?? "snapshot" };
}
