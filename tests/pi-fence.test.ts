// The fence around pi's part (design/pi-source.md, section k, 5): the tables of faults, generated from the functions
// the fence calls, and what the dataset is after each; the dataset complete without pi; own properties; being seen.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type * as fs from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { stringify } from "yaml";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EntrySummarySchema, MetaSchema, PiBlockSchema, ProviderSchema } from "../src/core/contract.ts";
import { buildIndex } from "../src/core/entries.ts";
import type { PiCatalog, PiModel } from "../src/core/pi.ts";
import { resolve } from "../src/core/resolve.ts";
import { ext, noPiMeta, PI_URL, PROVIDER_ID, type Catalog, type Meta } from "../src/core/schema.ts";
import type { Index } from "../src/core/entries.ts";
import { comparePublished } from "../scripts/lib/compare-published.ts";
import { pretty } from "../scripts/lib/files.ts";
import { PI_DEADLINE_MS, storedPi } from "../scripts/lib/pi-sync.ts";
import { publish, writeBuildOutputs, type PublishReport } from "../scripts/lib/publish.ts";
import { OBSERVED_URL, sync, UPSTREAM_COMMIT_URL, UPSTREAM_URL, writeStepOutputs, type SyncReport, type SyncStatus } from "../scripts/lib/sync.ts";
import { contractProblems, fetchByAddress, fixturePi, fixtureUpstream, ROOT, tempDataDir, writeAuthored } from "./helpers.ts";

/** The hooks of this file run whole data builds: well over vitest's 10 s default on a CI runner. */
const HOOK_TIMEOUT = 120_000;

// ---- the wrappers: every exported function of pi's two modules, counted, and the one fault of the row in hand.

/** A fault: given the true function (run it or not), what the boundary function does instead. */
type Fault = { name: string; label: string; apply: (callTrue: () => unknown) => unknown };

const state = vi.hoisted(() => ({
  calls: new Set<string>(),
  fault: null as null | { name: string; apply: (callTrue: () => unknown, args: unknown[]) => unknown; fired: boolean },
  exported: { pi: [] as string[], piSync: [] as string[] },
  /** A fault inside the reference's piStatements, which the fence calls through the guard (design/sources-side-by-side.md, 4). */
  statementsFault: null as null | ((callTrue: () => unknown) => unknown),
  statementsFired: false,
  /** Armed: every write of a file named pi-report.json throws, as a disk would (the report's write fault). */
  reportWriteFails: false,
  reportWrites: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  const writeFileSync = (...args: Parameters<typeof original.writeFileSync>): void => {
    if (typeof args[0] === "string" && args[0].endsWith("pi-report.json")) {
      state.reportWrites += 1;
      if (state.reportWriteFails) throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
    }
    original.writeFileSync(...args);
  };
  return { ...original, default: { ...original, writeFileSync }, writeFileSync };
});

vi.mock("../src/core/pi.ts", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const out: Record<string, unknown> = { ...original };
  for (const [name, value] of Object.entries(original)) {
    if (typeof value !== "function" || /^[A-Z]/.test(name)) continue;
    state.exported.pi.push(name);
    out[name] = function (this: unknown, ...args: unknown[]) {
      state.calls.add(name);
      const callTrue = () => (value as (...a: unknown[]) => unknown).apply(this, args);
      if (state.fault?.name !== name) return callTrue();
      state.fault.fired = true;
      return state.fault.apply(callTrue, args);
    };
  }
  return out;
});
vi.mock("../src/core/safe.ts", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const piStatements = original.piStatements as (...args: unknown[]) => unknown;
  return {
    ...original,
    piStatements(this: unknown, ...args: unknown[]) {
      const callTrue = () => piStatements.apply(this, args);
      if (!state.statementsFault) return callTrue();
      state.statementsFired = true;
      return state.statementsFault(callTrue);
    },
  };
});
vi.mock("../scripts/lib/pi-sync.ts", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const out: Record<string, unknown> = { ...original };
  for (const [name, value] of Object.entries(original)) {
    if (typeof value !== "function" || /^[A-Z]/.test(name)) continue;
    state.exported.piSync.push(name);
    const isAsync = value.constructor.name === "AsyncFunction";
    out[name] = isAsync
      ? async function (this: unknown, ...args: unknown[]) {
          state.calls.add(name);
          const callTrue = () => (value as (...a: unknown[]) => Promise<unknown>).apply(this, args);
          if (state.fault?.name !== name) return callTrue();
          state.fault.fired = true;
          return state.fault.apply(callTrue, args);
        }
      : function (this: unknown, ...args: unknown[]) {
          state.calls.add(name);
          const callTrue = () => (value as (...a: unknown[]) => unknown).apply(this, args);
          if (state.fault?.name !== name) return callTrue();
          state.fault.fired = true;
          return state.fault.apply(callTrue, args);
        };
  }
  return out;
});

// ---- the faults

/** An object whose `message` is a number and whose `toString` throws. */
const hostile = (): unknown => ({
  message: 503,
  toString() {
    throw new Error("toString");
  },
});

type Path = (string | number)[];

/** The value at `path` of `root`. */
const at = (root: unknown, path: Path): unknown => path.reduce<unknown>((value, key) => (value as Record<string | number, unknown>)[key], root);

/**
 * What the table mutates: what the fence reads. At the top level of the result, every key; inside `blocks[0]` and
 * `issues[0]`, every key and every value at every depth, but nothing inside `compat` (an open map of any JSON) and no
 * key deleted inside `thinking_level_map` (a level less still fits; its values are replaced); inside `report.totals`
 * the four keys the fence makes `counts` of. `delete`: the paths whose key is deleted; `replace`: whose value is replaced.
 */
function faultPaths(result: unknown): { delete: Path[]; replace: Path[] } {
  const out = { delete: [] as Path[], replace: [] as Path[] };
  if (typeof result !== "object" || result === null) return out;
  for (const key of Object.keys(result)) {
    out.delete.push([key]);
    out.replace.push([key]);
  }
  const below = (value: unknown, path: Path, inLevels: boolean): void => {
    if (typeof value !== "object" || value === null) return;
    for (const key of Array.isArray(value) ? value.map((_, index) => index) : Object.keys(value)) {
      const child = [...path, key];
      if (!inLevels) out.delete.push(child);
      out.replace.push(child);
      if (key !== "compat") below((value as Record<string | number, unknown>)[key], child, key === "thinking_level_map");
    }
  };
  for (const start of [["blocks", 0], ["issues", 0]] as Path[]) {
    try {
      const value = at(result, start);
      if (value !== undefined) below(value, start, false);
    } catch {
      // the result has no such part
    }
  }
  const totals = (result as { report?: { totals?: unknown } }).report?.totals;
  if (typeof totals === "object" && totals !== null) {
    for (const key of ["matched_id", "matched_alias", "left_out", "unmatched"]) {
      out.delete.push(["report", "totals", key]);
      out.replace.push(["report", "totals", key]);
    }
  }
  return out;
}

/** The true result, transformed: the result is a promise for an async boundary function. */
const after = (callTrue: () => unknown, change: (result: unknown) => unknown): unknown => {
  const result = callTrue();
  return result instanceof Promise ? result.then(change) : change(result);
};
/** The true result with the value at `path` deleted (an array keeps a hole). */
const deleted = (path: Path) => (result: unknown) => {
  const copy = structuredClone(result) as Record<string | number, unknown>;
  const parent = at(copy, path.slice(0, -1)) as Record<string | number, unknown>;
  delete parent[path[path.length - 1]!];
  return copy;
};
/**
 * A value the schema refuses at `path`: a number where it takes a string or null, a string everywhere else; inside a
 * block, the one of the two that the contract's PiBlockSchema refuses there (a nullable number takes a number, a
 * nullable string a string).
 */
