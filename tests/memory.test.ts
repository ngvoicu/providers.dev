// The Worker's memory (release review R1, finding 3): the large answers are streamed and never assembled, the index is
// loaded in parts, and nothing a request makes is kept. The peaks themselves are measured on workerd with the review's
// method (README, "Worker memory"); these tests hold the code to what keeps them low.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { stageSnapshot } from "../scripts/lib/stage.ts";
import { INDEX_PART_SIZE, indexPartSize, MAX_INDEX_PARTS, publish } from "../scripts/lib/publish.ts";
import { sync } from "../scripts/lib/sync.ts";
import { brief, handleApi, type ApiDeps, type LoadedDeps } from "../src/core/api.ts";
import type { Index } from "../src/core/entries.ts";
import { readSnapshot, type AssetBinding } from "../src/core/snapshot.ts";
import type { Catalog } from "../src/core/schema.ts";
import { depsFrom, fetchReturning, fixtureUpstream, ROOT, tempDataDir, writeAuthored } from "./helpers.ts";

let published: string;
let deps: LoadedDeps;
beforeAll(async () => {
  const dataDir = tempDataDir();
  await sync({ dataDir, fetch: fetchReturning(JSON.stringify(fixtureUpstream())) });
  writeAuthored(dataDir);
  expect(publish({ dataDir, rootDir: ROOT, now: () => new Date("2026-11-22T12:00:00Z") }).errors).toEqual([]);
  published = join(dataDir, "published");
  deps = depsFrom(published);
});

/** The same files, with every read recorded, and a file whose `json()` is never to be called. */
function watched(base: ApiDeps): { deps: ApiDeps; reads: string[]; parsed: string[] } {
  const reads: string[] = [];
  const parsed: string[] = [];
  return {
    reads,
    parsed,
    deps: {
      ...base,
      async asset(path) {
        reads.push(path);
        const response = await base.asset(path);
        if (!response) return null;
        const json = response.json.bind(response);
        return Object.assign(response, { json: () => (parsed.push(path), json()) });
      },
    },
  };
}

describe("a provider's full view is streamed, never assembled", () => {
  const catalog = (): Catalog => JSON.parse(readFileSync(join(published, "site", "api.json"), "utf8")) as Catalog;

  it("is byte for byte the answer it was when assembled, for every provider and both views, and reads no whole provider file", async () => {
    const all = catalog();
    for (const provider of deps.index.providers) {
      const entries = deps.index.entries.filter((entry) => entry.provider === provider.id).sort((a, b) => a.name.localeCompare(b.name) || a.model.localeCompare(b.model));
      for (const view of ["full", "summary"] as const) {
        const { deps: seen, reads, parsed } = watched(deps);
        const response = await handleApi(new Request(`https://providers.dev/api/v1/providers/${provider.id}?view=${view}`), seen);
        expect(response.status).toBe(200);
        expect(response.body).toBeInstanceOf(ReadableStream);
        const models = view === "full" ? all[provider.id]!.models : null;
        expect(await response.text(), `${provider.id} ${view}`).toBe(JSON.stringify({ meta: brief(deps.meta), data: { provider, entries, models } }));
        expect(reads).toEqual(view === "full" ? [`/data/provider-models/${provider.id}.json`] : []);
        expect(parsed).toEqual([]);
      }
    }
  });

  it("has a validator known before its body: 304 on a match, no body on HEAD, another for the other view", async () => {
    const ask = (init?: RequestInit, view = "full") => handleApi(new Request(`https://providers.dev/api/v1/providers/provider-02?view=${view}`, init), deps);
    const first = await ask();
    const tag = first.headers.get("etag")!;
    expect(tag).toMatch(/^"[0-9a-f]{64}"$/);
    expect((await ask()).headers.get("etag")).toBe(tag);
    const again = await ask({ headers: { "If-None-Match": tag } });
    expect([again.status, await again.text()]).toEqual([304, ""]);
    const head = await ask({ method: "HEAD" });
    expect([head.status, head.headers.get("etag"), await head.text()]).toEqual([200, tag, ""]);
    expect((await ask(undefined, "summary")).headers.get("etag")).not.toBe(tag);
  });

  it("answers 503 where the published file of the provider's entries is missing", async () => {
    const without: ApiDeps = { ...deps, asset: async (path) => (path.startsWith("/data/provider-models/") ? null : deps.asset(path)) };
    const response = await handleApi(new Request("https://providers.dev/api/v1/providers/provider-02?view=full"), without);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("snapshot_incomplete");
  });
});

describe("the Worker loads the index in parts", () => {
  it("publishes the index in parts of INDEX_PART_SIZE summaries, which together are the index", () => {
    const dir = join(published, "site", "data", "index-parts");
    const index = JSON.parse(readFileSync(join(published, "site", "data", "index.json"), "utf8")) as Index;
    const files = readdirSync(dir).sort();
    const parts = Math.ceil(index.entries.length / indexPartSize(index.entries.length));
    expect(parts).toBeGreaterThan(1);
    expect(files).toEqual(["head.json.gz", ...Array.from({ length: parts }, (_, part) => `${part}.json.gz`)].sort());
  });

  it("holds at most MAX_INDEX_PARTS parts, each a subrequest of a fresh isolate: past that the parts grow", () => {
    for (const count of [1, 250, 251, 6_500, 7_500, 7_501, 9_000, 50_000]) {
      const size = indexPartSize(count);
      expect(size).toBeGreaterThanOrEqual(INDEX_PART_SIZE);
      expect(Math.ceil(count / size), `${count} summaries`).toBeLessThanOrEqual(MAX_INDEX_PARTS);
    }
    expect(indexPartSize(6_500)).toBe(INDEX_PART_SIZE);
    expect(indexPartSize(9_000)).toBe(300);
  });

  it("reads the head and the parts one after another, never the whole index, and gets the index", async () => {
    const destination = tempDataDir();
    stageSnapshot(published, destination);
    const reads: string[] = [];
    let open = 0;
    let most = 0;
    const assets: AssetBinding = {
      async fetch(request) {
        const path = new URL(typeof request === "string" ? request : request.url).pathname;
        reads.push(path);
        const file = join(destination, path);
        if (!existsSync(file)) return new Response(null, { status: 404 });
        // How many parts of the index are being read at once.
        if (/\/index-parts\/\d+\.json\.gz$/.test(path)) {
          open += 1;
          most = Math.max(most, open);
          await new Promise((done) => setTimeout(done, 1));
          open -= 1;
        }
        return new Response(readFileSync(file));
      },
    };
    const snapshot = await readSnapshot(assets, "https://providers.dev");
    // The index is read only when a request reads it: until then the pointer and the meta.
    expect(reads.map((path) => path.replace(/^\/snapshots\/[a-f0-9]+/, ""))).toEqual(["/current.json", "/data/meta.json"]);
    const index = await snapshot.index();
    expect(index).toEqual(JSON.parse(readFileSync(join(published, "site", "data", "index.json"), "utf8")));
    expect(reads.some((path) => path.endsWith("/data/index.json.gz") || path.endsWith("/data/index.json"))).toBe(false);
    expect(most).toBe(1);
    // The same publication is read once: a second request reads the pointer alone.
    reads.length = 0;
    expect(await (await readSnapshot(assets, "https://providers.dev")).index()).toBe(index);
    expect(reads).toEqual(["/current.json"]);
  });
});
