// The whole-dataset comparison (design/pi-source.md, section j), on two copies of the fixture's published dataset.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { comparePublished } from "../scripts/lib/compare-published.ts";
import { publish } from "../scripts/lib/publish.ts";
import { sync } from "../scripts/lib/sync.ts";
import type { Index } from "../src/core/entries.ts";
import type { Catalog, JsonObject, Meta } from "../src/core/schema.ts";
import { fetchReturning, fixturePi, fixtureUpstream, ROOT, tempDataDir, writeAuthored, writePiSnapshot } from "./helpers.ts";

let original: string;
/** The same data with pi's catalog: blocks, and pi's statements laid over the safe values. */
let withPi: string;

beforeAll(async () => {
  const dataDir = tempDataDir();
  await sync({ dataDir, fetch: fetchReturning(JSON.stringify(fixtureUpstream())) });
  writeAuthored(dataDir);
  expect(publish({ dataDir, rootDir: ROOT }).errors).toEqual([]);
  original = join(dataDir, "published");
  const piDir = tempDataDir();
  for (const part of ["upstream", "authored"]) cpSync(join(dataDir, part), join(piDir, part), { recursive: true });
  mkdirSync(join(piDir, "sources"), { recursive: true });
  cpSync(join(dataDir, "sync-status.json"), join(piDir, "sync-status.json"));
  const pi = fixturePi();
  // A model only pi lists a window and an output for: provider-03/model-7 has no limit of its own.
  pi["provider-03"]!["model-7"]!.contextWindow = 777000;
  writePiSnapshot(piDir, pi);
  expect(publish({ dataDir: piDir, rootDir: ROOT }).errors).toEqual([]);
  withPi = join(piDir, "published");
});

/** A copy of the fixture's published dataset, with `change` applied to its files. */
function copy(change: (files: { catalog: Catalog; index: Index; meta: Meta }) => void = () => {}): string {
  const dir = join(tempDataDir(), "published");
  cpSync(original, dir, { recursive: true });
  const path = (name: string) => join(dir, "site", name);
  const files = {
    catalog: JSON.parse(readFileSync(path("api.json"), "utf8")) as Catalog,
    index: JSON.parse(readFileSync(path("data/index.json"), "utf8")) as Index,
    meta: JSON.parse(readFileSync(path("data/meta.json"), "utf8")) as Meta,
  };
  change(files);
  writeFileSync(path("api.json"), JSON.stringify(files.catalog));
  writeFileSync(path("data/index.json"), JSON.stringify(files.index));
  writeFileSync(path("data/meta.json"), JSON.stringify(files.meta));
  return dir;
}

const extension = (catalog: Catalog, provider: string, model: string) => catalog[provider]!.models[model]!.providers_dev as JsonObject;