function refused(trueResult: unknown, path: Path): unknown {
  const value = at(trueResult, path);
  const first = typeof value === "string" || value === null ? 7 : "not what the schema takes";
  const blockAt = path[0] === "blocks" && path[2] === "block" && path.length > 3 ? 3 : null;
  if (blockAt === null) return first;
  const fits = (candidate: unknown): boolean => {
    const block = structuredClone(at(trueResult, path.slice(0, blockAt))) as Record<string | number, unknown>;
    (at(block, path.slice(blockAt, -1)) as Record<string | number, unknown>)[path[path.length - 1]!] = candidate;
    return PiBlockSchema.safeParse(block).success;
  };
  return fits(first) ? (first === 7 ? "not what the schema takes" : 7) : first;
}
/** The true result with the value at `path` replaced by `value`. */
const replaced = (path: Path, value: unknown) => (result: unknown) => {
  const copy = structuredClone(result) as Record<string | number, unknown>;
  (at(copy, path.slice(0, -1)) as Record<string | number, unknown>)[path[path.length - 1]!] = value;
  return copy;
};

/**
 * The top-level keys a boundary function's result schema requires, where not all of them: syncPi's `summary` and
 * `revision` are optional (design/pi-source.md, section k, 5, test 2: "the keys its schema requires: `status`").
 */
const REQUIRED_TOP: Record<string, string[]> = { syncPi: ["status"] };

/** The faults of a boundary function, from its true result in the healthy run. */
function faultsOf(name: string, trueResult: unknown): Fault[] {
  const faults: Fault[] = [
    { name, label: "throws an Error", apply: () => { throw new Error("broken on purpose"); } },
    { name, label: "throws an object whose message is a number and whose toString throws", apply: () => { throw hostile(); } },
    { name, label: "throws an Error with line breaks, control characters and 1,000 characters", apply: () => { throw new Error(`one\ntwo\r\u0000\u001b[31m${"x".repeat(1000)}`); } },
    { name, label: "returns undefined", apply: () => undefined },
    { name, label: "returns {}", apply: () => ({}) },
  ];
  if (typeof trueResult !== "object" || trueResult === null) return faults;
  faults.push(
    // On the first key of the true result: a getter that throws, and the result itself.
    { name, label: "returns an object with a getter that throws", apply: (callTrue) => after(callTrue, (result) => Object.defineProperty({ ...(result as object) }, Object.keys(result as object)[0]!, { enumerable: true, get() { throw new Error("getter"); } })) },
    { name, label: "returns an object that contains itself", apply: (callTrue) => after(callTrue, (result) => { const copy: Record<string, unknown> = { ...(result as object) }; copy[Object.keys(copy)[0]!] = copy; return copy; }) },
  );
  const paths = faultPaths(trueResult);
  const required = REQUIRED_TOP[name];
  if (required) for (const list of [paths.delete, paths.replace]) list.splice(0, list.length, ...list.filter((path) => path.length > 1 || required.includes(String(path[0]))));
  for (const path of paths.delete) faults.push({ name, label: `the true result without ${path.join(".")}`, apply: (callTrue) => after(callTrue, deleted(path)) });
  for (const path of paths.replace) {
    const value = refused(trueResult, path);
    faults.push({ name, label: `the true result with ${path.join(".")} as ${JSON.stringify(value)}, which its schema refuses`, apply: (callTrue) => after(callTrue, replaced(path, value)) });
  }
  return faults;
}

// ---- the fixture

const NOW = () => new Date("2026-11-20T12:00:00.000Z");
const RECORD = { last_attempt_at: "2026-11-20T14:19:45.000Z", status: "updated" };

/** The fixture's pi catalog: its first block has a tier, a difference, compat, a thinking level map and prompt cache lifetimes. */
function piCatalog(): PiCatalog {
  const catalog = fixturePi(12, 30);
  const first = catalog["provider-00"]!["lab/model-0"]!;
  first.contextWindow = 123456;
  first.cost = { ...first.cost, input: 1, tiers: [{ inputTokensAbove: 199999, input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 }] };
  return catalog;
}

/** Write data/pi/ as the sync writes it, from a catalog built without assignment (a model id may be `__proto__`). */
function writePi(dir: string, catalog: PiCatalog): void {
  mkdirSync(join(dir, "pi", "providers"), { recursive: true });
  let models = 0;
  for (const [id, items] of Object.entries(catalog)) {
    const sorted = Object.fromEntries(Object.keys(items).sort().map((key) => [key, items[key]]));
    models += Object.keys(sorted).length;
    writeFileSync(join(dir, "pi", "providers", `${id}.json`), pretty({ id, models: sorted }));
  }
  writeFileSync(join(dir, "pi", "meta.json"), pretty({ source: "https://pi.dev/api/models", fetched_at: "2026-11-20T14:19:45.000Z", checked_at: "2026-11-20T14:19:45.000Z", etag: '"p1"', revision: "sha256-dd93eb27", sha256: "ab".repeat(32), providers: Object.keys(catalog).length, models }));
}

/** The `pi` key of data/sync-status.json: set, replaced or (undefined) taken out. */
function setRecord(dir: string, record: unknown): void {
  const path = join(dir, "sync-status.json");
  const status = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  delete status.pi;
  writeFileSync(path, pretty(record === undefined ? status : { ...status, pi: record }));
}

/** models.dev and our authored files, synced once; the alias file raises one alias issue. No pi yet. */
let base: string;
beforeAll(async () => {
  base = tempDataDir();
  const upstream = JSON.stringify(fixtureUpstream());
  await sync({
    dataDir: base,
    now: NOW,
    fetch: fetchByAddress({
      "https://models.dev": () => new Response(upstream, { headers: { etag: '"u1"' } }),
      "https://api.github.com": () => new Response(JSON.stringify({ sha: "abc123", commit: { committer: { date: "2026-11-12T00:00:00Z" } } })),
      "https://pi.dev": () => new Response("down", { status: 503 }),
    }),
  });
  writeAuthored(base);
  writeFileSync(
    join(base, "authored", "pi-aliases.yaml"),
    stringify({ providers: { "ghost-pi": { same_as: "provider-29", reason: "A pairing whose pi provider is gone.", evidence: [{ kind: "listed", url: "https://pi.dev/api/models", date: "2026-11-20", note: "ghost-pi" }] } } }),
  );
  setRecord(base, undefined);
}, HOOK_TIMEOUT);

/** A copy of the base data folder, with pi's catalog (or none) and the record (or none). */
function variant(pi: PiCatalog | null, record: unknown): string {
  const dir = tempDataDir();
  for (const part of ["upstream", "sources", "authored"]) if (existsSync(join(base, part))) cpSync(join(base, part), join(dir, part), { recursive: true });
  cpSync(join(base, "sync-status.json"), join(dir, "sync-status.json"));
  setRecord(dir, record);
  if (pi) writePi(dir, pi);
  return dir;
}

const build = (dir: string): PublishReport => publish({ dataDir: dir, rootDir: ROOT, now: NOW });

/** Every file under published/, by path. */
function filesOf(dir: string): Map<string, Buffer> {
  const root = join(dir, "published");
  const out = new Map<string, Buffer>();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out.set(join(entry.parentPath, entry.name).slice(root.length + 1), readFileSync(join(entry.parentPath, entry.name)));
  }
  return out;
}

const metaOf = (files: Map<string, Buffer>): Meta => JSON.parse(files.get("site/data/meta.json")!.toString("utf8")) as Meta;

/** The paths whose bytes differ between two builds, and those only one has. */
function differing(a: Map<string, Buffer>, b: Map<string, Buffer>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].filter((path) => !a.has(path) || !b.has(path) || !a.get(path)!.equals(b.get(path)!)).sort();
}

