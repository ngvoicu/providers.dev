// What a search engine or an agent reads first on a page: its title, its description, its social tags and its
// structured data (src/core/page-meta.ts, src/core/structured-data.ts). Every page type, on the fixture through
// handlePage; titles and descriptions over the whole publication in dist/; the product pages as built in dist/.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { publish } from "../scripts/lib/publish.ts";
import { sync } from "../scripts/lib/sync.ts";
import { handleApi, modelsFor, type LoadedDeps } from "../src/core/api.ts";
import type { Index, Summary } from "../src/core/entries.ts";
import { MARK } from "../src/core/page-shell.ts";
import { documentMeta, entryMeta, HOME_TITLE, modelMeta, providerMeta, type PageMeta } from "../src/core/page-meta.ts";
import { handlePage, type PageDeps } from "../src/core/pages.ts";
import type { Meta } from "../src/core/schema.ts";
import { depsFrom, fetchReturning, fixtureUpstream, ROOT, tempDataDir, writeAuthored } from "./helpers.ts";

// The shell's head as Base.astro writes it: the title, description and social tags from the markers, then the page's head.
const shell = `<html><head><title>${MARK.title}</title><meta name="description" content="${MARK.description}"><meta property="og:title" content="${MARK.title}"><meta property="og:description" content="${MARK.description}"><meta name="twitter:title" content="${MARK.title}">${MARK.head}</head><body><nav>${MARK.nav}</nav><main>${MARK.html}</main><footer>${MARK.dataset}</footer></body></html>`;
const now = () => new Date("2026-11-14T12:00:00Z");
const SITE = "https://providers.dev";
let deps: LoadedDeps;

beforeAll(async () => {
  const dataDir = tempDataDir();
  await sync({ dataDir, fetch: fetchReturning(JSON.stringify(fixtureUpstream())) });
  writeAuthored(dataDir);
  expect(publish({ dataDir, rootDir: ROOT, now }).errors).toEqual([]);
  deps = depsFrom(join(dataDir, "published"));
});

const api = (path: string) => handleApi(new Request(`${SITE}${path}`), deps);
const pageDeps = (): PageDeps => ({ api, shell: async () => new Response(shell), site: SITE, now });
const page = (path: string) => handlePage(new Request(`${SITE}${path}`), pageDeps());

const unescape = (text: string): string => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
type Node = Record<string, unknown>;

/** What a page's head says of it, and its structured data, parsed. */
interface Read { status: number; title: string; description: string; ogTitle: string; ogUrl: string | null; canonical: string | null; h1: string[]; crumbs: string | null; scripts: string[]; graph: Node[] }
function readHtml(status: number, html: string): Read {
  const pick = (re: RegExp): string | null => { const found = re.exec(html)?.[1]; return found === undefined ? null : unescape(found); };
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
  return {
    status,
    title: pick(/<title>([^<]*)<\/title>/)!,
    description: pick(/<meta name="description" content="([^"]*)"/)!,
    ogTitle: pick(/<meta property="og:title" content="([^"]*)"/)!,
    ogUrl: pick(/<meta property="og:url" content="([^"]*)"/),
    canonical: pick(/<link rel="canonical" href="([^"]*)"/),
    h1: [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((match) => unescape(match[1]!.replace(/<[^>]+>/g, "").trim())),
    crumbs: pick(/<p class="crumbs">([\s\S]*?)<\/p>/),
    scripts,
    graph: scripts.flatMap((script) => {
      const parsed = JSON.parse(script) as Node;
      expect(parsed["@context"]).toBe("https://schema.org");
      return parsed["@graph"] as Node[];
    }),
  };
}
async function read(path: string): Promise<Read> {
  const response = await page(path);
  return readHtml(response.status, await response.text());
}

/** Every value of a graph, with the key it is under, at any depth. */
function walk(value: unknown, visit: (key: string, value: unknown) => void, key = ""): void {
  if (Array.isArray(value)) for (const item of value) walk(item, visit, key);
  else if (value && typeof value === "object") for (const [name, inner] of Object.entries(value)) { visit(name, inner); walk(inner, visit, name); }
}

