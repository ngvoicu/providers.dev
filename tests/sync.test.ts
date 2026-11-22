import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publish } from "../scripts/lib/publish.ts";
import { MetaSchema } from "../src/core/contract.ts";
import { ObservedFile } from "../src/core/schema.ts";
import { loadUpstream, sync, SyncBusyError, UPSTREAM_URL } from "../scripts/lib/sync.ts";
import { stringify } from "yaml";
import { fetchReturning, fixtureUpstream, ROOT, tempDataDir, writeAuthored } from "./helpers.ts";

const good = JSON.stringify(fixtureUpstream());

/** A measurements file with one run; `ages` are the ages of its checks, in the order the file lists them. */
const observedWith = (ages: number[]): string =>
  JSON.stringify({
    schema: 1, repository: "https://github.com/example/probe", routes: {}, clients: {},
    cache: [{ id: "probe/R1", route: "provider-00", client: "direct", model: "model-1", date: "2026-11-12", source: "results/r1.json", latest: true, control: { warm: 1, total: 1 }, checks: ages.map((age_s, index) => ({ age_s, warm: index === 0 ? 1 : 0, total: 1 })) }],
  });
const REPEATED_AGE = /Run "probe\/R1" has two checks at age 150 s\. A run has one check result per age\./;

/** A measurements file with one good cache run and these `limits` rows. */
const observedWithLimits = (limits: object[]): string => JSON.stringify({ ...JSON.parse(observedWith([150, 300])), limits });
const LIMIT_ROW = { route: "devin", client: "cliproxyapi", model: "gpt-6-1-sol", base_model: "openai/gpt-6.1-sol", models_dev: null, source: "results/limits-2026-11-08/limits.jsonl" };
const ROW_NAME = 'The limits row of route "devin", client "cliproxyapi", model "gpt-6-1-sol"';
/** The rows the design refuses (section 6), and a token count that is not a whole number of 0 or more, each with the words of its refusal; a good row beside each. */
const REFUSED_LIMITS: [string, object[], RegExp][] = [
  ["two rows with the same route, client and model", [{ ...LIMIT_ROW, input_accepted: 915390, input_refused: 925000 }, { ...LIMIT_ROW, input_accepted: 900000, input_refused: 925000, date: "2026-11-12" }], /is in the file twice\. There is one limits row per route, client and model\./],
  ["an input accepted that is not below the input refused", [{ ...LIMIT_ROW, input_accepted: 925000, input_refused: 925000 }], /has input_accepted 925000, not below its input_refused 925000\./],
  ["an input accepted above the window the route names", [{ ...LIMIT_ROW, context: 1000000, input_accepted: 1000001 }], /has input_accepted 1000001, above its context 1000000\./],
  ["an input read above the input accepted", [{ ...LIMIT_ROW, input_accepted: 250000, input_read: 250001 }], /has input_read 250001, above its input_accepted 250000\./],
  ["an input read with no input accepted", [{ ...LIMIT_ROW, input_read: 250000 }], /has input_read 250000 and no input_accepted\./],
  ["a token count that is not a whole number", [{ ...LIMIT_ROW, input_accepted: 1000, input_read: 999.5 }], /has input_read 999\.5\. A token count is a whole number, 0 or more\./],
  ["a negative token count", [{ ...LIMIT_ROW, input_accepted: 1000, input_refused: 2000, output: -1 }], /has output -1\. A token count is a whole number, 0 or more\./],
];
const GOOD_LIMITS = [
  { ...LIMIT_ROW, input_accepted: 915390, input_refused: 925000 },
  { ...LIMIT_ROW, client: "direct", context: 1000000, input_accepted: 1000000, input_read: 1000000, date: "2026-11-12" },
  { ...LIMIT_ROW, client: "codex-cli", input_accepted: 250000, input_read: null, date: null },
];

/** models.dev as in the fixture, and the measurements file with `body`. */
const fetchWithObserved = (body: string): typeof fetch => {
  const rest = fetchReturning(good);
  return (async (input: RequestInfo | URL, init?: RequestInit) => (String(input).includes("observed.json") ? new Response(body, { status: 200, headers: { etag: `"${body.length}"` } }) : rest(input, init))) as typeof fetch;
};