const blocksOf = (files: Map<string, Buffer>): Map<string, unknown> => {
  const catalog = JSON.parse(files.get("site/api.json")!.toString("utf8")) as Catalog;
  const out = new Map<string, unknown>();
  for (const [id, provider] of Object.entries(catalog)) for (const [model, entry] of Object.entries(provider.models)) if (ext(entry).pi !== null) out.set(`${id}/${model}`, ext(entry).pi);
  return out;
};

/** The value imports of pi-fence.ts from pi's two modules, read from its source. */
function fenceImports(): string[] {
  const source = readFileSync(join(ROOT, "scripts", "lib", "pi-fence.ts"), "utf8");
  const names: string[] = [];
  for (const match of source.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)";/gm)) {
    if (match[1] || !/(src\/core\/pi|\.\/pi-sync)\.ts$/.test(match[3]!)) continue;
    for (const item of match[2]!.split(",").map((part) => part.trim()).filter(Boolean)) if (!item.startsWith("type ")) names.push(item.split(/\s+as\s+/)[0]!);
  }
  return names.sort();
}

/** The boundary functions of the build: the ones a healthy build and one without data/pi/ call through the wrappers. */
let buildCalls: string[] | null = null;
function buildBoundary(): string[] {
  if (buildCalls) return buildCalls;
  state.calls.clear();
  const healthy = variant(piCatalog(), undefined);
  build(healthy);
  build(variant(null, undefined));
  buildCalls = [...state.calls].sort();
  return buildCalls;
}

// ---- 1. the build's tables