/** Nothing the pages do not show: no rating, review, offer, search action, date or person (B6 is held). */
function claimsNothingElse(graph: Node[], persons: readonly string[] = []): void {
  walk(graph, (key, value) => {
    expect(["aggregateRating", "review", "offers", "potentialAction", "datePublished", "dateModified", "dateCreated", "founder", "sameAs"], key).not.toContain(key);
    if (key === "@type") expect(["Offer", "AggregateRating", "Review", "SearchAction", "Product"]).not.toContain(value);
    if (typeof value === "string") expect(value).not.toMatch(/ngvoicu\.dev|Gabriel/);
  });
  const people = graph.flatMap((node) => { const found: string[] = []; walk([node], (key, value) => { if (key === "@type" && value === "Person") found.push("Person"); }); return found; });
  expect(people.length).toBe(persons.length);
}

function byType(graph: Node[], type: string): Node[] {
  return graph.filter((node) => node["@type"] === type);
}

/** The page node of a graph: the node whose @id is the page's canonical address. */
function pageNode(result: Read): Node {
  const node = result.graph.find((item) => item["@id"] === result.canonical);
  expect(node, `${result.canonical}: a node for the page itself`).toBeDefined();
  return node!;
}

/** Each page type of the fixture, with what its structured data must hold. */
async function pagePaths(): Promise<{ providers: string[]; models: string[]; entries: Summary[] }> {
  const providers = (await (await api("/api/v1/providers?limit=200")).json() as { data: { id: string }[] }).data.map((item) => item.id);
  const models = (await (await api("/api/v1/models?limit=200")).json() as { data: { id: string }[] }).data.map((item) => item.id);
  return { providers, models, entries: deps.index.entries };
}

describe("titles and descriptions", () => {
  it("gives every page of the fixture its own title and description, the same in the title, og:title and structured data", async () => {
    const { providers, models, entries } = await pagePaths();
    const paths = [
      "/", "/?offset=50", "/providers/", "/models/", "/evidence/", "/docs/api/", "/docs/methodology/", "/docs/licensing/", "/docs/contributing/",
      ...providers.map((id) => `/providers/${encodeURIComponent(id)}/`),
      ...models.map((id) => `/models/${id.split("/").map(encodeURIComponent).join("/")}/`),
      ...entries.map((summary) => `/entries/${summary.ref.split("/").map(encodeURIComponent).join("/")}`),
    ];
    const titles = new Map<string, string>();
    const descriptions = new Map<string, string>();
    for (const path of paths) {
      const result = await read(path);
      expect([path, result.status]).toEqual([path, 200]);
      expect(result.h1, path).toHaveLength(1);
      expect(result.ogTitle, path).toBe(result.title);
      expect(result.ogUrl, path).toBe(result.canonical);
      expect(pageNode(result).name, path).toBe(result.title);
      expect(pageNode(result).description, path).toBe(result.description);
      expect(result.title.endsWith(" · providers.dev") || result.title === HOME_TITLE, path).toBe(true);
      // The site's name once, never twice.
      expect(result.title.match(/providers\.dev/g), path).toHaveLength(1);
      for (const text of [result.title, result.description]) expect(text, path).not.toMatch(/undefined|\bnull\b|NaN|%%PAGE|\$-|<|>/);
      expect(result.description.length, path).toBeLessThanOrEqual(400);
      expect(titles.get(result.title), `${path} has the title of ${titles.get(result.title)}`).toBeUndefined();
      titles.set(result.title, path);
      // The fixture's documents are one stand-in text; their own descriptions are checked on the build below.
      if (path.startsWith("/docs/") && path !== "/docs/api/") continue;
      expect(descriptions.get(result.description), `${path} has the description of ${descriptions.get(result.description)}`).toBeUndefined();
      descriptions.set(result.description, path);
    }
    expect(titles.size).toBe(paths.length);
  });

  it("keeps the qualifiers its page shows: at least, unknown, whose price, a warning; never measured", () => {
    for (const summary of deps.index.entries) checkEntry(summary, entryMeta(summary, "Provider"));
  });

  // The publication `npm run build` made: every entry, provider and model of the real data.
  const built = join(ROOT, "dist");
  it.skipIf(!existsSync(join(built, "current.json")))("has no two pages with one title or one description in the publication in dist/", () => {
    const id = (JSON.parse(readFileSync(join(built, "current.json"), "utf8")) as { id: string }).id;
    const index = JSON.parse(gunzipSync(readFileSync(join(built, "snapshots", id, "data", "index.json.gz"))).toString()) as Index;
    const names = new Map(index.providers.map((provider) => [provider.id, provider.name]));
    const pages: [string, PageMeta][] = [
      ...index.entries.map((summary): [string, PageMeta] => {
        const meta = entryMeta(summary, names.get(summary.provider)!);
        checkEntry(summary, meta);
        return [summary.ref, meta];
      }),
      ...index.providers.map((provider): [string, PageMeta] => [provider.id, providerMeta(provider)]),
      ...modelsFor(index).map((model): [string, PageMeta] => [model.id, modelMeta(model)]),
    ];
    // The documents' own descriptions, as the build wrote them.
    for (const name of ["methodology", "licensing", "contributing"]) {
      const document = JSON.parse(readFileSync(join(built, "reference-content", "docs", `${name}.json`), "utf8")) as { title: string; description: string };
      pages.push([`/docs/${name}/`, documentMeta(name, document)]);
    }
    expect(pages.length).toBeGreaterThan(1000);
    for (const key of ["title", "description"] as const) {
      const seen = new Map<string, string>();
      const twice = pages.filter(([ref, meta]) => { const before = seen.get(meta[key]); seen.set(meta[key], ref); return before !== undefined; });
      expect(twice.map(([ref, meta]) => `${ref}: ${meta[key]}`), key).toEqual([]);
    }
  });
});

