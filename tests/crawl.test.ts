// The crawl surface of providers.dev: one address per page (a 301 for the other form of its final slash), the
// canonical each page states, the views kept out of the index, and the sitemaps that list every page at the address
// the page states as canonical.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { publish } from "../scripts/lib/publish.ts";
import { stageSnapshot } from "../scripts/lib/stage.ts";
import { sync } from "../scripts/lib/sync.ts";
import { handleApi, type LoadedDeps } from "../src/core/api.ts";
import { FIXED_PAGES, listIndexing, SITEMAP_ENTRIES, SITEMAP_PATH, sitemapFiles } from "../src/core/crawl.ts";
import type { Index } from "../src/core/entries.ts";
import { MARK } from "../src/core/page-shell.ts";
import { handlePage, type PageDeps } from "../src/core/pages.ts";
import type { AssetBinding } from "../src/core/snapshot.ts";
import type { Meta } from "../src/core/schema.ts";
import worker from "../worker/index.ts";
import { depsFrom, fetchReturning, fixtureUpstream, ROOT, tempDataDir, writeAuthored } from "./helpers.ts";

const shell = `<html><head><title>${MARK.title} · providers.dev</title>${MARK.head}</head><body><nav>${MARK.nav}</nav><main>${MARK.html}</main><footer>${MARK.dataset}</footer></body></html>`;
const now = () => new Date("2026-11-14T12:00:00Z");
let deps: LoadedDeps;
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
const page = (path: string, init?: RequestInit, read = api) => handlePage(new Request(`https://providers.dev${path}`, init), pageDeps(read));
/** The canonical link and the robots meta a page states, null where it has none. */
async function head(path: string): Promise<{ status: number; canonical: string | null; robots: string | null }> {
  const response = await page(path);
  const html = await response.text();
  return {
    status: response.status,
    canonical: /<link rel="canonical" href="([^"]*)">/.exec(html)?.[1]?.replace(/&amp;/g, "&") ?? null,
    robots: /<meta name="robots" content="([^"]*)">/.exec(html)?.[1] ?? null,
  };
}

describe("canonical query of a list page", () => {
  const of = (search: string, offsets?: string[], paged?: boolean) => listIndexing(new URLSearchParams(search), offsets, paged);
  it("indexes a plain list and its pages at the default size, each canonical to itself, page one at one address", () => {
    expect(of("")).toEqual({ search: "", index: true });
    expect(of("offset=0")).toEqual({ search: "", index: true });
    expect(of("limit=50")).toEqual({ search: "", index: true });
    expect(of("offset=100")).toEqual({ search: "?offset=100", index: true });
    expect(of("limit=50&offset=050")).toEqual({ search: "?offset=50", index: true });
  });
  it("keeps every parameter that chooses the rows of a view, in name order, and does not index it", () => {
    expect(of("q=opus")).toEqual({ search: "?q=opus", index: false });
    expect(of("q=opus&offset=0")).toEqual({ search: "?q=opus", index: false });
    expect(of("provider=b&access=api&offset=50")).toEqual({ search: "?access=api&offset=50&provider=b", index: false });
    expect(of("sort=price_in&order=asc")).toEqual({ search: "?order=asc&sort=price_in", index: false });
    expect(of("limit=200")).toEqual({ search: "?limit=200", index: false });
    expect(of("limit=200&offset=200")).toEqual({ search: "?limit=200&offset=200", index: false });
    expect(of("offset=37")).toEqual({ search: "?offset=37", index: false });
    expect(of("origin=modified,added&q=a b")).toEqual({ search: "?origin=modified,added&q=a+b", index: false });
  });
  it("indexes only the plain evidence page, whose sections page apart", () => {
    const offsets = ["corrections_offset", "cache_offset", "limits_offset"];
    expect(of("cache_offset=0&limits_offset=0", offsets, false)).toEqual({ search: "", index: true });
    expect(of("limits_offset=50&cache_offset=50", offsets, false)).toEqual({ search: "?cache_offset=50&limits_offset=50", index: false });
  });
});

