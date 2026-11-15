import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publish } from "../scripts/lib/publish.ts";
import { loadUpstream, sync, SyncBusyError } from "../scripts/lib/sync.ts";
import { stringify } from "yaml";
import { fetchReturning, fixtureUpstream, ROOT, tempDataDir, writeAuthored } from "./helpers.ts";

const good = JSON.stringify(fixtureUpstream());

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
      if (String(input).includes("observed.json")) return new Response("x", { status: 404 });
      sent = (init?.headers as Record<string, string>)["If-None-Match"];
      return new Response(null, { status: 304 });
    }) as typeof fetch;
    const report = await sync({ dataDir, fetch: conditional, now: () => new Date("2026-11-14T00:00:00Z") });
    expect(sent).toBe('"v1"');
    expect(report.upstream.status).toBe("unchanged");
    expect(loadUpstream(dataDir)!.meta).toMatchObject({ fetched_at: "2026-11-13T00:00:00.000Z", checked_at: "2026-11-14T00:00:00.000Z" });
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
    const labels = (clients: Record<string, { id: string; label: string }>) => writeFileSync(join(dataDir, "authored", "measurement-labels.yaml"), stringify({ clients }));
    labels({ direct: { id: "direct", label: "Straight to the provider" }, "direct-2": { id: "direct", label: "Straight to the provider" }, "tool-x": { id: "gateway", label: "Through a gateway" } });
    expect(publish({ dataDir, rootDir: ROOT }).errors).toEqual([]);
    const before = readFileSync(join(dataDir, "published", "site", "data", "meta.json"), "utf8");

    labels({ "cli-a": { id: "direct", label: "Label A" }, "cli-z": { id: "direct", label: "Label Z" } });
    const report = publish({ dataDir, rootDir: ROOT });
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([expect.stringMatching(/measurement-labels\.yaml: clients\.cli-z\.label: Public client id "direct" has two labels: "cli-a" \("Label A"\) and "cli-z" \("Label Z"\)/)]);
    expect(readFileSync(join(dataDir, "published", "site", "data", "meta.json"), "utf8")).toBe(before);

    // `other` is what an undescribed client is published as, with its own label.
    labels({ "cli-a": { id: "other", label: "Label A" } });
    expect(publish({ dataDir, rootDir: ROOT }).errors).toEqual([expect.stringMatching(/Public client id "other" has two labels: a client the file does not describe \("Another client"\) and "cli-a" \("Label A"\)/)]);
    labels({ "cli-a": { id: "other", label: "Another client" } });
    expect(publish({ dataDir, rootDir: ROOT }).ok).toBe(true);
  });

  it("says so when there is no upstream snapshot yet", () => {
    const report = publish({ dataDir: tempDataDir(), rootDir: ROOT });
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatch(/npm run sync/);
  });
});
