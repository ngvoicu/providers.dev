import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { publish } from "../scripts/lib/publish.ts";
import { stageSnapshot } from "../scripts/lib/stage.ts";
import { sync } from "../scripts/lib/sync.ts";
import { handleApi, type ApiDeps } from "../src/core/api.ts";
import { CorrectionSchema, DocumentationSchema, FacetsSchema, one, pageOf } from "../src/core/contract.ts";
import { fillShell, MARK } from "../src/core/page-shell.ts";
import { handlePage, type PageDeps } from "../src/core/pages.ts";
import { readSnapshot, type AssetBinding } from "../src/core/snapshot.ts";
import worker from "../worker/index.ts";
import { depsFrom, fetchReturning, fixtureUpstream, ROOT, tempDataDir, writeAuthored } from "./helpers.ts";

const shell = `<html><head><title>${MARK.title} · providers.dev</title><meta name="description" content="${MARK.description}"><link rel="canonical" href="${MARK.canonical}"></head><body><nav>${MARK.nav}</nav><main>${MARK.html}</main><footer>${MARK.dataset}</footer></body></html>`;
const now = () => new Date("2026-11-14T12:00:00Z");
let deps: ApiDeps;
let dataDir: string;

beforeAll(async () => {
  dataDir = tempDataDir();
  await sync({ dataDir, fetch: fetchReturning(JSON.stringify(fixtureUpstream())) });
  writeAuthored(dataDir);
  expect(publish({ dataDir, rootDir: ROOT, now }).errors).toEqual([]);
  deps = depsFrom(join(dataDir, "published"));
});

const api = (path: string) => handleApi(new Request(`https://providers.dev${path}`), deps);
const pageDeps = (read = api): PageDeps => ({ api: read, shell: async () => new Response(shell), site: "https://providers.dev", now });
const page = (path: string, read = api) => handlePage(new Request(`https://providers.dev${path}`), pageDeps(read));