describe("one address per page", () => {
  it("sends the other form of the final slash to the canonical address with a 301, query kept, for GET and HEAD", async () => {
    const cases: [string, string][] = [
      ["/providers", "/providers/"],
      ["/providers?offset=0&q=Provider", "/providers/?offset=0&q=Provider"],
      ["/providers/provider-02", "/providers/provider-02/"],
      ["/models", "/models/"],
      ["/models/lab/model-3", "/models/lab/model-3/"],
      ["/entries/provider-02/lab/model-4/", "/entries/provider-02/lab/model-4"],
      ["/entries/provider-02/lab/model-4//?utm_source=x", "/entries/provider-02/lab/model-4?utm_source=x"],
      ["/evidence", "/evidence/"],
      ["/docs/api", "/docs/api/"],
      ["/docs/methodology", "/docs/methodology/"],
      ["/docs/licensing", "/docs/licensing/"],
      ["/docs/contributing", "/docs/contributing/"],
    ];
    for (const [from, to] of cases) {
      for (const method of ["GET", "HEAD"]) {
        const response = await page(from, { method });
        expect([from, method, response.status, response.headers.get("Location")]).toEqual([from, method, 301, `https://providers.dev${to}`]);
      }
      // The target is the page itself, not another redirect.
      expect([to, (await page(to)).status]).toEqual([to, 200]);
    }
  });

  it("does not redirect an address that is no page", async () => {
    for (const path of ["/providers/nobody", "/models/lab/nothing", "/entries/provider-02/none/", "/docs/nothing", "/docs/support"]) {
      expect([path, (await page(path)).status]).toEqual([path, 404]);
    }
  });

  it("states as canonical the address built from the ids the API returns, never the address asked", async () => {
    expect(await head("/providers/%70rovider-02/")).toEqual({ status: 200, canonical: "https://providers.dev/providers/provider-02/", robots: null });
    expect(await head("/models/lab%2Fmodel-3/")).toEqual({ status: 200, canonical: "https://providers.dev/models/lab/model-3/", robots: null });
    expect(await head("/models/lab/model-3/?utm_source=chatgpt.com")).toEqual({ status: 200, canonical: "https://providers.dev/models/lab/model-3/", robots: null });
    expect(await head("/entries/provider-02/lab%2Fmodel-4")).toEqual({ status: 200, canonical: "https://providers.dev/entries/provider-02/lab/model-4", robots: null });
    for (const path of FIXED_PAGES) expect([path, await head(path)]).toEqual([path, { status: 200, canonical: `https://providers.dev${path}`, robots: null }]);
  });
});

describe("lists and their views", () => {
  it("indexes the plain catalog and its pages, each canonical to itself", async () => {
    expect(await head("/?offset=0")).toEqual({ status: 200, canonical: "https://providers.dev/", robots: null });
    expect(await head("/?offset=50")).toEqual({ status: 200, canonical: "https://providers.dev/?offset=50", robots: null });
    expect(await head("/?utm_source=chatgpt.com&offset=50&fbclid=x")).toEqual({ status: 200, canonical: "https://providers.dev/?offset=50", robots: null });
  });

  it("follows but does not index a filtered, sorted or searched view, and its canonical keeps what chooses its rows", async () => {
    expect(await head("/?q=model")).toEqual({ status: 200, canonical: "https://providers.dev/?q=model", robots: "noindex, follow" });
    expect(await head("/?provider=provider-02&access=api")).toEqual({ status: 200, canonical: "https://providers.dev/?access=api&provider=provider-02", robots: "noindex, follow" });
    expect(await head("/?sort=price_in&order=asc&offset=50")).toEqual({ status: 200, canonical: "https://providers.dev/?offset=50&order=asc&sort=price_in", robots: "noindex, follow" });
    expect(await head("/?limit=200")).toEqual({ status: 200, canonical: "https://providers.dev/?limit=200", robots: "noindex, follow" });
    expect(await head("/?offset=7")).toEqual({ status: 200, canonical: "https://providers.dev/?offset=7", robots: "noindex, follow" });
    expect(await head("/providers/?q=Provider")).toEqual({ status: 200, canonical: "https://providers.dev/providers/?q=Provider", robots: "noindex, follow" });
    expect(await head("/models/?q=model&limit=5")).toEqual({ status: 200, canonical: "https://providers.dev/models/?limit=5&q=model", robots: "noindex, follow" });
    // A search with no result is a view like any other: 200, not indexed.
    expect(await head("/?q=nothing-matches-this")).toEqual({ status: 200, canonical: "https://providers.dev/?q=nothing-matches-this", robots: "noindex, follow" });
  });

  it("answers a page past the end with a real 404, not indexed and with no canonical", async () => {
    for (const path of ["/?offset=999999", "/providers/?offset=999999", "/models/?offset=5000", "/nope", "/entries/nope/nope"]) {
      const response = await page(path);
      const html = await response.text();
      expect([path, response.status, response.headers.get("X-Robots-Tag")]).toEqual([path, 404, "noindex"]);
      expect(html).not.toContain('rel="canonical"');
      expect(html).toContain('<meta name="robots" content="noindex">');
    }
  });

  it("answers a temporary failure with 503, Retry-After and no-store, not indexed", async () => {
    const failing = async () => new Response("{}", { status: 500 });
    const response = await page("/providers/", undefined, failing);
    expect([response.status, response.headers.get("Retry-After"), response.headers.get("Cache-Control"), response.headers.get("X-Robots-Tag")]).toEqual([503, "300", "no-store", "noindex"]);
    const noShell = await handlePage(new Request("https://providers.dev/providers/"), { ...pageDeps(), shell: async () => null });
    expect([noShell.status, noShell.headers.get("Retry-After"), noShell.headers.get("Cache-Control")]).toEqual([503, "300", "no-store"]);
  });
});