describe("1. the table of faults of the build, generated from what the fence calls", () => {
  let healthyDir: string;
  let withoutDir: string;
  let healthy: Map<string, Buffer>;
  let without: Map<string, Buffer>;
  const trueResults = new Map<string, unknown>();

  beforeAll(() => {
    healthyDir = variant(piCatalog(), undefined);
    withoutDir = variant(null, undefined);
    // The true result of every boundary function in the healthy build, for the faults that need it.
    for (const name of [...state.exported.pi, ...state.exported.piSync]) {
      state.fault = { name, fired: false, apply: (callTrue) => { const result = callTrue(); trueResults.set(name, structuredClone(result)); return result; } };
      build(healthyDir);
    }
    state.fault = null;
    expect(build(healthyDir)).toMatchObject({ ok: true, pi: "published" });
    expect(build(withoutDir)).toMatchObject({ ok: true, pi: "none" });
    healthy = filesOf(healthyDir);
    without = filesOf(withoutDir);
  }, HOOK_TIMEOUT);

  it("the fixture is as the table needs it: a first block with a tier, a difference, compat, levels, cache lifetimes and values with a tiers item that has pi_tiers; one alias issue", () => {
    const block = blocksOf(healthy).get("provider-00/lab/model-0") as { cost: { tiers: unknown[] }; differences: unknown[]; compat: object; thinking_level_map: object; prompt_cache: object; values: { field: string; standing: string; pi_tiers: unknown[] | null }[] };
    expect(block.cost.tiers.length).toBeGreaterThan(0);
    expect(block.differences.length).toBeGreaterThan(0);
    expect(block.values).toHaveLength(9);
    expect(block.values.find((item) => item.field === "cost.tiers")!.pi_tiers!.length).toBeGreaterThan(0);
    expect(block.values[0]).toMatchObject({ field: "context_window", standing: "differs" });
    expect([block.compat, block.thinking_level_map, block.prompt_cache].every((value) => value !== null)).toBe(true);
    expect((trueResults.get("piPart") as { blocks: { ref: string }[] }).blocks[0]!.ref).toBe("provider-00/lab/model-0");
    expect(metaOf(healthy).issues.filter((issue) => issue.code.startsWith("pi-alias"))).toHaveLength(1);
    expect(without.has("pi-report.json")).toBe(false);
  });

  it("the boundary functions are the value imports of pi-fence.ts from pi's two modules, found over builds and syncs", async () => {
    state.calls.clear();
    build(healthyDir);
    build(withoutDir);
    const ofBuild = [...state.calls].sort();
    expect(ofBuild).toEqual(buildBoundary());
    // A healthy first import, a 304 and a failed import.
    const dir = tempDataDir();
    const feed = JSON.stringify(piCatalog());
    const upstream = JSON.stringify(fixtureUpstream());
    let pi = (): Response => new Response(feed, { headers: { etag: '"p1"' } });
    const fetch = fetchByAddress({
      "https://models.dev": () => new Response(upstream, { headers: { etag: '"u1"' } }),
      "https://api.github.com": () => new Response("{}"),
      "https://pi.dev": () => pi(),
    });
    await sync({ dataDir: dir, now: NOW, fetch });
    pi = () => new Response(null, { status: 304 });
    await sync({ dataDir: dir, now: NOW, fetch });
    pi = () => new Response("down", { status: 503 });
    await sync({ dataDir: dir, now: NOW, fetch });
    expect([...state.calls].sort()).toEqual(fenceImports());
  });

  // The rows: generated when the table runs, for the boundary functions of the build.
  const rows = (): Fault[] => buildBoundary().flatMap((name) => faultsOf(name, trueResults.get(name)));

  it("every row: its fault fires and the build ends turned away, the dataset the without build's but for one warning", async () => {
    const results: { row: string; fired: boolean; ok: boolean; pi: unknown; problems: string[]; compared: number; files: string[]; why: string | null }[] = [];
    const fenceRows = rows();
    for (const fault of fenceRows) {
      const dir = variant(piCatalog(), undefined);
      state.fault = { name: fault.name, apply: fault.apply, fired: false };
      const report = build(dir);
      const fired = state.fault.fired;
      state.fault = null;
      const files = filesOf(dir);
      const problems = await contractProblems(join(dir, "published"));
      const compared = comparePublished(join(healthyDir, "published"), join(dir, "published")).differences.length;
      // Every file is the without build's, but meta.json, which gains one warning for data/pi.
      const meta = metaOf(files);
      const warnings = meta.issues.filter((issue) => issue.code === "pi-snapshot-unreadable");
      const expected = metaOf(without);
      expected.issues = [...expected.issues, ...warnings.slice(0, 1)];
      const sameMeta = JSON.stringify(meta) === JSON.stringify(expected);
      const why = warnings[0]?.message.match(/^pi's data is left out of this dataset \((.*)\)\. No entry has a pi block\.$/s)?.[1] ?? null;
      const oneLine = why !== null && !/[\r\n]/.test(why) && [...why].length <= 300;
      const otherFiles = differing(files, without).filter((path) => path !== "site/data/meta.json");
      results.push({ row: `${fault.name}: ${fault.label}`, fired, ok: report.ok, pi: report.pi, problems, compared, files: [...otherFiles, ...(sameMeta && warnings.length === 1 && warnings[0]!.target === "data/pi" && oneLine ? [] : ["site/data/meta.json"])], why });
    }
    if (process.env.PI_FENCE_ROWS) writeFileSync(process.env.PI_FENCE_ROWS, JSON.stringify(results, null, 1));
    console.log(`the build's table: ${new Set(fenceRows.map((row) => row.name)).size} boundary functions (${[...new Set(fenceRows.map((row) => row.name))].join(", ")}), ${fenceRows.length} rows, ${results.filter((row) => row.fired).length} fired, ${results.filter((row) => row.pi === "turned_away").length} turned away`);
    const failing = results.filter((row) => !row.fired || !row.ok || row.pi !== "turned_away" || row.problems.length > 0 || row.compared !== 0 || row.files.length > 0);
    expect(failing.map((row) => `${row.row} -> fired ${row.fired}, pi ${String(row.pi)}, problems ${row.problems.length}, compared ${row.compared}, files ${row.files.length}`)).toEqual([]);
    expect(fenceRows.length).toBeGreaterThan(100);
  }, 600_000);

  /** A change to the first block that fits the contract and agrees with itself: published as pi's part. */
  const notPromised: [string, (block: { name: string; thinking_level_map: Record<string, string | null>; values: { standing: string }[] }) => void, (text: string) => string][] = [
    ["the first block's name changed", (block) => { block.name = "Model 0, renamed by the fault table"; }, (text) => text.replaceAll("Model 0, renamed by the fault table", "Model 0")],
    ["one level deleted from the first block's thinking_level_map", (block) => { delete block.thinking_level_map.minimal; }, (text) => text.replaceAll('"thinking_level_map":{"high":"high"}', '"thinking_level_map":{"minimal":null,"high":"high"}')],
    // A wrong standing fits the contract: the fence publishes it, and it never changes the entry's own value.
    ["the standing of the first block's first value changed from differs to agrees", (block) => { block.values[0]!.standing = "agrees"; }, (text) => text.replaceAll('"standing":"agrees","pi":123456,', '"standing":"differs","pi":123456,')],
  ];
  it.each(notPromised)("what the fence does not promise: %s is published as pi's part", async (_name, change, back) => {
    const dir = variant(piCatalog(), undefined);
    state.fault = {
      name: "piPart",
      fired: false,
      apply: (callTrue) => after(callTrue, (result) => {
        const copy = structuredClone(result) as { blocks: { block: Parameters<typeof change>[0] }[] };
        change(copy.blocks[0]!.block);
        return copy;
      }),
    };
    const report = build(dir);
    expect(state.fault.fired).toBe(true);
    state.fault = null;
    expect(report).toMatchObject({ ok: true, pi: "published" });
    expect(await contractProblems(join(dir, "published"))).toEqual([]);
    expect(comparePublished(join(healthyDir, "published"), join(dir, "published")).differences).toEqual([]);
    // The files differ from the healthy build's only where that block and the version are.
    const files = filesOf(dir);
    const version = metaOf(files).dataset_version;
    const healthyVersion = metaOf(healthy).dataset_version;
    expect(version).not.toBe(healthyVersion);
    const text = (bytes: Buffer, path: string): string => (path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8");
    const changed = differing(files, healthy);
    expect(changed).toContain("site/data/entries/provider-00/0.json");
    for (const path of changed) expect(back(text(files.get(path)!, path).replaceAll(version, healthyVersion)), path).toBe(text(healthy.get(path)!, path));
  });

  /** The rows of piStatements: a throw, and a result its schema refuses. Each turns the part away, whole. */
  const statementRows: [string, (callTrue: () => unknown) => unknown][] = [
    ["throws an Error", () => { throw new Error("broken on purpose"); }],
    ["throws an object whose message is a number and whose toString throws", () => { throw hostile(); }],
    ["returns undefined", () => undefined],
    ["returns a window that is not a whole number", (callTrue) => ({ ...(callTrue() as object), input_window: 1.5 })],
    ["returns a price of 0, which states nothing", (callTrue) => ({ ...(callTrue() as object), price: { input: 0, output: 1, cache_read: null, cache_write: null, tiers: [] } })],
    ["returns a key the schema does not have", (callTrue) => ({ ...(callTrue() as object), extra: 1 })],
    ["returns an object with a getter that throws", (callTrue) => Object.defineProperty({ ...(callTrue() as object) }, "date", { enumerable: true, get() { throw new Error("getter"); } })],
  ];
  it.each(statementRows)("piStatements %s: the part turned away, the dataset the without build's but for one warning", async (_name, fault) => {
    const dir = variant(piCatalog(), undefined);
    state.statementsFault = fault;
    state.statementsFired = false;
    const report = build(dir);
    const fired = state.statementsFired;
    state.statementsFault = null;
    expect(fired).toBe(true);
    expect(report).toMatchObject({ ok: true, pi: "turned_away" });
    expect(await contractProblems(join(dir, "published"))).toEqual([]);
    expect(comparePublished(join(withoutDir, "published"), join(dir, "published")).differences).toEqual([]);
    const files = filesOf(dir);
    expect(differing(files, without)).toEqual(["site/data/meta.json"]);
    const meta = metaOf(files);
    const warning = meta.issues.at(-1)!;
    expect(warning).toMatchObject({ level: "warning", code: "pi-snapshot-unreadable", target: "data/pi" });
    expect(warning.message).toMatch(/^pi's data is left out of this dataset \([^\r\n]{1,300}\)\. No entry has a pi block\.$/);
    const expected = metaOf(without);
    expected.issues = [...expected.issues, warning];
    expect(meta).toEqual(expected);
  });

  it("what the fence does not promise: a wrong number on a value no other source states is published as pi.dev's, and no value another source states moves", async () => {
    const dir = variant(piCatalog(), undefined);
    state.fault = {
      name: "piPart",
      fired: false,
      apply: (callTrue) => after(callTrue, (result) => {
        const copy = structuredClone(result) as { blocks: { ref: string; block: { context_window: number } }[] };
        // provider-00/model-7 states no limit of its own: pi's window is its only one.
        copy.blocks.find((item) => item.ref === "provider-00/model-7")!.block.context_window = 999999;
        return copy;
      }),
    };
    const report = build(dir);
    expect(state.fault.fired).toBe(true);
    state.fault = null;
    expect(report).toMatchObject({ ok: true, pi: "published" });
    expect(await contractProblems(join(dir, "published"))).toEqual([]);
    const catalog = JSON.parse(filesOf(dir).get("site/api.json")!.toString("utf8")) as Catalog;
    expect(ext(catalog["provider-00"]!.models["model-7"]!).safe.input_window).toMatchObject({ value: 999999, source: "pi.dev", agreement: "single" });
    expect(ext(catalog["provider-00"]!.models["model-7"]!).limits.input_window).toMatchObject({ tokens: 999999, source: "pi.dev" });
    // Taken off on both sides, the two builds are the same: no value another source states differs.
    expect(comparePublished(join(healthyDir, "published"), join(dir, "published")).differences).toEqual([]);
    expect(comparePublished(join(withoutDir, "published"), join(dir, "published")).differences).toEqual([]);
  });

  it("the healthy build differs from the build without pi in exactly the keys of section 4", () => {
    const read = <T>(files: Map<string, Buffer>, path: string): T => JSON.parse(files.get(path)!.toString("utf8")) as T;
    /** Every path where `a` and `b` differ, array places as [], with the value of `b` at it. */
    const paths = (a: unknown, b: unknown, path: string, out: string[]): void => {
      const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
      if (JSON.stringify(a) === JSON.stringify(b)) return;
      if (!object(a) || !object(b) || Array.isArray(a) !== Array.isArray(b) || (Array.isArray(a) && Array.isArray(b) && a.length !== (b as unknown[]).length)) {
        out.push(path);
        return;
      }
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) paths(a[key], b[key], Array.isArray(a) ? `${path}[]` : `${path}.${key}`, out);
    };
    const QUANTITY = /\.safe\.(input_window|max_output|cache_short|cache_long|price)\.(\w+)/;
    /** The keys section 4 names; a value and its copies only where pi gives the value. */
    const allowed = (path: string, safe: { [key: string]: { source: string | null } }): boolean => {
      if (/^entry\.providers_dev\.pi$/.test(path) || /^summary\.pi$/.test(path)) return true;
      if (/\.safe\.differing$/.test(path)) return true;
      const quantity = QUANTITY.exec(path);
      if (quantity) return ["sources", "agreement", "differs"].includes(quantity[2]!) || safe[quantity[1]!]!.source === "pi.dev";
      if (/\.(limits\.)?input_window\.(tokens|basis|bound|scope|source|date)$/.test(path)) return safe.input_window!.source === "pi.dev";
      const lifetime = /\.(?:cache\.lifetime|cache_lifetime)\.(short|long)\.(safe_s|basis|source|date)$/.exec(path);
      if (lifetime) return safe[lifetime[1] === "short" ? "cache_short" : "cache_long"]!.source === "pi.dev";
      if (/^summary\.max_output$/.test(path)) return safe.max_output!.source === "pi.dev";
      if (/\.pricing(\.|$)|^summary\.price_(in|out|from)$/.test(path)) return safe.price!.source === "pi.dev";
      return false;
    };
    const kept: string[] = [];
    const seen = new Set<string>();
    const a = read<Catalog>(without, "site/api.json");
    const b = read<Catalog>(healthy, "site/api.json");
    for (const [id, provider] of Object.entries(b)) {
      for (const [model, entry] of Object.entries(provider.models)) {
        const found: string[] = [];
        paths(a[id]!.models[model], entry, "entry", found);
        for (const path of found) {
          seen.add(path.replace(QUANTITY, ".safe.$1.$2"));
          if (!allowed(path, ext(entry).safe as never)) kept.push(`${id}/${model} ${path}`);
        }
      }
    }
    const summaries = new Map(read<Index>(without, "site/data/index.json").entries.map((entry) => [entry.ref, entry]));
    for (const entry of read<Index>(healthy, "site/data/index.json").entries) {
      const found: string[] = [];
      paths(summaries.get(entry.ref), entry, "summary", found);
      for (const path of found) if (!allowed(path, entry.safe as never)) kept.push(`${entry.ref} ${path}`);
    }
    expect(kept).toEqual([]);
    // The fixture shows each kind: pi's block, pi's items, a value only pi states with its copies.
    for (const path of ["entry.providers_dev.pi", "entry.providers_dev.safe.input_window.sources", "entry.providers_dev.limits.input_window.tokens"]) expect([...seen]).toContain(path);
  });

  describe("the private report's write", () => {
    afterEach(() => {
      state.reportWriteFails = false;
    }, HOOK_TIMEOUT);

    it("the report's write throws: the healthy build, published, with one warning; pi-report.json absent", async () => {
      const dir = variant(piCatalog(), undefined);
      state.reportWriteFails = true;
      state.reportWrites = 0;
      const report = build(dir);
      expect(state.reportWrites).toBe(1);
      state.reportWriteFails = false;
      expect(report).toMatchObject({ ok: true, pi: "published" });
      expect(await contractProblems(join(dir, "published"))).toEqual([]);
      expect(comparePublished(join(healthyDir, "published"), join(dir, "published")).differences).toEqual([]);
      const files = filesOf(dir);
      expect(files.has("pi-report.json")).toBe(false);
      expect(differing(files, healthy)).toEqual(["pi-report.json", "site/data/meta.json"]);
      const meta = metaOf(files);
      const expected = metaOf(healthy);
      const warning = meta.issues.at(-1)!;
      expect(warning).toEqual({
        level: "warning",
        code: "pi-snapshot-unreadable",
        target: "data/published/pi-report.json",
        message: "pi's report could not be written (EIO: i/o error, write). The dataset is published with pi's data as usual; only data/published/pi-report.json is missing.",
      });
      expected.issues = [...expected.issues, warning];
      expect(meta).toEqual(expected);
      const output = join(tempDataDir(), "github-output");
      writeFileSync(output, "");
      writeBuildOutputs(report, output);
      expect(readFileSync(output, "utf8")).toBe("pi=published\n");
    });

    it("control: pi absent and the same write fault armed: nothing is written and nothing warns", () => {
      const dir = variant(null, undefined);
      state.reportWriteFails = true;
      state.reportWrites = 0;
      const report = build(dir);
      expect(state.reportWrites).toBe(0);
      state.reportWriteFails = false;
      expect(report).toMatchObject({ ok: true, pi: "none" });
      expect(differing(filesOf(dir), without)).toEqual([]);
    });
  });

  describe("the record's part", () => {
    let recordHealthyDir: string;
    let recordHealthy: Map<string, Buffer>;
    beforeAll(() => {
      recordHealthyDir = variant(piCatalog(), RECORD);
      expect(build(recordHealthyDir)).toMatchObject({ ok: true, pi: "published" });
      recordHealthy = filesOf(recordHealthyDir);
      expect(metaOf(recordHealthy).pi.sync).toEqual({ last_attempt_at: RECORD.last_attempt_at, last_attempt_ok: true, last_error: null });
    }, HOOK_TIMEOUT);

    const records: [string, unknown][] = [
      ["a string", "updated"],
      ["a number", 5],
      ["null", null],
      ["an array", [RECORD]],
      ...Object.keys(RECORD).map((key): [string, unknown] => [`the record without ${key}`, Object.fromEntries(Object.entries(RECORD).filter(([other]) => other !== key))]),
      ...Object.keys(RECORD).map((key): [string, unknown] => [`the record with ${key} of a wrong type`, { ...RECORD, [key]: 7 }]),
      ["the record with an unknown key", { ...RECORD, at: "x" }],
    ];

    it.each(records)("the pi record is %s: the healthy dataset, its record published as no attempt recorded, with a warning", async (_name, record) => {
      const dir = variant(piCatalog(), record);
      const report = build(dir);
      expect(report).toMatchObject({ ok: true, pi: "turned_away" });
      expect(await contractProblems(join(dir, "published"))).toEqual([]);
      expect(comparePublished(join(recordHealthyDir, "published"), join(dir, "published")).differences).toEqual([]);
      const files = filesOf(dir);
      expect(differing(files, recordHealthy)).toEqual(["site/data/meta.json"]);
      const meta = metaOf(files);
      const expected = metaOf(recordHealthy);
      const warning = meta.issues.at(-1)!;
      expect(warning).toMatchObject({ level: "warning", code: "pi-snapshot-unreadable", target: "data/sync-status.json" });
      expect(warning.message).toMatch(/^The record of the last pi import is left out of this dataset \([^\r\n]{1,300}\)\. It is published as no attempt recorded\.$/);
      expected.pi.sync = { last_attempt_at: null, last_attempt_ok: null, last_error: null };
      expected.issues = [...expected.issues, warning];
      expect(meta).toEqual(expected);
    });
  });
});

// ---- 4. the dataset is complete without pi

describe("4. the dataset is complete without pi", () => {
  it("resolve() gives pi null on every entry, buildIndex on every summary; both fit the contract; noPiMeta() fits", () => {
    const { catalog } = resolve({ upstream: fixtureUpstream(), additions: [], overrides: [], access: { default: "api", default_basis: "default", patterns: [], providers: {} }, routes: {} });
    const entries = Object.values(catalog).flatMap((provider) => Object.values(provider.models));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => ext(entry).pi === null)).toBe(true);
    for (const [id, provider] of Object.entries(catalog)) expect(ProviderSchema.safeParse(provider).success, id).toBe(true);
    const index = buildIndex(catalog, "v", "2026-11-20T12:00:00.000Z", "2026-11-20T12:00:00.000Z");
    expect(index.entries.every((summary) => summary.pi === null)).toBe(true);
    for (const summary of index.entries) expect(EntrySummarySchema.safeParse(summary).success, summary.ref).toBe(true);
    expect(MetaSchema.shape.pi.safeParse(noPiMeta()).success).toBe(true);
  });
});

