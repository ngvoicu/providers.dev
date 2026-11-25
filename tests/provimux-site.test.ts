// provimux.providers.dev: the third address of the Worker (src/core/provimux-site.ts). Its static pages and files on
// the subdomain, nothing else there; providers.dev's /support/ and anything under /provimux/ sent to it with a 301.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { movedToProvimux, PROVIMUX_PAGES, PROVIMUX_SITE, provimuxRoute } from "../src/core/provimux-site.ts";
import type { AssetBinding } from "../src/core/snapshot.ts";
import worker from "../worker/index.ts";
import { ROOT, tempDataDir } from "./helpers.ts";

/** A build with the subdomain's files only: no snapshot, so a request that read the dataset would fail. */
function assets() {
  const dist = tempDataDir();
  const files: Record<string, string> = {
    "provimux/index.html": "<h1>Provimux home</h1>",
    "provimux/support/index.html": "<h1>Provimux support</h1>",
    "provimux/not-found/index.html": "<h1>Nothing at this address</h1>",
    "provimux/media/console-models-light.webp": "webp",
    "provimux/robots.txt": "User-agent: *",
    "provimux/sitemap.xml": "<urlset/>",
    "provimux/favicon.svg": "<svg/>",
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

describe("provimux.providers.dev on the Worker", () => {
  it("serves its two pages and its files at the subdomain's root, from the build's provimux folder", async () => {
    const { binding, reads } = assets();
    for (const [path, body] of [["/", "Provimux home"], ["/support/", "Provimux support"]] as const) {
      const response = await get(binding, `https://provimux.providers.dev${path}`);
      expect([path, response.status]).toEqual([path, 200]);
      expect(await response.text()).toContain(body);
    }
    for (const path of ["/media/console-models-light.webp", "/robots.txt", "/sitemap.xml", "/favicon.svg", "/_astro/site.css"]) {
      expect([path, (await get(binding, `https://provimux.providers.dev${path}`)).status]).toEqual([path, 200]);
    }
    // Every file but Astro's shared stylesheets is the subdomain's own; the dataset is never read.
    expect(reads).toEqual(["/provimux/", "/provimux/support/", "/provimux/media/console-models-light.webp", "/provimux/robots.txt", "/provimux/sitemap.xml", "/provimux/favicon.svg", "/_astro/site.css"]);
  });

  it("answers anything else there with its own page and status 404: no API, no providers.dev page, no build folder by name", async () => {
    const { binding, reads } = assets();
    for (const path of ["/api/v1/meta", "/api.json", "/docs/methodology/", "/providers/", "/provimux/", "/provimux/support/", "/not-found/", "/index.html", "/support/index.html", "/site-shell/", "/media/missing.webp", "/media/", "/support/plans/"]) {
      const response = await get(binding, `https://provimux.providers.dev${path}`);
      expect([path, response.status, response.headers.get("Content-Type"), response.headers.get("Cache-Control")]).toEqual([path, 404, "text/html; charset=utf-8", "no-store"]);
      expect(await response.text(), path).toContain("Nothing at this address");
    }
    expect(reads.some((path) => path.startsWith("/snapshots/") || path === "/current.json" || path.startsWith("/site-shell"))).toBe(false);
    const head = await get(binding, "https://provimux.providers.dev/nothing", { method: "HEAD" });
    expect([head.status, await head.text()]).toEqual([404, ""]);
  });

  it("adds the slash to a page's address and keeps the query, answers GET and HEAD only, and sends plain http at the edge to https", async () => {
    const { binding } = assets();
    const slash = await get(binding, "https://provimux.providers.dev/support?from=readme");
    expect([slash.status, slash.headers.get("Location")]).toEqual([301, "https://provimux.providers.dev/support/?from=readme"]);
    expect((await get(binding, "https://provimux.providers.dev/", { method: "POST" })).status).toBe(405);
    expect((await get(binding, "https://provimux.providers.dev/support/", { method: "HEAD" })).status).toBe(200);
    for (const path of ["/", "/support/", "/media/console-models-light.webp?x=1"]) {
      const edge = await get(binding, `http://provimux.providers.dev${path}`, { headers: { "X-Forwarded-Proto": "http" } });
      expect([path, edge.status, edge.headers.get("Location")]).toEqual([path, 301, `https://provimux.providers.dev${path}`]);
    }
    // wrangler dev sees the host over plain http with no edge header: served as it comes.
    expect((await get(binding, "http://provimux.providers.dev/")).status).toBe(200);
    expect((await get(binding, "https://provimux.providers.dev/", { headers: { "X-Forwarded-Proto": "https" } })).status).toBe(200);
  });

  it("routes a path by the rules of src/core/provimux-site.ts", () => {
    expect(PROVIMUX_PAGES).toEqual(["/", "/support/"]);
    expect(provimuxRoute("/")).toEqual({ asset: "/provimux/", status: 200 });
    expect(provimuxRoute("/support")).toEqual({ redirect: "/support/" });
    expect(provimuxRoute("/og.png")).toEqual({ asset: "/provimux/og.png", status: 200 });
    for (const path of ["/support/index.html", "/media/", "/media/../og.png", "/support/plans", "//evil.example/x.png"]) expect(provimuxRoute(path), path).toEqual({ asset: "/provimux/not-found/", status: 404 });
  });
});

describe("providers.dev sends what moved to provimux.providers.dev with a 301, before reading anything", () => {
  it("sends the support page, at both of its old addresses, to https://provimux.providers.dev/support/ with the query", async () => {
    const { binding, reads } = assets();
    for (const [path, location] of [
      ["/support/", "https://provimux.providers.dev/support/"],
      ["/support", "https://provimux.providers.dev/support/"],
      ["/docs/support/", "https://provimux.providers.dev/support/"],
      ["/docs/support", "https://provimux.providers.dev/support/"],
      ["/support/?utm=sponsors", "https://provimux.providers.dev/support/?utm=sponsors"],
    ] as const) {
      for (const origin of ["https://providers.dev", "http://localhost:18791"]) {
        const response = await get(binding, `${origin}${path}`, origin.startsWith("https") ? { headers: { "X-Forwarded-Proto": "https" } } : {});
        expect([origin, path, response.status, response.headers.get("Location")]).toEqual([origin, path, 301, location]);
      }
    }
    expect(reads).toEqual([]);
  });

  it("sends anything under /provimux/ to the same path on the subdomain, so the build is never a stray page of providers.dev", async () => {
    const { binding, reads } = assets();
    for (const [path, location] of [
      ["/provimux", "https://provimux.providers.dev/"],
      ["/provimux/", "https://provimux.providers.dev/"],
      ["/provimux/support/", "https://provimux.providers.dev/support/"],
      ["/provimux/not-found/", "https://provimux.providers.dev/not-found/"],
      ["/provimux/media/console-models-light.webp", "https://provimux.providers.dev/media/console-models-light.webp"],
    ] as const) {
      const response = await get(binding, `https://providers.dev${path}`);
      expect([path, response.status, response.headers.get("Location")]).toEqual([path, 301, location]);
    }
    expect(reads).toEqual([]);
  });

  it("leaves every other address alone", () => {
    for (const path of ["/", "/supported/", "/support/plans/", "/docs/supports/", "/provimuxx/", "/docs/methodology/", "/api/v1/docs/support"]) {
      expect(movedToProvimux(new URL(`https://providers.dev${path}`)), path).toBeNull();
    }
    // A path that looks like another host stays a path on the subdomain.
    expect(movedToProvimux(new URL("https://providers.dev/provimux//evil.example/x"))).toBe("https://provimux.providers.dev//evil.example/x");
  });

  it("has the subdomain as a custom domain of the Worker, beside the apex, www and pi-cache-keeper's", () => {
    const config = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
    const patterns = [...config.matchAll(/\{ "pattern": "([^"]+)", "custom_domain": true \}/g)].map((match) => match[1]);
    expect(patterns).toEqual(["providers.dev", "www.providers.dev", "provimux.providers.dev", "pi-cache-keeper.providers.dev"]);
  });
});

describe("Provimux's pages", () => {
  const source = (...path: string[]) => readFileSync(join(ROOT, ...path), "utf8");
  const home = source("src", "pages", "provimux", "index.astro");
  const layout = source("src", "layouts", "Provimux.astro");
  const support = source("src", "pages", "provimux", "support", "index.astro");
  const body = source("src", "components", "provimux", "SupportBody.astro");
  const text = [home, layout, support, body, source("src", "pages", "provimux", "not-found", "index.astro")].join("\n").replace(/\s+/g, " ");

  it("lists its two pages in the sitemap and robots.txt at the subdomain's address, with canonical addresses there", () => {
    const sitemap = source("public", "provimux", "sitemap.xml");
    expect([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])).toEqual(PROVIMUX_PAGES.map((path) => `${PROVIMUX_SITE}${path}`));
    expect(source("public", "provimux", "robots.txt")).toContain("Sitemap: https://provimux.providers.dev/sitemap.xml");
    expect(layout).toContain("const canonical = path === null ? null : new URL(path, PROVIMUX_SITE).toString();");
    expect(layout).toContain('<link rel="canonical" href={canonical} />');
    expect(layout).toContain('<meta name="robots" content="noindex" />');
    expect(home).toContain('title="Provimux · One key for every AI account"');
    expect(home).toContain('path="/"');
    expect(support).toContain('title="Support · Provimux" description={SUPPORT.description} path="/support/"');
  });

  it("shows the console with example data, in both themes and two sizes", () => {
    const media = readdirSync(join(ROOT, "public", "provimux", "media")).sort();
    expect(media).toEqual(["accounts", "models", "names-narrow", "names-wide", "pool-narrow", "pool-wide", "savings-narrow", "savings-wide"].flatMap((page) => ["dark", "light"].flatMap((scheme) => [`console-${page}-${scheme}-2x.webp`, `console-${page}-${scheme}.webp`])).sort());
    expect(home.match(/Example data\./g)).toHaveLength(5);
    expect(home).toContain("alex@example.com");
  });

  it("says how to install it, and names pi-provimux with its install line, npm page and repository", () => {
    for (const words of [
      "brew install ngvoicu/tap/provimux", "brew services start provimux", "ghcr.io/ngvoicu/provimux",
      "pi install npm:pi-provimux", "https://www.npmjs.com/package/pi-provimux", "https://github.com/ngvoicu/pi-provimux",
      "It needs pi 1.6.0 or newer.", "This needs Provimux 8.1.1-pmx.1 or newer.",
      "https://github.com/ngvoicu/provimux", "https://providers.dev", 'href="/support/"',
    ]) expect(text, words).toContain(words);
  });

  it("keeps to Provimux's public wording: CLIProxyAPI in full, no promises about logins, no other e-mail, no local paths", () => {
    // "CPA" only inside a header name such as X-CPA-AUTH-KIND.
    expect(text.replace(/X-CPA-[A-Z-]+/g, "")).not.toMatch(/\bCPA\b/);
    for (const words of ["compliant", "ToS-safe", "won't get you banned", "cheapest", "save 83", "works with Claude Code", "local endpoint", "partner of", "referral", "affiliate link", "/Users/", "security boundary", "access control"]) {
      expect(text.toLowerCase(), words).not.toContain(words.toLowerCase());
    }
    // office@providers.dev, and the screenshots' made-up accounts at example.com.
    for (const address of text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g)!) expect(address).toMatch(/^(office@providers\.dev|[a-z]+@example\.com)$/);
    // Where logins are explained, the note on providers' terms goes with them.
    expect(home.replace(/\s+/g, " ")).toContain("Whether a provider allows a third-party tool to use its subscription login is that provider's decision: Anthropic's terms do not allow it, and OpenAI has not authorized it.");
    expect(layout).toContain("It is not affiliated with or endorsed by Anthropic or OpenAI.");
  });
});