/** The description of an entry against its summary: what its tiles say, qualifiers included. */
function checkEntry(summary: Summary, meta: PageMeta): void {
  const { input_window: window, max_output: output } = summary.safe;
  const text = meta.description;
  const warned = (safe: typeof window): string => (safe.agreement === "differ" ? " (not all sources agree)" : "");
  const said = (safe: typeof window): string => `${safe.value === null ? "unknown" : `${safe.at_least ? "at least " : ""}${safe.value.toLocaleString("en-US")} tokens`}${warned(safe)},`;
  expect(text).toContain(`context window ${said(window)}`);
  expect(text).toContain(`maximum output ${said(output)}`);
  if (summary.price_from && summary.price_in !== null && summary.price_out !== null) expect(text).toContain(`(API list price of ${summary.price_from})`);
  if (summary.price_in === null && summary.price_out === null && summary.pricing.billing === "not_applicable") expect(text).toContain("price: in plan");
  // An unknown price is never written as zero.
  if (summary.price_in === null || summary.price_out === null) expect(text).not.toMatch(/price \$/);
  expect(text).not.toMatch(/measured/i);
  expect(meta.title).toContain(summary.name);
}

describe("structured data", () => {
  it("describes the home page as the site, its publisher and the catalog as a dataset, from the same meta", async () => {
    const result = await read("/");
    const meta = (await (await api("/api/v1/meta")).json() as { data: Meta }).data;
    expect(result.scripts).toHaveLength(1);
    expect(result.scripts[0]).not.toMatch(/[<>]/);
    const [organization] = byType(result.graph, "Organization");
    expect(organization).toMatchObject({ "@id": `${SITE}/#organization`, name: "providers.dev", url: `${SITE}/`, logo: `${SITE}/apple-touch-icon.png`, email: "office@providers.dev" });
    expect(byType(result.graph, "WebSite")[0]).toMatchObject({ "@id": `${SITE}/#website`, name: "providers.dev", url: `${SITE}/` });
    const [dataset] = byType(result.graph, "Dataset");
    expect(dataset).toMatchObject({ "@id": `${SITE}/#catalog`, url: `${SITE}/`, version: meta.dataset_version, license: `${SITE}/docs/licensing/`, isAccessibleForFree: true });
    expect((dataset!.description as string).length).toBeGreaterThanOrEqual(50);
    expect(dataset!.description).toContain(`${meta.counts.entries.toLocaleString("en-US")} entries`);
    expect(dataset!.distribution).toEqual([
      { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${SITE}/api.json` },
      { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${SITE}/api/v1/catalog` },
    ]);
    claimsNothingElse(result.graph);
    await answers(result.graph);
  });

  it("gives each detail page a page node and the trail it shows above its h1", async () => {
    const { providers, models, entries } = await pagePaths();
    const entry = entries.find((summary) => summary.provider === providers[1])!;
    const cases: [string, string[]][] = [
      [`/providers/${providers[1]}/`, ["Providers", "{name}"]],
      [`/models/${models[0]}/`, ["Models", "{name}"]],
      [`/entries/${entry.ref}`, ["Providers", "{provider}", "{name}"]],
    ];
    for (const [path, shape] of cases) {
      const result = await read(path);
      const node = pageNode(result);
      expect(node["@type"]).toBe("WebPage");
      expect(node.isPartOf).toEqual([{ "@id": `${SITE}/#website` }, { "@id": `${SITE}/#catalog` }]);
      expect(node.breadcrumb).toEqual({ "@id": `${result.canonical}#breadcrumb` });
      const [trail] = byType(result.graph, "BreadcrumbList");
      const items = trail!.itemListElement as { "@type": string; position: number; name: string; item: string }[];
      expect(items.map((item) => item.position)).toEqual(shape.map((_, index) => index + 1));
      expect(items.every((item) => item["@type"] === "ListItem" && item.item.startsWith(`${SITE}/`))).toBe(true);
      // The last step is the page, named by its h1; every other step is a link of the trail on the page.
      expect(items.at(-1)).toMatchObject({ name: result.h1[0], item: result.canonical });
      for (const item of items.slice(0, -1)) expect(result.crumbs, path).toContain(`<a href="${new URL(item.item).pathname}">${item.name}</a>`);
      claimsNothingElse(result.graph);
      await answers(result.graph);
    }
  });

  it("marks the documents as technical articles (licensing as a page) and names the API by addresses that answer", async () => {
    for (const name of ["methodology", "contributing", "licensing"]) {
      const result = await read(`/docs/${name}/`);
      const node = pageNode(result);
      expect(node["@type"]).toBe(name === "licensing" ? "WebPage" : "TechArticle");
      if (name !== "licensing") expect(node).toMatchObject({ headline: result.h1[0], author: { "@id": `${SITE}/#organization` }, publisher: { "@id": `${SITE}/#organization` } });
      claimsNothingElse(result.graph);
    }
    const result = await read("/docs/api/");
    const node = pageNode(result);
    expect(node).toMatchObject({ "@type": "TechArticle", headline: "API" });
    const webApi = node.about as Node;
    expect(webApi).toMatchObject({ "@type": "WebAPI", url: `${SITE}/docs/api/`, documentation: [`${SITE}/docs/api/`, `${SITE}/api/v1/openapi.json`] });
    // Never the API's root, which answers 404.
    expect(JSON.stringify(result.graph)).not.toContain(`"${SITE}/api/v1/"`);
    expect((await api("/api/v1/")).status).toBe(404);
    await answers(result.graph);
  });

  it("marks the lists and the evidence as pages of the catalog, and gives an error page none", async () => {
    for (const path of ["/providers/", "/models/", "/?offset=50", "/evidence/", "/?q=model"]) {
      const result = await read(path);
      expect(pageNode(result)["@type"], path).toBe(path === "/evidence/" ? "WebPage" : "CollectionPage");
      claimsNothingElse(result.graph);
    }
    for (const path of ["/nothing-here", "/providers/nobody/", "/entries/nobody/nothing"]) {
      const result = await read(path);
      expect([path, result.status, result.scripts, result.ogUrl]).toEqual([path, 404, [], null]);
    }
  });

  it("writes a value that could close the script as an escape", async () => {
    const { jsonLdScript } = await import("../src/core/structured-data.ts");
    const script = jsonLdScript([{ "@type": "WebPage", name: "</script><script>alert(1)</script> & more" }]);
    expect(script.slice(0, -"</script>".length)).not.toMatch(/<\/script>/i);
    expect(JSON.parse(script.replace(/^<script[^>]*>|<\/script>$/g, ""))["@graph"][0].name).toBe("</script><script>alert(1)</script> & more");
  });

  // The product pages as Astro builds them.
  const built = join(ROOT, "dist");
  const product = (path: string): Read => readHtml(200, readFileSync(join(built, path), "utf8"));
  it.skipIf(!existsSync(join(built, "provimux", "index.html")))("describes each product as free software built on the project it credits, with no offer, rating or review", () => {
    const cases = [
      { path: "provimux/index.html", site: "https://provimux.providers.dev", name: "Provimux", repository: "https://github.com/ngvoicu/provimux", upstream: "CLIProxyAPI", persons: [] as string[] },
      { path: "pi-cache-keeper/index.html", site: "https://pi-cache-keeper.providers.dev", name: "pi-cache-keeper", repository: "https://github.com/ngvoicu/pi-cache-keeper", upstream: "pi-cached-compaction", persons: ["Nico Bailon"] },
    ];
    for (const { path, site, name, repository, upstream, persons } of cases) {
      const html = readFileSync(join(built, path), "utf8");
      const result = product(path);
      expect(result.canonical).toBe(`${site}/`);
      expect(result.h1).toHaveLength(1);
      expect(byType(result.graph, "WebSite")[0]).toMatchObject({ "@id": `${site}/#website`, name, url: `${site}/` });
      const [application] = byType(result.graph, "SoftwareApplication");
      expect(application).toMatchObject({ "@id": `${site}/#software`, name, url: `${site}/`, applicationCategory: "DeveloperApplication", isAccessibleForFree: true, license: "https://opensource.org/licenses/MIT", description: result.description, publisher: { "@id": `${SITE}/#organization` } });
      const sources = byType(result.graph, "SoftwareSourceCode");
      expect(sources.find((node) => node.codeRepository === repository)).toMatchObject({ targetProduct: { "@id": `${site}/#software` } });
      const credited = sources.find((node) => node.name === upstream)!;
      expect(application!.isBasedOn).toEqual({ "@id": credited["@id"] });
      // What it says is on the page: the credit, the requirement, the platforms.
      expect(html).toContain(`href="${credited.codeRepository as string}"`);
      if (application!.softwareRequirements) expect(html).toContain(application!.softwareRequirements as string);
      if (application!.operatingSystem) for (const system of (application!.operatingSystem as string).split(", ")) expect(html).toContain(system);
      expect(application!.softwareRequirements ?? "Pi 1.6.0 or newer").toBe("Pi 1.6.0 or newer");
      claimsNothingElse(result.graph, persons);
      for (const person of persons) expect(html).toContain(person);
    }
    const support = product("provimux/support/index.html");
    expect(pageNode(support)).toMatchObject({ "@type": "WebPage", name: "Support · Provimux", isPartOf: { "@id": "https://provimux.providers.dev/#website" } });
    expect(byType(support.graph, "BreadcrumbList")[0]!.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Provimux", item: "https://provimux.providers.dev/" },
      { "@type": "ListItem", position: 2, name: "Support", item: "https://provimux.providers.dev/support/" },
    ]);
    claimsNothingElse(support.graph);
    for (const path of ["provimux/not-found/index.html", "pi-cache-keeper/not-found/index.html"]) expect(product(path).scripts).toEqual([]);
  });
});

/** Every providers.dev address in a graph answers: a page, an API path, or a public file. Fragment ids are names, not addresses. */
async function answers(graph: Node[]): Promise<void> {
  const addresses = new Set<string>();
  walk(graph, (key, value) => {
    if (typeof value === "string" && value.startsWith(`${SITE}/`) && key !== "@id") addresses.add(value);
  });
  for (const address of addresses) {
    const { pathname, search } = new URL(address);
    let status: number;
    if (pathname.startsWith("/api/v1/") || pathname === "/api.json") status = (await api(`${pathname}${search}`)).status;
    else if (/\.[a-z]+$/.test(pathname)) status = existsSync(join(ROOT, "public", pathname)) ? 200 : 404;
    else status = (await page(`${pathname}${search}`)).status;
    expect([address, status]).toEqual([address, 200]);
  }
}