// ---- 5. own properties

describe("5. own properties: a name of Object.prototype is an id like any other", () => {
  const evidence = [{ kind: "listed", url: "https://pi.dev/api/models", date: "2026-11-20", note: "a name of Object.prototype" }];
  let plainBlocks: Map<string, unknown>;
  beforeAll(() => {
    const dir = variant(piCatalog(), undefined);
    rmSync(join(dir, "authored", "pi-aliases.yaml"));
    expect(build(dir).pi).toBe("published");
    plainBlocks = blocksOf(filesOf(dir));
  }, HOOK_TIMEOUT);

  const model = (provider: string, id: string): PiModel => ({ ...piCatalog()["provider-00"]!["model-1"]!, id, provider, name: `pi ${id}` });

  it.each(Object.getOwnPropertyNames(Object.prototype))("%s as a pi model id, and as a pi provider id where the grammar allows it", (name) => {
    const catalog = piCatalog();
    // Never by assignment: `__proto__` is a setter.
    catalog["provider-00"] = Object.fromEntries([...Object.entries(catalog["provider-00"]!), [name, model("provider-00", name)]]);
    const pi: PiCatalog = PROVIDER_ID.test(name) ? Object.fromEntries([...Object.entries(catalog), [name, Object.fromEntries([["m", model(name, "m")]])]]) : catalog;
    const dir = variant(pi, undefined);
    rmSync(join(dir, "authored", "pi-aliases.yaml"));
    const report = build(dir);
    if (name === "__proto__") {
      // zod's record drops it: storedPi calls the snapshot unusable, and the data is turned away, the reference untouched.
      expect(report).toMatchObject({ ok: true, pi: "turned_away" });
      expect(report.issues.filter((issue) => issue.code === "pi-snapshot-unreadable")).toMatchObject([{ target: "data/pi" }]);
      expect(blocksOf(filesOf(dir)).size).toBe(0);
      return;
    }
    expect(report).toMatchObject({ ok: true, pi: "published" });
    expect(report.issues.map((issue) => issue.code)).not.toContain("pi-snapshot-unreadable");
    const blocks = blocksOf(filesOf(dir));
    expect(blocks).toEqual(plainBlocks);
    expect([...blocks.values()].some((block) => (block as { model: string }).model === name || (block as { provider: string }).provider === name)).toBe(false);
    const piReport = JSON.parse(readFileSync(join(dir, "published", "pi-report.json"), "utf8")) as { left_out: { pi_provider: string; pi_model: string }[] };
    expect(piReport.left_out.filter((item) => item.pi_model === name || item.pi_provider === name)).toEqual([]);
  });

  it.each(Object.getOwnPropertyNames(Object.prototype))("%s as a model key and a same_as of the alias file, and as a provider key and a same_as where the grammar allows it", (name) => {
    const dir = variant(piCatalog(), undefined);
    const providers: Record<string, unknown> = Object.fromEntries([
      // A second line keeps the provider line valid where the schema drops the name (`__proto__`).
      ["provider-00", { checked: "2026-11-20", models: Object.fromEntries([[name, { same_as: name }], ["model-1", { same_as: "model-1" }]]) }],
      ...(PROVIDER_ID.test(name) ? [[name, { same_as: name, reason: "A name of Object.prototype.", evidence }]] : []),
    ]);
    writeFileSync(join(dir, "authored", "pi-aliases.yaml"), stringify({ providers }));
    const report = build(dir);
    expect(report).toMatchObject({ ok: true, pi: "published" });
    expect(report.issues.map((issue) => issue.code)).not.toContain("pi-snapshot-unreadable");
    const blocks = blocksOf(filesOf(dir));
    expect(blocks).toEqual(plainBlocks);
  });
});

