// pi-cache-keeper.providers.dev: the fourth address of the Worker (src/core/pi-cache-keeper-site.ts). Its static page
// and files on the subdomain, nothing else there; anything under /pi-cache-keeper/ on providers.dev sent to it with a
// 301. The routing is the one every product site shares (src/core/product-site.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { movedToPiCacheKeeper, PI_CACHE_KEEPER, PI_CACHE_KEEPER_PAGES, PI_CACHE_KEEPER_SITE } from "../src/core/pi-cache-keeper-site.ts";
import { siteRoute } from "../src/core/product-site.ts";
import type { AssetBinding } from "../src/core/snapshot.ts";
import worker from "../worker/index.ts";
import { ROOT, tempDataDir } from "./helpers.ts";

/** A build with the product sites' files only: no snapshot, so a request that read the dataset would fail. */
function assets() {
  const dist = tempDataDir();
  const files: Record<string, string> = {
    "pi-cache-keeper/index.html": "<h1>pi-cache-keeper home</h1>",
    "pi-cache-keeper/not-found/index.html": "<h1>Nothing at this address</h1>",
    "pi-cache-keeper/og.png": "png",
    "pi-cache-keeper/robots.txt": "User-agent: *",
    "pi-cache-keeper/sitemap.xml": "<urlset/>",
    "pi-cache-keeper/favicon.svg": "<svg/>",
    "provimux/index.html": "<h1>Provimux home</h1>",
    "provimux/support/index.html": "<h1>Provimux support</h1>",
    "provimux/og.png": "png",
    "_astro/site.css": "body{}",
    "site-shell/index.html": "providers.dev shell",
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dist, path)), { recursive: true });
    writeFileSync(join(dist, path), body);
  }
  const reads: string[] = [];
  const binding: AssetBinding = { async fetch(request) {
    const path = new URL(typeof request === "string" ? request : request.url).pathname;
    reads.push(path);
    const file = join(dist, path.endsWith("/") ? `${path}index.html` : path);
    return existsSync(file) ? new Response(readFileSync(file)) : new Response(null, { status: 404 });
  } };
  return { binding, reads };
}

const get = (binding: AssetBinding, url: string, init: RequestInit = {}) => worker.fetch(new Request(url, init), { ASSETS: binding });
const HOST = "https://pi-cache-keeper.providers.dev";

describe("pi-cache-keeper.providers.dev on the Worker", () => {
  it("serves its page and its files at the subdomain's root, from the build's pi-cache-keeper folder", async () => {
    const { binding, reads } = assets();
    const home = await get(binding, `${HOST}/`);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("pi-cache-keeper home");
    for (const path of ["/og.png", "/robots.txt", "/sitemap.xml", "/favicon.svg", "/_astro/site.css"]) {
      expect([path, (await get(binding, `${HOST}${path}`)).status]).toEqual([path, 200]);
    }
    // Every file but Astro's shared stylesheets is the subdomain's own: never Provimux's, never the dataset.
    expect(reads).toEqual(["/pi-cache-keeper/", "/pi-cache-keeper/og.png", "/pi-cache-keeper/robots.txt", "/pi-cache-keeper/sitemap.xml", "/pi-cache-keeper/favicon.svg", "/_astro/site.css"]);
  });

  it("answers anything else there with its own page and status 404: no API, no providers.dev page, no Provimux page, no build folder by name", async () => {
    const { binding, reads } = assets();
    for (const path of ["/api/v1/meta", "/api.json", "/docs/methodology/", "/providers/", "/support/", "/pi-cache-keeper/", "/provimux/", "/not-found/", "/index.html", "/site-shell/", "/media/missing.png", "/install/"]) {
      const response = await get(binding, `${HOST}${path}`);
      expect([path, response.status, response.headers.get("Content-Type"), response.headers.get("Cache-Control")]).toEqual([path, 404, "text/html; charset=utf-8", "no-store"]);
      expect(await response.text(), path).toContain("Nothing at this address");
    }
    expect(reads.some((path) => path.startsWith("/snapshots/") || path === "/current.json" || path.startsWith("/site-shell") || path.startsWith("/provimux"))).toBe(false);
    const head = await get(binding, `${HOST}/nothing`, { method: "HEAD" });
    expect([head.status, await head.text()]).toEqual([404, ""]);
  });

  it("answers GET and HEAD only, and sends plain http at the edge to https on the same host", async () => {
    const { binding } = assets();
    expect((await get(binding, `${HOST}/`, { method: "POST" })).status).toBe(405);
    expect((await get(binding, `${HOST}/`, { method: "HEAD" })).status).toBe(200);
    for (const path of ["/", "/og.png?x=1", "/install/"]) {
      const edge = await get(binding, `http://pi-cache-keeper.providers.dev${path}`, { headers: { "X-Forwarded-Proto": "http" } });
      expect([path, edge.status, edge.headers.get("Location")]).toEqual([path, 301, `${HOST}${path}`]);
    }
    // wrangler dev sees the host over plain http with no edge header: served as it comes.
    expect((await get(binding, "http://pi-cache-keeper.providers.dev/")).status).toBe(200);
    expect((await get(binding, `${HOST}/`, { headers: { "X-Forwarded-Proto": "https" } })).status).toBe(200);
  });

  it("routes a path by the shared rules of src/core/product-site.ts", () => {
    expect(PI_CACHE_KEEPER_PAGES).toEqual(["/"]);
    expect(PI_CACHE_KEEPER).toEqual({ site: HOST, host: "pi-cache-keeper.providers.dev", assets: "/pi-cache-keeper", notFound: "/pi-cache-keeper/not-found/", pages: ["/"] });
    expect(siteRoute(PI_CACHE_KEEPER, "/")).toEqual({ asset: "/pi-cache-keeper/", status: 200 });
    expect(siteRoute(PI_CACHE_KEEPER, "/og.png")).toEqual({ asset: "/pi-cache-keeper/og.png", status: 200 });
    expect(siteRoute(PI_CACHE_KEEPER, "/_astro/a.css")).toEqual({ asset: "/_astro/a.css", status: 200 });
    for (const path of ["/index.html", "/media/", "/media/../og.png", "/support/", "//evil.example/x.png"]) expect(siteRoute(PI_CACHE_KEEPER, path), path).toEqual({ asset: "/pi-cache-keeper/not-found/", status: 404 });
  });
});

