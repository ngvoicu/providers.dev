// The pages read their query leniently (an address carrying utm_source, fbclid, ref… still opens the page); the API
// stays strict. A page past the last one of a list is the not-found page.
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { publish } from "../scripts/lib/publish.ts";
import { sync } from "../scripts/lib/sync.ts";
import { handleApi, type LoadedDeps } from "../src/core/api.ts";
import { MARK } from "../src/core/page-shell.ts";
import { handlePage, pageParams, type PageDeps } from "../src/core/pages.ts";
import { PARAMS, PROVIDER_PARAMS } from "../src/core/query.ts";
import { depsFrom, fetchReturning, fixtureUpstream, ROOT, tempDataDir, writeAuthored } from "./helpers.ts";

const shell = `<html><head><title>${MARK.title}</title><meta name="description" content="${MARK.description}">${MARK.head}</head><body><nav>${MARK.nav}</nav><main>${MARK.html}</main><footer>${MARK.dataset}</footer></body></html>`;
const now = () => new Date("2026-11-14T12:00:00Z");
let deps: LoadedDeps;

beforeAll(async () => {
  const dataDir = tempDataDir();
  await sync({ dataDir, fetch: fetchReturning(JSON.stringify(fixtureUpstream())) });
  writeAuthored(dataDir);
  expect(publish({ dataDir, rootDir: ROOT, now }).errors).toEqual([]);
  deps = depsFrom(join(dataDir, "published"));
});

const api = (path: string) => handleApi(new Request(`https://providers.dev${path}`), deps);
const pageDeps = (): PageDeps => ({ api, shell: async () => new Response(shell), site: "https://providers.dev", now });
const page = (path: string) => handlePage(new Request(`https://providers.dev${path}`), pageDeps());
const canonical = (html: string): string | undefined => /<link rel="canonical" href="([^"]+)">/.exec(html)?.[1];

describe("an HTML page ignores a query parameter it does not know", () => {
  const cases: [string, string, string][] = [
    ["/?utm_source=chatgpt.com", "/", "https://providers.dev/"],
    ["/?fbclid=abc", "/", "https://providers.dev/"],
    ["/?gclid=1&mc_cid=2&utm_medium=social&utm_campaign=x", "/", "https://providers.dev/"],
    ["/providers/?utm_source=chatgpt.com", "/providers/", "https://providers.dev/providers/"],
    ["/models/?ref=x", "/models/", "https://providers.dev/models/"],
    ["/evidence/?utm_source=chatgpt.com", "/evidence/", "https://providers.dev/evidence/"],
    ["/entries/provider-02/lab/model-4?utm_source=chatgpt.com", "/entries/provider-02/lab/model-4", "https://providers.dev/entries/provider-02/lab/model-4"],
    ["/providers/provider-02/?fbclid=abc", "/providers/provider-02/", "https://providers.dev/providers/provider-02/"],
    ["/models/lab/model-4/?ref=x", "/models/lab/model-4/", "https://providers.dev/models/lab/model-4/"],
    ["/docs/methodology/?utm_source=chatgpt.com", "/docs/methodology/", "https://providers.dev/docs/methodology/"],
    ["/docs/api/?utm_source=chatgpt.com", "/docs/api/", "https://providers.dev/docs/api/"],
  ];
  for (const [path, plain, address] of cases) {
    it(`${path}: 200, the same page as ${plain}, canonical ${address}`, async () => {
      const response = await page(path);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toBe(await (await page(plain)).text());
      expect(canonical(html)).toBe(address);
      // The page's own links and forms do not carry the parameter on.
      expect(html).not.toMatch(/utm_|fbclid|gclid|mc_cid|[?&;]ref=/);
    });
  }

  it("keeps the known filters beside an unknown parameter, with their meaning", async () => {
    const html = await (await page("/?provider=provider-02&limit=2&offset=2&sort=model&utm_source=chatgpt.com")).text();
    expect(html).toBe(await (await page("/?provider=provider-02&limit=2&offset=2&sort=model")).text());
    expect(html).toContain("Page 2 of 10");
    expect(html).toContain('href="/?provider=provider-02&amp;limit=2&amp;offset=4&amp;sort=model"');
    const providers = await (await page("/providers/?q=Provider%202&ref=x")).text();
    expect(providers).toBe(await (await page("/providers/?q=Provider%202")).text());
  });
});

