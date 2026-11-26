// How long what the Worker answers may be kept (src/core/cache-control.ts). Astro's hashed files are kept a year on
// all three hosts and nothing else is: not a 404 under /_astro/, not a redirect, not a host's own icon or picture. What
// is made from the publication (pages, markdown, sitemaps, llms.txt) has the pages' five minutes, errors none, and a
// new publication is what the next request gets: the Worker keeps no answer.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { publish } from "../scripts/lib/publish.ts";
import { stageSnapshot } from "../scripts/lib/stage.ts";
import { sync } from "../scripts/lib/sync.ts";
import { IMMUTABLE_CACHE, isHashedAsset, PUBLICATION_CACHE } from "../src/core/cache-control.ts";
import { MARK } from "../src/core/page-shell.ts";
import type { AssetBinding } from "../src/core/snapshot.ts";
import worker from "../worker/index.ts";
import { fetchReturning, fixtureUpstream, ROOT, tempDataDir, writeAuthored } from "./helpers.ts";

const shell = `<html><head><title>${MARK.title}</title>${MARK.head}</head><body><nav>${MARK.nav}</nav><main>${MARK.html}</main><footer>${MARK.dataset}</footer></body></html>`;
const HOSTS = ["providers.dev", "provimux.providers.dev", "pi-cache-keeper.providers.dev"] as const;
const CSS = "/_astro/global.BbArlyj9.css";
const FONT = "/_astro/geist-mono-latin-wght-normal.XN7g48iV.woff2";

/** A publication of the fixture, `providers` providers wide, made at `now`. */
async function publication(providers: number, now: string): Promise<string> {
  const dataDir = tempDataDir();
  await sync({ dataDir, fetch: fetchReturning(JSON.stringify(fixtureUpstream(providers))) });
  writeAuthored(dataDir);
  expect(publish({ dataDir, rootDir: ROOT, now: () => new Date(now) }).errors).toEqual([]);
  return join(dataDir, "published");
}

/**
 * A build as Cloudflare's asset layer serves it: the files, a 304 to a matching If-None-Match, the 404 of a file that
 * is not there. Each host's own icon has its own bytes.
 */
function build(destination: string) {
  const files: Record<string, string> = {
    [CSS.slice(1)]: "body{}",
    [FONT.slice(1)]: "font",
    "_astro/unhashed.css": "a{}",
    "site-shell/index.html": shell,
    "favicon.ico": "providers.dev icon",
    "og.png": "providers.dev card",
    "robots.txt": "User-agent: *",
    "provimux/index.html": "<h1>Provimux</h1>",
    "provimux/index.html.md": "# Provimux",
    "provimux/support/index.html": "<h1>Support</h1>",
    "provimux/support/index.html.md": "# Support",
    "provimux/not-found/index.html": "<h1>Nothing at this address</h1>",
    "provimux/favicon.ico": "provimux icon",
    "provimux/og.png": "provimux card",
    "provimux/robots.txt": "User-agent: *",
    "provimux/llms.txt": "# Provimux",
    "pi-cache-keeper/index.html": "<h1>pi-cache-keeper</h1>",
    "pi-cache-keeper/index.html.md": "# pi-cache-keeper",
    "pi-cache-keeper/not-found/index.html": "<h1>Nothing at this address</h1>",
    "pi-cache-keeper/favicon.ico": "pi-cache-keeper icon",
    "pi-cache-keeper/og.png": "pi-cache-keeper card",
    "pi-cache-keeper/robots.txt": "User-agent: *",
    "pi-cache-keeper/llms.txt": "# pi-cache-keeper",
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(destination, path)), { recursive: true });
    writeFileSync(join(destination, path), body);
  }
  const binding: AssetBinding = { async fetch(request) {
    const req = typeof request === "string" ? new Request(request) : request;
    const path = new URL(req.url).pathname;
    const file = join(destination, path.endsWith("/") ? `${path}index.html` : path);
    if (!existsSync(file)) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=0, must-revalidate" } });
    const etag = `"${Buffer.from(path).toString("hex").slice(0, 16)}"`;
    const headers = { "Cache-Control": "public, max-age=0, must-revalidate", ETag: etag };
    if (req.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
    return new Response(readFileSync(file), { headers });
  } };
  return binding;
}

