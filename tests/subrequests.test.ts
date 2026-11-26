// Every read of ASSETS is a subrequest of the Worker, and Cloudflare allows 50 in one invocation; wrangler dev has no
// such cap, so only a count finds it. In 1.5.0 /api/v1/listings?view=full read one file per listing and failed above
// 48 (Cloudflare 1101). Every route of the Worker (every API path, every page family, the data files) is asked here
// through the Worker itself, each time on a fresh isolate (a new binding: the publication is read from nothing, which
// is the most a request can read), and may read ASSETS at most BUDGET times.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { publish } from "../scripts/lib/publish.ts";
import { stageSnapshot } from "../scripts/lib/stage.ts";
import { sync } from "../scripts/lib/sync.ts";
import { ENDPOINTS } from "../src/core/openapi.ts";
import { FULL_LISTING_LIMIT, MAX_LIMIT } from "../src/core/query.ts";
import { DOCUMENTS } from "../src/core/resources.ts";
import type { AssetBinding } from "../src/core/snapshot.ts";
import type { Listing, ListingModel } from "../src/core/listings.ts";
import worker from "../worker/index.ts";
import { fetchReturning, fixtureUpstream, ROOT, tempDataDir, writeAuthored } from "./helpers.ts";

/** The most ASSETS reads one request may make: Cloudflare's cap is 50, and 5 are left for what comes next. */
const BUDGET = 45;

/** ASSETS over a staged folder (current.json, snapshots/, site-shell/, reference-content/), every read counted. */
function binding(root: string): { assets: AssetBinding; reads: string[] } {
  const reads: string[] = [];
  const assets: AssetBinding = {
    async fetch(request) {
      const path = new URL(typeof request === "string" ? request : request.url).pathname;
      reads.push(path);
      const file = join(root, path.endsWith("/") ? `${path}index.html` : path);
      return existsSync(file) ? new Response(readFileSync(file)) : new Response(null, { status: 404 });
    },
  };
  return { assets, reads };
}

/** One request through the Worker on a fresh isolate: its status and the ASSETS reads it made. */
async function ask(root: string, path: string): Promise<{ status: number; reads: string[] }> {
  const { assets, reads } = binding(root);
  const response = await worker.fetch(new Request(`https://providers.dev${path}`), { ASSETS: assets });
  await response.arrayBuffer();
  return { status: response.status, reads };
}

/** Every route of the Worker on a staged folder, with ids taken from its publication. */
function routes(root: string): string[] {
  const id = (JSON.parse(readFileSync(join(root, "current.json"), "utf8")) as { id: string }).id;
  const data = join(root, "snapshots", id, "data");
  const head = JSON.parse(gunzipSync(readFileSync(join(data, "index-parts", "head.json.gz"))).toString("utf8")) as { providers: { id: string }[] };
  const summaries = JSON.parse(gunzipSync(readFileSync(join(data, "index-parts", "0.json.gz"))).toString("utf8")) as { ref: string; provider: string; canonical_id: string | null }[];
  const listings = (JSON.parse(readFileSync(join(data, "listings.json"), "utf8")) as { data: Listing[] }).data;
  const entry = summaries[0]!;
  const model = summaries.find((item) => item.canonical_id)?.canonical_id ?? "lab/model";
  const provider = head.providers[0]!.id;
  const listed = listings[0]?.provider ?? provider;
  const last = Math.max(0, Math.floor((listings.length - 1) / FULL_LISTING_LIMIT) * FULL_LISTING_LIMIT);
  const api = [
    "/api/v1/meta", "/api/v1/openapi.json", "/api/v1/catalog", "/api/v1/facets", "/api.json", "/data/catalog.json",
    `/api/v1/entries?limit=${MAX_LIMIT}`, `/api/v1/entries/${entry.ref}`,
    `/api/v1/providers?limit=${MAX_LIMIT}`, `/api/v1/providers/${provider}`, `/api/v1/providers/${provider}?view=full`,
    `/api/v1/models?limit=${MAX_LIMIT}`, `/api/v1/models/${model}`,
    `/api/v1/evaluations/cache?limit=${MAX_LIMIT}`, `/api/v1/evaluations/limits?limit=${MAX_LIMIT}`,
    `/api/v1/listings?limit=${MAX_LIMIT}`, "/api/v1/listings?view=full", `/api/v1/listings?view=full&limit=${FULL_LISTING_LIMIT}`,
    `/api/v1/listings?view=full&limit=${FULL_LISTING_LIMIT}&offset=${last}`, `/api/v1/listings/${listed}`, "/api/v1/listings/nobody",
    `/api/v1/corrections?limit=${MAX_LIMIT}`, ...DOCUMENTS.map((document) => `/api/v1/docs/${document}`),
  ];
  const pages = [
    "/", "/?sort=price_in&limit=200", "/providers/", `/providers/${provider}/`, `/providers/${listed}/`, "/models/", `/models/${model}/`,
    `/entries/${entry.ref}/`, "/evidence/", "/docs/api/", "/docs/methodology/", "/docs/licensing/", "/docs/contributing/", "/support/",
  ];
  const sitemaps = ["/sitemap.xml", "/sitemap-entries-1.xml"];
  // The markdown versions (each reads what its page reads) and what agents read first.
  const agents = ["/index.html.md", `/providers/${provider}/index.html.md`, `/models/${model}/index.html.md`, `/entries/${entry.ref}.md`, "/evidence/index.html.md", "/docs/api/index.html.md", "/llms.txt", "/.well-known/api-catalog"];
  return [...api, ...pages, ...sitemaps, ...agents, "/data/meta.json", `/data/listings/${listed}.json`, "/favicon.svg", "/nothing"];
}