/** The addresses of a urlset, after a strict check of its form: the XML declaration, the namespace, one loc a url. */
function locs(text: string): string[] {
  expect(text).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">\n(<url><loc>[^<>&]*(&(amp|lt|gt|quot|apos);[^<>&]*)*<\/loc><\/url>\n)*<\/urlset>\n$/);
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return [...text.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]!.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => entities[name]!));
}
function sitemapNames(text: string): string[] {
  expect(text).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n<sitemapindex xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">\n(<sitemap><loc>https:\/\/providers\.dev\/sitemap-[a-z0-9-]+\.xml<\/loc><\/sitemap>\n)+<\/sitemapindex>\n$/);
  return [...text.matchAll(/<loc>https:\/\/providers\.dev\/([^<]*)<\/loc>/g)].map((match) => match[1]!);
}
const xmllint = (() => { try { execFileSync("xmllint", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

/** Checks a publication's sitemaps against its own meta: every page once, nothing else. */
function checkSitemaps(files: Map<string, string>, meta: Meta, models: number): string[] {
  const names = sitemapNames(files.get("sitemap.xml")!);
  expect(new Set(names)).toEqual(new Set([...files.keys()].filter((name) => name !== "sitemap.xml")));
  for (const name of names) expect(SITEMAP_PATH.test(`/${name}`)).toBe(true);
  const all = names.flatMap((name) => locs(files.get(name)!));
  const count = (name: string) => locs(files.get(name)!).length;
  expect(count("sitemap-pages.xml")).toBe(FIXED_PAGES.length);
  expect(count("sitemap-providers.xml")).toBe(meta.counts.providers);
  expect(count("sitemap-models.xml")).toBe(models);
  const entryFiles = names.filter((name) => name.startsWith("sitemap-entries-"));
  expect(entryFiles.map((name) => count(name)).every((n) => n <= SITEMAP_ENTRIES)).toBe(true);
  expect(entryFiles.reduce((sum, name) => sum + count(name), 0)).toBe(meta.counts.entries);
  expect(all.length).toBe(FIXED_PAGES.length + meta.counts.providers + models + meta.counts.entries);
  expect(new Set(all).size).toBe(all.length);
  expect(all.every((loc) => loc.startsWith("https://providers.dev/"))).toBe(true);
  expect(all.some((loc) => loc.includes("?"))).toBe(false);
  for (const text of files.values()) expect(text).not.toMatch(/lastmod|priority|changefreq/);
  return all;
}

describe("sitemaps", () => {
  const read = (dir: string) => new Map(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), "utf8")]));

  it("list every page of the publication once, at the canonical address the page itself states", async () => {
    const files = read(join(dataDir, "published", "site", "data", "sitemaps"));
    expect(files).toEqual(sitemapFiles(deps.index as Index));
    const models = (await (await api("/api/v1/models?limit=1")).json() as { total: number }).total;
    const all = checkSitemaps(files, deps.meta, models);
    // Every address answers 200 with itself as canonical, and is indexed.
    for (const loc of all) {
      const path = loc.slice("https://providers.dev".length);
      expect([path, await head(path)]).toEqual([path, { status: 200, canonical: loc, robots: null }]);
    }
  }, 120_000);

  it.skipIf(!xmllint)("are well-formed XML (xmllint)", () => {
    const dir = join(dataDir, "published", "site", "data", "sitemaps");
    for (const name of readdirSync(dir)) execFileSync("xmllint", ["--noout", join(dir, name)]);
  });

  it("escape what XML needs escaped and split the entries at the most a file holds", () => {
    const index = { ...(deps.index as Index), entries: Array.from({ length: SITEMAP_ENTRIES + 1 }, (_, i) => ({ ...deps.index.entries[0]!, ref: `p/m&${i}<'x'>` })) };
    const files = sitemapFiles(index as Index);
    expect([...files.keys()].filter((name) => name.startsWith("sitemap-entries-"))).toEqual(["sitemap-entries-1.xml", "sitemap-entries-2.xml"]);
    expect(locs(files.get("sitemap-entries-2.xml")!)).toEqual([`https://providers.dev/entries/p/m%26${SITEMAP_ENTRIES}%3C'x'%3E`]);
    expect(files.get("sitemap-entries-2.xml")).toContain("%3C&apos;x&apos;%3E");
  });

  it("are served at the root of providers.dev from the current publication, and not on the product sites", async () => {
    const destination = tempDataDir();
    mkdirSync(join(destination, "site-shell"));
    writeFileSync(join(destination, "site-shell", "index.html"), shell);
    stageSnapshot(join(dataDir, "published"), destination);
    mkdirSync(join(destination, "provimux"));
    writeFileSync(join(destination, "provimux", "sitemap.xml"), "provimux's own");
    const assets: AssetBinding = { async fetch(request) {
      const path = new URL(typeof request === "string" ? request : request.url).pathname;
      const file = join(destination, path.endsWith("/") ? `${path}index.html` : path);
      return existsSync(file) ? new Response(readFileSync(file)) : new Response(null, { status: 404 });
    } };
    const get = (url: string, method = "GET") => worker.fetch(new Request(url, { method }), { ASSETS: assets });
    for (const name of readdirSync(join(dataDir, "published", "site", "data", "sitemaps"))) {
      const response = await get(`https://providers.dev/${name}`);
      expect([name, response.status, response.headers.get("Content-Type"), response.headers.get("Cache-Control")]).toEqual([name, 200, "application/xml; charset=utf-8", "public, max-age=3600"]);
      expect(await response.text()).toBe(readFileSync(join(dataDir, "published", "site", "data", "sitemaps", name), "utf8"));
      const headOnly = await get(`https://providers.dev/${name}`, "HEAD");
      expect([headOnly.status, await headOnly.text()]).toEqual([200, ""]);
    }
    for (const path of ["/sitemap-nothing.xml", "/sitemap-entries-99.xml"]) expect([path, (await get(`https://providers.dev${path}`)).status]).toEqual([path, 404]);
    expect((await get("https://providers.dev/sitemap.xml", "POST")).status).toBe(405);
    expect(await (await get("https://provimux.providers.dev/sitemap.xml")).text()).toBe("provimux's own");
  });

  // The publication `npm run build` made: the real counts.
  const built = join(ROOT, "dist");
  it.skipIf(!existsSync(join(built, "current.json")))("list every page of the publication in dist/", () => {
    const id = (JSON.parse(readFileSync(join(built, "current.json"), "utf8")) as { id: string }).id;
    const data = join(built, "snapshots", id, "data");
    const meta = JSON.parse(readFileSync(join(data, "meta.json"), "utf8")) as Meta;
    expect(meta.counts.models).toBeGreaterThan(0);
    checkSitemaps(read(join(data, "sitemaps")), meta, meta.counts.models);
    if (xmllint) for (const name of readdirSync(join(data, "sitemaps"))) execFileSync("xmllint", ["--noout", join(data, "sitemaps", name)]);
  });
});