describe("a known filter with a value the API refuses: the page leaves that one filter out", () => {
  for (const [path, plain] of [
    ["/?min_context=nope", "/"],
    ["/?access=everything&provider=provider-02", "/?provider=provider-02"],
    ["/?limit=100000", "/"],
    ["/?lifetime_basis=none", "/"],
    ["/?provider=provider-02&provider=provider-03", "/?provider=provider-02"],
    ["/providers/?limit=0&access=api", "/providers/?access=api"],
    ["/providers/?offset=-1", "/providers/"],
    ["/models/?offset=abc", "/models/"],
    ["/evidence/?corrections_offset=abc&cache_offset=-3", "/evidence/"],
  ] as const) {
    it(`${path} is ${plain}`, async () => {
      const response = await page(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(await (await page(plain)).text());
    });
  }

  it("pageParams keeps only described parameters with values the API accepts, the first of a repeated name", () => {
    expect(pageParams(new URLSearchParams("utm_source=x&access=api&access=subscription&limit=0&q=a"), PROVIDER_PARAMS).toString()).toBe("access=api&q=a");
    expect(pageParams(new URLSearchParams("min_output=12&max_age_months=0&sort=nope&order=desc&fbclid=1"), PARAMS).toString()).toBe("min_output=12&order=desc");
  });
});

describe("a page past the last one of a list is the not-found page", () => {
  for (const path of ["/?offset=999999", "/?provider=provider-02&offset=20", "/providers/?offset=999999", "/models/?offset=999999", "/evidence/?corrections_offset=999999", "/evidence/?cache_offset=999999", "/evidence/?limits_offset=999999"]) {
    it(`${path}: 404, noindex, a way back to the catalog`, async () => {
      const response = await page(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const html = await response.text();
      expect(html).toContain("<h1>Nothing at this address</h1>");
      expect(html).toContain('<a class="button" href="/">Search the catalog</a>');
      expect(html).not.toMatch(/Page \d+ of/);
    });
  }

  it("the last page itself, and an empty list's first page, are pages", async () => {
    expect((await page("/?provider=provider-02&limit=2&offset=18")).status).toBe(200);
    expect((await page("/?q=no-such-model-anywhere")).status).toBe(200);
    expect((await page("/providers/?q=no-such-provider")).status).toBe(200);
    expect((await page("/providers/?offset=30&limit=1")).status).toBe(200);
  });
});

describe("the JSON API stays strict", () => {
  for (const path of [
    "/api/v1/entries?utm_source=chatgpt.com",
    "/api/v1/entries?fbclid=abc",
    "/api/v1/providers?utm_source=chatgpt.com",
    "/api/v1/models?ref=x",
    "/api/v1/meta?fbclid=abc",
    "/api/v1/corrections?gclid=1",
    "/api/v1/evaluations/cache?ref=x",
    "/api/v1/entries/provider-02/lab/model-4?utm_source=chatgpt.com",
    "/api/v1/docs/methodology?utm_source=chatgpt.com",
  ]) {
    it(`${path}: 400 invalid_parameters, naming the unknown parameter`, async () => {
      const response = await api(path);
      expect(response.status).toBe(400);
      const body = await response.json() as { error: { code: string; message: string; details: { param: string; message: string }[] } };
      const name = new URL(path, "https://providers.dev").searchParams.keys().next().value;
      expect(body.error.code).toBe("invalid_parameters");
      expect(body.error.message).toBe("One or more query parameters are not valid.");
      expect(body.error.details).toHaveLength(1);
      expect(body.error.details[0]?.param).toBe(name);
      expect(body.error.details[0]?.message).toMatch(/^Unknown parameter\./);
    });
  }

  it("still refuses a bad value of a known filter, and still answers a page past the end with an empty page", async () => {
    expect((await api("/api/v1/entries?min_context=nope")).status).toBe(400);
    expect((await api("/api/v1/providers?limit=0")).status).toBe(400);
    const past = await api("/api/v1/providers?offset=999999");
    expect(past.status).toBe(200);
    expect(((await past.json()) as { data: unknown[] }).data).toEqual([]);
  });
});