async function firstImport(): Promise<string> {
  const dataDir = tempDataDir();
  const report = await sync({ dataDir, fetch: fetchReturning(good), now: () => new Date("2026-11-13T00:00:00Z") });
  expect(report.upstream.status).toBe("updated");
  return dataDir;
}

describe("sync", () => {
  it("imports a good snapshot and records where it came from", async () => {
    const dataDir = await firstImport();
    const loaded = loadUpstream(dataDir);
    expect(Object.keys(loaded!.catalog)).toHaveLength(30);
    expect(loaded!.meta).toMatchObject({ etag: '"v1"', commit: "abc123", providers: 30, models: 600, fetched_at: "2026-11-13T00:00:00.000Z" });
    // The measurements file failed (404), which fails the run but must not stop the upstream import.
    const status = JSON.parse(readFileSync(join(dataDir, "sync-status.json"), "utf8"));
    expect(status).toMatchObject({ last_attempt_ok: false, upstream: "updated", measurements: "failed" });
  });

  it.each([
    ["an outage", fetchReturning("upstream is down", { status: 502 })],
    ["a body that is not JSON", fetchReturning("<html>")],
    ["an empty catalog", fetchReturning("{}")],
    ["a catalog that lost most of its entries", fetchReturning(JSON.stringify(fixtureUpstream(30, 5)))],
    ["a provider whose key and id disagree", fetchReturning(JSON.stringify({ ...fixtureUpstream(), wrong: { id: "other", name: "X", models: {} } }))],
    ["a model without a name", fetchReturning(JSON.stringify({ ...fixtureUpstream(), bad: { id: "bad", name: "Bad", models: { m: { id: "m" } } } }))],
  ])("keeps the last good snapshot after %s", async (_name, failing) => {
    const dataDir = await firstImport();
    const before = readFileSync(join(dataDir, "upstream", "meta.json"), "utf8");
    const report = await sync({ dataDir, fetch: failing, force: true });
    expect(report.ok).toBe(false);
    expect(report.upstream.status).toBe("failed");
    expect(report.upstream.error).toBeTruthy();
    expect(readFileSync(join(dataDir, "upstream", "meta.json"), "utf8")).toBe(before);
    expect(Object.keys(loadUpstream(dataDir)!.catalog)).toHaveLength(30);
    expect(existsSync(join(dataDir, ".sync.lock"))).toBe(false);
  });

  it("sends the stored ETag and treats 304 as unchanged", async () => {
    const dataDir = await firstImport();
    let sent: string | undefined;
    const conditional = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("observed.json") || String(input).startsWith("https://pi.dev/")) return new Response("x", { status: 404 });
      sent = (init?.headers as Record<string, string>)["If-None-Match"];
      return new Response(null, { status: 304 });
    }) as typeof fetch;
    const report = await sync({ dataDir, fetch: conditional, now: () => new Date("2026-11-14T00:00:00Z") });
    expect(sent).toBe('"v1"');
    expect(report.upstream.status).toBe("unchanged");
    expect(loadUpstream(dataDir)!.meta).toMatchObject({ fetched_at: "2026-11-13T00:00:00.000Z", checked_at: "2026-11-14T00:00:00.000Z" });
  });

  it("asks models.dev for openai-codex, which its default catalog leaves out since f648ddb", async () => {
    expect(UPSTREAM_URL).toBe("https://models.dev/experimental/v2.0/api.json?include=openai-codex");
    let asked: string | undefined;
    const rest = fetchReturning(good);
    const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://models.dev/")) asked = String(input);
      return rest(input, init);
    }) as typeof fetch;
    const dataDir = tempDataDir();
    await sync({ dataDir, fetch: recording });
    expect(asked).toBe(UPSTREAM_URL);
    expect(loadUpstream(dataDir)!.meta.source).toBe(UPSTREAM_URL);
  });

  it("does not send or compare the ETag and digest of another address: the first import from a new address is a full one", async () => {
    const dataDir = await firstImport();
    const metaPath = join(dataDir, "upstream", "meta.json");
    const old = JSON.parse(readFileSync(metaPath, "utf8"));
    writeFileSync(metaPath, JSON.stringify({ ...old, source: "https://models.dev/experimental/v2.0/api.json" }));
    let sent: string | undefined = "not asked";
    const rest = fetchReturning(good, { status: 200, headers: { etag: '"v2"' } });
    const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://models.dev/")) sent = (init?.headers as Record<string, string>)["If-None-Match"];
      return rest(input, init);
    }) as typeof fetch;
    // The same body as the stored snapshot: from the same address it would be "unchanged".
    const report = await sync({ dataDir, fetch: recording, now: () => new Date("2026-11-18T00:00:00Z") });
    expect(sent).toBeUndefined();
    expect(report.upstream.status).toBe("updated");
    expect(loadUpstream(dataDir)!.meta).toMatchObject({ source: UPSTREAM_URL, etag: '"v2"', fetched_at: "2026-11-18T00:00:00.000Z" });
  });

  it("summarizes what changed", async () => {
    const dataDir = await firstImport();
    const changed = fixtureUpstream();
    delete changed["provider-00"]!.models["model-1"];
    changed["provider-01"]!.models["model-1"]!.limit = { context: 1 };
    changed["provider-02"]!.models.fresh = { id: "fresh", name: "Fresh" };
    const report = await sync({ dataDir, fetch: fetchReturning(JSON.stringify(changed), { status: 200, headers: { etag: '"v2"' } }) });
    expect(report.upstream.summary).toEqual(["models: +1 added, -1 removed, 1 changed"]);
  });

  it("writes the same files for the same catalog sent in another order, and keeps the order inside a model", async () => {
    const sent = fixtureUpstream();
    // Key order inside a model and the order of an array are left as models.dev sends them.
    sent["provider-03"]!.models["model-5"]!.cost = { output: 2, input: 1, cache_read: 0.1 };
    sent["provider-03"]!.models["model-5"]!.modalities = { input: ["text", "image"], output: ["text"] };
    // The same content: providers and the models of each provider in reverse order.
    const reordered = Object.fromEntries(
      Object.entries(sent).reverse().map(([id, provider]) => [id, { ...provider, models: Object.fromEntries(Object.entries(provider.models).reverse()) }]),
    );
    const files = (dataDir: string): Record<string, string> => {
      const dir = join(dataDir, "upstream", "providers");
      return Object.fromEntries(readdirSync(dir).sort().map((file) => [file, readFileSync(join(dir, file), "utf8")]));
    };
    const first = tempDataDir();
    const second = tempDataDir();
    expect((await sync({ dataDir: first, fetch: fetchReturning(JSON.stringify(sent)) })).upstream.status).toBe("updated");
    expect((await sync({ dataDir: second, fetch: fetchReturning(JSON.stringify(reordered)) })).upstream.status).toBe("updated");
    expect(JSON.stringify(sent)).not.toBe(JSON.stringify(reordered));
    expect(files(second)).toEqual(files(first));

    const stored = loadUpstream(first)!.catalog["provider-03"]!;
    expect(Object.keys(stored.models)).toEqual(Object.keys(sent["provider-03"]!.models).sort());
    expect(Object.keys(stored)).toEqual(["id", "name", "doc", "models"]);
    expect(Object.keys(stored.models["model-5"]!.cost as object)).toEqual(["output", "input", "cache_read"]);
    expect(stored.models["model-5"]!.modalities).toEqual({ input: ["text", "image"], output: ["text"] });
  });

  it("imports capabilities.tools.updates as models.dev lists it since e337b7d, a value it adds later included, and keeps it as sent", async () => {
    const sent = fixtureUpstream();
    const model = sent["provider-04"]!.models["model-1"]!;
    model.capabilities = { tools: { supported: true, updates: ["add", "remove", "replace"] } };
    model.api = { chat: { capabilities: { tools: { supported: true, updates: [] } } } };
    sent["provider-04"]!.models["model-3"]!.capabilities = { tools: { supported: true, updates: ["add", "reorder"] } };
    const dataDir = tempDataDir();
    expect((await sync({ dataDir, fetch: fetchReturning(JSON.stringify(sent)) })).upstream.status).toBe("updated");
    const stored = loadUpstream(dataDir)!.catalog["provider-04"]!.models;
    expect(stored["model-1"]!.capabilities).toEqual({ tools: { supported: true, updates: ["add", "remove", "replace"] } });
    expect(stored["model-1"]!.api).toEqual({ chat: { capabilities: { tools: { supported: true, updates: [] } } } });
    expect(stored["model-3"]!.capabilities).toEqual({ tools: { supported: true, updates: ["add", "reorder"] } });
  });

  it("refuses a measurements file with two checks at one age in a run, and keeps the last good copy", async () => {
    const dataDir = tempDataDir();
    const first = await sync({ dataDir, fetch: fetchWithObserved(observedWith([150, 300])), now: () => new Date("2026-11-13T00:00:00Z") });
    expect([first.ok, first.measurements.status]).toEqual([true, "updated"]);
    const kept = readFileSync(join(dataDir, "sources", "observed.json"), "utf8");
    const keptMeta = readFileSync(join(dataDir, "sources", "observed.meta.json"), "utf8");

    const second = await sync({ dataDir, fetch: fetchWithObserved(observedWith([150, 150])), force: true, now: () => new Date("2026-11-14T00:00:00Z") });
    expect([second.ok, second.measurements.status]).toEqual([false, "failed"]);
    expect(second.measurements.error).toMatch(/^the measurements file does not match the expected structure: /);
    expect(second.measurements.error).toMatch(REPEATED_AGE);
    expect(readFileSync(join(dataDir, "sources", "observed.json"), "utf8")).toBe(kept);
    expect(readFileSync(join(dataDir, "sources", "observed.meta.json"), "utf8")).toBe(keptMeta);
    expect(JSON.parse(readFileSync(join(dataDir, "sync-status.json"), "utf8"))).toMatchObject({ last_attempt_ok: false, measurements: "failed", last_error: expect.stringMatching(REPEATED_AGE) });
  });

  it.each(REFUSED_LIMITS)("refuses a measurements file with %s, names the row, and keeps the last good copy", async (_name, limits, words) => {
    const dataDir = tempDataDir();
    const first = await sync({ dataDir, fetch: fetchWithObserved(observedWithLimits(GOOD_LIMITS)), now: () => new Date("2026-11-13T00:00:00Z") });
    expect([first.ok, first.measurements.status]).toEqual([true, "updated"]);
    const kept = readFileSync(join(dataDir, "sources", "observed.json"), "utf8");
    const keptMeta = readFileSync(join(dataDir, "sources", "observed.meta.json"), "utf8");

    const second = await sync({ dataDir, fetch: fetchWithObserved(observedWithLimits([...GOOD_LIMITS.slice(1), ...limits])), force: true, now: () => new Date("2026-11-14T00:00:00Z") });
    expect([second.ok, second.measurements.status]).toEqual([false, "failed"]);
    expect(second.measurements.error).toMatch(/^the measurements file does not match the expected structure: /);
    expect(second.measurements.error).toContain(ROW_NAME);
    expect(second.measurements.error).toMatch(words);
    expect(readFileSync(join(dataDir, "sources", "observed.json"), "utf8")).toBe(kept);
    expect(readFileSync(join(dataDir, "sources", "observed.meta.json"), "utf8")).toBe(keptMeta);
  });

  it("reads today's measurements file, whose limits rows have no date and no input_read, without error", () => {
    const path = join(ROOT, "data", "sources", "observed.json");
    if (!existsSync(path)) return;
    const checked = ObservedFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
    expect(checked.success ? [] : checked.error.issues.slice(0, 3).map((issue) => issue.message)).toEqual([]);
    // The new keys are optional, and a row of either shape is read.
    expect(ObservedFile.safeParse(JSON.parse(observedWithLimits(GOOD_LIMITS))).success).toBe(true);
  });

  it("refuses to run while another sync holds the lock", async () => {
    const dataDir = await firstImport();
    writeFileSync(join(dataDir, ".sync.lock"), "1");
    await expect(sync({ dataDir, fetch: fetchReturning(good) })).rejects.toBeInstanceOf(SyncBusyError);
  });
});