// ---- 6. being seen: the folder cases

describe("6. a data/pi/ that is there and cannot be used is never none", () => {
  const folder = (setup: (pi: string) => void): string => {
    const dir = variant(piCatalog(), undefined);
    setup(join(dir, "pi"));
    return dir;
  };
  it.each<[string, (pi: string) => void]>([
    ["an empty folder", (pi) => { rmSync(pi, { recursive: true }); mkdirSync(pi); }],
    ["one without meta.json", (pi) => rmSync(join(pi, "meta.json"))],
    ["one whose meta.json holds null", (pi) => writeFileSync(join(pi, "meta.json"), "null\n")],
    ["one without providers/", (pi) => rmSync(join(pi, "providers"), { recursive: true })],
  ])("%s gives the warning and turned_away", (_name, setup) => {
    const report = build(folder(setup));
    expect(report).toMatchObject({ ok: true, pi: "turned_away" });
    expect(report.issues.filter((issue) => issue.code === "pi-snapshot-unreadable")).toMatchObject([{ level: "warning", target: "data/pi" }]);
  });

  it("writeBuildOutputs writes the state for the workflow, and no line where the report has none", () => {
    const path = join(tempDataDir(), "github-output");
    writeFileSync(path, "earlier=1\n");
    for (const pi of ["published", "published_without_blocks", "none", "turned_away"] as const) writeBuildOutputs({ ok: true, errors: [], issues: [], pi }, path);
    writeBuildOutputs({ ok: false, errors: ["No upstream snapshot"], issues: [] }, path);
    expect(readFileSync(path, "utf8")).toBe("earlier=1\npi=published\npi=published_without_blocks\npi=none\npi=turned_away\n");
    const dir = variant(null, undefined);
    rmSync(join(dir, "upstream"), { recursive: true });
    expect(build(dir).pi).toBeUndefined();
  });

  it("no data/pi/ gives no warning and none", () => {
    const report = build(variant(null, undefined));
    expect(report).toMatchObject({ ok: true, pi: "none" });
    expect(report.issues.filter((issue) => issue.code.startsWith("pi-"))).toEqual([]);
  });
});

// ---- 6. being seen: a part that fits and has no block