describe("providers.dev sends anything under /pi-cache-keeper/ to the subdomain with a 301, before reading anything", () => {
  it("sends the build's folder to the same path on the subdomain, with the query", async () => {
    const { binding, reads } = assets();
    for (const [path, location] of [
      ["/pi-cache-keeper", `${HOST}/`],
      ["/pi-cache-keeper/", `${HOST}/`],
      ["/pi-cache-keeper/?from=npm", `${HOST}/?from=npm`],
      ["/pi-cache-keeper/not-found/", `${HOST}/not-found/`],
      ["/pi-cache-keeper/og.png", `${HOST}/og.png`],
    ] as const) {
      for (const origin of ["https://providers.dev", "http://localhost:18791"]) {
        const response = await get(binding, `${origin}${path}`, origin.startsWith("https") ? { headers: { "X-Forwarded-Proto": "https" } } : {});
        expect([origin, path, response.status, response.headers.get("Location")]).toEqual([origin, path, 301, location]);
      }
    }
    expect(reads).toEqual([]);
  });

  it("leaves every other address alone", () => {
    for (const path of ["/", "/pi-cache-keeperx/", "/pi-cache/", "/docs/methodology/", "/providers/pi/"]) {
      expect(movedToPiCacheKeeper(new URL(`https://providers.dev${path}`)), path).toBeNull();
    }
    // A path that looks like another host stays a path on the subdomain.
    expect(movedToPiCacheKeeper(new URL("https://providers.dev/pi-cache-keeper//evil.example/x"))).toBe(`${HOST}//evil.example/x`);
  });

  it("has the subdomain as a custom domain of the Worker", () => {
    const config = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
    expect(config).toContain('{ "pattern": "pi-cache-keeper.providers.dev", "custom_domain": true }');
  });
});