let first: string;
let second: string;
beforeAll(async () => {
  // The second publication drops a provider: what an import that removes entries looks like.
  first = await publication(30, "2026-11-14T12:00:00Z");
  second = await publication(29, "2026-11-15T12:00:00Z");
}, 120_000);

function site(published = first) {
  const destination = tempDataDir();
  const binding = build(destination);
  stageSnapshot(published, destination);
  const get = (url: string, init: RequestInit = {}) => worker.fetch(new Request(url, init), { ASSETS: binding });
  return { destination, binding, get };
}

describe("Astro's hashed files", () => {
  it("are kept a year, immutable, on all three hosts, for GET, HEAD and a 304, with the file's own bytes", async () => {
    const { get } = site();
    for (const host of HOSTS) {
      for (const path of [CSS, FONT]) {
        const response = await get(`https://${host}${path}`);
        expect([host, path, response.status, response.headers.get("Cache-Control")]).toEqual([host, path, 200, IMMUTABLE_CACHE]);
        expect(await response.text()).toBe(path === CSS ? "body{}" : "font");
        const head = await get(`https://${host}${path}`, { method: "HEAD" });
        expect([host, path, head.status, head.headers.get("Cache-Control")]).toEqual([host, path, 200, IMMUTABLE_CACHE]);
        const etag = response.headers.get("ETag")!;
        const again = await get(`https://${host}${path}`, { headers: { "If-None-Match": etag } });
        expect([host, path, again.status, again.headers.get("Cache-Control"), again.headers.get("ETag")]).toEqual([host, path, 304, IMMUTABLE_CACHE, etag]);
      }
    }
  });

  it("never gives a year to a missing file, a name without a hash, a redirect, or a host's own files", async () => {
    const { get } = site();
    for (const host of HOSTS) {
      // A missing hashed name: 404, and never cacheable for a year (the product sites answer no-store).
      const missing = await get(`https://${host}/_astro/global.Zzzzzzzz.css`);
      expect([host, missing.status]).toEqual([host, 404]);
      expect(missing.headers.get("Cache-Control")).not.toContain("immutable");
      expect(missing.headers.get("Cache-Control") ?? "").not.toMatch(/max-age=[1-9]/);
      const unhashed = await get(`https://${host}/_astro/unhashed.css`);
      expect([host, unhashed.status, unhashed.headers.get("Cache-Control")]).toEqual([host, 200, "public, max-age=0, must-revalidate"]);
      // Icons, cards and robots.txt differ per host and keep their names: revalidated, and each host's own.
      for (const path of ["/favicon.ico", "/og.png", "/robots.txt"]) {
        const response = await get(`https://${host}${path}`);
        expect([host, path, response.status, response.headers.get("Cache-Control")]).toEqual([host, path, 200, "public, max-age=0, must-revalidate"]);
      }
      const name = host === "providers.dev" ? "providers.dev" : host.split(".")[0];
      expect(await (await get(`https://${host}/favicon.ico`)).text()).toBe(`${name} icon`);
    }
    // The edge's redirects still come first: www and plain http go to https, without the file's lifetime.
    for (const [url, proto, to] of [[`https://www.providers.dev${CSS}`, "https", `https://providers.dev${CSS}`], [`http://providers.dev${CSS}`, "http", `https://providers.dev${CSS}`], [`http://provimux.providers.dev${CSS}`, "http", `https://provimux.providers.dev${CSS}`]] as const) {
      const response = await get(url, { headers: { "X-Forwarded-Proto": proto } });
      expect([url, response.status, response.headers.get("Location"), response.headers.get("Cache-Control")]).toEqual([url, 301, to, null]);
    }
  });

  it("are the only names that match: every file of /_astro/ in the build is hashed, nothing outside it is, and public/ writes none there", () => {
    expect(isHashedAsset(CSS)).toBe(true);
    expect(isHashedAsset("/_astro/site-shell.astro_astro_type_script_index_0_lang.DXm7GePs.js")).toBe(true);
    for (const path of ["/_astro/site.css", "/_astro/a.b.css", "/favicon.ico", "/og.png", "/provimux/media/x.12345678.webp", "/_astro/../og.12345678.png", "/_astro/", "/_astro/x.12345678.css/"]) {
      expect([path, isHashedAsset(path)]).toEqual([path, false]);
    }
    expect(existsSync(join(ROOT, "public", "_astro"))).toBe(false);
    const built = join(ROOT, "dist", "_astro");
    if (existsSync(built)) for (const name of readdirSync(built)) expect([name, isHashedAsset(`/_astro/${name}`)]).toEqual([name, true]);
  });

  // The build: every /_astro/ address a built page names is a hashed file there, so a page never names one that changes.
  it.skipIf(!existsSync(join(ROOT, "dist", "site-shell", "index.html")))("are what the built pages link, and each is there", () => {
    const pages = [join("site-shell", "index.html"), join("provimux", "index.html"), join("provimux", "support", "index.html"), join("pi-cache-keeper", "index.html")];
    const named = new Set<string>();
    for (const page of pages) for (const match of readFileSync(join(ROOT, "dist", page), "utf8").matchAll(/\/_astro\/[^"')\s]+/g)) named.add(match[0]);
    expect(named.size).toBeGreaterThan(0);
    for (const path of named) {
      expect([path, isHashedAsset(path)]).toEqual([path, true]);
      expect([path, existsSync(join(ROOT, "dist", path))]).toEqual([path, true]);
    }
  });
});

describe("what is made from the publication", () => {
  it("has the pages' lifetime, varies by Accept where the address answers both, and errors are never kept", async () => {
    const { get } = site();
    for (const path of ["/", "/providers/provider-01/", "/entries/provider-01/lab/model-2", "/entries/provider-01/lab/model-2.md", "/providers/index.html.md", "/sitemap.xml", "/sitemap-entries-1.xml", "/llms.txt"]) {
      const response = await get(`https://providers.dev${path}`);
      expect([path, response.status, response.headers.get("Cache-Control")]).toEqual([path, 200, PUBLICATION_CACHE]);
    }
    for (const accept of ["text/html", "text/markdown"]) {
      const response = await get("https://providers.dev/entries/provider-01/lab/model-2", { headers: { Accept: accept } });
      expect([accept, response.headers.get("Vary"), response.headers.get("Content-Type")?.split(";")[0]]).toEqual([accept, "Accept", accept]);
      const revalidated = await get("https://providers.dev/entries/provider-01/lab/model-2", { headers: { Accept: accept, "If-None-Match": response.headers.get("ETag")! } });
      expect([accept, revalidated.status, revalidated.headers.get("Vary"), revalidated.headers.get("Cache-Control")]).toEqual([accept, 304, "Accept", PUBLICATION_CACHE]);
    }
    for (const path of ["/entries/nope/nope", "/entries/nope/nope.md", "/providers/nope/", "/sitemap-entries-99.xml", "/models/?offset=999999"]) {
      const response = await get(`https://providers.dev${path}`);
      expect([path, response.status, response.headers.get("Cache-Control")]).toEqual([path, 404, "no-store"]);
    }
    // No publication: 503, never kept.
    const empty = site();
    rmSync(join(empty.destination, "current.json"));
    for (const path of ["/", "/llms.txt", "/sitemap.xml", "/api/v1/meta"]) {
      const response = await empty.get(`https://providers.dev${path}`);
      expect([path, response.status, response.headers.get("Cache-Control")]).toEqual([path, 503, "no-store"]);
    }
  });

  it("is the new publication's on the next request after an import: the Worker keeps no answer", async () => {
    const { destination, get } = site(first);
    const before = { sitemap: await (await get("https://providers.dev/sitemap-providers.xml")).text(), llms: await get("https://providers.dev/llms.txt"), page: await get("https://providers.dev/providers/provider-29/") };
    expect(before.sitemap).toContain("/providers/provider-29/");
    expect(before.page.status).toBe(200);
    stageSnapshot(second, destination);
    const sitemap = await (await get("https://providers.dev/sitemap-providers.xml")).text();
    expect(sitemap).not.toContain("/providers/provider-29/");
    expect(sitemap).toBe(readFileSync(join(second, "site", "data", "sitemaps", "sitemap-providers.xml"), "utf8"));
    const llms = await get("https://providers.dev/llms.txt");
    expect(llms.headers.get("X-Dataset-Version")).not.toBe(before.llms.headers.get("X-Dataset-Version"));
    expect(await llms.text()).toContain(JSON.parse(readFileSync(join(second, "site", "data", "meta.json"), "utf8")).dataset_version);
    const gone = await get("https://providers.dev/providers/provider-29/");
    expect([gone.status, gone.headers.get("Cache-Control")]).toEqual([404, "no-store"]);
  }, 60_000);
});