describe("API response boundary", () => {
  it("serves filter options, grouped corrections, provider search and reference content through documented contracts", async () => {
    const facets = one(FacetsSchema).parse(await (await api("/api/v1/facets")).json()).data;
    expect(facets.providers).toHaveLength(31);
    expect(facets.types).toEqual(["chat", "embedding"]);
    const corrections = pageOf(CorrectionSchema).parse(await (await api("/api/v1/corrections?provider=provider-01")).json());
    expect(corrections.data[0]?.entry_refs).toEqual(["provider-01/model-1"]);
    expect(corrections.data[0]?.change.value).toBe(5000000);
    expect((await (await api("/api/v1/providers?q=Provider%202&limit=200")).json() as { data: { id: string }[] }).data.every((item) => item.id.includes("2"))).toBe(true);
    one(DocumentationSchema).parse(await (await api("/api/v1/docs/methodology")).json());
    expect((await api("/api/v1/docs/missing")).status).toBe(404);
    expect((await api("/api/v1/corrections?limit=0")).status).toBe(400);
  });

  it("renders every public page family from API responses, without access to an index or catalog", async () => {
    const routes = [
      ["/?provider=provider-02&limit=2&offset=2", "/api/v1/entries?"],
      ["/providers/?q=Provider", "/api/v1/providers?q="],
      ["/providers/provider-02/", "/api/v1/providers/provider-02"],
      ["/models/?q=model", "/api/v1/models?q="],
      ["/models/lab/model-4/", "/api/v1/models/lab/model-4"],
      ["/entries/provider-02/lab/model-4", "/api/v1/entries/provider-02/lab/model-4"],
      ["/evidence/", "/api/v1/corrections?"],
      ["/docs/api/", "/api/v1/openapi.json"],
      ["/docs/methodology/", "/api/v1/docs/methodology"],
      ["/docs/licensing/", "/api/v1/docs/licensing"],
    ];
    for (const [path, endpoint] of routes) {
      const calls: string[] = [];
      const response = await page(path!, async (path) => { calls.push(path); return api(path); });
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("%%PAGE_");
      expect(html).toContain(deps.meta.dataset_version);
      expect(calls.some((call) => call.startsWith(endpoint!)), path).toBe(true);
      expect(calls.every((call) => call.startsWith("/api/v1/"))).toBe(true);
    }
  });

  it("uses response values even when they differ from internal dataset objects", async () => {
    const response = await page("/models/lab/model-4/", async (path) => {
      const response = await api(path);
      const body = await response.json() as { data: { name: string; entry_count: number; generated_at: string } };
      if (path === "/api/v1/models/lab/model-4") { body.data.name = "API response only"; body.data.entry_count = 12345; }
      if (path === "/api/v1/meta") body.data.generated_at = "2030-01-02T03:04:00Z";
      return Response.json(body);
    });
    const html = await response.text();
    expect(html).toContain("<h1>API response only</h1>");
    expect(html).toContain("12,345");
    expect(html).toContain("Published 2030-01-02 03:04 UTC");
  });

  it("prints cache lifetimes from cache_lifetime", async () => {
    // Documented lifetimes, caching with no lifetime, does not cache, nothing known; and the lists.
    const paths = ["/?provider=provider-02&limit=8", "/providers/provider-02/", "/models/lab/model-4/", "/entries/provider-02/lab/model-4", "/entries/provider-02/model-1", "/entries/provider-02/lab/model-2", "/entries/provider-02/model-3"];
    for (const path of paths) {
      const response = await page(path);
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(html, path).not.toContain("Cache, measured");
    }
    // model-4 documents 5m and 1h: two documented lifetimes, models.dev, on the date of the import.
    const entry = await (await page("/entries/provider-02/lab/model-4")).text();
    expect(entry).toContain("<h3>Lifetimes</h3>");
    expect(entry.match(/<tbody class="item documented">/g)).toHaveLength(2);
    expect(entry).toContain('<th scope="row" title="Short retention: the cache a request gets without asking for a lifetime, or with the provider\'s shortest setting.">Short retention</th>');
    const catalog = await (await page("/?provider=provider-02&limit=8")).text();
    expect(catalog).toContain('<td class="life-col" data-label="Cache lifetime"><a class="plain lifes" href="/entries/provider-02/lab/model-4#cache"');
  });

  it("renders the requested homepage filters and page before JavaScript runs", async () => {
    const path = "/?provider=provider-02&limit=2&offset=2&sort=model";
    const html = await (await page(path)).text();
    const result = await (await api("/api/v1/entries?provider=provider-02&limit=2&offset=2&sort=model")).json() as { data: { ref: string }[] };
    expect(html.match(/<tr>/g)?.length).toBe(3); // header + two requested rows
    for (const entry of result.data) expect(html).toContain(entry.ref);
    expect(html).toContain("Page 2 of 10");
    expect(html).toContain('href="/?provider=provider-02&amp;limit=2&amp;offset=4&amp;sort=model"');
    expect((await page("/?min_context=nope")).status).toBe(400);
  });

  it("renders OpenAPI changes and examples without a documentation build", async () => {
    const html = await (await page("/docs/api/", async (path) => {
      if (path !== "/api/v1/openapi.json") return api(path);
      return Response.json({ info: { title: "API", version: "fixture", description: "From the API" }, paths: {}, components: { schemas: { NewPolicy: { description: "New policy from response", type: "object", properties: { condition: { type: "string", description: "Scoped rate" } }, examples: [{ condition: "new-value" }] } } } });
    })).text();
    expect(html).toContain("NewPolicy");
    expect(html).toContain("Scoped rate");
    expect(html).toContain("new-value");
  });

  it("takes the cache lifetime sorts and the basis filter through the catalog's address, as the API does", async () => {
    const response = await page("/?sort=cache_long&order=desc&lifetime_basis=documented");
    expect(response.status).toBe(200);
    const html = await response.text();
    const answer = await (await api("/api/v1/entries?lifetime_basis=documented&sort=cache_long&order=desc")).json() as { total: number; data: { ref: string }[] };
    expect(html).toContain(`<code>/api/v1/entries?lifetime_basis=documented&amp;sort=cache_long&amp;order=desc</code>`);
    expect(html).toContain(`${answer.total.toLocaleString("en-US")} entries`);
    // The rows in the API's order (each row's copy button carries its entry id).
    expect([...html.matchAll(/aria-label="Copy entry id"/g)].length).toBe(Math.min(answer.total, 50));
    expect([...html.matchAll(/data-copy="([^"]+)" aria-label="Copy entry id"/g)].map((match) => match[1])).toEqual(answer.data.map((item) => item.ref));
    // No header is marked as sorted: the table has no cache lifetime sort control.
    expect(html).not.toContain("aria-sort");
    expect((await page("/?lifetime_basis=none")).status).toBe(400);
  });

  it("takes the stale threshold from the published meta, on the pages and in the methodology", async () => {
    // A publication whose threshold is 7 days: the pages say 7, and nowhere 90.
    const sevenDays = async (path: string): Promise<Response> => {
      if (path === "/api/v1/meta") {
        const answer = await (await api(path)).json() as { meta: unknown; data: { stale_after_days: number } };
        return Response.json({ ...answer, data: { ...answer.data, stale_after_days: 7 } });
      }
      if (path === "/api/v1/docs/methodology") {
        const answer = await (await api(path)).json() as { meta: unknown; data: { body_html: string } };
        return Response.json({ ...answer, data: { ...answer.data, body_html: '<p>Older than <span data-meta="stale_after_days"><code>stale_after_days</code></span> days is stale.</p>' } });
      }
      return api(path);
    };
    const evidence = await (await page("/evidence/", sevenDays)).text();
    expect(evidence).toContain("Evidence older than 7 days is marked stale.");
    const methodology = await (await page("/docs/methodology/", sevenDays)).text();
    expect(methodology).toContain('Older than <span data-meta="stale_after_days">7</span> days is stale.');
    // The catalog hands the threshold to the list rendered in the browser.
    const catalog = await (await page("/", sevenDays)).text();
    expect(catalog).toContain('data-stale-after-days="7"');
    expect(`${evidence}${methodology}${catalog}`).not.toMatch(/90 days/);
  });

  it("takes the age columns of results by age from the published meta, on the entry page and the evidence page", async () => {
    // A publication whose ages are 10 minutes and 1 h 5: every table of results by age has those columns, after the control.
    const twoAges = async (path: string): Promise<Response> => {
      if (path !== "/api/v1/meta") return api(path);
      const answer = await (await api(path)).json() as { meta: unknown; data: { cache_ages_s: number[] } };
      return Response.json({ ...answer, data: { ...answer.data, cache_ages_s: [600, 3900] } });
    };
    const entry = await (await page("/entries/provider-02/lab/model-4", twoAges)).text();
    expect([...entry.matchAll(/<th scope="col" class="age"[^>]*>([^<]+)<\/th>/g)].map((match) => match[1])).toEqual(["At once", "10 min", "1 h 5"]);
    expect(entry).toContain('<th scope="colgroup" colspan="3" class="span"><span class="sr-only">Time since the prompt was cached');
    const strip = '<span class="strip"><span class="control">once</span><span>10m</span><span>65m</span></span>';
    const evidence = await (await page("/evidence/", twoAges)).text();
    expect(evidence).toContain(`<span class="heat-strip strip-head" aria-hidden="true"><span></span>${strip}`);
    expect(evidence).not.toContain("<span>2.5m</span>");
    // As published, the ladder of the build.
    const published = await (await page("/evidence/")).text();
    expect(published).toContain("<span>2.5m</span>");
  });

  it("fails visibly on API errors and does not substitute stale or private data", async () => {
    const response = await page("/providers/", async (path) => path === "/api/v1/meta" ? api(path) : new Response(null, { status: 503 }));
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).not.toContain("Provider 2");
    expect((await page("/models/no-such/model")).status).toBe(404);
    const result = fillShell(`${MARK.title}${MARK.html}`, { title: MARK.html, html: "actual content", description: "", canonical: "", dataset: "", nav: "" });
    expect(result).toBe(`${MARK.html}actual content`);
  });

  it("invalidates response validators on publication changes and does not reuse them across queries", async () => {
    const first = await api("/api/v1/entries?limit=1");
    const request = new Request("https://providers.dev/api/v1/entries?limit=1", { headers: { "If-None-Match": first.headers.get("etag")! } });
    expect((await handleApi(request, { ...deps, meta: { ...deps.meta, generated_at: "2030-01-01T00:00:00Z" } })).status).toBe(200);
    const other = await handleApi(new Request("https://providers.dev/api/v1/entries?limit=2", { headers: request.headers }), deps);
    expect(other.status).toBe(200);
  });
});