describe("compare:published", () => {
  it("passes two equal datasets, and counts the entries with the key and with a block", () => {
    const result = comparePublished(original, copy());
    expect(result.ok).toBe(true);
    expect(result.lines).toEqual(["compared: 31 providers, 601 entries", "entries with the key pi: 601 -> 601", "entries with a pi block: 0 -> 0", "items of safe.*.sources from pi.dev: 0 -> 0", "safe values from pi.dev: 0 -> 0", "differing objects: 0"]);
  });

  it("passes the build with pi's data against the build without: pi's items and the values only pi states are taken off with withoutPi and the copies", () => {
    const result = comparePublished(original, withPi);
    expect(result.differences).toEqual([]);
    const counted = (prefix: string) => Number(result.lines.find((line) => line.startsWith(prefix))!.split(" -> ")[1]);
    expect(counted("entries with a pi block")).toBeGreaterThan(0);
    expect(counted("items of safe.*.sources from pi.dev")).toBeGreaterThan(0);
    expect(counted("safe values from pi.dev")).toBeGreaterThanOrEqual(2);
    const catalog = JSON.parse(readFileSync(join(withPi, "site", "api.json"), "utf8")) as Catalog;
    expect(extension(catalog, "provider-03", "model-7").safe).toMatchObject({ input_window: { value: 777000, source: "pi.dev" }, max_output: { value: 8000, source: "pi.dev" } });
    expect((extension(catalog, "provider-03", "model-7").limits as JsonObject).input_window).toMatchObject({ tokens: 777000, basis: "documented", source: "pi.dev" });
  });

  it("fails where pi's data changed a value another source states", () => {
    const changed = join(tempDataDir(), "published");
    cpSync(withPi, changed, { recursive: true });
    const path = join(changed, "site", "api.json");
    const catalog = JSON.parse(readFileSync(path, "utf8")) as Catalog;
    const safe = extension(catalog, "provider-02", "lab/model-4").safe as { input_window: { value: number; sources: { source: string; value: number }[] } };
    safe.input_window.value = 1;
    writeFileSync(path, JSON.stringify(catalog));
    expect(comparePublished(withPi, changed).ok).toBe(false);
    expect(comparePublished(original, changed).differences.some((line) => line.startsWith("entry provider-02/lab/model-4"))).toBe(true);
  });

  it("passes a difference under providers_dev.pi, the summary's pi, meta.pi, the pi licence keys and the pi- issues alone", () => {
    const after = copy(({ catalog, index, meta }) => {
      extension(catalog, "provider-03", "model-1").pi = { ref: "provider-03/model-1" };
      index.entries.find((entry) => entry.ref === "provider-03/model-1")!.pi = { ref: "provider-03/model-1", api: "openai-completions", match: "id", difference_count: 0 };
      meta.pi.counts.entries_with_block = 1;
      meta.license.pi = "another line";
      meta.issues.push({ level: "warning", code: "pi-alias-orphan", target: "x", message: "x" });
      meta.dataset_version = "another";
      meta.generated_at = "2026-11-21T00:00:00.000Z";
    });
    const result = comparePublished(original, after);
    expect(result.differences).toEqual([]);
    expect(result.lines).toContain("entries with a pi block: 0 -> 1");
  });

  it.each<[string, (files: { catalog: Catalog; index: Index; meta: Meta }) => void, RegExp]>([
    ["a changed limit.context", ({ catalog }) => ((catalog["provider-02"]!.models["model-1"]!.limit as JsonObject).context = 1), /^entry provider-02\/model-1: \.limit\.context$/],
    ["a missing entry", ({ catalog, index }) => { delete catalog["provider-02"]!.models["model-1"]; index.entries = index.entries.filter((entry) => entry.ref !== "provider-02/model-1"); }, /^entry provider-02\/model-1: missing after$/],
    ["a new entry", ({ catalog }) => (catalog["provider-02"]!.models["fresh"] = { ...catalog["provider-02"]!.models["model-1"]!, id: "fresh" }), /^entry provider-02\/fresh: new after$/],
    ["a changed provider summary", ({ index }) => (index.providers.find((provider) => provider.id === "provider-04")!.entry_count += 1), /^provider summary provider-04: \.entry_count$/],
    ["another key of providers_dev", ({ catalog }) => (extension(catalog, "provider-05", "model-3").verified = "2026-11-20"), /^entry provider-05\/model-3: \.providers_dev\.verified$/],
    ["a changed count of meta", ({ meta }) => (meta.counts.entries += 1), /^meta: \.counts\.entries$/],
  ])("fails on %s and names it", (_name, change, words) => {
    const result = comparePublished(original, copy(change));
    expect(result.ok).toBe(false);
    expect(result.differences.some((line) => words.test(line)), result.differences.join("\n")).toBe(true);
    expect(result.lines).toContain(`differing objects: ${result.differences.length}`);
  });

  it("refuses two datasets built from different models.dev snapshots or measurements", () => {
    const upstream = comparePublished(original, copy(({ meta }) => (meta.upstream.sha256 = "0".repeat(64))));
    expect([upstream.ok, upstream.refused]).toEqual([false, expect.stringMatching(/^refused: the two are built from different models\.dev snapshots/)]);
    const measurements = comparePublished(original, copy(({ meta }) => (meta.measurements = { source: "x", fetched_at: "x", checked_at: "x", etag: null, sha256: "1".repeat(64), repository: "https://example.com" })));
    expect([measurements.ok, measurements.refused]).toEqual([false, expect.stringMatching(/^refused: the two are built from different measurements files/)]);
  });
});
