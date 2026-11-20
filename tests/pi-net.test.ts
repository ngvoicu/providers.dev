// The net under the pi part of the build (release review, blocker 4): whatever reaches the build from pi's side, the
// dataset it publishes fits the contract. Here the fault is put below the net, in what src/core/pi.ts hands the build,
// past every check of the snapshot: a block, a summary's pi, or the counts of meta.pi that the contract refuses.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { handleApi } from "../src/core/api.ts";
import { EntryDetailSchema, EntrySummarySchema, MetaSchema, one, ProviderSchema } from "../src/core/contract.ts";
import type * as PiModule from "../src/core/pi.ts";
import type { PiBlock, PiReport, PiSummary } from "../src/core/pi.ts";
import type { Catalog, Meta } from "../src/core/schema.ts";
import { piMisfit, publish } from "../scripts/lib/publish.ts";
import { pretty } from "../scripts/lib/files.ts";
import { piProviderFile, sync } from "../scripts/lib/sync.ts";
import { depsFrom, fetchReturning, fixturePi, fixtureUpstream, ROOT, tempDataDir, writeAuthored } from "./helpers.ts";

/** Which output of src/core/pi.ts is made not to fit the contract. */
const fault = vi.hoisted(() => ({ in: null as null | "meta" | "block" | "summary" }));
vi.mock("../src/core/pi.ts", async (importOriginal) => {
  const original = await importOriginal<typeof PiModule>();
  return {
    ...original,
    // One block (lab/model-2 of provider-02) with a context window the contract refuses.
    piBlock: (...args: Parameters<typeof original.piBlock>): PiBlock => {
      const block = original.piBlock(...args);
      return fault.in === "block" && block.ref === "provider-02/lab/model-2" ? { ...block, context_window: "wide" as unknown as number } : block;
    },
    piSummary: (block: PiBlock | null): PiSummary | null => {
      const summary = original.piSummary(block);
      return fault.in === "summary" && summary?.ref === "provider-02/lab/model-2" ? { ...summary, difference_count: -1 } : summary;
    },
    piReport: (...args: Parameters<typeof original.piReport>): PiReport => {
      const report = original.piReport(...args);
      return fault.in === "meta" ? { ...report, totals: { ...report.totals, left_out: 0.5 } } : report;
    },
  };
});
afterEach(() => {
  fault.in = null;
});

/** A data directory with models.dev, our authored files and a whole pi snapshot that matches its entries. */
async function dataDir(): Promise<string> {
  const dir = tempDataDir();
  await sync({ dataDir: dir, fetch: fetchReturning(JSON.stringify(fixtureUpstream())) });
  writeAuthored(dir);
  const catalog = fixturePi(12, 30);
  mkdirSync(join(dir, "pi", "providers"), { recursive: true });
  for (const [id, models] of Object.entries(catalog)) writeFileSync(join(dir, "pi", "providers", `${id}.json`), piProviderFile(id, models));
  writeFileSync(join(dir, "pi", "meta.json"), pretty({ source: "https://pi.dev/api/models", fetched_at: "2026-11-20T14:19:45.000Z", checked_at: "2026-11-20T14:19:45.000Z", etag: '"p1"', revision: "sha256-dd93eb27", sha256: "ab".repeat(32), providers: 12, models: 360 }));
  const status = join(dir, "sync-status.json");
  writeFileSync(status, pretty({ ...JSON.parse(readFileSync(status, "utf8")), pi: { last_attempt_at: "2026-11-20T14:19:45.000Z", status: "updated" } }));
  return dir;
}

/** What the contract test checks of a published dataset, for every part pi reaches; the problems found, none = it holds. */
async function contractProblems(published: string): Promise<string[]> {
  const deps = depsFrom(published);
  const problems: string[] = [];
  const valid = (schema: z.ZodType, value: unknown, what: string): void => {
    const result = schema.safeParse(value);
    if (!result.success) problems.push(`${what}: ${result.error.issues[0]?.path.join(".")}: ${result.error.issues[0]?.message}`);
  };
  const ask = async (path: string): Promise<unknown> => (await handleApi(new Request(`https://providers.dev${path}`), deps)).json();
  valid(one(MetaSchema), await ask("/api/v1/meta"), "meta");
  for (const entry of deps.index.entries) valid(EntrySummarySchema, entry, entry.ref);
  const exported = JSON.parse(readFileSync(join(published, "site", "api.json"), "utf8")) as Catalog;
  for (const [id, provider] of Object.entries(exported)) valid(ProviderSchema, provider, id);
  valid(one(EntryDetailSchema), await ask("/api/v1/entries/provider-02/lab/model-2"), "provider-02/lab/model-2");
  return problems;
}

const blocks = (published: string): number => {
  const exported = JSON.parse(readFileSync(join(published, "site", "api.json"), "utf8")) as Catalog;
  return Object.values(exported).flatMap((provider) => Object.values(provider.models)).filter((model) => (model.providers_dev as unknown as { pi: unknown }).pi !== null).length;
};