describe("robots.txt", () => {
  const hosts = [["providers.dev", "public/robots.txt"], ["provimux.providers.dev", "public/provimux/robots.txt"], ["pi-cache-keeper.providers.dev", "public/pi-cache-keeper/robots.txt"]] as const;

  it("allows every crawler everything, says the owner's content signals and names the host's sitemap, on every host", () => {
    for (const [host, file] of hosts) {
      const rules = readFileSync(join(ROOT, file), "utf8").split("\n").map((line) => line.replace(/#.*/, "").trim()).filter(Boolean);
      // One group for every user agent, none for a crawler apart, and no Disallow: nothing is kept from any crawler.
      expect([host, rules]).toEqual([host, ["User-agent: *", "Content-Signal: search=yes, ai-input=yes, ai-train=yes", "Allow: /", `Sitemap: https://${host}/sitemap.xml`]]);
    }
  });

  // The build: each host's robots.txt is served on that host, and the sitemap it names answers there.
  const built = join(ROOT, "dist");
  it.skipIf(!existsSync(join(built, "current.json")))("is served on each host from the build, and the sitemap it names answers", async () => {
    const assets: AssetBinding = { async fetch(request) {
      const path = new URL(typeof request === "string" ? request : request.url).pathname;
      const file = join(built, path.endsWith("/") ? `${path}index.html` : path);
      return existsSync(file) ? new Response(readFileSync(file)) : new Response(null, { status: 404 });
    } };
    for (const [host, file] of hosts) {
      const robots = await worker.fetch(new Request(`https://${host}/robots.txt`), { ASSETS: assets });
      const text = await robots.text();
      expect([host, robots.status, text]).toEqual([host, 200, readFileSync(join(ROOT, file), "utf8")]);
      const sitemap = /^Sitemap: (\S+)$/m.exec(text)![1]!;
      const answer = await worker.fetch(new Request(sitemap), { ASSETS: assets });
      expect([sitemap, answer.status]).toEqual([sitemap, 200]);
      expect(await answer.text()).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n<(urlset|sitemapindex) xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    }
  });
});