describe("6. a part that fits and has no block is published whole, with the fence's pi-no-blocks warning", () => {
  const noBlock = (issue: { code: string }) => issue.code === "pi-no-blocks";
  /** piPart's true result as a matcher that matches nothing gives it: no block, every match counted unmatched. */
  const matchingNothing = (result: unknown) => {
    const copy = structuredClone(result) as { blocks: unknown[]; lists: unknown[]; report: { totals: { matched_id: number; matched_alias: number; unmatched: number } }; issues: { code: string }[] };
    const totals = copy.report.totals;
    copy.blocks = [];
    // A matcher that matches nothing pairs no provider either: pi has no list for any provider of the catalog.
    copy.lists = [];
    totals.unmatched += totals.matched_id + totals.matched_alias;
    totals.matched_id = 0;
    totals.matched_alias = 0;
    return copy;
  };
  let healthyDir: string;
  let withoutDir: string;

  beforeAll(() => {
    healthyDir = variant(piCatalog(), undefined);
    withoutDir = variant(null, undefined);
    expect(build(healthyDir)).toMatchObject({ ok: true, pi: "published" });
    expect(build(withoutDir)).toMatchObject({ ok: true, pi: "none" });
  }, HOOK_TIMEOUT);

  it("piPart's true result with no block and every match counted unmatched: pi's code says nothing, the fence warns, the data is published", async () => {
    const dir = variant(piCatalog(), undefined);
    state.fault = {
      name: "piPart",
      fired: false,
      apply: (callTrue) => after(callTrue, (result) => {
        const copy = matchingNothing(result);
        // pi's code says nothing of it: no issue but its alias issues.
        expect(copy.issues.every((issue) => issue.code.startsWith("pi-alias") || issue.code === "pi-provider-collides")).toBe(true);
        return copy;
      }),
    };
    const report = build(dir);
    expect(state.fault.fired).toBe(true);
    state.fault = null;

    expect(report).toMatchObject({ ok: true, pi: "published_without_blocks" });
    // The contract fits, and the reference is untouched.
    expect(await contractProblems(join(dir, "published"))).toEqual([]);
    expect(comparePublished(join(healthyDir, "published"), join(dir, "published")).differences).toEqual([]);

    const files = filesOf(dir);
    const healthy = filesOf(healthyDir);
    const without = filesOf(withoutDir);
    const meta = metaOf(files);
    const healthyMeta = metaOf(healthy);
    // meta.pi: the healthy build's snapshot and record; the counts as pi's code gave them.
    expect(meta.pi.snapshot).toEqual(healthyMeta.pi.snapshot);
    expect(meta.pi.sync).toEqual(healthyMeta.pi.sync);
    const { entries_with_block, left_out_models, unmatched_models } = healthyMeta.pi.counts;
    expect(entries_with_block).toBeGreaterThan(0);
    expect(meta.pi.counts).toEqual({ entries_with_block: 0, left_out_models, unmatched_models: unmatched_models + entries_with_block });
    // Issues: the healthy build's (pi's alias issue first), then the one warning of the fence.
    const models = meta.pi.snapshot!.models;
    expect(meta.issues).toEqual([
      ...healthyMeta.issues,
      { level: "warning", code: "pi-no-blocks", target: "data/pi", message: `pi's snapshot has ${models} models and no entry has a pi block (left out: ${left_out_models}, unmatched: ${unmatched_models + entries_with_block}). pi's data is published as pi's code gave it.` },
    ]);
    expect(report.issues.filter(noBlock)).toHaveLength(1);
    expect(report.issues.filter((issue) => issue.code === "pi-snapshot-unreadable")).toEqual([]);
    // Published as it is: no entry has a block, pi's report is written, the notice names pi's snapshot as the healthy
    // build's does, and every other file is the without build's.
    expect(blocksOf(files).size).toBe(0);
    expect(files.has("pi-report.json")).toBe(true);
    expect(JSON.parse(files.get("pi-report.json")!.toString("utf8")).totals).toMatchObject({ matched_id: 0, matched_alias: 0 });
    // No entry has a block, so the dataset's version is the without build's.
    expect(meta.dataset_version).toBe(metaOf(without).dataset_version);
    expect(files.get("site/data/NOTICE.txt")!.toString("utf8")).toBe(healthy.get("site/data/NOTICE.txt")!.toString("utf8").replaceAll(healthyMeta.dataset_version, meta.dataset_version));
    expect(differing(files, without)).toEqual(["pi-report.json", "site/data/NOTICE.txt", "site/data/meta.json"]);
    // meta.json is the without build's but for meta.pi and the issues.
    const withoutMeta = metaOf(without);
    expect({ ...meta, pi: null, issues: null }).toEqual({ ...withoutMeta, pi: null, issues: null });
  });

  it("a record turned away beside a part with no block gives turned_away, with both warnings", () => {
    const dir = variant(piCatalog(), "not a record");
    state.fault = { name: "piPart", fired: false, apply: (callTrue) => after(callTrue, matchingNothing) };
    const report = build(dir);
    expect(state.fault.fired).toBe(true);
    state.fault = null;
    expect(report).toMatchObject({ ok: true, pi: "turned_away" });
    expect(report.issues.filter((issue) => issue.code === "pi-no-blocks" || issue.code === "pi-snapshot-unreadable").map((issue) => [issue.code, issue.target])).toEqual([
      ["pi-no-blocks", "data/pi"],
      ["pi-snapshot-unreadable", "data/sync-status.json"],
    ]);
  });

  it("a healthy build has no such warning; no data/pi/ and an unusable one have none either", () => {
    expect(build(variant(piCatalog(), undefined)).issues.filter(noBlock)).toEqual([]);
    expect(build(variant(null, undefined)).issues.filter(noBlock)).toEqual([]);
    const dir = variant(piCatalog(), undefined);
    rmSync(join(dir, "pi", "meta.json"));
    const unusable = build(dir);
    expect(unusable.pi).toBe("turned_away");
    expect(unusable.issues.filter(noBlock)).toEqual([]);
  });

  it("a usable snapshot with no models fits and has no block: the rule as decided warns there too", () => {
    const report = build(variant({}, undefined));
    expect(report).toMatchObject({ ok: true, pi: "published_without_blocks" });
    expect(report.issues.filter(noBlock)).toEqual([
      { level: "warning", code: "pi-no-blocks", target: "data/pi", message: "pi's snapshot has 0 models and no entry has a pi block (left out: 0, unmatched: 0). pi's data is published as pi's code gave it." },
    ]);
  });
});

// ---- 2. the sync, by the same table