describe("publish", () => {
  it("keeps the last published snapshot when the authored data is broken", async () => {
    const dataDir = await firstImport();
    writeAuthored(dataDir);
    const first = publish({ dataDir, rootDir: ROOT, now: () => new Date("2026-11-13T01:00:00Z") });
    expect(first.ok).toBe(true);
    const before = readFileSync(join(dataDir, "published", "site", "data", "meta.json"), "utf8");

    writeFileSync(join(dataDir, "authored", "overrides", "provider-01.yaml"), "provider: provider-01\nrules:\n  - models: [model-1]\n    set: { limit: { context: 1 } }\n");
    const second = publish({ dataDir, rootDir: ROOT });
    expect(second.ok).toBe(false);
    expect(second.errors.join(" ")).toMatch(/reason|evidence/);
    expect(readFileSync(join(dataDir, "published", "site", "data", "meta.json"), "utf8")).toBe(before);
  });

  it("publishes one exclusions item per catalog rule, with the count of the entries it removed", async () => {
    const dataDir = await firstImport();
    writeAuthored(dataDir);
    const before = publish({ dataDir, rootDir: ROOT });
    // family-0 is models 0, 3, 6, 9, 12, 15, 18 at each of the 30 providers; the rule leaves out 0, 3 and 6.
    const rule = { id: "family-0-before-9", family: "family-0", word: "model", before: "9", leaves_out: "Family 0 before 9", reason: "Editorial choice.", date: "2026-11-16" };
    writeFileSync(join(dataDir, "authored", "catalog-rules.yaml"), stringify({ exclude: [rule] }));
    const after = publish({ dataDir, rootDir: ROOT });
    expect(after.errors).toEqual([]);
    expect(after.meta?.exclusions).toEqual([{ kind: "rule", target: "family-0-before-9", leaves_out: "Family 0 before 9", reason: "Editorial choice.", date: "2026-11-16", evidence: [], entries: 90 }]);
    expect(after.meta!.counts.entries).toBe(before.meta!.counts.entries - 90);
    expect(after.meta?.issues).toEqual([]);
    const meta = JSON.parse(readFileSync(join(dataDir, "published", "site", "data", "meta.json"), "utf8"));
    expect(MetaSchema.parse(meta).exclusions).toHaveLength(1);
    expect(existsSync(join(dataDir, "published", "site", "data", "entries", "provider-00"))).toBe(true);
    const index = JSON.parse(readFileSync(join(dataDir, "published", "site", "data", "index.json"), "utf8"));
    expect(index.entries.some((entry: { ref: string }) => entry.ref === "provider-00/lab/model-6")).toBe(false);
    expect(index.entries.some((entry: { ref: string }) => entry.ref === "provider-00/model-9")).toBe(true);
  });

  it("gives the same dataset version for the same data and a new one when the data changes", async () => {
    const dataDir = await firstImport();
    writeAuthored(dataDir);
    const first = publish({ dataDir, rootDir: ROOT, now: () => new Date("2026-11-13T01:00:00Z") });
    const second = publish({ dataDir, rootDir: ROOT, now: () => new Date("2026-11-14T01:00:00Z") });
    expect(second.meta?.dataset_version).toBe(first.meta?.dataset_version);
    expect(second.meta?.generated_at).not.toBe(first.meta?.generated_at);

    writeFileSync(join(dataDir, "authored", "overrides", "provider-01.yaml"), "provider: provider-01\n");
    const third = publish({ dataDir, rootDir: ROOT });
    expect(third.meta?.dataset_version).not.toBe(first.meta?.dataset_version);
  });

  it("fails the build where the measurement labels give one public client id two labels, and names both", async () => {
    const dataDir = await firstImport();
    writeAuthored(dataDir);
    const labels = (clients: Record<string, { id: string; label: string; kind: string }>) => writeFileSync(join(dataDir, "authored", "measurement-labels.yaml"), stringify({ clients }));
    labels({ direct: { id: "direct", label: "Straight to the provider", kind: "direct" }, "direct-2": { id: "direct", label: "Straight to the provider", kind: "direct" }, "tool-x": { id: "gateway", label: "Through a gateway", kind: "direct" } });
    expect(publish({ dataDir, rootDir: ROOT }).errors).toEqual([]);
    const before = readFileSync(join(dataDir, "published", "site", "data", "meta.json"), "utf8");

    labels({ "cli-a": { id: "direct", label: "Label A", kind: "direct" }, "cli-z": { id: "direct", label: "Label Z", kind: "direct" } });
    const report = publish({ dataDir, rootDir: ROOT });
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([expect.stringMatching(/measurement-labels\.yaml: clients\.cli-z\.label: Public client id "direct" has two labels: "cli-a" \("Label A"\) and "cli-z" \("Label Z"\)/)]);
    expect(readFileSync(join(dataDir, "published", "site", "data", "meta.json"), "utf8")).toBe(before);

    // `other` is what an undescribed client is published as, with its own label.
    labels({ "cli-a": { id: "other", label: "Label A", kind: "direct" } });
    expect(publish({ dataDir, rootDir: ROOT }).errors).toEqual([expect.stringMatching(/Public client id "other" has two labels: a client the file does not describe \("Another client"\) and "cli-a" \("Label A"\)/)]);
    labels({ "cli-a": { id: "other", label: "Another client", kind: "direct" } });
    expect(publish({ dataDir, rootDir: ROOT }).ok).toBe(true);
  });

  it("fails the build on a measurements file with two checks at one age in a run, and keeps the last published dataset", async () => {
    const dataDir = await firstImport();
    writeAuthored(dataDir);
    mkdirSync(join(dataDir, "sources"), { recursive: true });
    const observed = (ages: number[]) => writeFileSync(join(dataDir, "sources", "observed.json"), observedWith(ages));
    observed([150, 300]);
    expect(publish({ dataDir, rootDir: ROOT }).errors).toEqual([]);
    const before = readFileSync(join(dataDir, "published", "site", "data", "meta.json"), "utf8");

    observed([150, 150]);
    const report = publish({ dataDir, rootDir: ROOT });
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([expect.stringMatching(new RegExp(`observed\\.json: ${REPEATED_AGE.source}$`))]);
    expect(readFileSync(join(dataDir, "published", "site", "data", "meta.json"), "utf8")).toBe(before);
  });

  it.each(REFUSED_LIMITS)("fails the build on a measurements file with %s, names the row, and keeps the last published dataset", async (_name, limits, words) => {
    const dataDir = await firstImport();
    writeAuthored(dataDir);
    mkdirSync(join(dataDir, "sources"), { recursive: true });
    writeFileSync(join(dataDir, "sources", "observed.json"), observedWithLimits(GOOD_LIMITS));
    expect(publish({ dataDir, rootDir: ROOT }).errors).toEqual([]);
    const before = readFileSync(join(dataDir, "published", "site", "data", "meta.json"), "utf8");

    writeFileSync(join(dataDir, "sources", "observed.json"), observedWithLimits([...GOOD_LIMITS.slice(1), ...limits]));
    const report = publish({ dataDir, rootDir: ROOT });
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([expect.stringMatching(new RegExp(`observed\\.json: ${ROW_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ${words.source}`))]);
    expect(readFileSync(join(dataDir, "published", "site", "data", "meta.json"), "utf8")).toBe(before);
  });

  it("says so when there is no upstream snapshot yet", () => {
    const report = publish({ dataDir: tempDataDir(), rootDir: ROOT });
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatch(/npm run sync/);
  });
});