describe("pi-cache-keeper's page", () => {
  const source = (...path: string[]) => readFileSync(join(ROOT, ...path), "utf8");
  const home = source("src", "pages", "pi-cache-keeper", "index.astro");
  const layout = source("src", "layouts", "PiCacheKeeper.astro");
  const missing = source("src", "pages", "pi-cache-keeper", "not-found", "index.astro");
  const text = [home, layout, missing].join("\n").replace(/\s+/g, " ");

  it("lists its page in the sitemap and robots.txt at the subdomain's address, with a canonical address there", () => {
    const sitemap = source("public", "pi-cache-keeper", "sitemap.xml");
    expect([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])).toEqual(PI_CACHE_KEEPER_PAGES.map((path) => `${PI_CACHE_KEEPER_SITE}${path}`));
    expect(source("public", "pi-cache-keeper", "robots.txt")).toContain("Sitemap: https://pi-cache-keeper.providers.dev/sitemap.xml");
    expect(layout).toContain("const canonical = path === null ? null : new URL(path, PI_CACHE_KEEPER_SITE).toString();");
    expect(layout).toContain('<link rel="canonical" href={canonical} />');
    expect(layout).toContain('<meta name="robots" content="noindex" />');
    expect(layout).toContain("<meta property=\"og:image\" content={`${PI_CACHE_KEEPER_SITE}/og.png`} />");
    expect(home).toContain('const title = "pi-cache-keeper · Make the prompt cache pay off";');
    expect(home).toContain('<PiCacheKeeper title={title} description={description} path="/" jsonLd={jsonLd}>');
    expect(missing).toContain("path={null}");
    expect(readdirSync(join(ROOT, "public", "pi-cache-keeper")).sort()).toEqual(["apple-touch-icon.png", "favicon.ico", "favicon.svg", "og.png", "robots.txt", "sitemap.xml"]);
  });

  it("says how to install it and what it needs, and links npm, GitHub, providers.dev and Provimux", () => {
    for (const words of [
      "pi install npm:pi-cache-keeper", "/reload", "It needs Pi 1.6.0 or newer.", "Pi 1.6.0 or newer.", "pi update --extensions",
      "https://www.npmjs.com/package/pi-cache-keeper", "https://github.com/ngvoicu/pi-cache-keeper", "https://providers.dev",
      "Works well with Provimux and pi-provimux", 'href="https://provimux.providers.dev/"', "https://www.npmjs.com/package/pi-provimux",
    ]) expect(text, words).toContain(words);
  });

  it("credits pi-cached-compaction as the README does", () => {
    for (const words of [
      "https://github.com/nicobailon/pi-cached-compaction", "pi-cache-keeper is based on",
      "released under the MIT licence, starting from its 0.2.0 release.",
      "Compaction from the warm cache, the compaction card, the cache countdown, compacting before the cache expires and the longer cache are his work",
      "This is a separate project; it is not maintained by Nico Bailon.",
    ]) expect(text, words).toContain(words);
    expect(layout.replace(/\s+/g, " ")).toContain("It is based on <a href=\"https://github.com/nicobailon/pi-cached-compaction\" class=\"underline\">pi-cached-compaction</a> by Nico Bailon.");
  });

  it("says what 0.10.8 says: what answered through a proxy, by name, and every command in plain words", () => {
    for (const words of [
      "⚠ answered by anthropic (API key)", "Through a proxy: an Anthropic API key answered for a login's values; the values follow what answered",
      "⚠ answered by devin (login)", "where providers.dev has no entry for it, <code>/cache-keeper</code> says which entry it looked up.",
      "Through a proxy it also names what answered last and, where providers.dev has no entry for that, the entry it looked up;",
      "It sends nothing itself and does not turn keep-warm on.", "A refresh already on its way can still cost, and a stop can't be taken back.",
      "Not pi-provimux's <code>/provimux-refresh</code>, which reloads your gateway's model list.", "#commands`}>Every command in full</a>",
      // /cache-keeper's sample output is the README's, with 0.10.8's lines.
      "next compaction: from the cache, as far as can be told now;", "compact when full: off:", "fallback compaction model (asked to write the summary when the cache can't be used): off:",
      "keep warm while you are away: re-sends your last request", "compact before expiry: on, from 140k tokens of context:", "cache retention: short:",
      "model data from providers.dev: off", "· change them with /cache-keeper-settings", "log file: ~/.pi/agent/cache-keeper.jsonl",
      "This session (its latest 12 entries in the log, at most):",
    ]) expect(text, words).toContain(words);
    // 0.10.7's wording is gone.
    for (const words of ["answered by an API key", "cached path", "The request prefix is checked when it runs.", "retention long</p>", "This session:</p>", "Starts keeping the cache warm again", "that uses the same settings"]) {
      expect(text, words).not.toContain(words);
    }
  });

  it("says what 0.10.9 adds: through Provimux, the price and cache lifetimes of what answered, display only", () => {
    for (const words of [
      "README as released (0.10.9)",
      "the values follow what answered (through Provimux, that account's own price and lifetimes)",
      "through Provimux, also that answer's cache lifetimes and price, and where they come from.",
      "After a fallback, the footer and <code>/cache-keeper</code> show the cache lifetimes and price of the account that really answered, where they used to say unknown.",
      "From Provimux 8.1.7-pmx.5 on, each answer names its providers.dev entry, and pi-provimux 105.0.9 hands on Provimux's price and cache lifetimes for it;",
      "This is display only: the countdown, keep-warm and what is written into <code>models.json</code> stay as they were.",
    ]) expect(text, words).toContain(words);
    expect(text).not.toContain("README as released (0.10.8)");
  });

  it("shows sample sessions only, and keeps to the public wording: no other e-mail, no local paths, no promises", () => {
    expect(home.match(/A sample session\./g)).toHaveLength(2);
    for (const words of ["/Users/", "cheapest", "guaranteed", "always cheaper", "referral", "affiliate"]) expect(text.toLowerCase(), words).not.toContain(words.toLowerCase());
    expect(text, "a task number").not.toMatch(/\bT-\d+\b/);
    for (const address of text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []) expect(address).toBe("office@providers.dev");
    // Where it is cheaper, the page says where it is not.
    expect(text).toContain("On small sessions, Pi's is often cheaper.");
  });
});