it("publishes new data without rebuilding the shell, while in-flight API reads stay on their pinned publication", async () => {
  const destination = tempDataDir();
  mkdirSync(join(destination, "site-shell"));
  writeFileSync(join(destination, "site-shell", "index.html"), shell);
  stageSnapshot(join(dataDir, "published"), destination);
  const assets: AssetBinding = { async fetch(request) {
    const path = new URL(typeof request === "string" ? request : request.url).pathname;
    const file = join(destination, path.endsWith("/") ? `${path}index.html` : path);
    return existsSync(file) ? new Response(readFileSync(file)) : new Response(null, { status: 404 });
  } };
  const pinned = await readSnapshot(assets, "https://providers.dev");
  // The index is staged as gzip only, well under the per-file limit of static assets, and served as plain JSON.
  const staged = join(destination, "snapshots", (JSON.parse(readFileSync(join(destination, "current.json"), "utf8")) as { id: string }).id, "data");
  expect([existsSync(join(staged, "index.json")), existsSync(join(staged, "index.json.gz"))]).toEqual([false, true]);
  const servedIndex = await worker.fetch(new Request("https://providers.dev/data/index.json"), { ASSETS: assets });
  expect(await servedIndex.json()).toEqual(JSON.parse(readFileSync(join(dataDir, "published", "site", "data", "index.json"), "utf8")));
  const first = await worker.fetch(new Request("https://providers.dev/providers/provider-02/"), { ASSETS: assets });
  const etag = first.headers.get("etag")!;
  expect(first.status).toBe(200);
  const changed = fixtureUpstream();
  changed["provider-02"]!.name = "Updated by data publication";
  changed["provider-02"]!.models["lab/model-4"]!.name = "Updated data entry";
  await sync({ dataDir, fetch: fetchReturning(JSON.stringify(changed), { headers: { etag: '"next"' } }) });
  expect(publish({ dataDir, rootDir: ROOT, now: () => new Date("2026-11-15T00:00:00Z") }).ok).toBe(true);
  stageSnapshot(join(dataDir, "published"), destination);
  const current = await readSnapshot(assets, "https://providers.dev");
  expect(current.meta.dataset_version).not.toBe(pinned.meta.dataset_version);
  const oldProvider = await (await handleApi(new Request("https://providers.dev/api/v1/providers/provider-02?view=full"), pinned)).json() as { data: { provider: { name: string } } };
  expect(oldProvider.data.provider.name).toBe("Provider 2");
  const oldEntry = await (await handleApi(new Request("https://providers.dev/api/v1/entries/provider-02/lab/model-4"), pinned)).json() as { data: { entry: { name: string } } };
  expect(oldEntry.data.entry.name).toBe("Model 4");
  const second = await worker.fetch(new Request("https://providers.dev/providers/provider-02/", { headers: { "If-None-Match": etag } }), { ASSETS: assets });
  expect(second.status).toBe(200);
  const html = await second.text();
  expect(html).toContain("<h1>Updated by data publication</h1>");
  expect(html).toContain("Updated data entry");
  expect(readFileSync(join(destination, "site-shell", "index.html"), "utf8")).toBe(shell);
  expect((await worker.fetch(new Request("https://providers.dev/current.json"), { ASSETS: assets })).status).toBe(404);
  expect((await worker.fetch(new Request("https://providers.dev/api/v1/entries"), { ASSETS: assets })).headers.get("X-Dataset-Version")).toBe(current.meta.dataset_version);
});