describe("the net under the pi part of the build", () => {
  it("lets a dataset whose pi part fits through unchanged, with no warning", async () => {
    const dir = await dataDir();
    const report = publish({ dataDir: dir, rootDir: ROOT });
    expect(report.ok).toBe(true);
    expect(report.issues.map((issue) => issue.code)).not.toContain("pi-snapshot-unreadable");
    const published = join(dir, "published");
    expect(blocks(published)).toBeGreaterThan(0);
    expect(await contractProblems(published)).toEqual([]);
  });

  it.each([
    ["meta.pi", "meta" as const, "meta.pi.counts.left_out_models"],
    ["an entry's block", "block" as const, "providers_dev.pi of the entry provider-02/lab/model-2.context_window"],
    ["a summary's pi", "summary" as const, "pi of the summary provider-02/lab/model-2.difference_count"],
  ])("%s that the contract refuses: the dataset is published without pi data, fits the contract and warns pi-snapshot-unreadable", async (_name, where, named) => {
    const dir = await dataDir();
    fault.in = where;
    const report = publish({ dataDir: dir, rootDir: ROOT });
    expect(report.ok).toBe(true);
    const published = join(dir, "published");
    expect(blocks(published)).toBe(0);
    const index = JSON.parse(readFileSync(join(published, "site", "data", "index.json"), "utf8")) as { entries: { pi: unknown }[] };
    expect(index.entries.every((entry) => entry.pi === null)).toBe(true);
    const meta = JSON.parse(readFileSync(join(published, "site", "data", "meta.json"), "utf8")) as Meta;
    expect(meta.pi.snapshot).toBeNull();
    expect(meta.pi.counts).toEqual({ entries_with_block: 0, left_out_models: 0, unmatched_models: 0 });
    expect(meta.pi.sync).toEqual({ last_attempt_at: "2026-11-20T14:19:45.000Z", last_attempt_ok: true, last_error: null });
    const warnings = meta.issues.filter((issue) => issue.code.startsWith("pi-"));
    expect(warnings).toMatchObject([{ level: "warning", code: "pi-snapshot-unreadable", target: "data/pi" }]);
    expect(warnings[0]!.message).toContain(`what the build would publish for pi does not fit the contract: ${named}`);
    expect(await contractProblems(published)).toEqual([]);
  });

  /** The data directory with the `pi` record of data/sync-status.json replaced by `record`. */
  const withRecord = async (record: unknown): Promise<string> => {
    const dir = await dataDir();
    const path = join(dir, "sync-status.json");
    writeFileSync(path, pretty({ ...JSON.parse(readFileSync(path, "utf8")), pi: record }));
    return dir;
  };
  const good = { last_attempt_at: "2026-11-20T14:19:45.000Z", status: "updated" };

  it.each<[string, unknown, string]>([
    ["last_attempt_at 5 (the reproduction)", { ...good, last_attempt_at: 5 }, "pi.last_attempt_at"],
    ["last_attempt_at missing", { status: "updated" }, "pi.last_attempt_at"],
    ["status a word the sync never writes", { ...good, status: "done" }, "pi.status"],
    ["status a number", { ...good, status: 1 }, "pi.status"],
    ["error a number", { ...good, status: "failed", error: 503 }, "pi.error"],
    ["a key the record does not have", { ...good, at: "x" }, "pi"],
    ["not a record at all", "updated", "pi"],
    ["null", null, "pi"],
  ])("a pi sync record with %s counts as no attempt recorded, with a warning; the pi data stays and /meta fits the contract", async (_name, record, where) => {
    const dir = await withRecord(record);
    const report = publish({ dataDir: dir, rootDir: ROOT });
    expect(report.ok).toBe(true);
    const published = join(dir, "published");
    const meta = JSON.parse(readFileSync(join(published, "site", "data", "meta.json"), "utf8")) as Meta;
    expect(meta.pi.sync).toEqual({ last_attempt_at: null, last_attempt_ok: null, last_error: null });
    expect(meta.pi.snapshot).not.toBeNull();
    expect(blocks(published)).toBeGreaterThan(0);
    const warnings = meta.issues.filter((issue) => issue.code.startsWith("pi-"));
    expect(warnings).toMatchObject([{ level: "warning", code: "pi-snapshot-unreadable", target: "data/sync-status.json" }]);
    expect(warnings[0]!.message).toContain(`cannot be read (${where}`);
    expect(warnings[0]!.message).toContain("published as no attempt recorded");
    expect(await contractProblems(published)).toEqual([]);
  });

  it("a bad sync record and a block the contract refuses together: the fallback of the net fits the contract too", async () => {
    const dir = await withRecord({ ...good, last_attempt_at: 5 });
    fault.in = "block";
    expect(publish({ dataDir: dir, rootDir: ROOT }).ok).toBe(true);
    const published = join(dir, "published");
    expect(blocks(published)).toBe(0);
    const meta = JSON.parse(readFileSync(join(published, "site", "data", "meta.json"), "utf8")) as Meta;
    expect(meta.issues.filter((issue) => issue.code === "pi-snapshot-unreadable").map((issue) => issue.target)).toEqual(["data/sync-status.json", "data/pi"]);
    expect(await contractProblems(published)).toEqual([]);
  });

  it("a good record is published as before", async () => {
    for (const [record, expected] of [
      [good, { last_attempt_at: "2026-11-20T14:19:45.000Z", last_attempt_ok: true, last_error: null }],
      [{ last_attempt_at: "2026-11-21T04:17:00.000Z", status: "failed", error: "pi.dev answered HTTP 503" }, { last_attempt_at: "2026-11-21T04:17:00.000Z", last_attempt_ok: false, last_error: "pi.dev answered HTTP 503" }],
    ] as const) {
      const dir = await withRecord(record);
      const report = publish({ dataDir: dir, rootDir: ROOT });
      expect(report.issues.map((issue) => issue.code)).not.toContain("pi-snapshot-unreadable");
      expect((JSON.parse(readFileSync(join(dir, "published", "site", "data", "meta.json"), "utf8")) as Meta).pi.sync).toEqual(expected);
    }
  });

  const real = join(ROOT, "data", "published", "site");
  it.skipIf(!existsSync(join(real, "api.json")))("lets the committed data through", () => {
    const read = (path: string) => JSON.parse(readFileSync(join(real, path), "utf8"));
    expect(piMisfit(read("api.json"), read("data/index.json"), read("data/meta.json"))).toBeNull();
  });
});
