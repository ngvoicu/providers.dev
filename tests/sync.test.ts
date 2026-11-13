import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publish } from "../scripts/lib/publish.ts";
import { loadUpstream, sync, SyncBusyError } from "../scripts/lib/sync.ts";
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

  it("says so when there is no upstream snapshot yet", () => {
    const report = publish({ dataDir: tempDataDir(), rootDir: ROOT });
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toMatch(/npm run sync/);
  });
});