/** The routes that read more than BUDGET, with what they read: none is the answer. */
async function overBudget(root: string): Promise<{ statuses: Record<string, number>; over: string[]; most: number }> {
  const statuses: Record<string, number> = {};
  const over: string[] = [];
  let most = 0;
  for (const path of routes(root)) {
    const { status, reads } = await ask(root, path);
    statuses[path] = status;
    most = Math.max(most, reads.length);
    if (reads.length > BUDGET) over.push(`${path}: ${reads.length} reads of ASSETS (${[...new Set(reads.map((read) => read.replace(/^\/snapshots\/[a-f0-9]+/, "").replace(/\/[^/]+\.json(\.gz)?$/, "/…")))].join(", ")})`);
  }
  return { statuses, over, most };
}

describe("subrequests: no request reads ASSETS more than 45 times", () => {
  let root: string;
  beforeAll(async () => {
    const dataDir = tempDataDir();
    await sync({ dataDir, fetch: fetchReturning(JSON.stringify(fixtureUpstream())) });
    writeAuthored(dataDir);
    expect(publish({ dataDir, rootDir: ROOT, now: () => new Date("2026-11-22T12:00:00Z") }).errors).toEqual([]);
    root = tempDataDir();
    const id = stageSnapshot(join(dataDir, "published"), root);
    mkdirSync(join(root, "site-shell"));
    writeFileSync(join(root, "site-shell", "index.html"), "<html><head><title>{{title}}</title></head><body>{{html}}</body></html>");
    mkdirSync(join(root, "reference-content", "docs"), { recursive: true });
    for (const document of DOCUMENTS) writeFileSync(join(root, "reference-content", "docs", `${document}.json`), JSON.stringify({ title: document, description: document, lead: document, toc: [], body_html: "<p>…</p>" }));
    // More listings than a page in full holds, twice over: a count that grows with the listings shows here.
    const data = join(root, "snapshots", id, "data");
    const model: ListingModel = { id: "m", name: null, owner: null, entry: null, canonical: null, released: null, context_window: null, max_input: null, max_output: null, input_modalities: null, output_modalities: null, reasoning: null, web_search: null, aliases: [], variants: [], plans: [], hidden: null, listed_by: ["listed"], sources: { name: null, owner: null, released: null, context_window: null, max_input: null, max_output: null, input_modalities: null, output_modalities: null, reasoning: { supported: null, levels: null, budget_min: null, budget_max: null, can_disable: null, dynamic: null, disable_with: null }, web_search: null, aliases: null, variants: null, plans: null, hidden: null } };
    const listings = Array.from({ length: FULL_LISTING_LIMIT * 3 }, (_, i): Listing => ({ provider: `listed-${String(i).padStart(3, "0")}`, basis: "listed", listed_at: "2026-11-22", lists: { listed: { listed_at: "2026-11-22", model_count: 1 }, "providers.dev": null, "models.dev": null, "pi.dev": null }, client: "provimux", client_label: "Provimux", evidence: [], model_count: 1, models: [model] }));
    mkdirSync(join(data, "listings"), { recursive: true });
    writeFileSync(join(data, "listings.json"), JSON.stringify({ meta: {}, data: listings.map((item) => ({ ...item, models: null })) }));
    for (const item of listings) writeFileSync(join(data, "listings", `${item.provider}.json`), JSON.stringify({ meta: {}, data: item }));
  });

  it("covers every path of the API", () => {
    const asked = routes(root).map((path) => path.split("?")[0]!);
    for (const { path } of ENDPOINTS) {
      const pattern = new RegExp(`^${path.replace(/\{model\}/g, ".+").replace(/\{[a-z]+\}/g, "[^/]+")}$`);
      expect(asked.some((item) => pattern.test(item)), path).toBe(true);
    }
  });

  it("holds on a publication with more listings than a page in full, every route answered", async () => {
    const { statuses, over } = await overBudget(root);
    expect(over).toEqual([]);
    expect(statuses["/api/v1/listings?view=full"]).toBe(200);
    expect(statuses[`/api/v1/listings?view=full&limit=${FULL_LISTING_LIMIT}`]).toBe(200);
    expect(statuses["/api/v1/listings/nobody"]).toBe(404);
    expect(statuses["/sitemap.xml"]).toBe(200);
  });

  it("reads the pointer, the meta and the one file for a sitemap, and no index", async () => {
    const { status, reads } = await ask(root, "/sitemap-entries-1.xml");
    expect(status).toBe(200);
    expect(reads.length).toBe(3);
  });

  it("reads exactly the pointer, the meta, the list and one file per listing for a page in full, and no index", async () => {
    const { status, reads } = await ask(root, `/api/v1/listings?view=full&limit=${FULL_LISTING_LIMIT}`);
    expect(status).toBe(200);
    expect(reads.length).toBe(3 + FULL_LISTING_LIMIT);
    expect(reads.some((path) => path.includes("/index-parts/"))).toBe(false);
  });

  // The publication `npm run build` made (Publish and Check build before they check): the real number of index parts,
  // listings and files. Without a build there is nothing to read.
  const built = join(ROOT, "dist");
  it.skipIf(!existsSync(join(built, "current.json")))("holds on the publication in dist/", async () => {
    const { statuses, over, most } = await overBudget(built);
    expect(over).toEqual([]);
    expect(most).toBeGreaterThan(0);
    for (const [path, status] of Object.entries(statuses)) if (path !== "/nothing" && path !== "/api/v1/listings/nobody") expect(status, path).toBeLessThan(400);
  });
});