describe("2. the sync, by the same table", () => {
  const OBSERVED = JSON.stringify({
    schema: 1, repository: "https://github.com/example/probe", routes: {}, clients: {},
    cache: [{ id: "probe/R1", route: "provider-00", client: "direct", model: "model-1", date: "2026-11-12", source: "results/r1.json", latest: true, control: { warm: 1, total: 1 }, checks: [{ age_s: 150, warm: 1, total: 1 }, { age_s: 300, warm: 0, total: 1 }] }],
  });
  const FIRST = JSON.stringify(fixturePi(20, 30));
  const CHANGED = (() => {
    const catalog = fixturePi(20, 30);
    catalog["provider-03"]!["model-1"]!.name = "Model 1, renamed";
    return JSON.stringify(catalog);
  })();
  const REVISION = "sha256-dd93eb2741d05a80";
  const SYNC_NOW = () => new Date("2026-11-21T04:17:00.000Z");

  /** models.dev, its commit and the measurements as on the first import (304 after it); pi as `pi` answers. */
  const fetchWith = (pi: (init?: RequestInit) => Promise<Response> | Response): typeof fetch =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === PI_URL) return pi(init);
      if (url === UPSTREAM_URL) return init?.headers && (init.headers as Record<string, string>)["If-None-Match"] ? new Response(null, { status: 304 }) : new Response(JSON.stringify(fixtureUpstream()), { headers: { etag: '"u1"' } });
      if (url === UPSTREAM_COMMIT_URL) return new Response(JSON.stringify({ sha: "abc123", commit: { committer: { date: "2026-11-12T00:00:00Z" } } }));
      if (url === OBSERVED_URL) return init?.headers && (init.headers as Record<string, string>)["If-None-Match"] ? new Response(null, { status: 304 }) : new Response(OBSERVED, { headers: { etag: '"o1"' } });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  const changedFeed = () => new Response(CHANGED, { headers: { etag: '"p2"', "x-pi-model-catalog-revision": REVISION } });

  /** Every file under `dir` (relative path -> bytes). */
  const under = (dir: string): Map<string, Buffer> => {
    const out = new Map<string, Buffer>();
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) if (entry.isFile()) out.set(join(entry.parentPath, entry.name).slice(dir.length + 1), readFileSync(join(entry.parentPath, entry.name)));
    return out;
  };
  const same = (a: Map<string, Buffer>, b: Map<string, Buffer>): boolean => a.size === b.size && [...a].every(([path, bytes]) => b.get(path)?.equals(bytes) === true);
  const statusOf = (dir: string): SyncStatus => JSON.parse(readFileSync(join(dir, "sync-status.json"), "utf8")) as SyncStatus;
  const fiveOf = (status: SyncStatus) => ({ ...status, pi: undefined });

  let base: string;
  let healthy: { report: SyncReport; status: SyncStatus; upstream: Map<string, Buffer>; sources: Map<string, Buffer>; pi: Map<string, Buffer> };
  let piBefore: Map<string, Buffer>;
  const copy = (): string => {
    const dir = tempDataDir();
    cpSync(base, dir, { recursive: true });
    return dir;
  };

  beforeAll(async () => {
    base = tempDataDir();
    const first = await sync({ dataDir: base, now: () => new Date("2026-11-20T04:17:00.000Z"), fetch: fetchWith(() => new Response(FIRST, { headers: { etag: '"p1"', "x-pi-model-catalog-revision": "sha256-0123456789" } })) });
    expect([first.ok, first.pi.status]).toEqual([true, "updated"]);
    piBefore = under(join(base, "pi"));
    const dir = copy();
    const report = await sync({ dataDir: dir, now: SYNC_NOW, fetch: fetchWith(changedFeed) });
    expect(report).toMatchObject({ ok: true, pi: { status: "updated" }, piRevision7: "dd93eb2" });
    healthy = { report, status: statusOf(dir), upstream: under(join(dir, "upstream")), sources: under(join(dir, "sources")), pi: under(join(dir, "pi")) };
    expect(same(healthy.pi, piBefore)).toBe(false);
  }, HOOK_TIMEOUT);

  afterEach(() => {
    vi.useRealTimers();
    state.fault = null;
  }, HOOK_TIMEOUT);

  /** What must hold after a pi part that failed: everything of models.dev as a healthy run leaves it; data/pi/ usable. */
  const holds = (dir: string, report: SyncReport, pi: "as it was" | "as a healthy run leaves it"): void => {
    expect(report.ok).toBe(healthy.report.ok);
    expect(report.pi.status).toBe("failed");
    expect(report.piRevision7).toBe("snapshot");
    const status = statusOf(dir);
    expect(fiveOf(status)).toEqual(fiveOf(healthy.status));
    expect(same(under(join(dir, "upstream")), healthy.upstream)).toBe(true);
    expect(same(under(join(dir, "sources")), healthy.sources)).toBe(true);
    expect(status.pi).toMatchObject({ last_attempt_at: SYNC_NOW().toISOString(), status: "failed" });
    expect(status.pi!.error).toMatch(/^[^\r\n]{1,300}$/);
    expect(Object.keys(status.pi!)).toEqual(["last_attempt_at", "status", "error"]);
    const output = join(tempDataDir(), "github-output");
    writeFileSync(output, "");
    writeStepOutputs(report, output);
    expect(readFileSync(output, "utf8")).toContain("pi=failed\n");
    expect(storedPi(dir).state).toBe("usable");
    expect(same(under(join(dir, "pi")), pi === "as it was" ? piBefore : healthy.pi)).toBe(true);
    expect(readdirSync(dir).filter((name) => name.startsWith("pi.tmp")).length).toBe(0);
  };

  /** The boundary functions of the sync: the ones a healthy first import, a 304 and a failed import call through the wrappers. */
  let syncCalls: string[] | null = null;
  async function syncBoundary(): Promise<string[]> {
    if (syncCalls) return syncCalls;
    state.calls.clear();
    const dir = tempDataDir();
    await sync({ dataDir: dir, now: SYNC_NOW, fetch: fetchWith(() => new Response(FIRST, { headers: { etag: '"p1"' } })) });
    await sync({ dataDir: dir, now: SYNC_NOW, fetch: fetchWith(() => new Response(null, { status: 304 })) });
    await sync({ dataDir: dir, now: SYNC_NOW, fetch: fetchWith(() => new Response("down", { status: 503 })) });
    syncCalls = [...state.calls].sort();
    return syncCalls;
  }

  it("the boundary function of the sync is syncPi, and every row of its faults fires and fails the pi part alone", async () => {
    const names = await syncBoundary();
    expect(names).toEqual(["syncPi"]);
    // The true result of syncPi in a healthy run, for the faults that need it.
    let trueResult: unknown;
    state.fault = { name: "syncPi", fired: false, apply: (callTrue) => after(callTrue, (result) => { trueResult = structuredClone(result); return result; }) };
    await sync({ dataDir: copy(), now: SYNC_NOW, fetch: fetchWith(changedFeed) });
    state.fault = null;
    expect(trueResult).toMatchObject({ status: "updated", revision: REVISION });
    const rows = names.flatMap((name) => faultsOf(name, trueResult));
    const fired: string[] = [];
    for (const row of rows) {
      const dir = copy();
      state.fault = { name: row.name, apply: row.apply, fired: false };
      // A fault that runs the true function first leaves data/pi/ as a healthy run leaves it; one that does not, as it was.
      let ranTrue = false;
      const apply = row.apply;
      state.fault.apply = (callTrue) => apply(() => { ranTrue = true; return callTrue(); });
      const report = await sync({ dataDir: dir, now: SYNC_NOW, fetch: fetchWith(changedFeed) });
      if (state.fault.fired) fired.push(row.label);
      state.fault = null;
      holds(dir, report, ranTrue ? "as a healthy run leaves it" : "as it was");
    }
    console.log(`the sync's table: ${names.join(", ")}, ${rows.length} rows, ${fired.length} fired`);
    expect(fired).toHaveLength(rows.length);
  }, 120_000);

  it("syncPi assigns each of its options: the run ends as a healthy run, with the pi part's own outcome", async () => {
    const dir = copy();
    const elsewhere = join(tempDataDir(), "not-the-data-folder");
    // Every option of SyncOptions, assigned on the object syncPi receives, before the true function runs with it.
    const assigned: Record<string, unknown> = {
      dataDir: elsewhere,
      fetch: () => Promise.reject(new Error("an assigned fetch")),
      now: () => new Date(Number.NaN),
      log: () => {
        throw new Error("an assigned log");
      },
      force: true,
      only: "pi",
    };
    state.fault = {
      name: "syncPi",
      fired: false,
      apply: (callTrue, args) => {
        Object.assign(args[0] as object, assigned);
        return callTrue();
      },
    };
    const report = await sync({ dataDir: dir, now: SYNC_NOW, fetch: fetchWith(changedFeed) });
    expect(state.fault.fired).toBe(true);
    state.fault = null;
    // The pi part's own outcome: its clock is invalid, so it fails; the caller's clock wrote the record.
    expect(report.pi).toEqual({ status: "failed", error: "Invalid time value" });
    holds(dir, report, "as it was");
    expect(report.upstream).toEqual(healthy.report.upstream);
    expect(report.measurements).toEqual(healthy.report.measurements);
    expect(existsSync(elsewhere)).toBe(false);
  });

  it.each<[string, () => unknown]>([
    ["an Error", () => new Error("broken on purpose")],
    ["an object whose message is a number and whose toString throws", hostile],
    ["an Error with line breaks, control characters and 1,000 characters", () => new Error(`one\ntwo\r\u0000${"x".repeat(1000)}`)],
  ])("a fetch that rejects with %s fails the pi part alone", async (_name, thrown) => {
    const dir = copy();
    const report = await sync({ dataDir: dir, now: SYNC_NOW, fetch: fetchWith(() => Promise.reject(thrown())) });
    holds(dir, report, "as it was");
  });

  it("a body that never ends fails the pi part at the deadline", async () => {
    const dir = copy();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let signal: AbortSignal | undefined;
    const pending = sync({
      dataDir: dir,
      now: SYNC_NOW,
      fetch: fetchWith((init) => {
        signal = init?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
            signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
          },
        });
        return new Response(body, { headers: { etag: '"p2"' } });
      }),
    });
    while (!signal) await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(PI_DEADLINE_MS);
    const report = await pending;
    expect(report.pi.error).toBe("pi.dev did not answer in full within 60 s");
    holds(dir, report, "as it was");
  });

  it("a body over the size cap fails the pi part without being read to the end", async () => {
    const dir = copy();
    let pulled = 0;
    const report = await sync({
      dataDir: dir,
      now: SYNC_NOW,
      fetch: fetchWith(() => new Response(new ReadableStream<Uint8Array>({ pull: (controller) => { pulled += 1; controller.enqueue(new Uint8Array(1024 * 1024).fill(32)); } }), { headers: { etag: '"p2"' } })),
    });
    expect(report.pi.error).toBe("the pi feed is unexpectedly large: more than 16 MB");
    expect(pulled).toBeLessThanOrEqual(20);
    holds(dir, report, "as it was");
  });

  it("while the pi part is held open, the status file already has this run's five fields and the record that it did not finish", async () => {
    const dir = copy();
    let answer: ((response: Response) => void) | undefined;
    const pending = sync({ dataDir: dir, now: SYNC_NOW, fetch: fetchWith(() => new Promise<Response>((resolve) => { answer = resolve; })) });
    while (!answer) await new Promise((resolve) => setImmediate(resolve));
    const during = statusOf(dir);
    expect(fiveOf(during)).toEqual(fiveOf(healthy.status));
    expect(during.pi).toEqual({ last_attempt_at: SYNC_NOW().toISOString(), status: "failed", error: "The pi part did not finish." });
    answer(changedFeed());
    const report = await pending;
    expect(report.pi.status).toBe("updated");
    expect(statusOf(dir)).toEqual(healthy.status);
  });
});
